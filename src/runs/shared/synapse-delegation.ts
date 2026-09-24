import { createHash, randomUUID } from "node:crypto";
import { childConsumesState } from "../../synapse/child-contract.ts";
import type { SynapseChildContract } from "../../synapse/child-contract.ts";
import { classifySynapseError } from "../../synapse/errors.ts";
import { clearStateEnvelope, nodeIdFor } from "../../synapse/envelope-inbox.ts";
import { meteringLogPath, modelUsageFrom, openDelegation, openRetrieveDelegation, type CloseDelegationInput, type OpenDelegation, type RetrieveSendResult, type SendDeps } from "../../synapse/delegation.ts";
import { autoDistillOutput } from "../../synapse/auto-distill.ts";
import { createCapabilityProbeCache, stateRetrievalProbeCheck } from "../../synapse/capability-probe.ts";
import { createMeteringLog, type MeteringIdentity, type StateSkipReason } from "../../synapse/metering.ts";
import { stateQueryOf } from "../../synapse/state-query.ts";
import { createMemoryService } from "../../synapse/memory-service.ts";
import { meteredEmbedder, resolveConfiguredEmbedder, type Embedder } from "../../synapse/embedding.ts";
import type { ReceiptOutcome } from "../../synapse/handoff.ts";
import { SYNAPSE_DEFAULT_SEARCH_K } from "../../synapse/memory-service.ts";
import { memoryVectorCacheFor } from "../../synapse/vector-cache.ts";
import type { Usage } from "../../shared/types.ts";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";

/**
 * The host-side call sites of the delegation seam.
 *
 * Foreground and background both send their task through one function here and
 * close it through the other, so the envelope, the negotiation and the meter
 * are identical on both paths by construction rather than by review.
 *
 * Both functions are total: shared memory is an addition to delegation, never a
 * precondition for it. A store that cannot be opened disables the seam with a
 * visible warning and leaves the child running exactly the task upstream would
 * have sent — a metering failure must not cost the user their run.
 *
 * `openChildDelegationWithState` is the one the two execution paths call: it
 * composes the task plane with the state plane, and the state half is total in
 * the same sense — a child that cannot consume state, or a host that cannot
 * build an embedder, gets exactly the delegation it would have got before the
 * state plane existed.
 */

export type OpenChildDelegationInput = {
	cwd: string;
	message: string;
	receiverSessionId: string;
	runtime: ChildRuntimeConfig;
};

function warn(agent: string, stage: string, reason: string): void {
	console.warn(`[pi-subagents] synapse: ${stage} skipped for ${agent}: ${reason}`);
}

export function openChildDelegation(input: OpenChildDelegationInput): OpenDelegation | null {
	const synapse = input.runtime.synapse;
	if (synapse === undefined) return null;
	try {
		return openDelegation({
			budgetBytes: synapse.contextBudgetBytes,
			contract: synapse.contract,
			identity: {
				agent: synapse.agent,
				// One pass through this seam is one delivery. An upstream retry builds
				// a new child session and therefore a new request, which the log shows
				// as a second delivery rather than as a duplicate of the first.
				attempt: 1,
				childIndex: input.runtime.childIndex,
				// The contract's own list: the receiver verifies the delegated envelope
				// against the capability it was launched with, so both planes negotiate
				// from that list rather than from whatever the caller declared.
				childTools: synapse.capabilityTools,
				receiverSessionId: input.receiverSessionId,
				requestId: `${synapse.runId}-${input.runtime.childIndex}-${randomUUID().slice(0, 8)}`,
				runId: synapse.runId,
				senderSessionId: synapse.sessionId,
			},
			message: input.message,
			worktreeRoot: input.cwd,
		});
	} catch (error) {
		// The catch is the boundary: the thrown value is turned into text here so
		// nothing downstream has to handle an unparsed one.
		warn(synapse.agent, "delegation metering", error instanceof Error ? error.message : String(error));
		return null;
	}
}

