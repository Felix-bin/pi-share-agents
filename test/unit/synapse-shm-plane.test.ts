import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	classifyShmAttachFailure,
	createInMemoryShmBindings,
	createPosixShmBindings,
	parseShmSegmentName,
	resetInMemoryShmSegments,
	shmSegmentName,
	type ShmBindings,
} from "../../src/synapse/shm-bindings.ts";
import {
	attachShmSegmentReader,
	crc32c,
	createOrAttachShmSegmentWriter,
	identityKeyTag,
	reapShmSegments,
	segmentBytesFor,
	segmentGeometry,
	SHM_LAYOUT_VERSION,
	SHM_SLOT_BYTES,
} from "../../src/synapse/shm-segment.ts";

/**
 * The shared-memory plane (P6-1 bindings + P6-2 segment protocol).
 *
 * The properties that matter, in order:
 *  1. a published object is exactly the bytes the writer wrote — the segment is
 *     a cache, and a cache that changes bytes is worse than no cache;
 *  2. a reader never trusts a torn or foreign segment (CRC/magic/namespace), so
 *     a corrupt segment degrades to the file path instead of lying;
 *  3. two "processes" (independent bindings instances) see the same bytes —
 *     the in-memory fake shares one registry precisely so this is provable;
 *  4. reaping touches only this tool's prefix and namespace, never the rest
 *     of /dev/shm (PostgreSQL's systemd-accident lesson).
 *
 * Real POSIX segments are exercised when the host allows it (Linux + koffi);
 * the same tests then run against kernel shm, which is what production uses.
 */

const NS = "0123456789abcdef";

function makeWriter(bindings: ShmBindings, generation = 0, segmentBytes = 1 << 20) {
	return createOrAttachShmSegmentWriter({ bindings, generation, indexCapacity: 256, namespaceId16: NS, segmentBytes });
}

function attachReader(bindings: ShmBindings, generation = 0) {
	return attachShmSegmentReader({ bindings, name: shmSegmentName(NS, generation), expect: { generation, namespaceId16: NS } });
}

beforeEach(() => resetInMemoryShmSegments());
afterEach(() => resetInMemoryShmSegments());

describe("shm segment naming (pure)", () => {
	it("round-trips a segment name", () => {
		const name = shmSegmentName(NS, 7);
		assert.equal(name, "/synapse-0123456789abcdef-g7");
		const parsed = parseShmSegmentName(name);
		assert.deepEqual(parsed, { generation: 7, namespaceId16: NS });
	});

	it("refuses malformed namespace ids and generations", () => {
		assert.throws(() => shmSegmentName("not-hex!", 0));
		assert.throws(() => shmSegmentName("0123456789abcde", 0)); // 15 chars
		assert.throws(() => shmSegmentName(NS, -1));
		assert.throws(() => shmSegmentName(NS, 1.5));
	});

	it("refuses foreign names in parse (reaping safety depends on it)", () => {
		assert.equal(parseShmSegmentName("/other-0123456789abcdef-g1"), null);
		assert.equal(parseShmSegmentName("/synapse-0123456789abcdef"), null);
	});

	it("classifies attach failures without errno knowledge", () => {
		assert.equal(classifyShmAttachFailure("ENOENT: No such file or directory"), "missing");
		assert.equal(classifyShmAttachFailure("ENOSPC: No space left on device"), "capacity");
		assert.equal(classifyShmAttachFailure("EACCES: Permission denied"), "permission");
		assert.equal(classifyShmAttachFailure("mmap failed (0x0)"), "unsupported");
	});
});

describe("shm segment layout (pure)", () => {
	it("geometries are aligned and validated", () => {
		const geometry = segmentGeometry(256, 1 << 20);
		assert.equal(geometry.indexStart, 8192);
		assert.equal(geometry.objectAreaStart, 8192 + 256 * SHM_SLOT_BYTES);
		assert.equal(geometry.objectAreaStart % 8, 0);
		assert.throws(() => segmentGeometry(100, 1 << 20)); // not a power of two
	});

	it("size estimation covers index plus payload headroom", () => {
		const bytes = segmentBytesFor(256, 4096);
		const geometry = segmentGeometry(256, bytes);
		assert.ok(geometry.objectAreaStart + 4096 < bytes);
	});

	it("crc32c is deterministic and input-sensitive", () => {
		const a = crc32c(new Uint8Array([1, 2, 3]));
		assert.equal(a, crc32c(new Uint8Array([1, 2, 3])));
		assert.notEqual(a, crc32c(new Uint8Array([3, 2, 1])));
	});

	it("identity keys are stable for hex and non-hex identities alike", () => {
		assert.deepEqual(identityKeyTag("ab".repeat(32)), { key: 0x0n + BigInt("0x" + "ab".repeat(8)), tag: Number.parseInt("ab".repeat(4), 16) });
		const one = identityKeyTag("namespace-id");
		assert.deepEqual(identityKeyTag("namespace-id"), one);
		assert.notDeepEqual(identityKeyTag("namespace-ie"), one);
	});
});

