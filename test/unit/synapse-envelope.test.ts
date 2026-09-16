import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildEnvelope,
	freezeSnapshot,
	parseEnvelope,
	SYNAPSE_PROTOCOL_VERSION,
	type EnvelopeInput,
	type SnapshotInput,
} from "../../src/synapse/envelope.ts";

function snapshotInput(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
	return {
		capabilityId: overrides.capabilityId ?? "c".repeat(64),
		contextRefs: overrides.contextRefs ?? ["a".repeat(64)],
		corpusSnapshotId: overrides.corpusSnapshotId ?? "corpus-1",
		namespaceId: overrides.namespaceId ?? "0123456789abcdef",
		permissionProjection: overrides.permissionProjection ?? { pathPrefixes: ["src"], write: false },
		representationId: overrides.representationId ?? "siliconflow/BAAI/bge-m3/1024/l2/f32le",
	};
}

function envelopeInput(overrides: Partial<EnvelopeInput> = {}): EnvelopeInput {
	return {
		action: overrides.action ?? "retrieve",
		attempt: overrides.attempt ?? 1,
		inputParams: overrides.inputParams ?? { query: "residual encoder" },
		nodeId: overrides.nodeId ?? "node-1",
		ownerRunId: overrides.ownerRunId ?? "owner-1",
		receiverSessionId: overrides.receiverSessionId ?? "sess-child",
		requestId: overrides.requestId ?? "req-1",
		runId: overrides.runId ?? "run-1",
		senderSessionId: overrides.senderSessionId ?? "sess-main",
		snapshot: overrides.snapshot ?? freezeSnapshot(snapshotInput()),
		stateRef: overrides.stateRef,
	};
}

describe("frozen snapshot", () => {
	it("identifies the frozen inputs by content", () => {
		assert.equal(freezeSnapshot(snapshotInput()).snapshotId, freezeSnapshot(snapshotInput()).snapshotId);
		assert.match(freezeSnapshot(snapshotInput()).snapshotId, /^[0-9a-f]{64}$/);
	});

	it("changes id when any frozen input changes", () => {
		const base = freezeSnapshot(snapshotInput()).snapshotId;
		assert.notEqual(freezeSnapshot(snapshotInput({ contextRefs: ["b".repeat(64)] })).snapshotId, base);
		assert.notEqual(freezeSnapshot(snapshotInput({ corpusSnapshotId: "corpus-2" })).snapshotId, base);
		assert.notEqual(freezeSnapshot(snapshotInput({ capabilityId: "d".repeat(64) })).snapshotId, base);
		assert.notEqual(freezeSnapshot(snapshotInput({ permissionProjection: { pathPrefixes: [""], write: false } })).snapshotId, base);
		assert.notEqual(freezeSnapshot(snapshotInput({ representationId: "other" })).snapshotId, base);
	});

	it("does not depend on the order context references were collected in", () => {
		const forward = freezeSnapshot(snapshotInput({ contextRefs: ["a".repeat(64), "b".repeat(64)] }));
		const reversed = freezeSnapshot(snapshotInput({ contextRefs: ["b".repeat(64), "a".repeat(64)] }));
		assert.equal(forward.snapshotId, reversed.snapshotId);
	});

	it("drops a duplicate reference instead of paying for it twice", () => {
		const frozen = freezeSnapshot(snapshotInput({ contextRefs: ["a".repeat(64), "a".repeat(64)] }));
		assert.deepEqual(frozen.contextRefs, ["a".repeat(64)]);
	});

	it("refuses more references than the contract allows", () => {
		const many = Array.from({ length: 33 }, (_unused, index) => index.toString(16).padStart(64, "0"));
		assert.throws(() => freezeSnapshot(snapshotInput({ contextRefs: many })), /contextRefs/);
	});

	it("refuses a reference that is not a content id", () => {
		assert.throws(() => freezeSnapshot(snapshotInput({ contextRefs: ["../../etc/passwd"] })), /contextRefs/);
	});
});

