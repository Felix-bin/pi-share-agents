import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createContentStore, SYNAPSE_DEFAULT_MAX_OBJECT_BYTES } from "../../src/synapse/content-store.ts";

let root = "";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-cas-"));
});

afterEach(() => {
	fs.rmSync(root, { force: true, recursive: true });
});

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

describe("synapse content store", () => {
	it("addresses objects by the sha-256 of their exact bytes", () => {
		const store = createContentStore(root);
		const payload = bytes("蓝色的证据");
		const id = store.put(payload, "text/plain");
		assert.equal(id, createHash("sha256").update(payload).digest("hex"));
		assert.deepEqual(store.read(id), payload);
	});

	it("deduplicates identical bytes without a second copy on disk", () => {
		const store = createContentStore(root);
		const first = store.put(bytes("same"), "text/plain");
		const second = store.put(bytes("same"), "text/plain");
		assert.equal(first, second);
		const files = fs.readdirSync(path.join(root, "objects"), { recursive: true }).filter((entry) => String(entry).endsWith(".bin"));
		assert.equal(files.length, 1);
	});

	it("rejects a media type that disagrees with the stored object", () => {
		const store = createContentStore(root);
		store.put(bytes("payload"), "text/plain");
		assert.throws(() => store.put(bytes("payload"), "application/json"), /integrity/i);
	});

	it("rejects objects larger than the configured limit and stores nothing", () => {
		const store = createContentStore(root, { maxObjectBytes: 8 });
		assert.throws(() => store.put(bytes("nine char"), "text/plain"), /maxObjectBytes/);
		assert.equal(store.list().length, 0);
	});

	it("defaults the object size limit to one mebibyte", () => {
		assert.equal(SYNAPSE_DEFAULT_MAX_OBJECT_BYTES, 1024 * 1024);
	});

	it("refuses to read an object whose bytes no longer match its id", () => {
		const store = createContentStore(root);
		const id = store.put(bytes("original"), "text/plain");
		fs.writeFileSync(store.objectPath(id), "tampered");
		assert.throws(() => store.read(id), /integrity/i);
	});

	it("reports a missing object as unavailable rather than throwing a bare fs error", () => {
		const store = createContentStore(root);
		const absent = "0".repeat(64);
		assert.equal(store.has(absent), false);
		assert.throws(() => store.read(absent), /object-unavailable/);
	});

	it("rejects ids that are not lowercase sha-256 hex", () => {
		const store = createContentStore(root);
		for (const bad of ["../escape", "ABC", "0".repeat(63), `${"0".repeat(64)}0`, ""]) {
			assert.throws(() => store.read(bad), /invalid content id/i);
		}
	});

	it("never exposes an in-progress temp file as a published object", () => {
		const store = createContentStore(root);
		store.put(bytes("published"), "text/plain");
		const shard = fs.readdirSync(path.join(root, "objects"))[0] ?? "";
		fs.writeFileSync(path.join(root, "objects", shard, ".halfwritten.tmp"), "partial");
		assert.equal(store.list().length, 1);
	});

	it("accepts a concurrent republish of identical bytes as idempotent", () => {
		const store = createContentStore(root);
		const id = store.put(bytes("shared"), "text/plain");
		assert.equal(store.put(bytes("shared"), "text/plain"), id);
		assert.deepEqual(store.read(id), bytes("shared"));
	});

	it("reads a byte range without corrupting multi-byte characters", () => {
		const store = createContentStore(root);
		// "中" is three UTF-8 bytes; a naive slice at 2 would split it.
		const id = store.put(bytes("中文证据"), "text/plain");
		const slice = store.readTextRange(id, 2, 4);
		assert.equal(slice.text.includes("�"), false);
		assert.equal(slice.nextOffsetBytes > 2, true);
	});

	it("keeps the empty object addressable", () => {
		const store = createContentStore(root);
		const id = store.put(new Uint8Array(0), "text/plain");
		assert.equal(store.has(id), true);
		assert.equal(store.read(id).byteLength, 0);
	});
});
