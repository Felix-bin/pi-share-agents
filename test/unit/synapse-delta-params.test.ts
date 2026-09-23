import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cosineInt, decodeDelta, encodeDelta, dequantize } from "../../src/synapse/delta.ts";
import { SYNAPSE_DELTA_CALIBRATION_ID, SYNAPSE_DELTA_LAYOUT, SYNAPSE_DELTA_PARAMS } from "../../src/synapse/delta-params.ts";

/**
 * The frozen parameters are only frozen if the report that chose them and the
 * constants that carry them cannot drift apart. These checks read the shipped
 * calibration and assert the constants against it, so editing one without the
 * other fails here rather than in a handoff.
 */
type ScanRow = {
	consistency: number;
	grid: number;
	layout: string;
	meanPayloadBytes: number;
	threshold: number;
};

type CalibrationReport = {
	recording: { mode: string };
	scan: ScanRow[];
	selection: {
		perfectCombinations: number;
		selected: { grid: number; layout: string; threshold: number };
		selectedConsistency: number;
		withinTolerance: {
			consistencyTolerance: number;
			selected: { grid: number; layout: string; threshold: number };
			selectedMeanPayloadBytes: number;
		};
	};
};

const REPORT_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"docs",
	"experiments",
	`${SYNAPSE_DELTA_CALIBRATION_ID}.json`,
);

const report: CalibrationReport = JSON.parse(fs.readFileSync(REPORT_PATH, "utf-8"));

/** The widest grid whose quantized values still fit a layout's value field. */
function gridLimitOf(layout: string): number | undefined {
	switch (layout) {
		case "int8":
			return 127;
		case "int16":
			return 32767;
		default:
			return undefined;
	}
}

describe("synapse frozen delta parameters", () => {
	it("freezes the point the calibration named, not a hand-written one", () => {
		const chosen = report.selection.withinTolerance.selected;
		assert.equal(SYNAPSE_DELTA_PARAMS.grid, chosen.grid);
		assert.equal(SYNAPSE_DELTA_PARAMS.threshold, chosen.threshold);
		assert.equal(SYNAPSE_DELTA_LAYOUT, chosen.layout);
	});

	it("freezes a grid that the frozen layout can actually represent", () => {
		const limit = gridLimitOf(SYNAPSE_DELTA_LAYOUT);
		assert.ok(limit !== undefined, `unknown layout ${SYNAPSE_DELTA_LAYOUT}`);
		// A grid wider than the value field silently clamps every large residual; the
		// calibration would then have measured a different codec than the one wired.
		assert.ok(SYNAPSE_DELTA_PARAMS.grid <= limit, `grid ${SYNAPSE_DELTA_PARAMS.grid} exceeds the ${SYNAPSE_DELTA_LAYOUT} range of ${limit}`);
	});

	it("freezes a point that was actually scanned", () => {
		const row = report.scan.find((candidate) => candidate.grid === SYNAPSE_DELTA_PARAMS.grid && candidate.threshold === SYNAPSE_DELTA_PARAMS.threshold);
		assert.ok(row, "the frozen (grid, threshold) does not appear in the calibration's scan table");
		assert.equal(row.layout, SYNAPSE_DELTA_LAYOUT);
		// The mean the report publishes for that row is what any byte claim has to
		// trace back to, so it must be the row the constants point at.
		assert.equal(row.meanPayloadBytes, report.selection.withinTolerance.selectedMeanPayloadBytes);
	});

	it("freezes the cheapest point within the calibration's stated tolerance of the best consistency", () => {
		const best = Math.max(...report.scan.map((row) => row.consistency));
		const tolerance = report.selection.withinTolerance.consistencyTolerance;
		const eligible = report.scan.filter((row) => best - row.consistency <= tolerance);
		assert.ok(eligible.length > 0, "the tolerance admits no scanned row");
		const cheapest = Math.min(...eligible.map((row) => row.meanPayloadBytes));
		const row = report.scan.find((candidate) => candidate.grid === SYNAPSE_DELTA_PARAMS.grid && candidate.threshold === SYNAPSE_DELTA_PARAMS.threshold);
		assert.ok(row);
		assert.equal(row.meanPayloadBytes, cheapest, "a cheaper scanned point sits within the tolerance, so the frozen point is not the one the rule picks");
	});

	it("keeps the downgrade on the record: full consistency was not reached", () => {
		// The card allows freezing an imperfect point only alongside an honest
		// statement that it is imperfect. If a later calibration does reach full
		// consistency, this assertion is what makes someone update the claim text
		// rather than leave the old wording in place.
		assert.equal(report.selection.perfectCombinations, 0);
		assert.ok(report.selection.selectedConsistency < 1);
	});

	it("round-trips with the frozen parameters, at the frozen layout's stride", () => {
		const dim = 64;
		const target = new Int32Array(dim);
		for (let index = 0; index < dim; index += 1) target[index] = Math.round(Math.sin(index) * SYNAPSE_DELTA_PARAMS.grid);
		// A base that points roughly the target's way but carries none of its last
		// two fifths: scaling the target would be parallel to it, and the encoder
		// would stop before emitting anything.
		const base = Int32Array.from(target);
		for (let index = Math.floor(dim * 0.6); index < dim; index += 1) base[index] = 0;
		const encoding = encodeDelta(target, base, SYNAPSE_DELTA_PARAMS);
		assert.equal(encoding.payload.byteLength % 3, 0, "the frozen layout is stride 3");
		assert.equal(encoding.payload.byteLength, encoding.nnz * 3);
		const decoded = decodeDelta(encoding.payload, base);
		// The encoder's contract is that it stopped only once the reconstruction it
		// built reached the threshold, and the receiver must see that same vector.
		assert.ok(cosineInt(decoded, target) >= SYNAPSE_DELTA_PARAMS.threshold, "decoded reconstruction is below the frozen threshold");
		assert.ok(encoding.nnz > 0, "a base missing two fifths of the target must emit components");
		assert.ok(encoding.nnz <= dim);
		const recovered = dequantize(decoded, SYNAPSE_DELTA_PARAMS.grid);
		assert.equal(recovered.length, dim);
		for (const value of recovered) assert.ok(Number.isFinite(value));
	});

	it("caps a frozen-layout payload below the vector it replaces", () => {
		// Stride 3 over 1024 components is 3072 bytes; a float32 vector is 4096. The
		// bound is what lets the sender's rate-distortion check stay a formality
		// instead of a coin flip, and it only holds while the layout is int8.
		const stride = SYNAPSE_DELTA_LAYOUT === "int8" ? 3 : 4;
		const dim = 1024;
		assert.ok(stride * dim < dim * 4, `stride ${stride} can reach or exceed the ${dim * 4}-byte full vector`);
	});
});
