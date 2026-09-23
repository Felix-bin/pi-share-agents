import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifySynapseError, SYNAPSE_ERROR_CATEGORIES, taskOutcomeFor } from "../../src/synapse/errors.ts";

describe("synapse error classification", () => {
	it("maps a refused read or write to permission", () => {
		assert.equal(classifySynapseError(new Error("not-authorised: retriever may not read abc")), "permission");
		assert.equal(classifySynapseError(new Error("outside-root: \"../secrets\"")), "permission");
	});

	it("separates a source that changed from a source that is gone", () => {
		assert.equal(classifySynapseError(new Error("source-stale: src/a.ts")), "source-stale");
		assert.equal(classifySynapseError(new Error("historical: abc was superseded")), "source-stale");
		assert.equal(classifySynapseError(new Error("source-missing: src/a.ts")), "object-unavailable");
		assert.equal(classifySynapseError(new Error("object-unavailable: abc")), "object-unavailable");
		assert.equal(classifySynapseError(new Error("unknown-memory: abc")), "object-unavailable");
	});

	it("maps corruption and dangling references to integrity", () => {
		assert.equal(classifySynapseError(new Error("integrity: object abc no longer matches its digest")), "integrity");
		assert.equal(classifySynapseError(new Error("orphan: memory abc references missing object def")), "integrity");
		assert.equal(classifySynapseError(new Error("namespace-corrupt: /store/namespace.json")), "integrity");
	});

	it("maps rejected input and store mismatch to configuration", () => {
		assert.equal(classifySynapseError(new Error("synapse.mode must be one of off / text / synapse")), "configuration");
		assert.equal(classifySynapseError(new Error("k-out-of-range: 50 is not an integer in 1..20")), "configuration");
		assert.equal(classifySynapseError(new Error("summary-too-large: 4096 > 2048")), "configuration");
		assert.equal(classifySynapseError(new Error("namespace-mismatch: /store belongs to /other")), "configuration");
	});

	it("maps an overlong uds endpoint path to configuration, like other bound violations", () => {
		assert.equal(
			classifySynapseError(new Error('uds-endpoint-path-too-long: storageRoot contributes 130 of the 145 bytes in "..."')),
			"configuration",
		);
	});

	it("maps an oversized frame's declared length to configuration, the same shape as other bound violations", () => {
		assert.equal(
			classifySynapseError(new Error("frame-too-large: length prefix declares 99999999 bytes, exceeding the 1048576-byte limit")),
			"configuration",
		);
	});

	it("maps a frame that ended mid-stream to integrity, like other corrupted-or-incomplete data", () => {
		assert.equal(
			classifySynapseError(new Error("frame-truncated: stream ended with 5 buffered byte(s) short of a complete frame")),
			"integrity",
		);
	});

	it("maps a missing representation capability to representation", () => {
		assert.equal(classifySynapseError(new Error("capability-unavailable: state-retrieval is not wired in this build")), "representation");
		assert.equal(classifySynapseError(new Error("representation-mismatch: dim 512 != 1024")), "representation");
	});

	it("maps a store that cannot accept the write to persistence", () => {
		assert.equal(classifySynapseError(new Error("maxObjectBytes exceeded: 2097152 > 1048576")), "persistence");
		assert.equal(classifySynapseError(new Error("persistence: disk full")), "persistence");
	});

	it("maps a uds delivery that found no listening peer to persistence, not to a silent empty success", () => {
		assert.equal(classifySynapseError(new Error("persistence: uds delivery to /run/x.sock found no peer listening (ECONNREFUSED): connect ECONNREFUSED")), "persistence");
	});

	it("keeps cancellation and timeout distinct from failure", () => {
		assert.equal(classifySynapseError(new Error("cancelled: user aborted the run")), "cancelled");
		assert.equal(classifySynapseError(new Error("timeout: deadline exceeded")), "timeout");
	});

	it("reports an unrecognised error as unclassified instead of guessing a category", () => {
		// Bucketing an unknown failure into a known category would make an unhandled
		// crash look like an ordinary, expected outcome in the run log.
		assert.equal(classifySynapseError(new Error("TypeError: x is not a function")), "unclassified");
		assert.equal(classifySynapseError("not even an error"), "unclassified");
		assert.equal(classifySynapseError(undefined), "unclassified");
	});

	it("exposes exactly the categories the design fixes", () => {
		assert.deepEqual([...SYNAPSE_ERROR_CATEGORIES].sort(), [
			"cancelled",
			"configuration",
			"integrity",
			"object-unavailable",
			"permission",
			"persistence",
			"representation",
			"source-stale",
			"timeout",
		]);
	});
});

describe("terminal-state mapping", () => {
	it("never maps a failure to a successful outcome", () => {
		for (const category of SYNAPSE_ERROR_CATEGORIES) {
			assert.notEqual(taskOutcomeFor(category), "completed");
		}
		assert.notEqual(taskOutcomeFor("unclassified"), "completed");
	});

	it("keeps cancellation distinct from failure so a cancelled run is not counted as an error", () => {
		assert.equal(taskOutcomeFor("cancelled"), "cancelled");
		assert.equal(taskOutcomeFor("timeout"), "failed");
		assert.equal(taskOutcomeFor("permission"), "failed");
	});

	it("reuses the upstream outcome vocabulary rather than inventing a SYNAPSE-only state", () => {
		const outcomes = new Set([...SYNAPSE_ERROR_CATEGORIES].map(taskOutcomeFor));
		assert.deepEqual([...outcomes].sort(), ["cancelled", "failed"]);
	});
});
