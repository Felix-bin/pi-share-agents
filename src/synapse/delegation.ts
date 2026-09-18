import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../shared/atomic-json.ts";
import { negotiate, type CapabilityDeclaration, type NegotiationResult, type TextFallbackReason } from "./capability.ts";
import { createContentStore } from "./content-store.ts";
import { type Embedder, SYNAPSE_VECTOR_MEDIA_TYPE } from "./embedding.ts";
import { buildEnvelope, freezeSnapshot, type Envelope, type StateRef } from "./envelope.ts";
import { classifySynapseError, type SynapseErrorClassification } from "./errors.ts";
import { buildReceipt, prepareHandoffContext, type HandoffCandidate, type HandoffContext, type Receipt, type ReceiptOutcome } from "./handoff.ts";
import type { LaunchContract } from "./lifecycle.ts";
import { createMemoryService, type MemoryService, type SearchResult } from "./memory-service.ts";
import { createMeteringLog, type MeteringIdentity, type MeteringLog, type ModelUsage } from "./metering.ts";
import { capabilityForAgent, hostCapability, SYNAPSE_CONSUMER_VERSION } from "./roles.ts";
import type { StateRetrievalResult } from "./state-retrieval.ts";

/**
 * The delegation seam: where a task actually leaves the parent for a child.
 *
 * Everything the protocol modules describe converges here. Capabilities are
 * negotiated before the task is sent, the snapshot is frozen around whatever
 * memory the child is allowed to see, the envelope binds that decision to this
 * request, and the meter records what crossed. The child in this seam still
 * receives text: a vector handoff needs the retrieve action wired end to end
 * (the sender embedding, the envelope carrying a stateRef, the receiver
 * consuming it against the pinned corpus), which is the P3-5 card — and the
 * negotiation result already names the reason rather than leaving a reader to
 * assume a vector path was taken.
 *
 * The seam is one function pair used by both execution paths. Foreground and
 * background therefore negotiate from the same declarations and meter into the
 * same log; a divergence between them would have to be introduced deliberately
 * rather than by one path drifting.
 */

/** Keeps a run or request id usable as a single path component. */
function safeComponent(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
	return cleaned.length > 0 ? cleaned : "unattributed";
}

export type DelegationIdentity = {
	/** The receiving agent, which is also the role whose capability is declared. */
	agent: string;
	attempt: number;
	/** The builtin tools the child was granted; decides whether it can consume state. */
	childTools: readonly string[];
	nodeId: string;
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
			// The pinned corpus travels with the contract, so the delegated child's
			// service can consume a state the envelope carries ("unset" keeps the
			// state plane off, matching what the child was launched with).
			corpusSnapshotId: input.contract.corpusSnapshotId === "unset" ? null : input.contract.corpusSnapshotId,
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
	// A query search types as the memory ranking, so the state shape cannot
	// appear on this path; the input decides the output shape.
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

const CONTENT_ID_PATTERN = /^[0-9a-f]{64}$/;

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
	const meterIdentity: MeteringIdentity = {
		agent: identity.agent,
		attempt: identity.attempt,
		mode: contract.mode,
		nodeId: identity.nodeId,
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
		contextRefs: handoff.refs,
		corpusSnapshotId: contract.corpusSnapshotId,
		namespaceId: contract.namespaceId,
		permissionProjection: { pathPrefixes: contract.scope.pathPrefixes, write: contract.scope.write },
		representationId: contract.representationId,
	});
	const envelope = buildEnvelope({
		action: "delegate",
		attempt: identity.attempt,
		inputParams: { agent: identity.agent, memoryRefs: [...handoff.refs], task: input.message },
		nodeId: identity.nodeId,
		ownerRunId: identity.runId,
		receiverSessionId: identity.receiverSessionId,
		requestId: identity.requestId,
		runId: identity.runId,
		senderSessionId: identity.senderSessionId,
		snapshot,
	});
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

/**
 * ---- P3-5: the retrieve action over the state plane ----
 *
 * A retrieve delegation is the one place a non-text payload may cross: the
 * sender embeds the query, publishes the vector bytes to the CAS and names
 * them in the envelope's stateRef; the receiver decodes exactly those bytes
 * and ranks the pinned corpus with them (P3-4). Every step is metered
 * separately, because only a consume proves the state was used.
 */

/** Who is sending the retrieve request; the child tools decide the negotiation. */
export type SendIdentity = DelegationIdentity;