describe("shm segment protocol over the in-memory fake", () => {
	it("publishes and reads back exactly the bytes written (a cache must not change bytes)", () => {
		const bindings = createInMemoryShmBindings();
		const writer = makeWriter(bindings);
		const payload = new Float32Array([1.5, -2.25, 3.125, 0]).buffer;
		writer.publish("f".repeat(64), "corpus-matrix", new Uint8Array(payload));

		const reader = attachReader(bindings);
		assert.ok(reader && !("status" in reader), `attach failed: ${reader && "reason" in reader ? reader.reason : ""}`);
		const hit = (reader as Exclude<typeof reader, { status: string }>).lookup("f".repeat(64));
		assert.ok(hit !== null);
		assert.equal(hit?.kind, "corpus-matrix");
		assert.equal(hit?.byteLength, 16);
		assert.deepEqual(new Uint8Array(hit?.payload?.buffer ?? new ArrayBuffer(0), hit?.payload?.byteOffset ?? 0, 16), new Uint8Array(payload));
		writer.close();
		(reader as { detach(): void }).detach();
	});

	it("returns null for identities never published", () => {
		const bindings = createInMemoryShmBindings();
		const writer = makeWriter(bindings);
		const reader = attachReader(bindings);
		assert.ok(reader && !("status" in reader));
		assert.equal((reader as { lookup(i: string): unknown }).lookup("e".repeat(64)), null);
		writer.close();
	});

	it("republishing an identity bumps its epoch and swaps the payload", () => {
		const bindings = createInMemoryShmBindings();
		const writer = makeWriter(bindings);
		writer.publish("a".repeat(64), "corpus-matrix", new Uint8Array([1, 1, 1, 1]));
		const second = writer.publish("a".repeat(64), "corpus-matrix", new Uint8Array([2, 2, 2, 2, 2, 2, 2, 2]));
		const reader = attachReader(bindings);
		const hit = (reader as { lookup(i: string): { byteLength: number; epoch: number; payload: Uint8Array } | null }).lookup("a".repeat(64));
		assert.equal(hit?.byteLength, 8);
		assert.equal(hit?.epoch, second.epoch);
		assert.deepEqual([...(hit?.payload ?? [])], [2, 2, 2, 2, 2, 2, 2, 2]);
		writer.close();
	});

	it("flags tampered payloads under auditVerify (corruption is detected, not returned silently)", () => {
		const bindings = createInMemoryShmBindings();
		const writer = makeWriter(bindings);
		writer.publish("c".repeat(64), "corpus-chunks", new Uint8Array([9, 9, 9]));
		const mapping = bindings.openSegment(shmSegmentName(NS, 0));
		assert.ok(mapping !== null);
		// Flip one payload byte through a second mapping — the corruption a second
		// process (or a kernel page bug) would leave behind.
		new Uint8Array(mapping.buffer)[8192 + 256 * 20 + 80] ^= 0xff;
		const reader = attachReader(bindings);
		const hit = (reader as { lookup(i: string, o?: { auditVerify?: boolean }): { auditChecksumOk: boolean | null } | null }).lookup("c".repeat(64), { auditVerify: true });
		assert.equal(hit?.auditChecksumOk, false);
		writer.close();
	});

	it("refuses a torn superblock (odd seq) as untrusted", () => {
		const bindings = createInMemoryShmBindings();
		const writer = makeWriter(bindings);
		writer.publish("d".repeat(64), "record-vector", new Uint8Array(64));
		const mapping = bindings.openSegment(shmSegmentName(NS, 0));
		assert.ok(mapping !== null);
		// Simulate a publish mid-flight in BOTH copies: seq flipped odd and each
		// copy's CRC recalculated, so the odd-seq signal — not a broken CRC — is
		// all that remains. (Flipping one copy alone is *survivable by design*:
		// the other copy stays authoritative; this test first proves that.)
		const view = new DataView(mapping.buffer);
		const scratch = new Uint8Array(mapping.buffer);
		for (const base of [0, 4096]) {
			view.setUint32(base + 12, view.getUint32(base + 12, true) | 1, true);
			view.setUint32(base + 4092, crc32c(scratch.subarray(base, base + 4092)), true);
		}
		const reader = attachReader(bindings);
		assert.ok(reader && "status" in reader && reader.status === "untrusted");
		writer.close();
	});

	it("survives one corrupted superblock copy via the other (double-copy design)", () => {
		const bindings = createInMemoryShmBindings();
		const writer = makeWriter(bindings);
		writer.publish("d".repeat(64), "record-vector", new Uint8Array(64));
		const mapping = bindings.openSegment(shmSegmentName(NS, 0));
		assert.ok(mapping !== null);
		new Uint8Array(mapping.buffer).fill(0x58, 0, 8); // clobber copy A's magic only
		const reader = attachReader(bindings);
		assert.ok(reader && !("status" in reader), "copy B alone must remain authoritative");
		const hit = (reader as { lookup(i: string): { byteLength: number } | null }).lookup("d".repeat(64));
		assert.equal(hit?.byteLength, 64);
		writer.close();
	});

	it("refuses a foreign-magic segment as untrusted", () => {
		const bindings = createInMemoryShmBindings();
		const mapping = bindings.createSegment(shmSegmentName(NS, 0), 1 << 20);
		new Uint8Array(mapping.buffer).fill(0x58, 0, 8); // clobber magic
		const reader = attachReader(bindings);
		assert.ok(reader && "status" in reader && reader.status === "untrusted");
	});

	it("writer reattach keeps previously published objects", () => {
		const bindings = createInMemoryShmBindings();
		const first = makeWriter(bindings);
		first.publish("5".repeat(64), "corpus-matrix", new Uint8Array([7, 7, 7]));
		first.close();
		const second = makeWriter(bindings); // same name: reattach, not truncate
		assert.deepEqual(second.liveIdentities(), ["5".repeat(64)]);
		const reader = attachReader(bindings);
		assert.ok(reader && !("status" in reader));
		const hit = (reader as { lookup(i: string): { byteLength: number } | null }).lookup("5".repeat(64));
		assert.equal(hit?.byteLength, 3);
		second.close();
	});

	it("two bindings instances see the same bytes (the two-process property)", () => {
		const writerSide = createInMemoryShmBindings();
		const readerSide = createInMemoryShmBindings(); // a different instance, shared registry
		const writer = makeWriter(writerSide);
		writer.publish("9".repeat(64), "corpus-matrix", new Uint8Array(32).fill(3));
		const reader = attachReader(readerSide);
		assert.ok(reader && !("status" in reader));
		const hit = (reader as { lookup(i: string): { byteLength: number } | null }).lookup("9".repeat(64));
		assert.equal(hit?.byteLength, 32);
		writer.close();
	});

	it("reaps only older generations of its own namespace", () => {
		const bindings = createInMemoryShmBindings();
		const old = makeWriter(bindings, 0);
		old.publish("0".repeat(64), "corpus-matrix", new Uint8Array(8));
		const current = makeWriter(bindings, 1);
		current.publish("1".repeat(64), "corpus-matrix", new Uint8Array(8));
		const foreignNs = createInMemoryShmBindings();
		foreignNs.createSegment(shmSegmentName("fedcba9876543210", 0), 1 << 18);
		const foreignPrefix = createInMemoryShmBindings();
		foreignPrefix.createSegment("/someone-elses", 4096);

		const removed = reapShmSegments({ bindings, keepGeneration: 1, namespaceId16: NS });
		assert.deepEqual(removed, [shmSegmentName(NS, 0)]);
		assert.equal(bindings.openSegment(shmSegmentName(NS, 1)) !== null, true);
		assert.equal(foreignNs.openSegment(shmSegmentName("fedcba9876543210", 0)) !== null, true); // other namespace untouched
		assert.equal(foreignPrefix.openSegment("/someone-elses") !== null, true); // other prefix untouched
		current.close();
	});

	it("exhausting the object area raises instead of wrapping", () => {
		const bindings = createInMemoryShmBindings();
		const writer = createOrAttachShmSegmentWriter({ bindings, generation: 0, indexCapacity: 64, namespaceId16: NS, segmentBytes: segmentGeometry(64, 1 << 30).objectAreaStart + 8192 });
		writer.publish("b".repeat(64), "corpus-matrix", new Uint8Array(4096));
		assert.throws(() => writer.publish("c".repeat(64), "corpus-matrix", new Uint8Array(65536)));
		writer.close();
	});
});

