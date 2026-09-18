import * as path from "node:path";
import { writeAtomicJson } from "../shared/atomic-json.ts";
import { negotiate, type NegotiationResult } from "./capability.ts";
import { buildEnvelope, freezeSnapshot, type Envelope } from "./envelope.ts";
import { nodeIdFor, publishEnvelope, safeComponent } from "./envelope-inbox.ts";
import { classifySynapseError } from "./errors.ts";
import { buildReceipt, prepareHandoffContext, type HandoffCandidate, type HandoffContext, type Receipt, type ReceiptOutcome } from "./handoff.ts";
import type { LaunchContract } from "./lifecycle.ts";
import { createMemoryService, type MemoryService } from "./memory-service.ts";
import { createMeteringLog, type MeteringIdentity, type MeteringLog, type ModelUsage } from "./metering.ts";
import { capabilityForAgent, hostCapability } from "./roles.ts";

/**
 * The delegation seam: where a task actually leaves the parent for a child.
 *
 * Everything the protocol modules describe converges here. Capabilities are
 * negotiated before the task is sent, the snapshot is frozen around whatever
 * memory the child is allowed to see, the envelope binds that decision to this
 * request, and the meter records what crossed. The child still receives text,
 * because no peer in this build holds a tool that decodes a state payload — and
 * the negotiation result says so explicitly instead of leaving a reader to
 * assume a vector path was taken.
 *
 * The seam is one function pair used by both execution paths. Foreground and
 * background therefore negotiate from the same declarations and meter into the
 * same log; a divergence between them would have to be introduced deliberately
 * rather than by one path drifting.
 */

export type DelegationIdentity = {
	/** The receiving agent, which is also the role whose capability is declared. */
	agent: string;
	attempt: number;
	/**
	 * Which child of this run is receiving. The node id and the envelope inbox are
	 * both derived from it, so the address the parent meters and the address the
	 * receiver reads from cannot disagree.
	 */
	childIndex: number | undefined;
	/** The builtin tools the child was granted; decides whether it can consume state. */
	childTools: readonly string[];
	receiverSessionId: string;
	requestId: string;
	runId: string;
	senderSessionId: string;
};

export type DelegationDeps = {
	log: MeteringLog;
	/** Reads shared memory as the child is authorised to, never as the parent. */
	service: MemoryService;
};

export type OpenDelegationInput = {
	/** Budget for the recalled memory section only; never applied to the task. */
	budgetBytes: number;
	contract: LaunchContract;
	deps?: DelegationDeps;
	identity: DelegationIdentity;
	/** The task text upstream would have sent, unchanged. */
	message: string;
	worktreeRoot: string;
};

export type CloseDelegationInput = {
	/** The failure, when there was one; classified rather than interpreted. */
	cause?: unknown;
	outcome: ReceiptOutcome;
	summary: string;
	usage: ModelUsage | null;
};

export type OpenDelegation = {
	close: (input: CloseDelegationInput) => Receipt;
	envelope: Envelope;
	handoff: HandoffContext;
	negotiation: NegotiationResult;
	/** The text to send: the original message plus whatever memory was recalled. */
	prompt: string;
	receiptPath: string;
};

export function meteringLogPath(contract: LaunchContract, runId: string): string {
	return path.join(contract.storageRoot, "metering", `${safeComponent(runId)}.jsonl`);
}

export function receiptPath(contract: LaunchContract, requestId: string): string {
	return path.join(contract.storageRoot, "receipts", `${safeComponent(requestId)}.json`);
}

/**
 * The live dependencies, built from the contract the child was launched with.
 * The scope is the child's, not the parent's: material the child may not read
 * must not be recalled on its behalf, or the handoff would widen its reach.
 */
export function createDelegationDeps(input: OpenDelegationInput): DelegationDeps {
	return {
		log: createMeteringLog(meteringLogPath(input.contract, input.identity.runId)),
		service: createMemoryService({
			provenance: {
				agent: input.identity.agent,
				attempt: input.identity.attempt,
				runId: input.identity.runId,
				sessionId: input.identity.receiverSessionId,
			},
			scope: {
				agent: input.identity.agent,
				namespaceId: input.contract.namespaceId,
				pathPrefixes: [...input.contract.scope.pathPrefixes],
				write: input.contract.scope.write,
			},
			storeRoot: input.contract.storageRoot,
			worktreeRoot: input.worktreeRoot,
		}),
	};
}

/**
 * A reported zero and an absent report are different facts. Upstream starts a
 * run with a zeroed usage record, so a child that never reported usage would
 * otherwise be indistinguishable from one that used nothing.
 */
export function modelUsageFrom(usage: { cacheRead: number; cacheWrite: number; cost: number; input: number; output: number; turns: number }): ModelUsage | null {
	if (usage.turns === 0 && usage.input === 0 && usage.output === 0) return null;
	return { cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost, input: usage.input, output: usage.output };
}

function candidatesFor(service: MemoryService, message: string): HandoffCandidate[] {
	const found = service.search({ query: message });
	return found.results.map((hit) => ({
		contentId: hit.contentId,
		memoryId: hit.memoryId,
		score: hit.score,
		sourceAgent: hit.sourceAgent,
		sourcePath: hit.sourcePath,
		summary: hit.summary,
		validity: hit.validity,
	}));
}

const MEMORY_SECTION_HEADER = "Shared memory recalled for this task (read-only unless you record a new finding):";

function promptWith(message: string, handoff: HandoffContext): string {
	if (handoff.text.length === 0) return message;
	return `${message}\n\n${MEMORY_SECTION_HEADER}\n${handoff.text}`;
}

