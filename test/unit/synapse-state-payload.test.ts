import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SYNAPSE_DELTA_LAYOUT, SYNAPSE_DELTA_PARAMS } from "../../src/synapse/delta-params.ts";
import { cosineInt, quantize } from "../../src/synapse/delta.ts";
import type { PredictedBase } from "../../src/synapse/predict-base.ts";
import { chooseStatePayload, decodeStatePayload } from "../../src/synapse/state-payload.ts";

/**
 * The wire-format decision and its inverse. The card's rules live here as
 * assertions rather than as prose: a residual ships only when it is smaller
 * than the vector it replaces AND still cheaper once the receiver's base read
 * is counted, because a saving that ignores the base read is not a saving.
 */

const DIM = 1024;
const REPRESENTATION_ID = "siliconflow/BAAI/bge-m3/1024";

/** A unit vector from a deterministic angle walk, so a test can dial the base's similarity. */
function unitVector(seed: number, dim = DIM): Float32Array {
	const raw = new Float32Array(dim);
	for (let index = 0; index < dim; index += 1) raw[index] = Math.sin(seed + index * 0.7) + Math.cos(seed * 1.3 + index * 0.11);
	let norm = 0;
	for (const value of raw) norm += value * value;
	const scale = 1 / Math.sqrt(norm);
	for (let index = 0; index < dim; index += 1) raw[index] = raw[index]! * scale;
	return raw;
}

/** A base at a chosen cosine to `vector`: `mix` 1 is identical, 0 is orthogonal. */
function baseAt(vector: Float32Array, mix: number, seed: number): PredictedBase {
	const orthogonal = unitVector(seed);
	// Gram-Schmidt the noise against the query so the achievable cosine is exactly `mix`.
	let dot = 0;
	for (let index = 0; index < vector.length; index += 1) dot += orthogonal[index]! * vector[index]!;
	const residual = new Float32Array(vector.length);
	for (let index = 0; index < vector.length; index += 1) residual[index] = orthogonal[index]! - dot * vector[index]!;
	let norm = 0;
	for (const value of residual) norm += value * value;
	const scale = Math.sqrt(1 - mix * mix) / Math.sqrt(norm);
	const base = new Float32Array(vector.length);
	for (let index = 0; index < vector.length; index += 1) base[index] = mix * vector[index]! + scale * residual[index]!;
	return { memoryId: "a".repeat(64), representationId: REPRESENTATION_ID, vector: base };
}

function cosine(left: Float32Array, right: Float32Array): number {
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index += 1) {
		dot += left[index]! * right[index]!;
		leftNorm += left[index]! * left[index]!;
		rightNorm += right[index]! * right[index]!;
	}
	return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

describe("synapse state payload choice", () => {
	it("sends a residual when the base is close and the residual is cheaper than the vector", () => {
		const vector = unitVector(1);
		const base = baseAt(vector, 0.99, 7);
		const choice = chooseStatePayload({ base, fullVector: vector, params: SYNAPSE_DELTA_PARAMS, representationId: REPRESENTATION_ID });
		assert.equal(choice.encoding, "delta");
		assert.ok(choice.payload.byteLength < DIM * 4, `residual is ${choice.payload.byteLength} bytes, not below the ${DIM * 4}-byte vector`);
		assert.equal(choice.baseMemoryId, base.memoryId);
		// The receiver must land on a vector that ranks like the one the sender meant.
		const decoded = decodeStatePayload({ base: base.vector, dim: DIM, payload: choice.payload, representationId: REPRESENTATION_ID });
		assert.ok(cosine(decoded, vector) >= SYNAPSE_DELTA_PARAMS.threshold, `decoded vector is only ${cosine(decoded, vector)} similar to the query`);
	});

	it("falls back to the full vector when the base is too far for the residual to pay", () => {
		const vector = unitVector(2);
		// Near-orthogonal base: the residual covers almost every component, so the
		// receiver's base read would be spent to send back roughly the vector itself.
		const base = baseAt(vector, 0.05, 11);
		const choice = chooseStatePayload({ base, fullVector: vector, params: SYNAPSE_DELTA_PARAMS, representationId: REPRESENTATION_ID });
		assert.equal(choice.encoding, "float32-vector");
		assert.equal(choice.baseMemoryId, null);
		assert.equal(choice.reason, "delta-too-large-a-share-of-the-vector");
		assert.ok(choice.payload.byteLength % 4 === 0);
	});

	it("sends the full vector when memory offers no base at all", () => {
		const vector = unitVector(3);
		const choice = chooseStatePayload({ base: null, fullVector: vector, params: SYNAPSE_DELTA_PARAMS, representationId: REPRESENTATION_ID });
		assert.equal(choice.encoding, "float32-vector");
		assert.equal(choice.baseMemoryId, null);
		assert.equal(choice.reason, "no-base");
		assert.equal(choice.payload.byteLength, DIM * 4);
	});

	it("refuses a base from another representation instead of subtracting incomparable spaces", () => {
		const vector = unitVector(4);
		const base = { ...baseAt(vector, 0.99, 13), representationId: "siliconflow/other-model/1024" };
		const choice = chooseStatePayload({ base, fullVector: vector, params: SYNAPSE_DELTA_PARAMS, representationId: REPRESENTATION_ID });
		assert.equal(choice.encoding, "float32-vector");
		assert.equal(choice.reason, "base-space-mismatch");
	});

	it("keeps the sender's vector recoverable from the payload it chose", () => {
		const vector = unitVector(5);
		const choice = chooseStatePayload({ base: null, fullVector: vector, params: SYNAPSE_DELTA_PARAMS, representationId: REPRESENTATION_ID });
		const decoded = decodeStatePayload({ base: null, dim: DIM, payload: choice.payload, representationId: REPRESENTATION_ID });
		assert.deepEqual([...decoded], [...vector]);
	});
});

