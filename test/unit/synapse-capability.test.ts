import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	describeCapability,
	negotiate,
	SYNAPSE_ENCODINGS,
	type CapabilityDeclaration,
	type NegotiationInput,
} from "../../src/synapse/capability.ts";

function declare(overrides: Partial<CapabilityDeclaration> = {}): CapabilityDeclaration {
	return {
		actions: overrides.actions ?? ["delegate", "retrieve"],
		agent: overrides.agent ?? "retriever",
		consumesState: overrides.consumesState ?? true,
		consumerVersion: overrides.consumerVersion ?? 1,
		encodings: overrides.encodings ?? ["text", "float32-vector"],
		representationId: overrides.representationId ?? "siliconflow/BAAI/bge-m3/1024/l2/f32le",
	};
}

function input(overrides: Partial<NegotiationInput> = {}): NegotiationInput {
	return {
		action: overrides.action ?? "retrieve",
		allowTextFallback: overrides.allowTextFallback ?? true,
		mode: overrides.mode ?? "synapse",
		receiver: overrides.receiver ?? declare({ agent: "retriever" }),
		receiverMayRead: overrides.receiverMayRead ?? true,
		sender: overrides.sender ?? declare({ agent: "planner" }),
	};
}

describe("capability records", () => {
	it("identifies a declaration by its content, not by when it was registered", () => {
		const first = describeCapability(declare());
		const second = describeCapability(declare());
		assert.equal(first.capabilityId, second.capabilityId);
		assert.match(first.capabilityId, /^[0-9a-f]{64}$/);
	});

	it("changes identity when a declared action or encoding changes", () => {
		const base = describeCapability(declare()).capabilityId;
		assert.notEqual(describeCapability(declare({ actions: ["delegate"] })).capabilityId, base);
		assert.notEqual(describeCapability(declare({ encodings: ["text"] })).capabilityId, base);
		assert.notEqual(describeCapability(declare({ consumerVersion: 2 })).capabilityId, base);
	});

	it("normalises declaration order so the same capability is one record", () => {
		const forward = describeCapability(declare({ actions: ["delegate", "retrieve"], encodings: ["text", "float32-vector"] }));
		const reversed = describeCapability(declare({ actions: ["retrieve", "delegate"], encodings: ["float32-vector", "text"] }));
		assert.equal(forward.capabilityId, reversed.capabilityId);
	});

	it("rejects a declaration with no action at all rather than registering an unusable peer", () => {
		assert.throws(() => describeCapability(declare({ actions: [] })), /no declared action/);
	});
});

describe("negotiation outcome (AC-02)", () => {
	it("chooses the vector path when both sides declare it and the receiver consumes state", () => {
		const result = negotiate(input());
		assert.equal(result.outcome, "state");
		if (result.outcome !== "state") return;
		assert.equal(result.encoding, "float32-vector");
		assert.match(result.capabilityId, /^[0-9a-f]{64}$/);
	});

	it("falls back to text, and records it as text, when the receiver drops the vector encoding", () => {
		const result = negotiate(input({ receiver: declare({ encodings: ["text"] }) }));
		assert.equal(result.outcome, "text");
		if (result.outcome !== "text") return;
		assert.equal(result.reason, "no-common-encoding");
		// A text path must never be counted as a vector success.
		assert.equal("encoding" in result ? result.encoding : "text", "text");
	});

	it("falls back to text when the receiver declares the encoding but cannot consume state", () => {
		// Declaring a representation is not the same as having a tool that uses it.
		const result = negotiate(input({ receiver: declare({ consumesState: false }) }));
		assert.equal(result.outcome, "text");
		if (result.outcome !== "text") return;
		assert.equal(result.reason, "receiver-cannot-consume-state");
	});

	it("falls back to text when the two sides disagree about the representation", () => {
		const result = negotiate(input({ receiver: declare({ representationId: "siliconflow/BAAI/bge-m3/512/l2/f32le" }) }));
		assert.equal(result.outcome, "text");
		if (result.outcome !== "text") return;
		assert.equal(result.reason, "representation-mismatch");
	});

	it("refuses before launch when text is not allowed and no vector path exists", () => {
		const result = negotiate(input({ allowTextFallback: false, receiver: declare({ encodings: ["text"] }) }));
		assert.equal(result.outcome, "refused");
		if (result.outcome !== "refused") return;
		assert.equal(result.reason, "no-common-encoding");
	});

	it("refuses when the receiver does not declare the requested action", () => {
		const result = negotiate(input({ receiver: declare({ actions: ["delegate"] }) }));
		assert.equal(result.outcome, "refused");
		if (result.outcome !== "refused") return;
		assert.equal(result.reason, "action-unsupported");
	});

	it("refuses on an unsupported action even when text would otherwise be allowed", () => {
		// The task cannot be carried out at all, so a text handoff would not be a
		// degraded success but a different task.
		const result = negotiate(input({ allowTextFallback: true, receiver: declare({ actions: ["delegate"] }) }));
		assert.equal(result.outcome, "refused");
	});
});

describe("negotiation is bounded by mode and permission (AC-03)", () => {
	it("never takes the vector path in text mode, even when both sides could", () => {
		const result = negotiate(input({ mode: "text" }));
		assert.equal(result.outcome, "text");
		if (result.outcome !== "text") return;
		assert.equal(result.reason, "mode-text");
	});

	it("keeps delegate on the text path: only retrieve carries query state", () => {
		const result = negotiate(input({ action: "delegate" }));
		assert.equal(result.outcome, "text");
		if (result.outcome !== "text") return;
		assert.equal(result.reason, "action-needs-no-state");
	});

	it("does not widen reach: an unauthorised receiver is refused, not handed text", () => {
		const result = negotiate(input({ receiverMayRead: false }));
		assert.equal(result.outcome, "refused");
		if (result.outcome !== "refused") return;
		assert.equal(result.reason, "receiver-unauthorised");
	});

	it("produces the same outcome for the same inputs", () => {
		assert.deepEqual(negotiate(input()), negotiate(input()));
	});

	it("reserves the delta encoding without selecting it in v1", () => {
		assert.ok(SYNAPSE_ENCODINGS.includes("delta"));
		const result = negotiate(input({ receiver: declare({ encodings: ["text", "float32-vector", "delta"] }), sender: declare({ encodings: ["text", "float32-vector", "delta"] }) }));
		assert.equal(result.outcome, "state");
		if (result.outcome !== "state") return;
		// v1 sends full vectors; delta only becomes selectable once it is calibrated.
		assert.equal(result.encoding, "float32-vector");
	});
});