/**
 * Negotiates, freezes, meters and returns the text to send. Returns null when
 * the receiver may not be given this task at all: a refusal leaves the launch
 * exactly as upstream would have run it rather than quietly degrading it.
 */
export function openDelegation(input: OpenDelegationInput): OpenDelegation | null {
	const { contract, identity } = input;
	const receiver = capabilityForAgent({ agent: identity.agent, childTools: identity.childTools, representationId: contract.representationId });
	const sender = hostCapability(contract.representationId);
	const negotiation = negotiate({
		action: "delegate",
		// A delegated task is text by construction; refusing it here would refuse
		// the delegation upstream is entitled to make.
		allowTextFallback: true,
		mode: contract.mode,
		receiver: receiver.declaration,
		receiverMayRead: contract.scope.pathPrefixes.length > 0,
		sender: sender.declaration,
	});
	if (negotiation.outcome === "refused") return null;

	const deps = input.deps ?? createDelegationDeps(input);
	const nodeId = nodeIdFor(identity.runId, identity.childIndex);
	const meterIdentity: MeteringIdentity = {
		agent: identity.agent,
		attempt: identity.attempt,
		mode: contract.mode,
		nodeId,
		runId: identity.runId,
		sessionId: identity.senderSessionId,
		snapshotId: null,
	};

	deps.log.record(meterIdentity, { kind: "task-span", phase: "start", taskId: identity.requestId });

	const candidates = candidatesFor(deps.service, input.message);
	deps.log.record(meterIdentity, {
		authorisedValidHits: candidates.filter((candidate) => candidate.validity === "current").length,
		kind: "memory-query",
		queryId: identity.requestId,
	});
	const handoff = prepareHandoffContext({
		budgetBytes: input.budgetBytes,
		candidates,
		mode: contract.mode,
		readBody: (memoryId) => deps.service.get({ memoryId }).text,
	});
	const injected = new Map(candidates.map((candidate) => [candidate.memoryId, candidate.sourceAgent]));
	for (const memoryId of handoff.refs) {
		// Reuse is recorded for what was actually handed over, not for what was
		// found: a candidate the budget dropped was never reused.
		deps.log.record(meterIdentity, { kind: "memory-reuse", memoryId, sourceAgent: injected.get(memoryId) ?? identity.agent });
	}

	const snapshot = freezeSnapshot({
		capabilityId: negotiation.capabilityId,
		corpusSnapshotId: contract.corpusSnapshotId,
		memoryRefs: handoff.refs,
		namespaceId: contract.namespaceId,
		permissionProjection: { pathPrefixes: contract.scope.pathPrefixes, write: contract.scope.write },
		representationId: contract.representationId,
	});
	const envelope = buildEnvelope({
		action: "delegate",
		attempt: identity.attempt,
		inputParams: { agent: identity.agent, memoryRefs: [...handoff.refs], task: input.message },
		nodeId,
		ownerRunId: identity.runId,
		receiverSessionId: identity.receiverSessionId,
		requestId: identity.requestId,
		runId: identity.runId,
		senderSessionId: identity.senderSessionId,
		snapshot,
	});
	// The envelope is published before the delivery is metered, so a logged
	// delivery never claims an envelope the receiver could not find. A failure to
	// publish is degraded rather than fatal: the receiver treats an absent
	// envelope as upstream's own delegation, which is what it would have run.
	try {
		publishEnvelope(contract.storageRoot, identity.runId, identity.childIndex, envelope);
	} catch (error) {
		console.warn(`[pi-subagents] synapse: envelope delivery skipped for ${identity.agent}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const prompt = promptWith(input.message, handoff);
	const boundIdentity: MeteringIdentity = { ...meterIdentity, snapshotId: snapshot.snapshotId };
	deps.log.record(boundIdentity, {
		envelopeBytes: envelope.envelopeBytes,
		kind: "message-delivered",
		messageId: identity.requestId,
		// What the child is actually charged for reading, memory section included.
		textBytes: Buffer.byteLength(prompt, "utf-8"),
	});

	const target = receiptPath(contract, identity.requestId);
	return {
		close(closeInput: CloseDelegationInput): Receipt {
			// The child received the task whether or not its run succeeded; the
			// failure is recorded separately rather than by denying the delivery.
			deps.log.record(boundIdentity, { kind: "message-received", messageId: identity.requestId });
			if (closeInput.outcome !== "completed") {
				deps.log.record(boundIdentity, {
					// A cancelled run is cancelled whatever the host phrased the stop as:
					// the terminal state is the fact, and the message is only a hint.
					category: closeInput.outcome === "cancelled" ? "cancelled" : classifySynapseError(closeInput.cause),
					kind: "message-failed",
					messageId: identity.requestId,
				});
			}
			deps.log.record(boundIdentity, { kind: "model-usage", role: "child", usage: closeInput.usage });
			deps.log.record(boundIdentity, { kind: "task-span", phase: "end", taskId: identity.requestId });
			const receipt = buildReceipt({
				memoryRefs: handoff.refs,
				meteringRef: deps.log.path,
				outcome: closeInput.outcome,
				// This build publishes no output object, so there is nothing to verify
				// and nothing to reference; claiming otherwise is the one thing a
				// receipt must never do.
				outputRef: null,
				persistence: "skipped",
				snapshotId: snapshot.snapshotId,
				summary: closeInput.summary,
			});
			writeAtomicJson(target, { ...receipt, requestId: identity.requestId });
			return receipt;
		},
		envelope,
		handoff,
		negotiation,
		prompt,
		receiptPath: target,
	};
}
