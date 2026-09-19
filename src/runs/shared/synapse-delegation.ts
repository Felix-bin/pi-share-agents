import { randomUUID } from "node:crypto";
import { childConsumesState } from "../../synapse/child-contract.ts";
import { clearStateEnvelope } from "../../synapse/envelope-inbox.ts";
import { modelUsageFrom, openDelegation, openRetrieveDelegation, type CloseDelegationInput, type OpenDelegation, type RetrieveSendResult } from "../../synapse/delegation.ts";
import { resolveConfiguredEmbedder, type Embedder } from "../../synapse/embedding.ts";
import type { ReceiptOutcome } from "../../synapse/handoff.ts";
import { SYNAPSE_DEFAULT_SEARCH_K } from "../../synapse/memory-service.ts";
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
	/** The builtin tools the child was granted, as the tool plan resolved them. */
	childTools: readonly string[];
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
				childTools: input.childTools,
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
	/** The sender's embedder; the product path builds it from synapse.embedding. */
	embedder: Embedder;
	/** How many corpus chunks the receiver should rank. */
	k: number;
	/** The query text to embed and hand over. */
	query: string;
	receiverSessionId: string;
	runtime: ChildRuntimeConfig;
};

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
		return openRetrieveDelegation({
			contract: synapse.contract,
			embedder: input.embedder,
			identity: {
				agent: synapse.agent,
				attempt: 1,
				childIndex: input.runtime.childIndex,
				childTools: input.childTools,
				receiverSessionId: input.receiverSessionId,
				requestId: `${synapse.runId}-${input.runtime.childIndex}-${randomUUID().slice(0, 8)}`,
				runId: synapse.runId,
				senderSessionId: synapse.sessionId,
			},
			k: input.k,
			query: input.query,
			worktreeRoot: input.cwd,
		});
	} catch (error) {
		// The catch is the boundary: the thrown value is turned into text here so
		// nothing downstream has to handle an unparsed one.
		warn(synapse.agent, "retrieve delegation", error instanceof Error ? error.message : String(error));
		return null;
	}
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
	// A pass that publishes nothing must leave nothing behind. The receiver reads
	// the state inbox by path, not by request, so a payload a previous pass wrote
	// for this node would be consumed here as though this pass had sent it. The
	// text branch clears for itself; this covers every path that never reaches it.
	const publishNothing = (): null => {
		clearStateEnvelope(synapse.contract.storageRoot, synapse.runId, input.runtime.childIndex);
		return null;
	};
	if (synapse.contract.mode !== "synapse") return publishNothing();
	if (synapse.contract.corpusSnapshotId === "unset") return publishNothing();
	if (!childConsumesState(input.childTools)) return publishNothing();
	const embedder = resolveConfiguredEmbedder(synapse.embedding, synapse.contract.storageRoot);
	if (embedder === undefined) return publishNothing();
	const result = await openChildRetrieveDelegation({
		childTools: input.childTools,
		cwd: input.cwd,
		embedder,
		// The child reads the corpus itself, so the count is the same one the
		// memory tool would return by default rather than a second policy.
		k: SYNAPSE_DEFAULT_SEARCH_K,
		query: input.message,
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
	const state = await openChildStateDelegation(input);
	return { delegation, state };
}

export type CloseChildDelegationInput = {
	/** True when the run was stopped rather than failed; the two are not the same outcome. */
	cancelled: boolean;
	cause?: unknown;
	finalOutput: string;
	/** A timeout is a failure the host observed rather than an error it caught. */
	timedOut: boolean;
	usage: Usage;
};

export function closeChildDelegation(delegation: OpenDelegation | null, input: CloseChildDelegationInput): void {
	if (delegation === null) return;
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
}