/** Who is consuming on the receiving side; bound to the envelope's own names. */
export type ConsumeIdentity = {
	agent: string;
	attempt: number;
	nodeId: string;
	runId: string;
	sessionId: string;
};

export type SendDeps = { log: MeteringLog };

export type OpenRetrieveInput = {
	contract: LaunchContract;
	deps?: SendDeps;
	/** The sender's embedding provider; must share the contract's representation. */
	embedder: Embedder;
	identity: SendIdentity;
	k: number;
	/** The query text to embed — it also travels in the envelope for text fallback. */
	query: string;
	worktreeRoot: string;
};

export type RetrieveSendResult =
	| { envelope: Envelope; kind: "state"; stateRef: StateRef }
	| { envelope: Envelope; kind: "text"; reason: TextFallbackReason };

export type ConsumeDeps = {
	/**
	 * Present only when a text fallback may re-embed the original query here.
	 * When `service` is injected instead of built, the caller guarantees that
	 * service's own embedder matches this one — the fallback gate checks this
	 * field, the fallback itself runs inside the service.
	 */
	embedder?: Embedder;
	log: MeteringLog;
	/** The sender's one permitted re-send of the original object bytes; null = cannot. */
	resend?: () => Uint8Array | null;
	service?: MemoryService;
};

export type ConsumeInput = {
	contract: LaunchContract;
	deps: ConsumeDeps;
	envelope: Envelope;
	/** The original query, held by the host as controlled recovery material (spec §8.2). */
	fallbackQuery?: string;
	identity: ConsumeIdentity;
	k: number;
	stateRecovery?: "resend" | "resend-then-text";
	worktreeRoot: string;
};

export type ConsumeOutcome =
	| { kind: "consumed"; result: StateRetrievalResult }
	| { kind: "text-fallback"; result: SearchResult }
	| { category: SynapseErrorClassification; kind: "failed"; reason: string }
	| { category: SynapseErrorClassification; kind: "refused"; reason: string };

/**
 * A unit vector of the input. A zero vector cannot carry a direction at all,
 * and neither can a non-finite one; hypot is used for the same reason the
 * embedder itself uses it — a naive sum of squares can overflow to infinity
 * before the sqrt.
 */
function unitVectorOf(vector: Float32Array, label: string): Float32Array {
	for (const value of vector) {
		if (!Number.isFinite(value)) {
			throw new Error(`integrity: ${label} embedded to a non-finite value; refusing to publish it`);
		}
	}
	const norm = Math.hypot(...vector);
	if (norm === 0) throw new Error(`integrity: ${label} embedded to a zero vector; cosine is undefined`);
	const unit = new Float32Array(vector.length);
	for (let index = 0; index < vector.length; index += 1) unit[index] = vector[index]! / norm;
	return unit;
}

function littleEndianBytes(vector: Float32Array): Uint8Array {
	const buffer = Buffer.alloc(vector.length * 4);
	for (const [index, value] of vector.entries()) buffer.writeFloatLE(value, index * 4);
	return new Uint8Array(buffer);
}

/**
 * Embeds the query, publishes the vector bytes to the CAS and returns the
 * retrieve envelope carrying the stateRef. A negotiation that cannot take the
 * vector path returns the text envelope with its reason instead — and never a
 * state event, so a text handoff cannot be misread as a degraded state
 * attempt.
 */
