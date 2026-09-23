import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../shared/atomic-json.ts";
import { negotiate, type CapabilityDeclaration, type NegotiationResult, type TextFallbackReason } from "./capability.ts";
import { SYNAPSE_STATE_VERIFY_MIN_COSINE, type SynapseMode } from "./config.ts";
import { createContentStore } from "./content-store.ts";
import { meteredEmbedder, type Embedder, SYNAPSE_VECTOR_MEDIA_TYPE } from "./embedding.ts";
import { buildEnvelope, envelopeQueryText, freezeSnapshot, type Envelope, type EnvelopeWire, type StateRef } from "./envelope.ts";
import { selectEnvelopeRoute, verifiedTransportByteCount } from "./envelope-gear.ts";
import { clearStateEnvelope, nodeIdFor, publishEnvelope, publishStateEnvelope, safeComponent } from "./envelope-inbox.ts";
import { publishEnvelopeViaUds, type UdsClientTransport } from "./envelope-uds.ts";
import { classifySynapseError, type SynapseErrorClassification } from "./errors.ts";
import { buildReceipt, MEMORY_SECTION_HEADER, prepareHandoffContext, type HandoffCandidate, type HandoffContext, type Receipt, type ReceiptOutcome } from "./handoff.ts";
import type { LaunchContract } from "./lifecycle.ts";
import { createMemoryService, SYNAPSE_MAX_SEARCH_K, type MemoryService, type SearchResult } from "./memory-service.ts";
import { createMeteringLog, recordProcessIdentity, recordTransportBytes, type MeteringIdentity, type MeteringLog, type ModelUsage } from "./metering.ts";
import { capabilityForAgent, hostCapability, SYNAPSE_CONSUMER_VERSION } from "./roles.ts";
import type { PredictedBase } from "./predict-base.ts";
import { chooseStatePayload, SYNAPSE_DELTA_MEDIA_TYPE } from "./state-payload.ts";
import { cosineSimilarity } from "./state-retrieval.ts";
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
	/**
	 * The AF_UNIX client the `uds` gear sends through. Left unset in production,
	 * where `publishEnvelopeViaUds` builds the real `node:net` one; supplied by
	 * tests, which cannot bind a socket in this repository's sandbox.
	 */
	udsClient?: UdsClientTransport;
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
	/**
	 * The `uds` gear's send, still in flight. Absent on the `file` gear, whose
	 * publish already finished synchronously inside `openDelegation` — which is
	 * why a caller writes `if (delegation.envelopeDelivery) await …` rather than
	 * awaiting unconditionally: the default path must not acquire so much as a
	 * microtask boundary it did not have before.
	 *
	 * It never rejects. A failed socket delivery is warned and metered as a
	 * classified error inside; the caller's only interest is that the send has
	 * finished before the child is prompted, so that a delivery either arrived
	 * or is on the record as having failed, never silently in flight.
	 */
	envelopeDelivery?: Promise<void>;
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
	const log = createMeteringLog(meteringLogPath(input.contract, input.identity.runId));
	// Binds this OS process to the run identity for a future kernel-side
	// collector. Called on whichever side opens delegation, so the same
	// delegation can eventually produce one such event per process. On a
	// platform without /proc this simply records nothing and never throws.
	recordProcessIdentity(log, {
		agent: input.identity.agent,
		attempt: input.identity.attempt,
		mode: input.contract.mode,
		nodeId: nodeIdFor(input.identity.runId, input.identity.childIndex),
		runId: input.identity.runId,
		sessionId: input.identity.senderSessionId,
		snapshotId: null,
	});
	return {
		log,
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

const CONTENT_ID_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The task as the child receives it.
 *
 * Under `text` the recalled memory travels inside the prompt, which is what the
 * baseline costs and is left exactly as it was. Under `synapse` it does not:
 * the envelope carries the handles and the child redeems the bodies from the
 * shared store itself (design §4.2). Leaving the section here as well would
 * send every body over the wire *and* read it again on the other side, which is
 * the one outcome worse than either gear alone — and it would make the byte
 * saving this whole plane exists for unmeasurable, because `textBytes` would
 * still carry it.
 *
 * `handoff.text` is still built under `synapse`, and still discarded here. It
 * is not waste: the budget is applied to those lines, so which handles are
 * handed over stays decided the same way it always was. Only where the bodies
 * are read changes.
 */
function promptWith(message: string, handoff: HandoffContext, mode: SynapseMode): string {
	if (mode === "synapse") return message;
	if (handoff.text.length === 0) return message;
	return `${message}\n\n${MEMORY_SECTION_HEADER}\n${handoff.text}`;
}

type UdsDeliveryInput = {
	agent: string;
	deps: DelegationDeps;
	endpointPath: string;
	envelope: Envelope;
	identity: MeteringIdentity;
};

/**
 * The `uds` gear's send, and the one call site of `recordTransportBytes`.
 *
 * `metering.ts` defined that counter without a caller because this dispatch is
 * where the number is born: `publishEnvelopeViaUds` has already rejected a
 * short write, so `bytesWritten` is the frame that really left the process,
 * and `verifiedTransportByteCount` rejects a count that could not be one at
 * all before it can reach the meter.
 *
 * Failure is recorded as a classified error and nothing else. Spec §5 forbids
 * a failed delivery being written down as "delivered but empty", and the
 * concrete form that would take here is a `transport-bytes` event carrying
 * zero: `control.transportBytes` distinguishes `"N/A"` from `0` precisely so
 * that a socket gear which moved nothing cannot be read as a gear which was
 * never used. So a failed send records no byte count whatsoever.
 *
 * Never rejects: a transport failure degrades the envelope exactly as a failed
 * `file` publish does, leaving the child to run the task upstream sent.
 */
function deliverEnvelopeViaUds(input: UdsDeliveryInput): Promise<void> {
	const { deps, endpointPath, identity } = input;
	const degrade = (error: unknown): void => {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-subagents] synapse: envelope delivery skipped for ${input.agent}: ${detail}`);
		try {
			deps.log.record(identity, { category: classifySynapseError(error), detail, kind: "error" });
		} catch (recordError) {
			// The "never rejects" promise above has to hold even when the meter is
			// the thing that broke. Both host call sites await this before prompting,
			// inside the try whose catch fails the run: a log write that throws here
			// would cost the user their run, which is precisely what the `file` gear
			// refuses to do (see synapse-delegation.ts's header — a metering failure
			// must not be fatal). Warned and dropped, exactly as an unopenable meter
			// already is upstream.
			console.warn(`[pi-subagents] synapse: envelope delivery failure could not be metered for ${input.agent}: ${recordError instanceof Error ? recordError.message : String(recordError)}`);
		}
	};
	const send = deps.udsClient === undefined
		? publishEnvelopeViaUds(endpointPath, input.envelope)
		: publishEnvelopeViaUds(endpointPath, input.envelope, deps.udsClient);
	return send.then((result) => {
		// The count check is inside the same guarded region as the send: a byte
		// count that cannot be one is a failed delivery for metering purposes,
		// and must degrade the same way rather than escape as a rejection the
		// caller is documented not to have to handle.
		try {
			recordTransportBytes(deps.log, identity, verifiedTransportByteCount(result.bytesWritten, endpointPath));
		} catch (error) {
			degrade(error);
		}
	}, degrade);
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
	const boundIdentity: MeteringIdentity = { ...meterIdentity, snapshotId: snapshot.snapshotId };
	// The envelope is published before the delivery is metered, so a logged
	// delivery never claims an envelope the receiver could not find. A failure to
	// publish is degraded rather than fatal: the receiver treats an absent
	// envelope as upstream's own delegation, which is what it would have run.
	//
	// Which gear publishes it is decided by `selectEnvelopeRoute`, a pure
	// function of the contract — the effectful half stays here, one branch per
	// gear. The `file` branch is the original call, unchanged and synchronous,
	// inside the original try/catch: the default path performs exactly the I/O
	// it always did, in the same order, and reaches no socket code at all.
	let envelopeDelivery: Promise<void> | undefined;
	try {
		const route = selectEnvelopeRoute({
			childIndex: identity.childIndex,
			deliveryGear: contract.deliveryGear,
			runId: identity.runId,
			storageRoot: contract.storageRoot,
		});
		if (route.gear === "file") publishEnvelope(contract.storageRoot, identity.runId, identity.childIndex, envelope);
		else envelopeDelivery = deliverEnvelopeViaUds({ deps, endpointPath: route.address, envelope, identity: boundIdentity, agent: identity.agent });
	} catch (error) {
		console.warn(`[pi-subagents] synapse: envelope delivery skipped for ${identity.agent}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const prompt = promptWith(input.message, handoff, contract.mode);
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
		// Present only on the `uds` gear, so a `file` caller's `if` is false and
		// its control flow is what it always was.
		...(envelopeDelivery === undefined ? {} : { envelopeDelivery }),
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
	/**
	 * Which child of the run is consuming. The node id is derived from it, the
	 * same way the sending side derives it, so a meter entry written on either
	 * side addresses the same node.
	 */
	childIndex: number | undefined;
	runId: string;
	/**
	 * Metering and provenance only — never an admission input. This side
	 * resolves its own session identity from the session file path when one
	 * exists, while the sender records the id of the host's child session
	 * object, so the two strings are not reliably equal and comparing them
	 * would refuse correct runs (P4-4b，两路 K3 独立裁决一致：convergent on C).
	 *
	 * Admission binds only facts both sides derive for themselves: the run id,
	 * the node id recomputed from the run and child index, and — when the
	 * consumer knows it — the sender session id it was launched under. See
	 * {@link ConsumeInput.expectedSenderSessionId}.
	 */
	sessionId: string;
};

export type SendDeps = {
	log: MeteringLog;
	/**
	 * The sender's base-selection seam: given the query, name the memory whose
	 * vector a residual may be computed against, or null when none is usable.
	 *
	 * Injected rather than built here because the base comes from the sender's own
	 * memory store and its frozen semantic weighting — the same ranking the
	 * retrieval path reports (P4-3). Absent means no base exists, which is the
	 * `no-base` reason for sending a full vector rather than a failure.
	 */
	predictedBase?: (query: { text: string }) => Promise<PredictedBase | null>;
};

export type OpenRetrieveInput = {
	contract: LaunchContract;
	deps?: SendDeps;
	/** The sender's embedding provider; must share the contract's representation. */
	embedder: Embedder;
	identity: SendIdentity;
	k: number;
	/**
	 * The query text to embed — it also travels in the envelope for text fallback.
	 */
	query: string;
	/**
	 * Runs the receiver's declared runtime probe, when the caller wired one.
	 * Returned verdict feeds negotiation: a failed probe takes the text path
	 * with `probe-unverified` before an embedding call is spent on a payload no
	 * consume could rank, and the verdict leaves a `capability-probe` metering
	 * event whether it passed or failed. A receiver that declares probe items
	 * and a caller that wires nothing negotiates down to text — the claim is
	 * only trusted once something verified it. A probe that throws is treated
	 * as unverified rather than allowed to pierce the seam.
	 */
	receiverProbe?: () => boolean;
	worktreeRoot: string;
};

export type RetrieveSendResult =
	| { envelope: Envelope; kind: "state"; stateRef: StateRef }
	| { envelope: Envelope; kind: "text"; reason: TextFallbackReason };

/** A re-send that replaces the failed message rather than repeating it. */
export type ResendReplacement = {
	bytes: Uint8Array;
	/**
	 * The space the replacement is sent under. Its encoding is fixed to a full vector
	 * because that is what "replace an unrebuildable residual" means — a delta
	 * replacement would re-enter the same failure. The two id fields are not the
	 * caller's to state either: they are the digest of `bytes`, so the recovery fills
	 * them from what it actually stored and a replacement whose ids disagreed with its
	 * bytes cannot be expressed.
	 */
	stateRef: Omit<StateRef, "encoding" | "payloadId" | "sha256"> & { encoding: "float32-vector" };
};

export type ConsumeDeps = {
	/**
	 * Present only when a text fallback may re-embed the original query here.
	 * When `service` is injected instead of built, the caller guarantees that
	 * service's own embedder matches this one — the fallback gate checks this
	 * field, the fallback itself runs inside the service.
	 */
	embedder?: Embedder;
	log: MeteringLog;
	/**
	 * The sender's one permitted re-send; null = cannot.
	 *
	 * Plain bytes re-publish the same object, which recovers a payload lost or
	 * corrupted in transit. A replacement carries its own stateRef instead, which is
	 * the only way to recover a residual the receiver cannot rebuild: the base lives
	 * in the receiver's memory, so no re-send of the residual's own bytes can help,
	 * and the fallback AC-17 requires is a full vector.
	 */
	resend?: () => Uint8Array | ResendReplacement | null;
	service?: MemoryService;
};

export type ConsumeInput = {
	contract: LaunchContract;
	deps: ConsumeDeps;
	/**
	 * The delivered wire form, which is what a receiver actually holds: it read
	 * the envelope from its inbox and the bytes it was sent are the file's, not
	 * a locally measured figure. The consumer reads nothing else from it, so a
	 * receiver built on a wire cannot fabricate fields it never had.
	 */
	envelope: EnvelopeWire;
	/**
	 * The session this consumer was launched by, when it knows which identity
	 * launched it. Present, the envelope must name it as its sender; absent, that
	 * half of the binding is not attempted rather than passed on a guess. The
	 * primary binding is unaffected either way: the run id and the node id
	 * recomputed from the run and child index hold regardless of what the
	 * consumer was told about its own session.
	 */
	expectedSenderSessionId?: string;
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

/**
 * The sender half of a retrieve negotiation. Exported because the `delta`
 * encoding is declarable but not otherwise observable: negotiation only ever
 * requires the common `float32-vector`, so without a named declaration a future
 * edit could drop `delta` from this list and every behavioural test would still
 * pass — while the capability the envelope advertises silently narrowed.
 */
export function retrieveSenderCapability(representationId: string): CapabilityDeclaration {
	// The host both asks and answers retrieval, but only the receiver needs the
	// consuming tool; declaring float32 on the sender side is what lets the pair
	// leave text at all.
	return {
		actions: ["delegate", "retrieve"],
		agent: "parent",
		consumesState: false,
		consumerVersion: SYNAPSE_CONSUMER_VERSION,
		// delta is declared as a supported encoding; whether one is actually sent is
		// decided per message by the rate-distortion choice below. Negotiation states
		// capability, the choice states the fact — folding the choice into negotiation
		// would make the capability table vary with the payload's numbers.
		encodings: ["text", "float32-vector", "delta"],
		representationId,
	};
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
	const sender = retrieveSenderCapability(contract.representationId);
	const receiver = capabilityForAgent({ agent: identity.agent, childTools: identity.childTools, representationId: contract.representationId });
	// The verifiable promise: a receiver that declared probe items is only
	// trusted once its probe ran. The verdict is the caller's to supply — this
	// seam never probes on its own. A probe that THROWS is an unverified promise
	// rather than a failed delegation: the environment-fact contract belongs to
	// the probe itself, and a throwing caller-supplied probe must degrade to the
	// text path here instead of piercing the seam. The consultation is timed so
	// the ledger can answer whether the probe's cost belongs on the state
	// budget's critical path; `wired` separates a failed probe from an unwired one.
	type ProbeConsultation = { durationMs: number; ok: boolean };
	const runReceiverProbe = (): ProbeConsultation => {
		const startedAt = Date.now();
		try {
			// The probe runs BEFORE the clock is read: an object literal evaluates its
			// properties in source order, and timing it in the literal measured the
			// moment before the probe instead of the probe (preregistration §16 —
			// 60/60 events read 0 in the v3 batch; a TTL hit legitimately reads ~0,
			// so only a correctly-timed real run can tell the two apart).
			const ok = input.receiverProbe?.() ?? false;
			return { durationMs: Date.now() - startedAt, ok };
		} catch {
			return { durationMs: Date.now() - startedAt, ok: false };
		}
	};
	const probeOutcome = receiver.declaration.probe !== undefined && receiver.declaration.probe.length > 0 ? runReceiverProbe() : undefined;
	const receiverProbeVerified = probeOutcome?.ok;
	const probeField = receiverProbeVerified === undefined ? {} : { receiverProbeVerified };
	const negotiation = negotiate({
		action: "retrieve",
		allowTextFallback: true,
		mode: contract.mode,
		receiver: receiver.declaration,
		...probeField,
		receiverMayRead: contract.scope.pathPrefixes.length > 0,
		sender,
	});
	if (negotiation.outcome === "refused") return null;
	const deps = input.deps ?? { log: createMeteringLog(meteringLogPath(contract, identity.runId)) };
	// The node id is derived from the run and child index rather than carried, so
	// the address this side meters and the inbox the receiver reads cannot drift.
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
	// The verifiable promise leaves its trace whether it passed or failed: a
	// round that degraded to text because of the probe must be answerable from
	// the ledger, including rounds whose verdict came from the TTL cache.
	if (probeOutcome !== undefined) {
		deps.log.record(meterIdentity, {
			durationMs: probeOutcome.durationMs,
			kind: "capability-probe",
			ok: probeOutcome.ok,
			wired: input.receiverProbe !== undefined,
		});
	}
	const snapshot = freezeSnapshot({
		capabilityId: negotiation.capabilityId,
		memoryRefs: [],
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
			nodeId,
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
		// A delivery that carries no state must not leave an earlier delivery's
		// state envelope behind: the receiver reads that path by name, so a stale
		// file would be consumed as though this message had published it.
		clearStateEnvelope(contract.storageRoot, identity.runId, identity.childIndex);
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

	// The caller built this embedder from configuration, so it carries no
	// identity and every call it makes would go unrecorded; the wrapper pairs it
	// with this seam's own identity and log, which is where the cost belongs.
	const embedder = meteredEmbedder(input.embedder, meterIdentity, deps.log);
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
	// The bound is the receiver's, taken from the same constant: a k this side
	// accepted but the receiver's parameter check refuses would be an envelope
	// that is sent, metered and never consumable.
	if (!Number.isInteger(input.k) || input.k < 1 || input.k > SYNAPSE_MAX_SEARCH_K) {
		throw new Error(`k-out-of-range: ${input.k} is not an integer in [1, ${SYNAPSE_MAX_SEARCH_K}]`);
	}
	// The provider normalises on its side; normalising again is idempotent and
	// keeps the invariant true for any embedder, per spec §8.1.
	const embedded = await embedder.embedQuery(input.query);
	const vector = unitVectorOf(embedded.vector, "the retrieve query");
	// Base selection runs against the sender's own memory, through the injected
	// seam; a null base is the normal cold-start answer and lands on the full-vector
	// branch with its reason recorded, not on an error path.
	const base = deps.predictedBase === undefined ? null : await deps.predictedBase({ text: input.query });
	// One function decides encoding and bytes together, so the payload this side
	// publishes is always the one the decoder expects for the encoding it names.
	const choice = chooseStatePayload({
		base,
		fullVector: vector,
		representationId: input.embedder.representationId,
	});
	const payload = choice.payload;
	// The store is content-addressed, so the object id is the sha-256 of exactly
	// the bytes that were sent — the digest the envelope then claims (spec §8.1).
	// The media type follows the encoding: a residual is not a float32 vector, and a
	// reader that sniffed it as one would decode plausible garbage.
	const store = createContentStore(contract.storageRoot);
	const payloadId = store.put(payload, choice.encoding === "delta" ? SYNAPSE_DELTA_MEDIA_TYPE : SYNAPSE_VECTOR_MEDIA_TYPE);
	// The state payload is storage traffic like any other object: its bytes
	// belong in storage.writeBytes so a calibration's storage-cost column is
	// not quietly missing the vector payloads (P4 group review X-5).
	deps.log.record(meterIdentity, { bytes: payload.byteLength, direction: "write", kind: "object-io" });
	const stateRef: StateRef = {
		baseMemoryId: choice.baseMemoryId,
		byteLength: payload.byteLength,
		// dim stays the full vector's width even for a residual: it is what the
		// receiver needs to rebuild, and the envelope validates the payload against it.
		dim: vector.length,
		encoding: choice.encoding,
		payloadId,
		representationId: embedder.representationId,
		sha256: payloadId,
	};
	// canonicalJson refuses a present-but-undefined value, so the reason key is
	// added rather than set to undefined: an absent reason and a null one would
	// both be wrong to write.
	const choiceFields = choice.reason === null ? { encoding: choice.encoding } : { encoding: choice.encoding, fallbackReason: choice.reason };
	deps.log.record(meterIdentity, {
		...choiceFields,
		kind: "state-prepare",
		ok: true,
		payloadBytes: payload.byteLength,
		representationId: stateRef.representationId,
		stateId: payloadId,
	});
	const envelope = envelopeOf(stateRef);
	// The envelope is published before the delivery is metered, so a logged
	// delivery never claims an envelope the receiver could not find — the same
	// order, and the same reason, as the delegation path above. It lands on the
	// state-plane sibling path; a failure to publish degrades rather than throws,
	// because an absent state envelope is not a failure to the receiver.
	let published = true;
	try {
		publishStateEnvelope(contract.storageRoot, identity.runId, identity.childIndex, envelope);
	} catch (error) {
		published = false;
		console.warn(`[pi-subagents] synapse: state envelope delivery skipped for ${identity.agent}: ${error instanceof Error ? error.message : String(error)}`);
	}
	// Bytes are what crossed the wire, so an envelope that never landed reports
	// zero of them. The aggregate counts bytes on every attempt because an
	// attempt that reached the wire still cost them — this one did not.
	deps.log.record({ ...meterIdentity, snapshotId: snapshot.snapshotId }, {
		...choiceFields,
		kind: "state-send",
		ok: published,
		payloadBytes: published ? payload.byteLength : 0,
		representationId: stateRef.representationId,
		stateId: payloadId,
	});
	if (!published) {
		// Nothing was delivered, so nothing is recorded as delivered: a
		// `message-delivered` row here would be the one entry a reconciliation
		// reads as "the receiver can find this".
		deps.log.record({ ...meterIdentity, snapshotId: snapshot.snapshotId }, {
			category: "object-unavailable",
			detail: "the state envelope could not be published",
			kind: "error",
		});
		return { envelope, kind: "state", stateRef };
	}
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
	const wire = input.envelope;
	// The metering identity exists before any check so a refusal can still leave
	// its trace: an append-only log is the only audit surface a rejected envelope
	// will ever have, and a permission or configuration refusal is exactly the
	// event an auditor must be able to see.
	const meterIdentity: MeteringIdentity = {
		agent: input.identity.agent,
		attempt: input.identity.attempt,
		mode: input.contract.mode,
		nodeId: nodeIdFor(input.identity.runId, input.identity.childIndex),
		runId: input.identity.runId,
		sessionId: input.identity.sessionId,
		snapshotId: wire.snapshotId,
	};
	const refuse = (category: SynapseErrorClassification, reason: string): ConsumeOutcome => {
		input.deps.log.record(meterIdentity, { category, detail: reason, kind: "error" });
		return { category, kind: "refused", reason };
	};
	// Audience binding, on facts this side derives rather than on a string it was
	// told. `receiverSessionId` is deliberately not compared: the sender records
	// the id of the host's child session object while the receiver resolves its
	// own identity differently, so an equality check would refuse correct runs —
	// the ruling envelope-inbox.ts already records for its own verification. What
	// replaces it binds at least as tightly: the node id is recomputed from this
	// launch's own run and child index, and it is the same derivation that names
	// the inbox this envelope was read from, so an envelope addressed to another
	// child cannot be consumed here.
	const expectedNodeId = nodeIdFor(input.identity.runId, input.identity.childIndex);
	if (wire.runId !== input.identity.runId || wire.nodeId !== expectedNodeId) {
		return refuse(
			"permission",
			`not-authorised: envelope names run ${wire.runId} node ${wire.nodeId}, the consumer is ${input.identity.runId}/${expectedNodeId}`,
		);
	}
	if (input.expectedSenderSessionId !== undefined && wire.senderSessionId !== input.expectedSenderSessionId) {
		return refuse(
			"permission",
			`not-authorised: envelope names sender session ${wire.senderSessionId}, this launch was created by ${input.expectedSenderSessionId}`,
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
			// object-io on the same log as the receive and send events above, and the
			// wrapper is what puts the re-embedding itself on that log too.
			embedder: input.deps.embedder === undefined ? undefined : meteredEmbedder(input.deps.embedder, meterIdentity, input.deps.log),
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
		encoding: stateRef.encoding,
		kind: "state-receive",
		ok: store.has(stateRef.payloadId),
		payloadBytes: stateRef.byteLength,
		representationId: stateRef.representationId,
		stateId: stateRef.payloadId,
	});

	type ConsumeAttempt =
		| { kind: "ok"; result: StateRetrievalResult }
		| { category: SynapseErrorClassification; kind: "error"; reason: string; verifyRefused?: boolean };
	const attemptConsume = (against: StateRef): ConsumeAttempt => {
		try {
			return { kind: "ok", result: service.search({ k: input.k, stateId: against.payloadId, stateRef: against }) };
		} catch (error) {
			return { category: classifySynapseError(error), kind: "error", reason: error instanceof Error ? error.message : String(error) };
		}
	};

	// The receiver's semantic check, when the launch froze it on and the receiver can
	// re-embed. A residual is a lossy encoding and the calibrated agreement is well
	// below 1, so without this a decoded vector is ranked with no per-message question
	// asked about whether it still means the query. Its own embedding call is metered
	// like every other, and it runs after the ranking: the vector checked is the one
	// that ranked, and refusing before ranking would mean a second decode path that
	// could disagree with the first.
	const verifyRequested = input.contract.stateVerify === "reembed";
	// The check is against the query the *sender* encoded — carried by the envelope — not
	// against whatever text this side happens to hold, because the state is a claim about
	// the sender's query. Comparing against a local copy would accept a state whose sender
	// had already moved on, which is one of the failures the check exists to catch.
	const verifyQuery = envelopeQueryText(wire) ?? input.fallbackQuery;
	if (verifyRequested && (input.deps.embedder === undefined || verifyQuery === undefined || verifyQuery.trim() === "")) {
		// A launch that asked for verification and a receiver that cannot perform it is a
		// configuration disagreement, not a state that passed it: accepting the payload
		// quietly would make the setting a no-op on exactly the side that must honour it.
		return refuse("configuration", "synapse.stateVerify is reembed but the receiver cannot re-embed: an embedder and the query text are both required");
	}
	const stateVerify =
		verifyRequested && input.deps.embedder !== undefined && verifyQuery !== undefined && verifyQuery.trim() !== ""
			? { embedder: meteredEmbedder(input.deps.embedder, meterIdentity, input.deps.log), minCosine: SYNAPSE_STATE_VERIFY_MIN_COSINE, query: verifyQuery }
			: null;

	/** The classification of the failure that forced a hop, with the semantic refusal split out. */
	function hopCauseOf(failure: { category: SynapseErrorClassification; verifyRefused?: boolean }): SynapseErrorClassification | "state-verify" {
		return failure.verifyRefused === true ? "state-verify" : failure.category;
	}

	/**
	 * Re-embeds the query and compares it with the vector this side decoded, when the
	 * launch asked for the check. Every run is recorded with its cosine, so how much
	 * margin the threshold leaves over legitimate payloads is a measurement rather than
	 * a claim. Null means the state passed, or that no check is configured.
	 */
	async function verifyDecoded(decoded: Float32Array): Promise<ConsumeAttempt | null> {
		if (stateVerify === null) return null;
		let cosine: number;
		try {
			const reembedded = await stateVerify.embedder.embedQuery(stateVerify.query);
			cosine = cosineSimilarity(decoded, reembedded.vector);
		} catch (error) {
			// A check that could not run is not a state that passed it: the failure takes
			// the recovery path like any other unusable payload, and the category says
			// which of the two happened.
			return { category: classifySynapseError(error), kind: "error", reason: error instanceof Error ? error.message : String(error) };
		}
		input.deps.log.record(meterIdentity, { cosine, kind: "state-verify", ok: cosine >= stateVerify.minCosine });
		if (cosine >= stateVerify.minCosine) return null;
		const reason = `state-verify: decoded state matches the query at cosine ${cosine.toFixed(6)}, below the frozen ${stateVerify.minCosine}`;
		// Marked structurally rather than by parsing this message later: the flag decides
		// which recovery runs, and control flow that depends on a string prefix is one
		// third-party message away from taking the wrong branch.
		return { category: classifySynapseError(new Error(reason)), kind: "error", reason, verifyRefused: true };
	}

	async function verifiedAttempt(against: StateRef): Promise<ConsumeAttempt> {
		const consumed = attemptConsume(against);
		if (consumed.kind !== "ok") return consumed;
		return (await verifyDecoded(consumed.result.decoded)) ?? consumed;
	}

	/**
	 * The text path, which both a semantic refusal and an exhausted re-send end at.
	 * Recorded as a hop of its own so "how often did the state plane need recovering"
	 * counts it the same way it counts a re-send.
	 */
	async function textFallback(failure: ConsumeAttempt & { kind: "error" }): Promise<ConsumeOutcome | null> {
		if ((input.stateRecovery ?? "resend") !== "resend-then-text" || input.deps.embedder === undefined || input.fallbackQuery === undefined || input.fallbackQuery === "") {
			return null;
		}
		try {
			const result = await service.searchSemantic({ k: input.k, query: input.fallbackQuery });
			input.deps.log.record(meterIdentity, { cause: hopCauseOf(failure), hop: "text", kind: "state-restore", ok: true });
			return { kind: "text-fallback", result };
		} catch (error) {
			const fallbackFailure = { category: classifySynapseError(error), kind: "error" as const, reason: error instanceof Error ? error.message : String(error) };
			input.deps.log.record(meterIdentity, { category: fallbackFailure.category, detail: fallbackFailure.reason, kind: "error" });
			return { category: fallbackFailure.category, kind: "failed", reason: fallbackFailure.reason };
		}
	}

	const first = await verifiedAttempt(stateRef);
	if (first.kind === "ok") return { kind: "consumed", result: first.result };

	// A semantic refusal never goes through the re-send. Every digest matched and the
	// meaning drifted, so repeating the bytes — or replacing them with the same encoding —
	// reproduces the same refusal one round trip later, at the cost of the round trip and a
	// second embedding. It goes straight to the text path, which is the only branch that
	// can answer with a fresh embedding of the query.
	if (first.verifyRefused === true) {
		const recovered = await textFallback(first);
		if (recovered !== null) return recovered;
		input.deps.log.record(meterIdentity, { category: first.category, detail: first.reason, kind: "error" });
		return { category: first.category, kind: "failed", reason: first.reason };
	}

	// Only object-class problems recover: the bytes may have been lost in
	// transit while the sender still holds the verified original. A
	// representation or permission failure says the peers disagree on meaning,
	// and re-sending cannot change that.
	if (first.category === "object-unavailable" || first.category === "integrity") {
		let afterResend: ConsumeAttempt = first;
		if (input.deps.resend !== undefined) {
			const resent = input.deps.resend();
			if (resent !== null) {
				// A replacement states its own encoding, space and base but not its ids:
				// the recovery below is what stores the bytes, so it is the only party
				// that can name them without the two disagreeing.
				// The union is discriminated by the value's own shape, so neither branch
				// needs an assertion: a Uint8Array repeats the message, anything else
				// replaces it.
				let replacement: ResendReplacement | null = null;
				let bytes: Uint8Array;
				if (resent instanceof Uint8Array) {
					bytes = resent;
				} else {
					replacement = resent;
					bytes = resent.bytes;
				}
				// The re-sent bytes are caller-supplied; a store that rejects them
				// (oversized, or colliding with an object stored under another media
				// type) is a failed recovery, not an exception through the seam.
				let resendFailed: ConsumeAttempt | null = null;
				let against: StateRef = stateRef;
				try {
					const mediaType = (replacement?.stateRef.encoding ?? stateRef.encoding) === "delta" ? SYNAPSE_DELTA_MEDIA_TYPE : SYNAPSE_VECTOR_MEDIA_TYPE;
					const idToReplace = replacement === null ? stateRef.payloadId : "";
					// A corrupted object that still matches its file name would make
					// the store's put a no-op and the retry fail again: a body that
					// no longer hashes to its id is removed first (its metadata is
					// rewritten by the put below), so the re-sent verified copy
					// actually lands (P4 group review X-1).
					if (idToReplace !== "" && store.has(idToReplace)) {
						try {
							store.read(idToReplace);
						} catch {
							fs.rmSync(store.objectPath(idToReplace), { force: true });
						}
					}
					// A re-send is a delivery in its own right and is metered as one;
					// the content-addressed store makes re-publishing the same bytes a no-op.
					const resentId = store.put(bytes, mediaType);
					if (replacement !== null) {
						against = { ...replacement.stateRef, payloadId: resentId, sha256: resentId };
						// The replacement is a second delivery, so it is received as one: without
						// this line the receiver would hold a consume for an id it never recorded
						// receiving, and the received/consumed reconciliation would report the
						// message as received-but-unconsumed even though it was consumed.
						input.deps.log.record(meterIdentity, {
							encoding: against.encoding,
							kind: "state-receive",
							ok: true,
							payloadBytes: bytes.byteLength,
							representationId: against.representationId,
							stateId: resentId,
						});
					}
					input.deps.log.record(meterIdentity, { bytes: bytes.byteLength, direction: "write", kind: "object-io" });
					input.deps.log.record({ ...meterIdentity, attempt: meterIdentity.attempt + 1 }, {
						encoding: against.encoding,
						kind: "state-send",
						ok: true,
						payloadBytes: bytes.byteLength,
						representationId: against.representationId,
						// The hop is what a reader counts: a recovery that repeats the same
						// message and one that replaces it are both one hop, and the encoding
						// says which happened.
						restore: replacement === null ? "resend" : "full-vector",
						stateId: resentId,
					});
					input.deps.log.record(meterIdentity, {
						cause: hopCauseOf(first),
						hop: replacement === null ? "resend" : "full-vector",
						kind: "state-restore",
						ok: true,
					});
				} catch (error) {
					resendFailed = { category: classifySynapseError(error), kind: "error", reason: error instanceof Error ? error.message : String(error) };
				}
				afterResend = resendFailed ?? (await verifiedAttempt(against));
				if (afterResend.kind === "ok") return { kind: "consumed", result: afterResend.result };
			}
		}
		// Text fallback is an ordinary text retrieval done over again, metered as such —
		// never recorded as an integrity failure (spec §8.2). A fallback that itself
		// fails is a terminal failure of the recovery, never an exception through the seam.
		const recovered = await textFallback(afterResend);
		if (recovered !== null) return recovered;
		// A terminal failure is an auditable event in its own right, recorded as
		// an error with its category rather than only as a missing consume.
		input.deps.log.record(meterIdentity, { category: afterResend.category, detail: afterResend.reason, kind: "error" });
		return { category: afterResend.category, kind: "failed", reason: afterResend.reason };
	}
	input.deps.log.record(meterIdentity, { category: first.category, detail: first.reason, kind: "error" });
	return { category: first.category, kind: "failed", reason: first.reason };
}