describe("real POSIX segments (only where the host allows)", () => {
	const real = createPosixShmBindings();
	if (real === null) {
		it("skips: no koffi or not Linux (this host cannot run kernel shm; the fake covered the protocol)", { skip: true }, () => {});
		return;
	}
	beforeEach(() => {
		for (const name of real.listOwnSegments()) real.unlink(name);
	});
	afterEach(() => {
		for (const name of real.listOwnSegments()) real.unlink(name);
	});

	it("round-trips a payload across two independently created bindings (kernel shm)", () => {
		const writerSide = createPosixShmBindings();
		const readerSide = createPosixShmBindings();
		assert.ok(writerSide !== null && readerSide !== null);
		const ns = "0011223344556677";
		const writer = createOrAttachShmSegmentWriter({ bindings: writerSide, generation: 0, indexCapacity: 64, namespaceId16: ns, segmentBytes: 1 << 18 });
		const payload = new Uint8Array(1024);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		writer.publish("ab".repeat(32), "corpus-matrix", payload);
		const reader = attachShmSegmentReader({ bindings: readerSide, name: shmSegmentName(ns, 0), expect: { generation: 0, namespaceId16: ns } });
		assert.ok(reader && !("status" in reader), `attach failed: ${reader && "reason" in reader ? reader.reason : ""}`);
		const hit = (reader as { lookup(i: string): { byteLength: number; payload: Uint8Array } | null }).lookup("ab".repeat(32));
		assert.equal(hit?.byteLength, 1024);
		assert.deepEqual([...(hit?.payload ?? [])], [...payload]);
		writer.close();
		(reader as { detach(): void }).detach();
	});

	it("capacityBytes reports a positive number or stays null", () => {
		const capacity = real.capacityBytes();
		if (capacity !== null) assert.ok(capacity > 0);
	});
});
