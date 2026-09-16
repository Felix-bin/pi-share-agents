import { canonicalDigest } from "./canonical-json.ts";
import type { SynapseMode } from "./config.ts";

/**
 * Capability negotiation and resolution.
 *
 * Two peers take the vector path only when every condition holds at once: the
 * receiver declares the action, both declare a common encoding, both agree on
 * the exact representation, the receiver actually has a tool that consumes
 * state, and the caller's mode permits it. Declaring a representation is not
 * the same as being able to use one, which is why consumption is a separate
 * condition rather than an implication of the encoding list.
 *
 * When no vector path exists the result is either an explicitly recorded text
 * path or a refusal before launch. The two are different outcomes in the type,
 * so a text handoff can never be counted as a vector success.
 */

export const SYNAPSE_ACTIONS = ["delegate", "retrieve"] as const;

/**
 * `delta` is declared in v1 so the contract does not change when residual
 * coding lands; it is never selected until its quantisation is calibrated.
 */
export const SYNAPSE_ENCODINGS = ["text", "float32-vector", "delta"] as const;

export type SynapseAction = (typeof SYNAPSE_ACTIONS)[number];
export type SynapseEncoding = (typeof SYNAPSE_ENCODINGS)[number];

export type CapabilityDeclaration = {
	actions: readonly SynapseAction[];
	agent: string;
	/** Whether the peer holds a tool that actually consumes a decoded state. */
	consumesState: boolean;
	consumerVersion: number;
	encodings: readonly SynapseEncoding[];
	representationId: string;
};

export type CapabilityRecord = {
	capabilityId: string;
	declaration: CapabilityDeclaration;
};

export type NegotiationInput = {
	action: SynapseAction;
	/** Whether the caller accepts a recorded plain-text handoff instead. */
	allowTextFallback: boolean;
	mode: SynapseMode;
	receiver: CapabilityDeclaration;
	/** The receiver's authorisation, already projected by the host. */
	receiverMayRead: boolean;
	sender: CapabilityDeclaration;
};

export type TextFallbackReason =
	| "mode-text"
	| "action-needs-no-state"
	| "no-common-encoding"
	| "receiver-cannot-consume-state"
	| "representation-mismatch";

export type RefusalReason = TextFallbackReason | "action-unsupported" | "receiver-unauthorised" | "mode-off";

export type NegotiationResult =
	| { capabilityId: string; encoding: "float32-vector"; outcome: "state" }
	| { capabilityId: string; outcome: "text"; reason: TextFallbackReason }
	| { outcome: "refused"; reason: RefusalReason };

function normalise(declaration: CapabilityDeclaration): CapabilityDeclaration {
	return {
		// Order is not part of a capability: two peers that list the same actions
		// differently declare the same thing and must share one record.
		actions: [...new Set(declaration.actions)].sort(),
		agent: declaration.agent,
		consumesState: declaration.consumesState,
		consumerVersion: declaration.consumerVersion,
		encodings: [...new Set(declaration.encodings)].sort(),
		representationId: declaration.representationId,
	};
}

export function describeCapability(declaration: CapabilityDeclaration): CapabilityRecord {
	const normalised = normalise(declaration);
	if (normalised.actions.length === 0) {
		throw new Error(`capability has no declared action: ${normalised.agent}`);
	}
	return {
		capabilityId: canonicalDigest({
			actions: [...normalised.actions],
			consumerVersion: normalised.consumerVersion,
			consumesState: normalised.consumesState,
			encodings: [...normalised.encodings],
			representationId: normalised.representationId,
		}),
		declaration: normalised,
	};
}

export function negotiate(input: NegotiationInput): NegotiationResult {
	// Authorisation is checked first: a peer that may not read must be refused
	// outright, never quietly handed the same material as text.
	if (!input.receiverMayRead) return { outcome: "refused", reason: "receiver-unauthorised" };
	if (input.mode === "off") return { outcome: "refused", reason: "mode-off" };

	const receiver = describeCapability(input.receiver);
	const sender = describeCapability(input.sender);
	if (!receiver.declaration.actions.includes(input.action)) {
		// Without the action the task cannot be performed at all, so text would be
		// a different task rather than a degraded version of this one.
		return { outcome: "refused", reason: "action-unsupported" };
	}

	const capabilityId = receiver.capabilityId;
	const asText = (reason: TextFallbackReason): NegotiationResult =>
		input.allowTextFallback ? { capabilityId, outcome: "text", reason } : { outcome: "refused", reason };

	if (input.mode === "text") return asText("mode-text");
	if (input.action !== "retrieve") return asText("action-needs-no-state");
	if (!receiver.declaration.encodings.includes("float32-vector") || !sender.declaration.encodings.includes("float32-vector")) {
		return asText("no-common-encoding");
	}
	if (receiver.declaration.representationId !== sender.declaration.representationId) return asText("representation-mismatch");
	if (!receiver.declaration.consumesState) return asText("receiver-cannot-consume-state");

	return { capabilityId, encoding: "float32-vector", outcome: "state" };
}