describe("envelope construction", () => {
	it("binds the request, run, attempt and both session identities", () => {
		const envelope = buildEnvelope(envelopeInput());
		assert.equal(envelope.protocolVersion, SYNAPSE_PROTOCOL_VERSION);
		assert.equal(envelope.requestId, "req-1");
		assert.equal(envelope.ownerRunId, "owner-1");
		assert.equal(envelope.attempt, 1);
		assert.equal(envelope.senderSessionId, "sess-main");
		assert.equal(envelope.receiverSessionId, "sess-child");
		assert.equal(envelope.action, "retrieve");
		assert.deepEqual(envelope.inputParams, { query: "residual encoder" });
	});

	it("carries the namespace, snapshot, capability and corpus the host froze", () => {
		const envelope = buildEnvelope(envelopeInput());
		assert.equal(envelope.namespaceId, "0123456789abcdef");
		assert.match(envelope.snapshotId, /^[0-9a-f]{64}$/);
		assert.equal(envelope.capabilityId, "c".repeat(64));
		assert.equal(envelope.corpusSnapshotId, "corpus-1");
		assert.deepEqual(envelope.contextRefs, ["a".repeat(64)]);
	});

	it("has no state reference unless one was supplied", () => {
		assert.equal(buildEnvelope(envelopeInput()).stateRef, null);
	});

	it("reserves the fields residual coding will need, so P4 changes no protocol version", () => {
		const envelope = buildEnvelope(
			envelopeInput({
				stateRef: {
					baseMemoryId: null,
					byteLength: 4096,
					dim: 1024,
					encoding: "float32-vector",
					payloadId: "e".repeat(64),
					representationId: "siliconflow/BAAI/bge-m3/1024/l2/f32le",
					sha256: "f".repeat(64),
				},
			}),
		);
		assert.equal(envelope.stateRef?.encoding, "float32-vector");
		assert.equal(envelope.stateRef?.baseMemoryId, null);
		assert.equal(envelope.protocolVersion, 1);
	});

	it("measures its own control bytes so the envelope is not free in the accounting", () => {
		const envelope = buildEnvelope(envelopeInput());
		assert.ok(envelope.envelopeBytes > 0);
		assert.equal(envelope.envelopeBytes, Buffer.byteLength(JSON.stringify(envelope.wire), "utf-8"));
	});
});

describe("envelope parsing", () => {
	it("round-trips an envelope through its wire form", () => {
		const envelope = buildEnvelope(envelopeInput());
		assert.deepEqual(parseEnvelope(envelope.wire), envelope.wire);
	});

	it("rejects a protocol version it does not know", () => {
		const envelope = buildEnvelope(envelopeInput());
		assert.throws(() => parseEnvelope({ ...envelope.wire, protocolVersion: 2 }), /protocolVersion/);
	});

	it("rejects an envelope missing a bound identity rather than filling in a default", () => {
		const envelope = buildEnvelope(envelopeInput());
		const { receiverSessionId: _dropped, ...withoutReceiver } = envelope.wire;
		assert.throws(() => parseEnvelope(withoutReceiver), /envelope/);
	});

	it("rejects an unknown field, since an ignored field is a silently different contract", () => {
		const envelope = buildEnvelope(envelopeInput());
		assert.throws(() => parseEnvelope({ ...envelope.wire, residualHint: true }), /envelope/);
	});

	it("rejects a full vector whose declared length disagrees with its dimension", () => {
		const stateRef = {
			baseMemoryId: null,
			byteLength: 4096,
			dim: 1024,
			encoding: "float32-vector" as const,
			payloadId: "e".repeat(64),
			representationId: "rep",
			sha256: "f".repeat(64),
		};
		assert.doesNotThrow(() => buildEnvelope(envelopeInput({ stateRef })));
		assert.throws(() => buildEnvelope(envelopeInput({ stateRef: { ...stateRef, byteLength: 100 } })), /byteLength/);
		const tampered = buildEnvelope(envelopeInput({ stateRef })).wire;
		assert.throws(() => parseEnvelope({ ...tampered, stateRef: { ...stateRef, byteLength: 100 } }), /byteLength/);
	});

	it("allows a delta payload to be shorter than the full vector but never longer", () => {
		// A residual that exceeded the full vector would have no reason to exist.
		const stateRef = {
			baseMemoryId: "a".repeat(64),
			byteLength: 900,
			dim: 1024,
			encoding: "delta" as const,
			payloadId: "e".repeat(64),
			representationId: "rep",
			sha256: "f".repeat(64),
		};
		assert.doesNotThrow(() => buildEnvelope(envelopeInput({ stateRef })));
		assert.throws(() => buildEnvelope(envelopeInput({ stateRef: { ...stateRef, byteLength: 5000 } })), /byteLength/);
	});

	it("requires a delta to name the base it was computed against", () => {
		const stateRef = {
			baseMemoryId: null,
			byteLength: 900,
			dim: 1024,
			encoding: "delta" as const,
			payloadId: "e".repeat(64),
			representationId: "rep",
			sha256: "f".repeat(64),
		};
		assert.throws(() => buildEnvelope(envelopeInput({ stateRef })), /baseMemoryId/);
	});
});