export type OpenChildRetrieveInput = {
	/** The builtin tools the child was granted, as the tool plan resolved them. */
	childTools: readonly string[];
	cwd: string;
	/** The sender's deps, when the caller has already built the log they belong on. */
	deps?: SendDeps;
	/** The sender's embedder; the product path builds it from synapse.embedding. */
	embedder: Embedder;
	/** How many corpus chunks the receiver should rank. */
	k: number;
	/** The query text to embed and hand over. */
	query: string;
	/**
	 * Runs the receiver's declared runtime probe. The state seam below is the
	 * one production caller and always wires this; injecting it keeps the
	 * function honest under test instead of probing as a hidden side effect.
	 */
	receiverProbe?: () => boolean;
	receiverSessionId: string;
	runtime: ChildRuntimeConfig;
};

/**
 * The state seam's probe cache: process-wide with the prototype's TTL, keyed by
 * the facts the check depends on — store, pinned snapshot, representation,
 * embedding configuration — so consecutive delegations against the same corpus
 * share one verification and a reconfigured store is a different key. Each
 * process holds its own cache (the prototype ran one CNR instance in one
 * process; a background child is a second process with a second cache) —
 * recorded as a deliberate difference in the migration coverage doc.
 */
const capabilityProbes = createCapabilityProbeCache();

/** A stable digest of the embedding configuration for the probe cache key; the key material never enters it. */
function sha256OfEmbedding(embedding: SynapseChildContract["embedding"]): string {
	if (embedding === null) return "none";
	return createHash("sha256").update(JSON.stringify({ dim: embedding.dim, endpoint: embedding.endpoint, keyEnv: embedding.keyEnv, model: embedding.model, provider: embedding.provider }), "utf-8").digest("hex").slice(0, 16);
}

/**
 * The state-plane sibling of openChildDelegation: a retrieve delegation whose
 * negotiation may take the float32 path. Total in the same sense — a refusal
 * or a thrown setup returns null/warns and the caller keeps its text behaviour
 * rather than losing the run.
 */
export async function openChildRetrieveDelegation(input: OpenChildRetrieveInput): Promise<RetrieveSendResult | null> {
	const synapse = input.runtime.synapse;
	if (synapse === undefined) return null;
	try {
		return await openRetrieveDelegation({
			contract: synapse.contract,
			...(input.deps === undefined ? {} : { deps: input.deps }),
			embedder: input.embedder,
			identity: {
				agent: synapse.agent,
				attempt: 1,
				childIndex: input.runtime.childIndex,
				// The contract's own list: the receiver verifies the envelope against the
				// capability it was launched with, so the sender negotiates with that same
				// list rather than with whatever the caller happened to declare.
				childTools: synapse.capabilityTools,
				receiverSessionId: input.receiverSessionId,
				requestId: `${synapse.runId}-${input.runtime.childIndex}-${randomUUID().slice(0, 8)}`,
				runId: synapse.runId,
				senderSessionId: synapse.sessionId,
			},
			k: input.k,
			query: input.query,
			...(input.receiverProbe === undefined ? {} : { receiverProbe: input.receiverProbe }),
			worktreeRoot: input.cwd,
		});
	} catch (error) {
		// The catch is the boundary: the thrown value is turned into text here so
		// nothing downstream has to handle an unparsed one.
		const detail = error instanceof Error ? error.message : String(error);
		warn(synapse.agent, "retrieve delegation", detail);
		// A console line is gone once the runner exits; the ledger is where a
		// missing state is looked for, so the failure is recorded there too.
		recordBestEffort(synapse, input.runtime.childIndex, { category: classifySynapseError(error), detail: `retrieve delegation: ${detail}`, kind: "error" });
		return null;
	}
}

/** The seam's own identity for rows it writes outside a delegation's log. */
function seamIdentity(synapse: SynapseChildContract, childIndex: number | undefined): MeteringIdentity {
	return { agent: synapse.agent, attempt: 1, mode: synapse.contract.mode, nodeId: nodeIdFor(synapse.runId, childIndex), runId: synapse.runId, sessionId: synapse.sessionId, snapshotId: null };
}

/** Metering a skip or a failure must never be what costs the launch. */
function recordBestEffort(synapse: SynapseChildContract, childIndex: number | undefined, payload: Parameters<ReturnType<typeof createMeteringLog>["record"]>[1]): void {
	try {
		createMeteringLog(meteringLogPath(synapse.contract, synapse.runId)).record(seamIdentity(synapse, childIndex), payload);
	} catch {
		// Best effort, as above.
	}
}

