import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBytes, formatNanoseconds, renderObservation } from "../../src/observation/render.ts";
import type { ObservationCategoryView, ObservationRunView } from "../../src/observation/aggregate.ts";

function categoryView(readBytes: number, writeBytes: number, readOps = 1, writeOps = 1): ObservationCategoryView {
	return {
		failedOps: 0,
		readBytes,
		readLatency: { approxP95Ns: readOps === 0 ? null : 2048, meanNs: readOps === 0 ? null : 1200, operations: readOps },
		readOps,
		writeBytes,
		writeLatency: { approxP95Ns: writeOps === 0 ? null : 8192, meanNs: writeOps === 0 ? null : 5000, operations: writeOps },
		writeOps,
	};
}

function measuredView(overrides: Partial<Extract<ObservationRunView, { measured: true }>> = {}): ObservationRunView {
	return {
		attribution: "exclusive",
		categories: {
			content: categoryView(1_048_576, 524_288, 40, 12),
			envelope: categoryView(4096, 2048, 4, 2),
			memoryIndex: categoryView(0, 0, 0, 0),
			unclassified: categoryView(0, 0, 0, 0),
		},
		coverage: "active",
		gaps: [],
		incompleteReasons: [],
		measured: true,
		observedFromMs: 1000,
		processes: 4,
		totals: categoryView(1_052_672, 526_336, 44, 14),
		...overrides,
	};
}

describe("byte and duration formatting", () => {
	it("keeps small values exact and scales larger ones", () => {
		assert.equal(formatBytes(512), "512 B");
		assert.equal(formatBytes(2048), "2.0 KB");
		assert.equal(formatBytes(1024 * 1024 * 5), "5.0 MB");
	});

	it("prints an unmeasured duration as a dash, never as zero", () => {
		assert.equal(formatNanoseconds(null), "—");
		assert.equal(formatNanoseconds(900), "900ns");
		assert.equal(formatNanoseconds(1500), "1.5µs");
	});
});

describe("fleet view projection", () => {
	it("renders nothing at all when the feature is off", () => {
		const lines = renderObservation({ coverage: "disabled", detail: "systemObservation.enabled is false", measured: false }, { scope: "background", verbose: true });
		assert.deepEqual(lines, []);
	});

	it("says why a measurement is missing instead of printing zeros", () => {
		const lines = renderObservation({ coverage: "unavailable", detail: "no collector snapshot has been received", measured: false }, { scope: "background", verbose: false });
		assert.equal(lines.length, 1);
		assert.match(lines[0] ?? "", /unavailable — no collector snapshot/);
		assert.doesNotMatch(lines[0] ?? "", /0 B/);
	});

	it("shows the coverage state, byte counts and bounded percentile", () => {
		const lines = renderObservation(measuredView(), { scope: "background", verbose: false });
		assert.match(lines[0] ?? "", /active · 4 background processes/);
		assert.match(lines[1] ?? "", /read {2}1.0 MB in 44 ops/);
		assert.match(lines[1] ?? "", /p95 ≤2.0µs/);
		assert.match(lines[2] ?? "", /write 514 KB in 14 ops/);
	});

	it("counts a foreground session once instead of per child", () => {
		const lines = renderObservation(measuredView(), { scope: "foreground", verbose: false });
		assert.match(lines[0] ?? "", /counted once for all its children/);
	});

	it("names a shared process as shared rather than splitting it", () => {
		const lines = renderObservation(measuredView({ attribution: "shared", processes: 2 }), { scope: "background", verbose: false });
		assert.match(lines[0] ?? "", /shared process summary across 2 registrations/);
	});

	it("lists gaps and caveats in detail, and refuses to merge kernel and logical bytes", () => {
		const lines = renderObservation(
			measuredView({
				coverage: "partial",
				gaps: [{ fromMs: 1000, reason: "collector-restart", toMs: 1600 }],
				incompleteReasons: ["observation started 900ms after the run"],
			}),
			{ scope: "background", verbose: true },
		);
		const body = lines.join("\n");
		assert.match(body, /! observation started 900ms after the run/);
		assert.match(body, /! observation gap \(collector-restart, 600ms\)/);
		assert.match(body, /not added to them/);
		assert.match(body, /envelope r 4.0 KB \/ w 2.0 KB/);
		// A category with no operations is left out rather than shown as zero.
		assert.doesNotMatch(body, /unclassified/);
	});
});