export async function openRetrieveDelegation(input: OpenRetrieveInput): Promise<RetrieveSendResult | null> {
	const { contract, identity } = input;
	// The host both asks and answers retrieval, but only the receiver needs the
	// consuming tool; declaring float32 on the sender side is what lets the pair
	// leave text at all.
	const sender: CapabilityDeclaration = {
		actions: ["delegate", "retrieve"],
		agent: "parent",
		consumesState: false,
		consumerVersion: SYNAPSE_CONSUMER_VERSION,
		encodings: ["text", "float32-vector"],
		representationId: contract.representationId,
	};
	const receiver = capabilityForAgent({ agent: identity.agent, childTools: identity.childTools, representationId: contract.representationId });
	const negotiation = negotiate({
		action: "retrieve",
		allowTextFallback: true,
		mode: contract.mode,
		receiver: receiver.declaration,
		receiverMayRead: contract.scope.pathPrefixes.length > 0,
		sender,
	});
	if (negotiation.outcome === "refused") return null;
	const deps = input.deps ?? { log: createMeteringLog(meteringLogPath(contract, identity.runId)) };
	const meterIdentity: MeteringIdentity = {
		agent: identity.agent,
		attempt: identity.attempt,
		mode: contract.mode,
		nodeId: identity.nodeId,
		runId: identity.runId,
		sessionId: identity.senderSessionId,
		snapshotId: null,
	};
	const snapshot = freezeSnapshot({
		capabilityId: negotiation.capabilityId,
		contextRefs: [],
		corpusSnapshotId: contract.corpusSnapshotId,
		namespaceId: contract.namespaceId,
		permissionProjection: { pathPrefixes: contract.scope.pathPrefixes, write: contract.scope.write },
		representationId: contract.representationId,
	});
	const envelopeOf = (stateRef?: StateRef) =>
		buildEnvelope({
			action: "retrieve",
			attempt: identity.attempt,
			inputParams: { k: input.k, query: input.query },
			nodeId: identity.nodeId,
			ownerRunId: identity.runId,
			receiverSessionId: identity.receiverSessionId,
			requestId: identity.requestId,
			runId: identity.runId,
			senderSessionId: identity.senderSessionId,
			snapshot,
			stateRef,
		});
	if (negotiation.outcome === "text") {
		const envelope = envelopeOf();
		// A text fallback is a delivery like any other: its envelope bytes and
		// its query text count, so a calibration comparing text and vector paths
		// is not skewed by an unmetered baseline (P4 group review X-2).
		deps.log.record({ ...meterIdentity, snapshotId: snapshot.snapshotId }, {
			envelopeBytes: envelope.envelopeBytes,
			kind: "message-delivered",
			messageId: identity.requestId,
			textBytes: Buffer.byteLength(input.query, "utf-8"),
		});
		return { envelope, kind: "text", reason: negotiation.reason };
	}

	if (input.embedder.representationId !== contract.representationId) {
		throw new Error(
			`representation-mismatch: the sender's embedder is ${input.embedder.representationId}, the contract pins ${contract.representationId}; refusing to publish a state no corpus can rank`,
		);
	}
	// A contract without a pinned corpus cannot have a consumer that ranks
	// anything; refusing here, before the embedding call is spent, is the same
	// guard the receiving service applies (createDelegationDeps maps "unset" to
	// null for exactly this reason).
	if (contract.corpusSnapshotId === "unset") {
		throw new Error("synapse.corpusSnapshotId is not configured; a retrieve delegation cannot publish a state no corpus can rank");
	}
	if (!Number.isInteger(input.k) || input.k < 1) {
		throw new Error(`k-out-of-range: ${input.k} is not an integer >= 1`);
	}
	// The provider normalises on its side; normalising again is idempotent and
	// keeps the invariant true for any embedder, per spec §8.1.
	const embedded = await input.embedder.embedQuery(input.query);
	const vector = unitVectorOf(embedded.vector, "the retrieve query");
	const payload = littleEndianBytes(vector);
	// The store is content-addressed, so the object id is the sha-256 of exactly
	// the bytes that were sent — the digest the envelope then claims (spec §8.1).
	const store = createContentStore(contract.storageRoot);
	const payloadId = store.put(payload, SYNAPSE_VECTOR_MEDIA_TYPE);
	// The state payload is storage traffic like any other object: its bytes
	// belong in storage.writeBytes so a calibration's storage-cost column is
	// not quietly missing the vector payloads (P4 group review X-5).
	deps.log.record(meterIdentity, { bytes: payload.byteLength, direction: "write", kind: "object-io" });
	const stateRef: StateRef = {
		baseMemoryId: null,
		byteLength: payload.byteLength,
		dim: vector.length,
		encoding: "float32-vector",
		payloadId,
		representationId: input.embedder.representationId,
		sha256: payloadId,
	};
	deps.log.record(meterIdentity, { kind: "state-prepare", ok: true, payloadBytes: payload.byteLength, representationId: stateRef.representationId, stateId: payloadId });
	const envelope = envelopeOf(stateRef);
	deps.log.record({ ...meterIdentity, snapshotId: snapshot.snapshotId }, {
		kind: "state-send",
		ok: true,
		payloadBytes: payload.byteLength,
		representationId: stateRef.representationId,
		stateId: payloadId,
	});
	// The envelope is control traffic like any other: its bytes count even when
	// the payload carries no text at all (spec §10.1 control/metadata row).
	deps.log.record({ ...meterIdentity, snapshotId: snapshot.snapshotId }, {
		envelopeBytes: envelope.envelopeBytes,
		kind: "message-delivered",
		messageId: identity.requestId,
		textBytes: 0,
	});
	return { envelope, kind: "state", stateRef };
}