/**
 * The sender's base-selection seam, built only when this launch may send a residual.
 *
 * The service ranks the **child's** store under the **contract's** scope, not the
 * parent's own: the receiver resolves the named base from its own memory with the
 * scope it was launched under, so a base chosen under that same scope is
 * rebuildable on the far side by construction. A wider scope could name a base the
 * child may not read — a residual that can never be rebuilt, which is the one
 * failure this design cannot recover from, since re-sending residual bytes cannot
 * help a receiver that never had the base.
 *
 * The corpus is null on purpose. Base selection ranks the sender's memories, not
 * corpus chunks; pinning a snapshot here would open a second state path inside the
 * call whose whole purpose is to measure one path's cost.
 */
function senderBaseSelector(synapse: SynapseChildContract, childIndex: number | undefined, cwd: string, embedder: Embedder): SendDeps {
	const identity: MeteringIdentity = {
		agent: synapse.agent,
		attempt: 1,
		mode: synapse.contract.mode,
		nodeId: nodeIdFor(synapse.runId, childIndex),
		runId: synapse.runId,
		sessionId: synapse.sessionId,
		snapshotId: null,
	};
	// One log for the whole state send: the payload's own events and base
	// selection's reads belong to the same node, and a second log instance over the
	// same file would give them a second monotonic origin.
	const log = createMeteringLog(meteringLogPath(synapse.contract, synapse.runId));
	const service = createMemoryService({
		corpusSnapshotId: null,
		// Base selection embeds the query through the same provider the payload
		// does. Wrapping it keeps the cost of the decision that chooses an encoding
		// visible; otherwise the one path that decides whether a residual is sent
		// would be the only unmetered one.
		embedder: meteredEmbedder(embedder, identity, log),
		metering: { identity, log },
		provenance: { agent: synapse.agent, attempt: 1, runId: synapse.runId, sessionId: synapse.sessionId },
		scope: {
			agent: synapse.agent,
			namespaceId: synapse.contract.namespaceId,
			pathPrefixes: [...synapse.contract.scope.pathPrefixes],
			write: synapse.contract.scope.write,
		},
		storeRoot: synapse.contract.storageRoot,
		// Base selection ranks every record the sender holds, every time it sends.
		// With the cache on, those vectors are read once per process instead — the
		// difference between the pre-registered cold row (this default) and its hot
		// row, which stops being a derived figure the moment this switch exists.
		vectorCache: synapse.vectorCache ? memoryVectorCacheFor(synapse.contract.storageRoot, embedder) : undefined,
		worktreeRoot: cwd,
	});
	return {
		log,
		predictedBase: async ({ text }) => {
			try {
				return await service.predictBase({ text });
			} catch (error) {
				// predictBase refuses to degrade to a quieter base, and it is right not
				// to: a base from a different ranking would be a different experiment.
				// That refusal stops here — the residual is abandoned and the full
				// vector goes out — but it is recorded, because "no base exists" and
				// "the base could not be looked up" produce the same envelope and are
				// not the same measurement.
				log.record(identity, {
					category: classifySynapseError(error),
					detail: `base-selection failed: ${error instanceof Error ? error.message : String(error)}`,
					kind: "error",
				});
				return null;
			}
		},
	};
}

/**
 * The state-plane half of the same delegation, when this child can receive one.
 *
 * Three conditions gate it, and all three are answered from what the launch
 * already holds rather than guessed: the extension must be in `synapse` mode,
 * the child must have been granted a state-consuming tool (its own role's rule,
 * not a second copy of it), and the launch must pin a corpus. A child that
 * fails any of them negotiates to text on its own, so sending an envelope would
 * add noise to the mailbox and nothing else.
 *
 * The embedder is built here from the contract, which is the only place in the
 * run path that carries the embedding configuration — building it at each call
 * site would be the fork this seam exists to prevent. A missing provider key
 * yields no embedder and therefore no state delivery, which is the same
 * degradation the tool path takes rather than an error.
 */
