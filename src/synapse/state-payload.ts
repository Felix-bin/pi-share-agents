import { decodeDelta, dequantize, encodeDelta, quantize } from "./delta.ts";
import type { DeltaParams } from "./delta.ts";
import { SYNAPSE_DELTA_PARAMS } from "./delta-params.ts";
import type { PredictedBase } from "./predict-base.ts";

/**
 * The state payload on the wire: which encoding a sender chooses, and how a
 * receiver turns those bytes back into a vector.
 *
 * The choice is a rate-distortion decision, not a preference. A residual is only
 * sent when it is smaller than the vector it replaces *and* still smaller once
 * the receiver's base read is counted — the second half is what the full-account
 * rule of plan §5.4 requires, because a saving that ignores the base read is not
 * a saving. Under the frozen int8 layout the first half holds by construction
 * (3 bytes per component against 4), so the interesting branch is the second.
 *
 * Both directions live here so the sender and the receiver cannot drift: the
 * payload the sender writes is the payload this module's decoder expects, and
 * the dimension rule the decoder enforces is the one the encoder was measured
 * under.
 */

/** A residual payload is not a float32 vector; the content store records which it is. */
export const SYNAPSE_DELTA_MEDIA_TYPE = "application/x-synapse-delta";

/** Why a full vector was sent where a residual was possible. */
export type StateFallbackReason = "base-space-mismatch" | "delta-payload-not-smaller" | "delta-too-large-a-share-of-the-vector" | "no-base";

export type StateEncodingChoice = {
	/** The memory the receiver must read to rebuild the base; null exactly when the payload is a full vector. */
	baseMemoryId: string | null;
	encoding: "delta" | "float32-vector";
	payload: Uint8Array;
	/** Set when a residual was available but not worth sending; null when one was sent. */
	reason: StateFallbackReason | null;
};

export type ChooseStatePayloadInput = {
	base: PredictedBase | null;
	fullVector: Float32Array;
	params: DeltaParams;
	/** The space the sender embeds in; a base from another space cannot be subtracted from. */
	representationId: string;
};

/**
 * A residual that costs more than half the vector is not sent: the exact vector
 * is cheaper to decode and ranks exactly.
 *
 * This is a policy on when an approximation is acceptable, not a rate-distortion
 * optimum — no threshold makes the delta path a net win once the receiver's base
 * read is counted, and that question is answered by measurement in P4-5 rather
 * than here. The number comes from the measured curve at the frozen point:
 * payload share against the 4096-byte vector is 14.5% at cosine 0.99, 36.1% at
 * 0.95, 40.9% at 0.90, 51.5% at 0.80, and saturates near 62% for anything at or
 * below 0.6 (the stop condition at cosine 0.99 halts the encoder around 830 of
 * 1024 components). Half the vector therefore partitions the curve at a base
 * cosine of roughly 0.85.
 *
 * Two properties matter more than the exact number. It is strictly stronger than
 * the card's condition (a residual may not reach the vector's size) — which the
 * frozen layout can never violate, since 3 bytes per component cannot reach 4 —
 * so it can only turn a residual into a full vector, never the reverse; and it is
 * reachable, so the fallback branch is exercised by tests instead of sitting
 * dead.
 */
export const SYNAPSE_DELTA_MAX_PAYLOAD_SHARE = 0.5;

export type DecodeStatePayloadInput = {
	/** The base vector the receiver rebuilt from memory; required for, and ignored by, a full vector. */
	base: Float32Array | null;
	dim: number;
	payload: Uint8Array;
	representationId: string;
	/** The space the pinned corpus ranks; a payload from another one cannot be compared against it. */
	requiredRepresentationId?: string;
};

function littleEndianBytes(vector: Float32Array): Uint8Array {
	const bytes = new Uint8Array(vector.length * 4);
	const view = new DataView(bytes.buffer);
	for (let index = 0; index < vector.length; index += 1) view.setFloat32(index * 4, vector[index]!, true);
	return bytes;
}

export function chooseStatePayload(input: ChooseStatePayloadInput): StateEncodingChoice {
	const fullPayload = littleEndianBytes(input.fullVector);
	const fullVector = (): StateEncodingChoice => ({ baseMemoryId: null, encoding: "float32-vector", payload: fullPayload, reason: null });
	const { base } = input;
	// A base the receiver cannot rebuild is worse than no base: the residual would
	// be undecodable on arrival, so the sender falls back before publishing.
	if (base === null) return { ...fullVector(), reason: "no-base" };
	if (base.representationId !== input.representationId) return { ...fullVector(), reason: "base-space-mismatch" };

	const residual = encodeDelta(quantize(input.fullVector, input.params.grid), quantize(base.vector, input.params.grid), input.params);
	// The card's rule, kept as a guard rather than as the working criterion: with an
	// int8 value and a two-byte index a payload cannot reach the vector's size, so
	// this branch only becomes reachable if the frozen layout widens.
	if (residual.payload.byteLength >= fullPayload.byteLength) return { ...fullVector(), reason: "delta-payload-not-smaller" };
	// The working criterion. Note what it deliberately does NOT do: it does not add
	// the receiver's base read to the residual's side, because that would make every
	// residual lose (a 4 KiB base read exceeds any payload saving at dim 1024) and
	// the mechanism would never run to be measured. Whether the base read makes the
	// whole path a net loss is the full-account question, and it is answered by
	// measurement in P4-5, not hidden inside the sender's choice.
	if (residual.payload.byteLength > fullPayload.byteLength * SYNAPSE_DELTA_MAX_PAYLOAD_SHARE) {
		return { ...fullVector(), reason: "delta-too-large-a-share-of-the-vector" };
	}
	return { baseMemoryId: base.memoryId, encoding: "delta", payload: residual.payload, reason: null };
}

export function decodeStatePayload(input: DecodeStatePayloadInput): Float32Array {
	if (input.requiredRepresentationId !== undefined && input.representationId !== input.requiredRepresentationId) {
		throw new Error(
			`representation-mismatch: state payload is ${input.representationId}, the corpus ranks ${input.requiredRepresentationId}; the spaces are incomparable`,
		);
	}
	if (input.base === null) {
		if (input.payload.byteLength !== input.dim * 4) {
			throw new Error(`integrity: float32 payload holds ${input.payload.byteLength} bytes, dim ${input.dim} needs ${input.dim * 4}`);
		}
		const view = new DataView(input.payload.buffer, input.payload.byteOffset, input.payload.byteLength);
		const vector = new Float32Array(input.dim);
		for (let index = 0; index < input.dim; index += 1) vector[index] = view.getFloat32(index * 4, true);
		return vector;
	}
	// delta.ts decodes by the indices a payload names and never compares widths, so
	// a base of the wrong length would rebuild values at the right offsets from the
	// wrong vector. The check belongs here, where the envelope's dim is known.
	if (input.base.length !== input.dim) {
		throw new Error(`integrity: base width ${input.base.length} does not match dim ${input.dim}`);
	}
	// The grid comes from the frozen constants rather than from the caller: a
	// payload does not name its grid, so a receiver that could be handed a
	// different one would decode every residual into a plausible wrong vector with
	// every checksum still passing. Changing the grid is therefore a wire-format
	// decision, not a configuration change.
	const quantizedBase = quantize(input.base, SYNAPSE_DELTA_PARAMS.grid);
	return dequantize(decodeDelta(input.payload, quantizedBase), SYNAPSE_DELTA_PARAMS.grid);
}
