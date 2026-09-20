import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	cosineInt,
	decodeDelta,
	DeltaDecodeError,
	dequantize,
	encodeDelta,
	quantize,
	roundHalfEven,
} from "../../src/synapse/delta.ts";

/**
 * The codec is a port of the Python reference in the SYNAPSE repository
 * (src/synapse/stateplane/residual.py), so every assertion here has a
 * counterpart that was run against that reference: the first four restate the
 * documented algorithm on inputs this file builds itself, and the fifth replays
 * a committed fixture the reference produced, byte for byte.
 */

type GoldenCoverage = {
	exactHalfTies: number;
	clampedComponents: number;
	nonzeroComponents: number;
};

type GoldenCase = {
	name: string;
	dim: number;
	grid: number;
	threshold: number;
	baseMemoryId: string;
	y: number[];
	b: number[];
	nnz: number;
	payloadHex: string;
	yhat: number[];
	coverage: GoldenCoverage;
};

type GoldenFixture = {
	reference: { module: string; sha256: string; indexBytes: number; stride: number };
	cases: GoldenCase[];
};

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "delta-golden.json");
// SAFETY: this file is a committed artifact of scripts/gen-delta-golden.mjs, which writes exactly the shape declared above.
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8")) as GoldenFixture;

const STRIDE = 3;
const GRID = 64;
const THRESHOLD = 0.97;

/**
 * Fixed-seed LCG. The assertions below depend on the exact vector, so the
 * generator is spelled out here rather than reached for from Math.random.
 */
function deterministicVector(dim: number, seed: number): Float32Array {
	const values = new Float32Array(dim);
	let state = seed >>> 0;
	for (let index = 0; index < dim; index += 1) {
		state = (state * 1664525 + 1013904223) >>> 0;
		values[index] = (state / 4294967296) * 2 - 1;
	}
	return values;
}

/** The companion noise the Python fixture generator mixes into a base vector. */
function mixedBase(target: Float32Array, mix: number): Float32Array {
	const base = new Float32Array(target.length);
	for (let index = 0; index < target.length; index += 1) {
		const noise = ((index * 37) % 101) / 101 - 0.5;
		base[index] = mix * target[index]! + (1 - mix) * noise;
	}
	return base;
}

/**
 * A vector built for the two tail behaviours, because random values produce
 * neither: components on the grid's zero (so a correction of exactly zero
 * exists at all) and components at full grid magnitude (whose doubled correction
 * leaves the int8 range). The second matters as much as the first — without a
 * clamped component the base below reconstructs the target exactly, the
 * threshold fires at the same moment the tail would, and the tail branch is
 * never consulted.
 */
function tailAndClampTarget(dim: number, seed: number): Float32Array {
	const values = deterministicVector(dim, seed);
	for (let index = 0; index < dim; index += 1) {
		if (index % 32 === 0) values[index] = 0;
		else if (index % 8 === 1) values[index] = 1;
	}
	return values;
}

function floatCosine(left: Float32Array, right: Float32Array): number {
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index += 1) {
		const l = left[index]!;
		const r = right[index]!;
		dot += l * r;
		leftNorm += l * l;
		rightNorm += r * r;
	}
	const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
	return denominator === 0 ? 0 : dot / denominator;
}

function countNonZero(values: Int32Array): number {
	let count = 0;
	for (const value of values) {
		if (value !== 0) count += 1;
	}
	return count;
}

function countExactHalfTies(values: Float32Array, grid: number): number {
	let count = 0;
	for (const value of values) {
		const scaled = value * grid;
		if (scaled - Math.floor(scaled) === 0.5) count += 1;
	}
	return count;
}

/** Recomputes the reference's clamp count independently of the codec. */
function countClamped(target: Int32Array, base: Int32Array): number {
	let count = 0;
	for (let index = 0; index < target.length; index += 1) {
		const residual = target[index]! - base[index]!;
		if (Math.max(-127, Math.min(127, residual)) !== residual) count += 1;
	}
	return count;
}

/** Reads the index column back out of the wire bytes without using the codec. */
function indicesFrom(payload: Uint8Array): number[] {
	const indexes: number[] = [];
	for (let offset = 0; offset + STRIDE <= payload.length; offset += STRIDE) {
		indexes.push(payload[offset]! | (payload[offset + 1]! << 8));
	}
	return indexes;
}

