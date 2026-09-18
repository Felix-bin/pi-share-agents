import { randomUUID } from "node:crypto";
import { modelUsageFrom, openDelegation, type CloseDelegationInput, type OpenDelegation } from "../../synapse/delegation.ts";
import type { ReceiptOutcome } from "../../synapse/handoff.ts";
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