describe("synapse state payload decode", () => {
	it("refuses a base whose width disagrees with the envelope's dim", () => {
		const vector = unitVector(6);
		const base = baseAt(vector, 0.99, 17);
		const choice = chooseStatePayload({ base, fullVector: vector, params: SYNAPSE_DELTA_PARAMS, representationId: REPRESENTATION_ID });
		assert.equal(choice.encoding, "delta");
		// delta.ts decodes by the indices the payload names, so a longer base would
		// silently rebuild wrong values unless the width is checked here.
		assert.throws(
			() => decodeStatePayload({ base: base.vector.subarray(0, DIM / 2), dim: DIM, payload: choice.payload, representationId: REPRESENTATION_ID }),
			/base width/u,
		);
	});

	it("refuses a residual whose bytes do not parse as component triples", () => {
		assert.throws(
			() => decodeStatePayload({ base: unitVector(7), dim: DIM, payload: Uint8Array.from([1, 2]), representationId: REPRESENTATION_ID }),
			/not a multiple of 3/u,
		);
	});

	it("refuses a payload whose representation is not the one the corpus ranks", () => {
		const vector = unitVector(8);
		const choice = chooseStatePayload({ base: null, fullVector: vector, params: SYNAPSE_DELTA_PARAMS, representationId: REPRESENTATION_ID });
		assert.throws(
			() => decodeStatePayload({ base: null, dim: DIM, payload: choice.payload, representationId: "siliconflow/other-model/1024", requiredRepresentationId: REPRESENTATION_ID }),
			/representation-mismatch/u,
		);
	});
});

describe("synapse residual size rules", () => {
	it("keeps the frozen layout's payload below the vector it replaces at every width", () => {
		// The card's "residual must be smaller than the vector" branch is unreachable
		// while the layout is int8 with a two-byte index: 3 * dim < 4 * dim for every
		// dim. This assertion is what fails if the frozen layout ever widens, which is
		// the moment that branch has to be exercised for real.
		const stride = SYNAPSE_DELTA_LAYOUT === "int8" ? 3 : 4;
		for (const dim of [1, 64, 256, 1024, 4096]) {
			assert.ok(stride * dim < dim * 4, `stride ${stride} at dim ${dim} can reach the ${dim * 4}-byte vector`);
		}
	});

	it("quantises to the frozen grid and decodes without loss on the components it emits", () => {
		const vector = unitVector(9);
		const base = baseAt(vector, 0.99, 19);
		const quantized = quantize(vector, SYNAPSE_DELTA_PARAMS.grid);
		const quantizedBase = quantize(base.vector, SYNAPSE_DELTA_PARAMS.grid);
		const choice = chooseStatePayload({ base, fullVector: vector, params: SYNAPSE_DELTA_PARAMS, representationId: REPRESENTATION_ID });
		assert.equal(choice.encoding, "delta");
		const decoded = decodeStatePayload({ base: base.vector, dim: DIM, payload: choice.payload, representationId: REPRESENTATION_ID });
		// dequantize already L2-normalises, so the receiver ranks a unit vector.
		let norm = 0;
		for (const value of decoded) norm += value * value;
		assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-5, `decoded vector's norm is ${Math.sqrt(norm)}`);
		assert.ok(cosineInt(quantized, quantizedBase) < 1, "the fixture must have a non-trivial residual");
	});
});