/** Rebuilds the decoded vector from the raw bytes; an independent second reader of the same layout. */
function rebuildFromBytes(payload: Uint8Array, base: Int32Array): Int32Array {
	const rebuilt = Int32Array.from(base);
	for (let offset = 0; offset + STRIDE <= payload.length; offset += STRIDE) {
		const index = payload[offset]! | (payload[offset + 1]! << 8);
		const raw = payload[offset + 2]!;
		rebuilt[index] = base[index]! + (raw >= 128 ? raw - 256 : raw);
	}
	return rebuilt;
}

function hexOf(payload: Uint8Array): string {
	return Buffer.from(payload).toString("hex");
}

describe("delta codec", () => {
	it("rounds halves to even, as the reference quantizer does (assertion 1)", () => {
		const halves: readonly (readonly [number, number])[] = [
			[0.5, 0],
			[1.5, 2],
			[2.5, 2],
			[3.5, 4],
			[4.5, 4],
			[-0.5, 0],
			[-1.5, -2],
			[-2.5, -2],
			[-3.5, -4],
		];
		for (const [input, expected] of halves) {
			assert.equal(roundHalfEven(input), expected, `roundHalfEven(${input})`);
		}
		const offGrid: readonly (readonly [number, number])[] = [
			[0.25, 0],
			[0.75, 1],
			[-0.25, 0],
			[-0.75, -1],
			[0, 0],
			[7, 7],
			[-7, -7],
		];
		for (const [input, expected] of offGrid) {
			assert.equal(roundHalfEven(input), expected, `roundHalfEven(${input})`);
		}
		// The point of writing this by hand: Math.round disagrees on the odd halves.
		assert.notEqual(roundHalfEven(0.5), Math.round(0.5));
		assert.notEqual(roundHalfEven(2.5), Math.round(2.5));
		assert.notEqual(roundHalfEven(4.5), Math.round(4.5));
	});

	it("sends nothing for a perfect base and selects every residual for an unreachable threshold (assertion 2)", () => {
		const target = quantize(tailAndClampTarget(64, 1234), GRID);

		const perfectBase = encodeDelta(target, quantize(tailAndClampTarget(64, 1234), GRID), { grid: GRID, threshold: THRESHOLD });
		assert.equal(perfectBase.nnz, 0);
		assert.equal(perfectBase.payload.length, 0);

		const zeroBase = new Int32Array(target.length);
		const reachable = encodeDelta(target, zeroBase, { grid: GRID, threshold: THRESHOLD });
		const nonZeroComponents = countNonZero(target);
		assert.ok(nonZeroComponents < target.length, "this case needs zero components for the tail branch to be reachable");

		// With a zero base the cosine climbs as components arrive, so the default
		// threshold stops the loop early: fewer components than the target has.
		assert.ok(reachable.nnz > 0, "a zero base must still send the leading components");
		assert.ok(reachable.nnz < nonZeroComponents, `expected an early stop, got ${reachable.nnz} of ${nonZeroComponents}`);
		// This pair sits at or below 256 dimensions with a non-empty payload, which is
		// the one regime where this port and the reference differ in layout: the port
		// keeps its two-byte index where the reference narrows to one. Asserting the
		// fixed stride here pins that choice rather than leaving it incidental.
		assert.equal(reachable.payload.length, reachable.nnz * STRIDE);

		// The card's own phrasing — a zero base selects every non-zero component —
		// holds once the threshold cannot stop the scan, which is what these two
		// assertions say together.
		const zeroBaseExhaustive = encodeDelta(target, zeroBase, { grid: GRID, threshold: 1 });
		assert.equal(zeroBaseExhaustive.nnz, nonZeroComponents);
		assert.equal(zeroBaseExhaustive.payload.length, nonZeroComponents * STRIDE);

		// An anti-correlated base doubles every correction, so components leave the
		// int8 range, the reconstruction never equals the target exactly, and a
		// threshold of 1 can never be met — which is what forces the scan past the
		// last non-zero component and onto the zero tail. That is the only shape in
		// which the tail branch can be observed at all: with a zero base the
		// reconstruction does reach the target, the threshold fires, and the branch
		// is never consulted.
		const antiBase = Int32Array.from(target, (value) => -value);
		const exhaustive = encodeDelta(target, antiBase, { grid: GRID, threshold: 1 });
		assert.equal(exhaustive.nnz, nonZeroComponents);
		assert.equal(exhaustive.payload.length, nonZeroComponents * STRIDE);

		// Components arrive in decreasing residual magnitude, ties by ascending
		// index; the reference relies on both to keep its byte count reproducible.
		const emitted = indicesFrom(exhaustive.payload);
		assert.equal(emitted.length, nonZeroComponents);
		const restored = decodeDelta(exhaustive.payload, antiBase);
		for (const index of emitted) {
			// The zero check runs before a component is appended, so nothing the
			// reconstruction already agrees with may be carried, and no carried value
			// may leave the int8 range. Move that check past the append and the first
			// assertion names the component; widen the clamp to ±128 and the second
			// one does.
			assert.notEqual(target[index], antiBase[index], `component ${index} was emitted with nothing to correct`);
			assert.ok(Math.abs(restored[index]! - antiBase[index]!) <= 127, `component ${index} left the int8 range`);
		}
		for (let position = 1; position < emitted.length; position += 1) {
			const residualOf = (index: number): number => Math.abs(target[index]! - antiBase[index]!);
			const previous = residualOf(emitted[position - 1]!);
			const current = residualOf(emitted[position]!);
			const ordered = previous > current || (previous === current && emitted[position - 1]! < emitted[position]!);
			assert.ok(ordered, `component order broke at position ${position}`);
		}
	});

	it("keeps a 0.9-similar base inside the quantized domain and above the threshold (assertion 3)", () => {
		const dim = 1024;
		const target = deterministicVector(dim, 20260919);
		const base = mixedBase(target, 0.5);
		const similarity = floatCosine(target, base);
		assert.ok(similarity > 0.85 && similarity < 0.95, `base similarity ${similarity} is not the intended ~0.9`);

		const targetQ = quantize(target, GRID);
		const baseQ = quantize(base, GRID);
		const encoded = encodeDelta(targetQ, baseQ, { grid: GRID, threshold: THRESHOLD });
		assert.ok(encoded.nnz > 0 && encoded.nnz < dim, `expected a partial residual, got ${encoded.nnz}`);
		assert.equal(encoded.payload.length, encoded.nnz * STRIDE);

		const decoded = decodeDelta(encoded.payload, baseQ);
		assert.deepEqual(decoded, rebuildFromBytes(encoded.payload, baseQ), "decoder disagrees with a direct read of the bytes");
		assert.equal(decoded.length, dim);

		// Residuals here stay inside the int8 range, so every emitted component must
		// come back exactly; the rest must still carry the base value.
		const emitted = new Set(indicesFrom(encoded.payload));
		for (let index = 0; index < dim; index += 1) {
			assert.equal(decoded[index], emitted.has(index) ? targetQ[index] : baseQ[index], `component ${index}`);
		}

		const restored = dequantize(decoded, GRID);
		assert.ok(Math.abs(Math.hypot(...restored) - 1) < 1e-6, "dequantize must return a unit vector");

		// The threshold is a contract on the quantized domain, which is the domain
		// the reference verifies in: it quantizes the true vector before comparing.
		const integerScore = cosineInt(decoded, targetQ);
		assert.ok(integerScore >= THRESHOLD, `quantized-domain cosine ${integerScore} fell below the threshold`);
		// Dequantizing must not move the score; it changes representation, not direction.
		assert.ok(
			Math.abs(floatCosine(restored, dequantize(targetQ, GRID)) - integerScore) < 1e-9,
			"dequantizing the reconstruction changed its similarity to the quantized target",
		);
		// Scored against the raw target instead of the quantized one, the same
		// reconstruction reads 1.28e-4 lower (0.969958 against 0.970087), and it
		// cannot read the threshold there: the target itself is off-grid, so even the
		// exact quantized target scores only 0.99997 against it, and a reconstruction
		// that stops short of exact stays below that. The gap is the grid's, not the
		// encoder's, which is why the bound below allows for it; the allowance is
		// 1e-3 against a measured gap of 1.28e-4, so it is ~7.8× the thing it covers
		// and real decoding degradation still lands outside it. The threshold's
		// contract is the quantized-domain assertion above, which is where the
		// reference verifies too.
		const rawScore = floatCosine(restored, target);
		assert.ok(rawScore >= THRESHOLD - 1e-3, `reconstruction scored ${rawScore} against the raw target`);
	});

	it("rejects malformed payloads and mismatched bases (assertion 4)", () => {
		const dim = 320;
		const targetQ = quantize(deterministicVector(dim, 5), GRID);
		const baseQ = new Int32Array(dim);
		const payload = encodeDelta(targetQ, baseQ, { grid: GRID, threshold: THRESHOLD }).payload;
		assert.ok(payload.length >= STRIDE, "this fixture needs a non-empty payload");

		// Bytes that do not divide into index/value triples.
		assert.throws(() => decodeDelta(payload.subarray(0, payload.length - 1), baseQ), DeltaDecodeError);
		// A component index the base cannot address.
		assert.throws(() => decodeDelta(Uint8Array.from([0xff, 0x07, 0x01]), baseQ), DeltaDecodeError);
		// No base to reconstruct into: the dimension would be undefined.
		assert.throws(() => decodeDelta(payload, new Int32Array(0)), DeltaDecodeError);
		// A base that does not match the target is a caller error, not wire corruption.
		assert.throws(() => encodeDelta(targetQ, new Int32Array(dim - 1), { grid: GRID, threshold: THRESHOLD }), /dimension/);
		assert.throws(() => cosineInt(targetQ, new Int32Array(dim - 1)), /dimension/);
		assert.throws(() => quantize(new Float32Array([0, Number.NaN, 1]), GRID), /non-finite/);
		// Outside the integer domain a component would wrap into a plausible-looking
		// neighbour, so it is refused at both ends: on the way in, and on the
		// subtraction that a wrapped pair would corrupt.
		assert.throws(() => quantize(Float32Array.from([2 ** 31]), 1), /int32/);
		assert.throws(
			() => encodeDelta(Int32Array.from([2147483647, 0]), Int32Array.from([-2147483647, 0]), { grid: GRID, threshold: THRESHOLD }),
			/comparison domain/,
		);
		// A well-formed payload against a base at the int32 edge would wrap the
		// reconstructed component, so the decode side refuses it for the same reason
		// the encode side refuses its own inputs.
		assert.throws(() => decodeDelta(Uint8Array.from([0x00, 0x00, 0x01]), Int32Array.from([2147483647])), DeltaDecodeError);
		// A dimension past what a two-byte index can address is refused, not truncated.
		assert.throws(
			() => encodeDelta(new Int32Array(65537), new Int32Array(65537), { grid: GRID, threshold: THRESHOLD }),
			/addressable maximum/,
		);
		// A grid that is not a positive integer has no grid points to round onto, and
		// a non-finite input has no rounding at all.
		assert.throws(() => quantize(new Float32Array([1]), 0), /positive integer grid/);
		assert.throws(() => quantize(new Float32Array([1]), 1.5), /positive integer grid/);
		assert.throws(() => dequantize(Int32Array.from([1]), -1), /positive integer grid/);
		assert.throws(() => roundHalfEven(Number.POSITIVE_INFINITY), /finite/);
	});

	it("matches the Python reference byte for byte on every golden case (assertion 5)", () => {
		// Pinned rather than decorative: a fixture regenerated from a different
		// revision of the reference must fail here instead of silently re-baselining
		// what "the same bytes" means. These two digests are what make a hand-edited
		// fixture visible; regenerating it means updating both deliberately. The file
		// is hashed with line endings normalised, because a checkout on a runner with
		// core.autocrlf=true would otherwise change the bytes of an identical fixture
		// and fail a block that says nothing about the codec.
		assert.equal(fixture.reference.sha256, "95cc29d0ff6d1f117a66e708cd4a7510066ade07f1265a20942a9af1bbfeb2d0");
		assert.equal(
			createHash("sha256")
				.update(fs.readFileSync(FIXTURE_PATH, "utf-8").replace(/\r\n/gu, "\n"))
				.digest("hex"),
			"6079a675fa1a48f73897c8714b131e651300b9ac848bf6c4f54fd33907d678f5",
		);
		assert.equal(fixture.reference.stride, STRIDE);
		assert.equal(fixture.reference.indexBytes, STRIDE - 1);
		assert.equal(fixture.cases.length, 3);

		for (const golden of fixture.cases) {
			const target = Float32Array.from(golden.y);
			const base = Float32Array.from(golden.b);
			const targetQ = quantize(target, golden.grid);
			const baseQ = quantize(base, golden.grid);
			const encoded = encodeDelta(targetQ, baseQ, { grid: golden.grid, threshold: golden.threshold });

			assert.equal(hexOf(encoded.payload), golden.payloadHex, `${golden.name}: payload bytes`);
			assert.equal(encoded.nnz, golden.nnz, `${golden.name}: non-zero components`);
			assert.deepEqual(Array.from(decodeDelta(encoded.payload, baseQ)), golden.yhat, `${golden.name}: decoded vector`);
			// The reference's own account of what this pair exercises must hold here
			// too: the same doubles, the same roundings, the same clamps. countClamped
			// recomputes the premise rather than the codec — how many components of
			// this pair fall outside the int8 range — so a regeneration that quietly
			// stopped exercising the clamp path is named instead of passing unnoticed.
			assert.equal(countExactHalfTies(target, golden.grid), golden.coverage.exactHalfTies, `${golden.name}: exact half ties`);
			assert.equal(countClamped(targetQ, baseQ), golden.coverage.clampedComponents, `${golden.name}: clamped components`);
			// What pins the clamp's behaviour is the byte comparison above plus these
			// two invariants, both of which are live on the clamped pair (g3): a clamp
			// widened to ±128 lands outside the signed-byte range once decoded, and a
			// zero check moved past the append carries a component that had nothing to
			// correct.
			const restoredGolden = decodeDelta(encoded.payload, baseQ);
			for (const index of indicesFrom(encoded.payload)) {
				assert.ok(
					Math.abs(restoredGolden[index]! - baseQ[index]!) <= 127,
					`${golden.name}: component ${index} left the int8 range`,
				);
				assert.notEqual(targetQ[index], baseQ[index], `${golden.name}: component ${index} was emitted with nothing to correct`);
			}
			// A bound on these frozen pairs, not a codec invariant: a pair whose target
			// is zero where its base is not would legitimately emit there. It still
			// catches wholesale over-emission, which is the failure mode that matters
			// here (the zero tail riding along in the payload).
			assert.ok(encoded.nnz <= golden.coverage.nonzeroComponents, `${golden.name}: emitted more components than the target's non-zero count`);
		}
	});

	it("scores quantized vectors without truncating the dimension", () => {
		assert.equal(cosineInt(Int32Array.from([3, 4]), Int32Array.from([3, 4])), 1);
		assert.equal(cosineInt(Int32Array.from([1, 0]), Int32Array.from([0, 1])), 0);
		// An empty side has no direction: zero, not NaN.
		assert.equal(cosineInt(new Int32Array(4), Int32Array.from([1, 2, 3, 4])), 0);

		// Scaling either side cannot move the score, and a shift of every component
		// must: this is the property the encoder's stop condition rests on.
		const dim = 1024;
		const targetQ = quantize(deterministicVector(dim, 99), GRID);
		const scaled = Int32Array.from(targetQ, (value) => value * 3);
		assert.ok(Math.abs(cosineInt(targetQ, scaled) - 1) < 1e-12, "a positive rescaling changed the score");
		assert.ok(cosineInt(targetQ, Int32Array.from(targetQ, (value) => value + 64)) < 1, "an offset left the score unchanged");
		assert.equal(cosineInt(new Int32Array(dim), targetQ), 0);
	});

	it("accepts the domain edges it documents and refuses the ones past them", () => {
		// A vector with no direction normalizes to zero rather than dividing by a zero
		// norm, so a comparison against it scores zero instead of returning NaN.
		assert.deepEqual(Array.from(dequantize(new Int32Array(4), GRID)), [0, 0, 0, 0]);

		// Grid points may sit anywhere inside the int32 domain, and the quantizer
		// refuses the first value past each edge rather than wrapping it.
		assert.deepEqual(Array.from(quantize(Float32Array.from([-2147483648]), 1)), [-2147483648]);
		assert.throws(() => quantize(Float32Array.from([-(2 ** 32)]), 1), /int32/);

		// The largest addressable dimension is accepted; one past it is refused above.
		const largest = new Int32Array(65536);
		assert.equal(encodeDelta(largest, Int32Array.from(largest), { grid: GRID, threshold: THRESHOLD }).payload.length, 0);

		// A repeated component index resolves last-wins, which is what the reference's
		// assignment order does too.
		assert.deepEqual(Array.from(decodeDelta(Uint8Array.from([0x00, 0x00, 0x05, 0x00, 0x00, 0x03]), Int32Array.from([10]))), [13]);

		// The decode-side domain guard has a negative edge as well as a positive one.
		assert.throws(() => decodeDelta(Uint8Array.from([0x00, 0x00, 0xff]), Int32Array.from([-2147483648])), DeltaDecodeError);

		// The threshold is inclusive: a score exactly equal to it stops the scan, as
		// the reference's `>=` does, rather than being rounded past. The equality is
		// exact in the integer domain — after one component the score is 16/20 — so
		// this pair distinguishes `>=` from `>` where no other case here does.
		assert.equal(cosineInt(Int32Array.from([0, 4]), Int32Array.from([3, 4])), 0.8);
		const atThreshold = encodeDelta(Int32Array.from([3, 4]), new Int32Array(2), { grid: 1, threshold: 0.8 });
		assert.equal(atThreshold.nnz, 1, "a score exactly at the threshold must stop the scan");
		assert.equal(atThreshold.payload.length, STRIDE);

		// A non-finite threshold would silently never stop the scan, so it is refused
		// rather than producing a payload that looks merely larger than it should.
		assert.throws(() => encodeDelta(Int32Array.from([5]), Int32Array.from([0]), { grid: GRID, threshold: Number.NaN }), /finite threshold/);
	});
});
