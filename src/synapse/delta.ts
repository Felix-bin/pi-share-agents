/**
 * The residual (delta) codec: the wire format for "this state, expressed as a
 * correction to one you already hold".
 *
 * Two agents that share memory usually share most of a vector already, so the
 * payload worth sending is the difference. This module carries only that
 * difference — the quantized components that move a predicted vector towards
 * the target, largest correction first — so a receiver can stop reading as soon
 * as its reconstruction is close enough, and a receiver whose prediction was
 * already right pays nothing at all.
 *
 * Everything here is a pure function over an integer grid: no I/O, no clock,
 * no negotiation. That is deliberate, because the same bytes have to decode
 * identically on both sides of a wire that neither side controls, and the only
 * way to keep that true is to keep the arithmetic free of anything ambient.
 *
 * The layout is fixed by the reference implementation this ports
 * (src/synapse/stateplane/residual.py): each component is a two-byte
 * little-endian index followed by one int8 value, so a component costs three
 * bytes and carries no marker of its own. Two consequences belong here rather
 * than in a caller: dimensions above 65536 cannot be addressed at all, and a
 * correction outside the int8 range is clamped instead of escaped — which the
 * receiver's own verification, in a later card, is what catches.
 *
 * One deliberate difference from that reference: it selects the index width
 * from the dimension (one byte up to 256, two above), while this port fixes two
 * bytes for every dimension, because the product vector is 1024-dimensional and
 * a format that switches shape on a parameter is a format two peers can
 * disagree about. The bytes are therefore interchangeable with the reference
 * only above 256 dimensions; at or below it the reference emits a narrower
 * layout this module never produces, and cannot reliably read either — the
 * decoding side has the details.
 *
 * The arithmetic domain is the other boundary worth stating: quantized
 * components must fit int32 (guarded below), and `cosineInt` accumulates in
 * doubles, so it stays exact while `dim × maxComponent²` stays under 2^53. Real
 * sentence embeddings sit far inside both bounds; a caller feeding raw
 * activations rather than a quantized unit vector is outside the contract.
 */

/**
 * grid: the quantizer step both peers agreed on. threshold: the cosine at which
 * a reconstruction counts as close enough — a value from the calibration card,
 * not a constant of this module. A threshold above 1 makes the stop condition
 * unreachable, which is a legitimate way to ask for every component; a
 * non-finite one would disable the condition silently and is refused.
 */
export type DeltaParams = { grid: number; threshold: number };

/** One encode's output: the wire bytes, and how many components paid for them. */
export type DeltaEncoding = { payload: Uint8Array; nnz: number };

/** Raised when wire bytes cannot be trusted to reconstruct a vector. */
export class DeltaDecodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeltaDecodeError";
	}
}

/** The residual value range: one signed byte, clamped rather than wrapped. */
const INT8_MAX = 127;
const INDEX_BYTES = 2;
const STRIDE = INDEX_BYTES + 1;
/** A two-byte index addresses positions 0..65535, so this is the largest vector the format can describe. */
const MAX_DIM = 65536;
/** The comparison domain: components live in Int32Array, and a wrapped component would sort and clamp as a different number. */
const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

/**
 * Rounds to the nearest integer, breaking exact halves towards the even
 * neighbour. Python's round does this and JavaScript's Math.round does not
 * (it breaks halves upward), so the port has to spell it out: a quantizer that
 * disagreed on .5 would put the two implementations on different bytes for the
 * same vector.
 */