async function openChildStateDelegation(input: OpenChildDelegationInput): Promise<RetrieveSendResult | null> {
	const synapse = input.runtime.synapse;
	if (synapse === undefined) return null;
	// Total, like the task-plane half: anything the state half throws — an
	// unreadable credentials file, a store that refuses a write — costs this
	// launch its state delivery, never the launch itself. The task plane was
	// already opened and metered; failing here would leave it without a receipt.
	try {
		return await openChildStateDelegationUnguarded(input, synapse);
	} catch (error) {
		warn(synapse.agent, "state delivery", error instanceof Error ? error.message : String(error));
		recordBestEffort(synapse, input.runtime.childIndex, { category: classifySynapseError(error), detail: `state delivery skipped: ${error instanceof Error ? error.message : String(error)}`, kind: "error" });
		try {
			clearStateEnvelope(synapse.contract.storageRoot, synapse.runId, input.runtime.childIndex);
		} catch {
			// Best effort, as above.
		}
		return null;
	}
}

async function openChildStateDelegationUnguarded(input: OpenChildDelegationInput, synapse: SynapseChildContract): Promise<RetrieveSendResult | null> {
	// A pass that publishes nothing must leave nothing behind. The receiver reads
	// the state inbox by path, not by request, so a payload a previous pass wrote
	// for this node would be consumed here as though this pass had sent it. The
	// text branch clears for itself; this covers every path that never reaches it.
	// Each host gate names itself in the ledger: otherwise a role kept on text by
	// design and a store missing its corpus or key leave the same empty trace.
	const publishNothing = (reason?: StateSkipReason): null => {
		clearStateEnvelope(synapse.contract.storageRoot, synapse.runId, input.runtime.childIndex);
		if (reason !== undefined) recordBestEffort(synapse, input.runtime.childIndex, { kind: "state-skipped", reason });
		return null;
	};
	if (synapse.contract.mode !== "synapse") return publishNothing("mode-not-synapse");
	if (synapse.contract.corpusSnapshotId === "unset") return publishNothing("corpus-unset");
	// The gate reads the same list the contract froze: the child's real tools,
	// the extension's included.
	if (!childConsumesState(synapse.capabilityTools)) return publishNothing("no-state-tool");
	const embedder = resolveConfiguredEmbedder(synapse.embedding, synapse.contract.storageRoot);
	if (embedder === undefined) return publishNothing("embedder-unavailable");
	// With the switch off the call is byte-for-byte the one this seam made before
	// residuals were reachable: no deps, therefore no base, therefore the existing
	// no-base branch and a full vector.
	const deps = synapse.delta ? senderBaseSelector(synapse, input.runtime.childIndex, input.cwd, embedder) : undefined;
	// The verifiable promise, wired at the one production call site: the
	// receiver's declaration claims state retrieval can work here, and the probe
	// holds that claim to the runtime — an embedder that cannot be constructed
	// or a corpus that cannot load takes the text path before an embedding call
	// is spent. The TTL cache keeps consecutive delegations against the same
	// store to one verification per window (passes 300 s, failures 30 s: a
	// failure is usually a transient environment fact and must not pin a whole
	// window to text). The key carries every fact the check reads — store,
	// pinned snapshot, representation, and the embedding configuration, whose
	// endpoint/keyEnv the check also depends on.
	const receiverProbe = () =>
		capabilityProbes.probe(
			`state-retrieval:${synapse.contract.storageRoot}:${synapse.contract.corpusSnapshotId}:${synapse.contract.representationId}:${sha256OfEmbedding(synapse.embedding)}`,
			() =>
				stateRetrievalProbeCheck({
					// The unset contract never reaches the probe: the gate above returned
					// before it, so this is always a published snapshot id here.
					corpusSnapshotId: synapse.contract.corpusSnapshotId,
					embedding: synapse.embedding,
					representationId: synapse.contract.representationId,
					storageRoot: synapse.contract.storageRoot,
				}),
		);
	const result = await openChildRetrieveDelegation({
		childTools: synapse.capabilityTools,
		cwd: input.cwd,
		...(deps === undefined ? {} : { deps }),
		embedder,
		// The child reads the corpus itself, so the count is the same one the
		// memory tool would return by default rather than a second policy.
		k: SYNAPSE_DEFAULT_SEARCH_K,
		// The query, not the whole message: one embedding of a full plan averages
		// its steps into a direction that ranks generic chunks. See state-query.ts.
		query: stateQueryOf(input.message).text,
		receiverProbe,
		receiverSessionId: input.receiverSessionId,
		runtime: input.runtime,
	});
	return result === null ? publishNothing() : result;
}

/** What a delegation produced on both planes; the caller closes the first and
 * reads nothing from the second beyond what the meter already recorded. */
