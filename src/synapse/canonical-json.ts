import { createHash } from "node:crypto";

/**
 * Deterministic JSON used for every SYNAPSE digest and snapshot summary.
 *
 * Object keys are ordered by UTF-16 code unit, which `Array.prototype.sort`
 * already guarantees without consulting the machine locale. Arrays keep their
 * order, no insignificant whitespace is emitted, and anything JSON cannot carry
 * losslessly is rejected instead of being silently coerced: a digest computed
 * over `null`-substituted NaN would still compare equal across two runs that
 * meant different things.
 */
export type CanonicalValue = string | number | boolean | null | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue };

function isCanonicalArray(value: CanonicalValue): value is readonly CanonicalValue[] {
	return Array.isArray(value);
}

function isCanonicalObject(value: CanonicalValue): value is { readonly [key: string]: CanonicalValue } {
	return value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]";
}

function encodeValue(value: CanonicalValue, pathLabel: string): string {
	if (value === null) return "null";
	if (value === true) return "true";
	if (value === false) return "false";
	if (isCanonicalArray(value)) {
		return `[${value.map((entry, index) => encodeValue(entry, `${pathLabel}[${index}]`)).join(",")}]`;
	}
	if (isCanonicalObject(value)) {
		const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${encodeValue(entry, `${pathLabel}.${key}`)}`).join(",")}}`;
	}
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(value);
	} catch {
		// BigInt and similar values throw rather than returning undefined.
		throw new Error(`canonicalJson: unsupported value at ${pathLabel}`);
	}
	if (encoded === undefined) {
		throw new Error(`canonicalJson: unsupported value at ${pathLabel}`);
	}
	if (encoded === "null") {
		// JSON.stringify maps NaN and +/-Infinity to null; a canonical digest must
		// never quietly equate them with an explicit null.
		throw new Error(`canonicalJson: non-finite number at ${pathLabel}`);
	}
	return encoded;
}

export function canonicalJson(value: CanonicalValue): string {
	return encodeValue(value, "$");
}

export function canonicalDigest(value: CanonicalValue): string {
	return createHash("sha256").update(canonicalJson(value), "utf-8").digest("hex");
}