export function roundHalfEven(x: number): number {
	if (!Number.isFinite(x)) throw new Error("roundHalfEven requires a finite value");
	const floor = Math.floor(x);
	const fraction = x - floor;
	if (fraction < 0.5) return floor;
	if (fraction > 0.5) return floor + 1;
	return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Quantizes a vector onto the integer grid. Both sides of the wire do their
 * arithmetic on these integers, so the grid is the contract and the floats
 * never travel.
 */
export function quantize(vec: Float32Array, grid: number): Int32Array {
	if (!Number.isInteger(grid) || grid <= 0) throw new Error("quantize requires a positive integer grid");
	const quantized = new Int32Array(vec.length);
	for (let index = 0; index < vec.length; index += 1) {
		const value = vec[index]!;
		if (!Number.isFinite(value)) throw new Error(`quantize: non-finite value at index ${index}`);
		const scaled = value * grid;
		// Storing a scaled value outside the int32 range would wrap it into a
		// plausible-looking neighbour, so the domain is refused rather than muddled
		// through; no sentence embedding comes near this.
		if (scaled > INT32_MAX || scaled < INT32_MIN) throw new Error(`quantize: component ${index} scales outside the int32 grid domain`);
		quantized[index] = roundHalfEven(scaled);
	}
	return quantized;
}

/**
 * Returns the grid points divided by the grid, scaled to unit length, which is
 * the direction a cosine search consumes. A vector with no direction is
 * returned as zero rather than divided by a zero norm; a zero vector scores
 * zero against everything, which is the honest reading of "no direction".
 */
export function dequantize(quantized: Int32Array, grid: number): Float32Array {
	if (!Number.isInteger(grid) || grid <= 0) throw new Error("dequantize requires a positive integer grid");
	const values = new Float32Array(quantized.length);
	let sumOfSquares = 0;
	for (let index = 0; index < quantized.length; index += 1) {
		const value = quantized[index]! / grid;
		values[index] = value;
		sumOfSquares += value * value;
	}
	// A loop rather than Math.hypot(...values): spreading the array would cap the
	// dimensions this can normalize at the engine's argument limit, which is well
	// below the 65536 the wire format already addresses. Squares cannot overflow
	// here — components are int32-bounded above, so even the largest reachable
	// sum stays far inside a double.
	const norm = Math.sqrt(sumOfSquares);
	if (!(norm > 0)) return values;
	for (let index = 0; index < values.length; index += 1) values[index] = values[index]! / norm;
	return values;
}

/**
 * Cosine similarity over quantized vectors, accumulated in the same order as
 * the reference. The order is not a detail: the encoder stops on
 * `score >= threshold`, so a score that landed on a different side of the
 * threshold in one language would change how many components travel.
 */
export function cosineInt(left: Int32Array, right: Int32Array): number {
	if (left.length !== right.length) {
		throw new Error(`cosineInt: dimension mismatch ${left.length} vs ${right.length}`);
	}
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

/**
 * Encodes the correction from `base` to `target`, both already quantized, as
 * [index, value] triples ordered by decreasing correction magnitude.
 *
 * The loop is a greedy climb: each component is added only while the
 * reconstruction is still short of the threshold, so a good prediction stops
 * the scan early and a perfect one emits nothing. Order matters in one place:
 * the zero check runs before the component is appended, which is what keeps a
 * zero correction out of the payload and lets the scan end on the first
 * already-matching component — with the components sorted by magnitude, every
 * remaining correction is zero too. Move that check after the append and one
 * dead triple rides along on every scan that ends this way; remove it and the
 * whole zero tail is emitted, one triple per already-matched component.
 *
 * `params.grid` is not read here: quantizing happened in the caller, which is
 * what makes this function a pure byte layout operation. It is carried in the
 * parameters so a caller cannot quantize at one grid and describe the payload
 * at another.
 */
export function encodeDelta(target: Int32Array, base: Int32Array, params: DeltaParams): DeltaEncoding {
	if (target.length !== base.length) {
		throw new Error(`encodeDelta: dimension mismatch ${target.length} vs ${base.length}`);
	}
	if (target.length > MAX_DIM) {
		throw new Error(`encodeDelta: dimension ${target.length} exceeds the addressable maximum ${MAX_DIM} for a two-byte index`);
	}
	if (!Number.isFinite(params.threshold)) {
		throw new Error("encodeDelta requires a finite threshold: a non-finite one would never stop the scan");
	}
	const residual = new Int32Array(target.length);
	const order: number[] = [];
	for (let index = 0; index < target.length; index += 1) {
		const difference = target[index]! - base[index]!;
		// The same domain argument as in quantize: a difference outside int32 would
		// wrap and then sort and clamp as a different number than it is.
		if (difference > INT32_MAX || difference < INT32_MIN) {
			throw new Error(`encodeDelta: residual at component ${index} does not fit the comparison domain`);
		}
		residual[index] = difference;
		order.push(index);
	}
	// Array.prototype.sort is stable, so equal magnitudes keep ascending index
	// order, which is what the reference's sorted(..., reverse=True) produces.
	order.sort((left, right) => Math.abs(residual[right]!) - Math.abs(residual[left]!));

	const reconstruction = Int32Array.from(base);
	const bytes: number[] = [];
	let nnz = 0;
	for (const index of order) {
		const delta = residual[index]!;
		if (delta === 0) break;
		if (cosineInt(reconstruction, target) >= params.threshold) break;
		const value = Math.max(-INT8_MAX, Math.min(INT8_MAX, delta));
		reconstruction[index] = base[index]! + value;
		bytes.push(index & 0xff, (index >> 8) & 0xff, value & 0xff);
		nnz += 1;
	}
	return { payload: Uint8Array.from(bytes), nnz };
}

/**
 * Rebuilds the quantized target from a payload and the base the sender named.
 *
 * Bad input throws rather than degrading: a payload that is not stride-aligned,
 * that addresses a component the base does not have, or that arrives with no
 * base at all cannot be interpreted as "close enough", and a caller that
 * guessed would turn corruption into a plausible-looking vector. The caller's
 * recovery path — resend, then fall back to the full vector — is what handles
 * these, and it can only do that if they surface.
 *
 * The base's own length is the only dimension this can check against, so a base
 * that is the right kind of vector but the wrong length is not detectable here:
 * whoever wires this to a wire format (P4-4) has to compare the reconstructed
 * dimension against the frame's declared dimension before trusting the result.
 * The same goes for the layout itself. A payload written by the reference at or
 * below 256 dimensions uses a one-byte index, and what happens next depends on
 * the base it meets: against a base of that payload's own dimension the
 * two-byte read puts the first index past the end and this refuses it, but
 * against a longer base the same bytes read as perfectly well-formed indices
 * and reconstruct something wrong without raising anything. Nothing at this
 * layer can tell the two formats apart, so the frame carrying a payload has to
 * state which layout it is and refuse the other.
 */
export function decodeDelta(payload: Uint8Array, base: Int32Array): Int32Array {
	if (base.length === 0) {
		throw new DeltaDecodeError("decodeDelta: the base has no dimension to reconstruct into");
	}
	if (payload.length % STRIDE !== 0) {
		throw new DeltaDecodeError(`decodeDelta: payload length ${payload.length} is not a multiple of ${STRIDE}`);
	}
	const reconstruction = Int32Array.from(base);
	for (let offset = 0; offset < payload.length; offset += STRIDE) {
		const index = payload[offset]! | (payload[offset + 1]! << 8);
		if (index >= base.length) {
			throw new DeltaDecodeError(`decodeDelta: component index ${index} is outside the base dimension ${base.length}`);
		}
		const raw = payload[offset + 2]!;
		const restored = base[index]! + (raw >= 128 ? raw - 256 : raw);
		// The decode-side counterpart of the encode guard: a base near the int32
		// edge would otherwise wrap through a well-formed payload. A sender that
		// quantized inside the domain cannot produce this, so it means the frame and
		// the base do not belong together.
		if (restored > INT32_MAX || restored < INT32_MIN) {
			throw new DeltaDecodeError(`decodeDelta: component ${index} reconstructs outside the comparison domain`);
		}
		reconstruction[index] = restored;
	}
	return reconstruction;
}