/**
 * Consumes a received retrieve envelope on the state plane: identity-bound to
 * the envelope's own run and session, verified against the pinned corpus, and
 * recovered per spec §8.2 — object problems are re-sent at most once, a failed
 * recovery may fall back to text at most once when configured, and
 * representation or permission failures never recover at all.
 */
export async function consumeRetrieveState(input: ConsumeInput): Promise<ConsumeOutcome> {
	const wire = input.envelope.wire;
	// The metering identity exists before any check so a refusal can still leave
	// its trace: an append-only log is the only audit surface a rejected envelope
	// will ever have, and a permission or configuration refusal is exactly the
	// event an auditor must be able to see.
	const meterIdentity: MeteringIdentity = {
		agent: input.identity.agent,
		attempt: input.identity.attempt,
		mode: input.contract.mode,
		nodeId: input.identity.nodeId,
		runId: input.identity.runId,
		sessionId: input.identity.sessionId,
		snapshotId: wire.snapshotId,
	};
	const refuse = (category: SynapseErrorClassification, reason: string): ConsumeOutcome => {
		input.deps.log.record(meterIdentity, { category, detail: reason, kind: "error" });
		return { category, kind: "refused", reason };
	};
	if (wire.runId !== input.identity.runId || wire.receiverSessionId !== input.identity.sessionId) {
		return refuse(
			"permission",
			`not-authorised: envelope names run ${wire.runId} for session ${wire.receiverSessionId}, the consumer is ${input.identity.runId}/${input.identity.sessionId}`,
		);
	}
	const stateRef = wire.stateRef;
	if (stateRef === null) {
		return refuse("configuration", "envelope carries no stateRef: a text handoff is not consumed on the state plane");
	}
	if (wire.corpusSnapshotId !== input.contract.corpusSnapshotId) {
		return refuse(
			"configuration",
			`namespace-mismatch: envelope corpus ${wire.corpusSnapshotId} is not the pinned ${input.contract.corpusSnapshotId}`,
		);
	}
	// A malformed id would throw out of the store's own guard below the contract
	// level; checking the shape here keeps every failure inside the outcome type.
	if (!CONTENT_ID_PATTERN.test(stateRef.payloadId) || !CONTENT_ID_PATTERN.test(stateRef.sha256)) {
		return refuse("integrity", `integrity: stateRef names ids that are not content ids (payload ${JSON.stringify(stateRef.payloadId.slice(0, 8))}…)`);
	}
	// The contract is what this session was launched with; a stateRef claiming a
	// representation the contract does not pin is a forged or stale envelope.
	if (stateRef.representationId !== input.contract.representationId) {
		return refuse(
			"representation",
			`representation-mismatch: stateRef claims ${stateRef.representationId}, the contract pins ${input.contract.representationId}`,
		);
	}
	const service =
		input.deps.service ??
		createMemoryService({
			corpusSnapshotId: input.contract.corpusSnapshotId === "unset" ? null : input.contract.corpusSnapshotId,
			// The fallback embedder is the receiver's own provider (spec §8.2: the
			// receiver re-embeds); the metering pair keeps state-consume and
			// object-io on the same log as the receive and send events above.
			embedder: input.deps.embedder,
			metering: { identity: meterIdentity, log: input.deps.log },
			provenance: { agent: input.identity.agent, attempt: input.identity.attempt, runId: input.identity.runId, sessionId: input.identity.sessionId },
			scope: {
				agent: input.identity.agent,
				namespaceId: input.contract.namespaceId,
				pathPrefixes: [...input.contract.scope.pathPrefixes],
				write: input.contract.scope.write,
			},
			storeRoot: input.contract.storageRoot,
			worktreeRoot: input.worktreeRoot,
		});
	const store = createContentStore(input.contract.storageRoot);
	// The envelope arrived for this consumer; like the delegate seam, receipt is
	// recorded before any payload verdict so the delivery itself is countable.
	input.deps.log.record(meterIdentity, { kind: "message-received", messageId: wire.requestId });
	// Receipt on the state plane is the payload being addressable; a missing
	// object is a recovery input, not a delivery failure.
	input.deps.log.record(meterIdentity, {
		kind: "state-receive",
		ok: store.has(stateRef.payloadId),
		payloadBytes: stateRef.byteLength,
		representationId: stateRef.representationId,
		stateId: stateRef.payloadId,
	});

	type ConsumeAttempt = { kind: "ok"; result: StateRetrievalResult } | { category: SynapseErrorClassification; kind: "error"; reason: string };
	const attemptConsume = (): ConsumeAttempt => {
		try {
			return { kind: "ok", result: service.search({ k: input.k, stateId: stateRef.payloadId, stateRef }) };
		} catch (error) {
			return { category: classifySynapseError(error), kind: "error", reason: error instanceof Error ? error.message : String(error) };
		}
	};
	const first = attemptConsume();
	if (first.kind === "ok") return { kind: "consumed", result: first.result };

	// Only object-class problems recover: the bytes may have been lost in
	// transit while the sender still holds the verified original. A
	// representation or permission failure says the peers disagree on meaning,
	// and re-sending cannot change that.
	if (first.category === "object-unavailable" || first.category === "integrity") {
		let afterResend: ConsumeAttempt = first;
		if (input.deps.resend !== undefined) {
			const bytes = input.deps.resend();
			if (bytes !== null) {
				// The re-sent bytes are caller-supplied; a store that rejects them
				// (oversized, or colliding with an object stored under another media
				// type) is a failed recovery, not an exception through the seam.
				let resendFailed: ConsumeAttempt | null = null;
				try {
					// A corrupted object that still matches its file name would make
					// the store's put a no-op and the retry fail again: a body that
					// no longer hashes to its id is removed first (its metadata is
					// rewritten by the put below), so the re-sent verified copy
					// actually lands (P4 group review X-1).
					if (store.has(stateRef.payloadId)) {
						try {
							store.read(stateRef.payloadId);
						} catch {
							fs.rmSync(store.objectPath(stateRef.payloadId), { force: true });
						}
					}
					// A re-send is a delivery in its own right and is metered as one;
					// the content-addressed store makes re-publishing the same bytes a no-op.
					const resentId = store.put(bytes, SYNAPSE_VECTOR_MEDIA_TYPE);
					input.deps.log.record(meterIdentity, { bytes: bytes.byteLength, direction: "write", kind: "object-io" });
					input.deps.log.record({ ...meterIdentity, attempt: meterIdentity.attempt + 1 }, {
						kind: "state-send",
						ok: true,
						payloadBytes: bytes.byteLength,
						representationId: stateRef.representationId,
						stateId: resentId,
					});
				} catch (error) {
					resendFailed = { category: classifySynapseError(error), kind: "error", reason: error instanceof Error ? error.message : String(error) };
				}
				afterResend = resendFailed ?? attemptConsume();
				if (afterResend.kind === "ok") return { kind: "consumed", result: afterResend.result };
			}
		}
		if ((input.stateRecovery ?? "resend") === "resend-then-text" && input.deps.embedder !== undefined && input.fallbackQuery !== undefined && input.fallbackQuery !== "") {
			// Text fallback is an ordinary text retrieval done over again here,
			// metered as such — never recorded as an integrity failure (spec §8.2).
			// A fallback that itself fails is a terminal failure of the recovery,
			// never an exception through the seam.
			try {
				const result = await service.searchSemantic({ k: input.k, query: input.fallbackQuery });
				return { kind: "text-fallback", result };
			} catch (error) {
				const fallbackFailure = { category: classifySynapseError(error), kind: "error" as const, reason: error instanceof Error ? error.message : String(error) };
				input.deps.log.record(meterIdentity, { category: fallbackFailure.category, detail: fallbackFailure.reason, kind: "error" });
				return { category: fallbackFailure.category, kind: "failed", reason: fallbackFailure.reason };
			}
		}
		// A terminal failure is an auditable event in its own right, recorded as
		// an error with its category rather than only as a missing consume.
		input.deps.log.record(meterIdentity, { category: afterResend.category, detail: afterResend.reason, kind: "error" });
		return { category: afterResend.category, kind: "failed", reason: afterResend.reason };
	}
	input.deps.log.record(meterIdentity, { category: first.category, detail: first.reason, kind: "error" });
	return { category: first.category, kind: "failed", reason: first.reason };
}
