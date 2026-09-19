import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildObservationArtifact, observationArtifactPath, writeObservationArtifact } from "../../src/observation/artifact.ts";
import type { ObservationCategoryView, ObservationRunView } from "../../src/observation/aggregate.ts";

const WATCHED = ["vfs_read", "vfs_write", "vfs_readv", "vfs_writev"];
const EXCLUDED = ["mmap", "io_uring", "splice"];

let root = "";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-observation-"));
});

afterEach(() => {
	fs.rmSync(root, { force: true, recursive: true });
});

function categoryView(readBytes: number, writeBytes: number): ObservationCategoryView {
	return {
		failedOps: 0,
		readBytes,
		readLatency: { approxP95Ns: 2048, meanNs: 1200, operations: 3 },
		readOps: 3,
		writeBytes,
		writeLatency: { approxP95Ns: null, meanNs: null, operations: 0 },
		writeOps: 0,
	};
}

const MEASURED: ObservationRunView = {
	attribution: "exclusive",
	categories: {
		content: categoryView(2048, 0),
		envelope: categoryView(1024, 0),
		memoryIndex: categoryView(0, 0),
		unclassified: categoryView(0, 0),
	},
	coverage: "partial",
	gaps: [],
	incompleteReasons: ["collector restarted mid-run"],
	measured: true,
	observedFromMs: 1000,
	processes: 2,
	totals: categoryView(3072, 0),
};

describe("run observation artifact", () => {
	it("always states which call paths were watched and which were not", () => {
		const artifact = buildObservationArtifact({ excluded: EXCLUDED, nowMs: 9000, runId: "run-1", view: MEASURED, watched: WATCHED });
		assert.deepEqual(artifact.coverageBoundary.watched, WATCHED);
		assert.deepEqual(artifact.coverageBoundary.excluded, EXCLUDED);
		assert.match(artifact.note, /must not be summed with them/);
	});

	it("records an unmeasured direction as unavailable, not as zero", () => {
		const artifact = buildObservationArtifact({ excluded: EXCLUDED, nowMs: 9000, runId: "run-1", view: MEASURED, watched: WATCHED });
		assert.notEqual(artifact.totals, "unavailable");
		if (artifact.totals === "unavailable") throw new Error("unreachable");
		assert.equal(artifact.totals.write.meanNs, "unavailable");
		assert.equal(artifact.totals.write.approxP95Ns, "unavailable");
		// Bytes really were zero and are reported as zero; only the unmeasured
		// latency becomes unavailable.
		assert.equal(artifact.totals.write.bytes, 0);
	});

	it("writes an artifact even for a run nothing observed, so the gap is on record", () => {
		const artifact = buildObservationArtifact({
			excluded: EXCLUDED,
			nowMs: 9000,
			runId: "run-1",
			view: { coverage: "unavailable", detail: "no collector snapshot has been received", measured: false },
			watched: WATCHED,
		});
		assert.equal(artifact.measured, false);
		assert.equal(artifact.totals, "unavailable");
		assert.equal(artifact.categories, "unavailable");
		assert.equal(artifact.processes, "unavailable");
		assert.deepEqual(artifact.incompleteReasons, ["no collector snapshot has been received"]);
	});

	it("lands beside the metering log in the directory the classifier excludes", () => {
		const target = observationArtifactPath(root, "run-1");
		assert.equal(path.dirname(target), path.join(root, "observation"));
	});

	it("sanitises a run id so it cannot escape the observation directory", () => {
		const target = observationArtifactPath(root, "../../escape");
		assert.equal(path.dirname(target), path.join(root, "observation"));
		assert.equal(path.basename(target), ".._.._escape.json");
	});

	it("writes readable JSON that keeps the incompleteness visible", () => {
		const artifact = buildObservationArtifact({ excluded: EXCLUDED, nowMs: 9000, runId: "run-1", view: MEASURED, watched: WATCHED });
		const target = writeObservationArtifact(root, artifact);
		const parsed = JSON.parse(fs.readFileSync(target, "utf-8"));
		assert.equal(parsed.coverage, "partial");
		assert.deepEqual(parsed.incompleteReasons, ["collector restarted mid-run"]);
		assert.equal(parsed.schemaVersion, 1);
	});
});