export type ChildStateDelegation = {
	delegation: OpenDelegation | null;
	state: RetrieveSendResult | null;
};

/**
 * How long the state half may hold up a child's first turn.
 *
 * The two sides of this plane disagree by design about which is worth waiting
 * for: the receiver deliberately does not wait for a payload — it is not worth
 * holding back the first turn for — while the sender's embedding call sits on
 * exactly that turn, bounded only by the HTTP client's own 30s timeout. A budget
 * gives them the same shape. Past it the launch proceeds with no state, which is
 * the delivery a child that cannot consume state gets.
 *
 * The attempt is left running rather than cleared. Clearing would delete an
 * envelope the ledger has just recorded as sent, and a late delivery is still a
 * correct one — it names this node and carries this query — so a receiver that
 * reads it has not been handed anything stale. What the expiry does produce is an
 * explicit error event, so "no state crossed" is never ambiguous with "the sender
 * was still thinking when the child started"; that ambiguity is the one thing the
 * pre-registration forbids.
 */
export const SYNAPSE_STATE_BUDGET_MS = 2500;

/**
 * The state half under the budget. A launch must not be held hostage to a
 * provider that is not answering, and a slow answer must not silently look like
 * a fast empty one.
 */
async function stateWithinBudget(input: OpenChildDelegationInput): Promise<RetrieveSendResult | null> {
	const synapse = input.runtime.synapse;
	const pending = openChildStateDelegation(input);
	if (synapse === undefined) return pending;
	const EXPIRED = Symbol("state-budget-expired");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<typeof EXPIRED>((resolve) => {
		timer = setTimeout(() => resolve(EXPIRED), SYNAPSE_STATE_BUDGET_MS);
		// A pending timer must never be the reason the process stays alive.
		timer.unref();
	});
	try {
		const outcome = await Promise.race([pending, expiry]);
		if (outcome !== EXPIRED) return outcome;
		const identity: MeteringIdentity = {
			agent: synapse.agent,
			attempt: 1,
			mode: synapse.contract.mode,
			nodeId: nodeIdFor(synapse.runId, input.runtime.childIndex),
			runId: synapse.runId,
			sessionId: synapse.sessionId,
			snapshotId: null,
		};
		try {
			createMeteringLog(meteringLogPath(synapse.contract, synapse.runId)).record(identity, {
				category: "timeout",
				detail: `state budget expired after ${SYNAPSE_STATE_BUDGET_MS} ms; the delivery may still complete`,
				kind: "error",
			});
		} catch {
			// Metering a budget must never be the thing that costs the launch.
		}
		// The attempt keeps its own bookkeeping; this only stops the wait. The
		// handler is attached so a late rejection is not an unhandled one.
		void pending.catch(() => undefined);
		return null;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Sends one task to one child, on the task plane always and on the state plane
 * when the child is eligible.
 *
 * The two are composed rather than chosen between: the delegation is what
 * carries the prompt the child is actually sent and the receipt its close
 * writes, so skipping it would trade a delivery for a delivery. The state
 * envelope is written to its own path, and its bytes are metered by the send
 * side that produced it — so a comparison across the two planes is reading two
 * recorded deliveries rather than one delivery counted twice.
 */
export async function openChildDelegationWithState(input: OpenChildDelegationInput): Promise<ChildStateDelegation> {
	const delegation = openChildDelegation(input);
	const state = await stateWithinBudget(input);
	return { delegation, state };
}

export type CloseChildDelegationInput = {
	/** True when the run was stopped rather than failed; the two are not the same outcome. */
	cancelled: boolean;
	cause?: unknown;
	finalOutput: string;
	/** The child's runtime config, when the caller holds it: its synapse contract carries the distill switch. */
	runtime?: ChildRuntimeConfig;
	/** The delegated task text, when the caller has it: the distillate's topic. */
	taskText?: string;
	/** A timeout is a failure the host observed rather than an error it caught. */
	timedOut: boolean;
	usage: Usage;
};

/**
 * How long a completed delegation's close may wait for distillation to land.
 *
 * The distiller embeds each line before it publishes it, so it outlives the
 * child's prompt by several provider round trips. A detached distill would be
 * lost whenever the process ends first — and a background runner exits the
 * moment its run resolves — so the close waits for it, but never unboundedly:
 * a stalled provider costs the run at most this long, and the expiry is
 * recorded rather than passed off as "nothing to distill".
 */
export const SYNAPSE_DISTILL_BUDGET_MS = 20_000;

/**
 * Closes the delegation and, when the launch asked for it, distills the child's
 * output into shared memory. The returned promise settles once distillation has
 * landed, failed, or run out of budget; it never rejects. A caller that ends its
 * process after the run must await it, or the distill is cut off mid-write.
 */
export function closeChildDelegation(delegation: OpenDelegation | null, input: CloseChildDelegationInput): Promise<void> {
	if (delegation === null) return Promise.resolve();
	// A stop and a failure are different outcomes, and a timeout is a failure the
	// host observed rather than one it caught, so it carries its own cause.
	const outcome: ReceiptOutcome = input.cancelled ? "cancelled" : input.cause === undefined && !input.timedOut ? "completed" : "failed";
	const closeInput: CloseDelegationInput = { outcome, summary: input.finalOutput, usage: modelUsageFrom(input.usage) };
	if (input.cause !== undefined) closeInput.cause = input.cause;
	else if (input.timedOut) closeInput.cause = new Error("timeout: the child did not finish in time");
	try {
		delegation.close(closeInput);
	} catch (error) {
		warn("child", "delegation receipt", error instanceof Error ? error.message : String(error));
	}
	// Memory sedimentation is a side condition of the run, never a result of it:
	// only a completed delegation distills, and any failure of the distiller
	// itself is a warning on this close path, not a failed delegation.
	const contract = input.runtime?.synapse;
	if (outcome !== "completed" || contract?.autoDistill !== true) return Promise.resolve();
	return distillWithinBudget(contract, input);
}

async function distillWithinBudget(contract: SynapseChildContract, input: CloseChildDelegationInput): Promise<void> {
	const identity: MeteringIdentity = {
		agent: contract.agent,
		attempt: 1,
		mode: contract.contract.mode,
		nodeId: nodeIdFor(contract.runId, input.runtime?.childIndex),
		runId: contract.runId,
		sessionId: contract.sessionId,
		snapshotId: null,
	};
	const record = (payload: Parameters<ReturnType<typeof createMeteringLog>["record"]>[1]): void => {
		try {
			createMeteringLog(meteringLogPath(contract.contract, contract.runId)).record(identity, payload);
		} catch {
			// Metering the distill must never be what costs the run.
		}
	};
	const distill = (async () => {
		const resolved = resolveConfiguredEmbedder(contract.embedding, contract.contract.storageRoot);
		// Metered like every other embedding call, so the reuse experiment's cost
		// column includes what it took to build the memory it reuses.
		const embedder = resolved === undefined ? undefined : meteredEmbedder(resolved, identity, createMeteringLog(meteringLogPath(contract.contract, contract.runId)));
		return autoDistillOutput(
			{
				contract,
				embedder: embedder === undefined ? null : { embed: async (text) => (await embedder.embedQuery(text)).vector, representationId: embedder.representationId },
				provenance: { agent: contract.agent, attempt: 1, runId: contract.runId, sessionId: contract.sessionId },
				taskText: input.taskText ?? "",
			},
			input.finalOutput,
		);
	})();
	const EXPIRED = Symbol("distill-budget-expired");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<typeof EXPIRED>((resolve) => {
		timer = setTimeout(() => resolve(EXPIRED), SYNAPSE_DISTILL_BUDGET_MS);
		timer.unref();
	});
	try {
		const result = await Promise.race([distill, expiry]);
		if (result === EXPIRED) {
			void distill.catch(() => undefined);
			record({ category: "timeout", detail: `auto-distill budget expired after ${SYNAPSE_DISTILL_BUDGET_MS} ms; records past that point may be missing`, kind: "error" });
			warn(contract.agent, "auto-distill", `budget expired after ${SYNAPSE_DISTILL_BUDGET_MS} ms`);
			return;
		}
		record({ kind: "memory-distill", withoutVector: result.withoutVector, written: result.written });
		if (result.written > 0) console.log(`[pi-subagents] synapse: auto-distilled ${result.written} memory line(s)${result.withoutVector > 0 ? ` (${result.withoutVector} without a vector)` : ""}`);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		record({ category: classifySynapseError(error), detail: `auto-distill: ${detail}`, kind: "error" });
		warn(contract.agent, "auto-distill", detail);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
