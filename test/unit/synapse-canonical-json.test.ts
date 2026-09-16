import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalDigest, canonicalJson } from "../../src/synapse/canonical-json.ts";

describe("synapse canonical json", () => {
	it("orders object keys by code point, not by locale collation", () => {
		// "Z" (U+005A) sorts before "a" (U+0061) by code point; many locales disagree.
		assert.equal(canonicalJson({ a: 1, Z: 2, "ä": 3, A: 4 }), '{"A":4,"Z":2,"a":1,"ä":3}');
	});

	it("preserves array order and emits no insignificant whitespace", () => {
		assert.equal(canonicalJson({ list: [3, 1, 2], nested: { b: [{ y: 1, x: 2 }] } }), '{"list":[3,1,2],"nested":{"b":[{"x":2,"y":1}]}}');
	});

	it("produces identical output for differently ordered inputs", () => {
		assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
	});

	it("rejects non-finite numbers instead of emitting null", () => {
		assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/i);
		assert.throws(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), /non-finite/i);
	});

	it("keeps null as a representable value distinct from a rejected non-finite", () => {
		assert.equal(canonicalJson({ value: null }), '{"value":null}');
		assert.throws(() => canonicalJson({ value: 0 / 0 }), /non-finite/i);
	});

	it("derives a stable sha-256 digest from the canonical form", () => {
		const first = canonicalDigest({ b: 1, a: 2 });
		const second = canonicalDigest({ a: 2, b: 1 });
		assert.equal(first, second);
		assert.match(first, /^[0-9a-f]{64}$/);
		assert.notEqual(first, canonicalDigest({ a: 2, b: 2 }));
	});
});
