/**
 * The shared-memory plane's segment layout and publish protocol (design v1
 * §4.2–§4.4, P6-2). Pure byte arithmetic over an injected `ArrayBuffer` — the
 * same `ShmBindings` mapping a real POSIX segment and the in-memory fake both
 * hand this module, which is what makes the protocol testable on any host.
 *
 * Layout (all little-endian, fixed for the segment's lifetime — SQLite's
 * WAL-index lesson: a segment that outlives processes must not depend on the
 * writer's host byte order):
 *
 * ```
 * [0, 4 KiB)      SuperBlock copy A   ──┐ two copies, each closed by CRC32C;
 * [4 KiB, 8 KiB)  SuperBlock copy B   ──┘ a reader takes the valid one with the
 *                                         larger seq (SQLite WAL-index style)
 * [8 KiB, …index) HashIndex           open addressing, 20 B per slot
 * …               ObjectArea          append-only, 8-byte aligned
 * ```
 *
 * Concurrency model is single-writer + RCU-style publication + superblock
 * seqlock (design §4.3):
 *
 *   publish: seq++ (odd) → append object → fill slot with state=publishing →
 *            state=live (last) → superblock copies+CRC → seq++ (even)
 *   read:    seq (even, stable across the read) → slot must be live → object
 *            header must match → payload is a zero-copy view
 *
 * A slot's `state=live` is written *after* the object bytes and slot identity,
 * so a reader that honors "only trust live slots" never sees a half-written
 * object. On x86-64 (TSO) store order makes "flag last" sound; arm64 would
 * need real release/acquire fences through the binding layer — the prototype
 * targets x86-64 (openEuler server + WSL2), recorded as a limitation, not an
 * assumption.
 *
 * Handles are offsets, never pointers (the seqlock documentation's rule: no
 * pointers under shared-memory protocols; Mooncake's BufHandle is the same
 * shape). Everything a reader computes derives from `ObjectArea base + slot
 * offset`, so processes with different mapping addresses read the same object.
 *
 * The disk store remains the source of truth (design §4.4): the segment is a
 * materialized view, rebuilt by re-reading files whenever validation fails.
 * A reader that sees anything off — bad CRC, wrong magic, torn superblock —
 * reports the segment untrusted; callers drop it and use the file path. No
 * in-segment repair.
 *
 * Slot size note: design §4.2 sketches 16 B/slot; the implementation uses
 * 20 B to carry a full 32-bit object offset (a 128 MiB segment) plus kind and
 * epoch without bit-packing. Index byte budgets in manifest fields are
 * computed from this constant, never from the sketch.
 */

import { classifyShmAttachFailure, parseShmSegmentName, shmSegmentName, type ShmBindings } from "./shm-bindings.ts";

export const SHM_MAGIC = "SYNSHM01";
export const SHM_LAYOUT_VERSION = 1;
/** 20 B: key(8) tag(4) kind(1) state(1) epoch(2) offset(4). */
export const SHM_SLOT_BYTES = 20;
/** 80 B, 8-aligned: kind(1) epoch(2) byteLength(4) keyIdLen(1) keyId(≤64) payloadChecksum(4) pad. */
export const SHM_OBJECT_HEADER_BYTES = 80;
export const SHM_OBJECT_AREA_ALIGN = 8;

export type ShmObjectKind = "corpus-matrix" | "corpus-chunks" | "record-vector" | "identity-projection";

const KIND_CODE: Record<ShmObjectKind, number> = {
	"corpus-matrix": 1,
	"corpus-chunks": 2,
	"record-vector": 3,
	"identity-projection": 4,
};
const KIND_NAME = new Map<number, ShmObjectKind>(Object.entries(KIND_CODE).map(([name, code]) => [code, name as ShmObjectKind]));

const SLOT_EMPTY = 0;
const SLOT_PUBLISHING = 1;
const SLOT_LIVE = 2;
const SLOT_TOMBSTONE = 3;

// SuperBlock field offsets within one 4 KiB copy (little-endian).
const SB = {
	magic: 0, // 8 bytes ASCII
	layoutVersion: 8, // u32
	seq: 12, // u32 — seqlock counter, odd means a publish is in flight
	namespaceId: 16, // 16 ASCII hex chars
	generation: 32, // u32
	segmentBytes: 36, // u64
	createdAtMs: 44, // u64
	writerPid: 52, // u32
	heartbeatAtMs: 56, // u64
	leaseMs: 64, // u32
	allocBump: 68, // u64 — ObjectArea-relative append pointer
	objectCount: 76, // u32
	indexSlotsUsed: 80, // u32
	indexCapacity: 84, // u32
	crc: 4092, // u32 — CRC32C over [0, 4092)
} as const;

const SLOT = {
	key: 0, // u64
	tag: 8, // u32
	kind: 12, // u8
	state: 13, // u8
	epoch: 14, // u16
	offset: 16, // u32 — ObjectArea-relative
} as const;

const OBJ = {
	kind: 0, // u8
	epoch: 1, // u16
	byteLength: 3, // u32
	keyIdLen: 7, // u8
	keyId: 8, // ≤64 ASCII chars
	payloadChecksum: 72, // u32 CRC32C over payload
} as const;

/** Maximum identity length: sha256 hex (64). Longer identities are refused, not truncated. */
const KEY_ID_MAX = 64;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const CRC32C_POLY = 0x82f63b78;
let crc32cTable: Uint32Array | null = null;

/** CRC32C (Castagnoli), table-driven. Pure. */
export function crc32c(bytes: Uint8Array): number {
	if (crc32cTable === null) {
		crc32cTable = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let c = i;
			for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ CRC32C_POLY : c >>> 1;
			crc32cTable[i] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i] ?? 0;
		crc = (crc >>> 8) ^ (crc32cTable[(crc ^ byte) & 0xff] ?? 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** Identity → {key, tag}: first 16 hex chars as u64 key, next 8 as u32 tag. Deterministic, allocation-free. */
export function identityKeyTag(identity: string): { key: bigint; tag: number } {
	const hex = /^[0-9a-f]+$/.test(identity) ? identity : simpleIdentityHash(identity);
	const keyHex = (hex + "0".repeat(16)).slice(0, 16);
	const tagHex = (hex.slice(16) + "0".repeat(8)).slice(0, 8);
	return { key: BigInt(`0x${keyHex}`), tag: Number.parseInt(tagHex, 16) >>> 0 };
}

/** Non-hex identities (namespace ids, snapshot labels) get a stable FNV-1a 64 hex form. */
function simpleIdentityHash(text: string): string {
	let h1 = 0xcbf29ce484222325n;
	let h2 = 0x84222325cbf29ce4n;
	for (let i = 0; i < text.length; i++) {
		const byte = text.charCodeAt(i) & 0xff;
		h1 = BigInt.asUintN(64, (h1 ^ BigInt(byte)) * 0x100000001b3n);
		h2 = BigInt.asUintN(64, (h2 + BigInt(byte) * BigInt(i + 1)) * 0x9e3779b97f4a7c15n);
	}
	return (h1.toString(16) + h2.toString(16)).padStart(32, "0");
}

/** Linear-probe start slot for a key. Deterministic across processes. */
export function slotFor(key: bigint, indexCapacity: number): number {
	return Number(key % BigInt(indexCapacity));
}

export type SegmentGeometry = {
	indexCapacity: number;
	indexStart: number;
	objectAreaStart: number;
	segmentBytes: number;
};

/** Geometry for a segment of `segmentBytes` with `indexCapacity` slots. Capacity must be a power of two. */
export function segmentGeometry(indexCapacity: number, segmentBytes: number): SegmentGeometry {
	if (indexCapacity <= 0 || (indexCapacity & (indexCapacity - 1)) !== 0) throw new Error(`shm: indexCapacity must be a power of two, got ${indexCapacity}`);
	const indexStart = 8192;
	const objectAreaStart = indexStart + indexCapacity * SHM_SLOT_BYTES;
	if (objectAreaStart % SHM_OBJECT_AREA_ALIGN !== 0) throw new Error("shm: object area start misaligned");
	const usable = segmentBytes - objectAreaStart;
	if (usable <= SHM_OBJECT_HEADER_BYTES) throw new Error(`shm: segment too small for its index (${segmentBytes} bytes, ${indexCapacity} slots)`);
	return { indexCapacity, indexStart, objectAreaStart, segmentBytes };
}

/** Minimum segment bytes that fit `payloadBytes` of objects at load factor ≤ 0.7. */
export function segmentBytesFor(indexCapacity: number, payloadBytes: number): number {
	const { objectAreaStart } = segmentGeometry(indexCapacity, 1 << 30);
	// +1 header per object, plus 20% headroom; round up to 4 KiB.
	const need = objectAreaStart + Math.ceil((payloadBytes + 4096) * 1.2);
	return Math.ceil(need / 4096) * 4096;
}

// ---------------------------------------------------------------------------
// View plumbing over the mapped bytes
// ---------------------------------------------------------------------------

type SegmentViews = {
	u8: Uint8Array;
	dv: DataView;
};

function viewsOf(buffer: ArrayBuffer): SegmentViews {
	return { u8: new Uint8Array(buffer), dv: new DataView(buffer) };
}

function writeAscii(u8: Uint8Array, offset: number, text: string): void {
	for (let i = 0; i < text.length; i++) u8[offset + i] = text.charCodeAt(i) & 0xff;
}

function readAscii(u8: Uint8Array, offset: number, length: number): string {
	let out = "";
	for (let i = 0; i < length; i++) out += String.fromCharCode(u8[offset + i] ?? 0);
	return out;
}

function superblockCrcOf(views: SegmentViews, copy: 0 | 1): number {
	return crc32c(views.u8.subarray(copy * 4096, copy * 4096 + SB.crc));
}

/**
 * Read the authoritative superblock: the valid-CRC copy with the larger seq.
 * Torn or foreign segments surface as `{ status: "untrusted" }` — never as an
 * exception, because an untrusted segment is the normal degraded case a caller
 * answers by falling back to files (design §4.4).
 */
function readSuperblock(views: SegmentViews): { status: "ok"; seq: number } | { reason: string; status: "untrusted" } {
	let best: { copy: 0 | 1; seq: number } | null = null;
	for (const copy of [0, 1] as const) {
		const base = copy * 4096;
		if (readAscii(views.u8, base + SB.magic, 8) !== SHM_MAGIC) continue;
		const crcStored = views.dv.getUint32(base + SB.crc, true);
		if (superblockCrcOf(views, copy) !== crcStored) continue;
		const seq = views.dv.getUint32(base + SB.seq, true);
		if (best === null || seq > best.seq) best = { copy, seq };
	}
	if (best === null) return { reason: "no superblock copy passes CRC with our magic", status: "untrusted" };
	return { status: "ok", seq: best.seq };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export type ShmPublishResult = { epoch: number; identity: string; kind: ShmObjectKind };

export type ShmSegmentWriter = {
	readonly name: string;
	publish(identity: string, kind: ShmObjectKind, payload: Uint8Array): ShmPublishResult;
	/** Objects currently published (live slots), by identity. For projection refresh on attach. */
	liveIdentities(): string[];
	refreshHeartbeat(): void;
	close(): void;
};

/**
 * Create (or reattach to) a segment and hand back a writer. When the segment
 * already exists for this namespace+generation, the writer revalidates magic,
 * namespace and capacity and keeps the live objects — the "writer restart"
 * case — rather than truncating published state.
 */
export function createOrAttachShmSegmentWriter(options: {
	bindings: ShmBindings;
	epochOf?: (identity: string) => number;
	generation: number;
	heartbeatAt?: () => number;
	indexCapacity: number;
	namespaceId16: string;
	now?: () => number;
	segmentBytes: number;
}): ShmSegmentWriter {
	const name = shmSegmentName(options.namespaceId16, options.generation);
	const geometry = segmentGeometry(options.indexCapacity, options.segmentBytes);
	const mapping = options.bindings.createSegment(name, options.segmentBytes);
	const views = viewsOf(mapping.buffer);
	const now = options.now ?? Date.now;
	const epochFor = options.epochOf ?? (() => 1);
	let closed = false;

	let seq = 0;
	let allocBump = 0;
	let slotsUsed = 0;
	let objectCount = 0;
	const liveByKey = new Map<string, number>(); // identity → slot index

	const superblockBase = (copy: 0 | 1) => copy * 4096;

	const writeSuperblock = () => {
		for (const copy of [0, 1] as const) {
			const base = superblockBase(copy);
			writeAscii(views.u8, base + SB.magic, SHM_MAGIC);
			views.dv.setUint32(base + SB.layoutVersion, SHM_LAYOUT_VERSION, true);
			views.dv.setUint32(base + SB.seq, seq, true);
			writeAscii(views.u8, base + SB.namespaceId, options.namespaceId16);
			views.dv.setUint32(base + SB.generation, options.generation, true);
			views.dv.setBigUint64(base + SB.segmentBytes, BigInt(options.segmentBytes), true);
			views.dv.setBigUint64(base + SB.createdAtMs, BigInt(Math.trunc(now())), true);
			views.dv.setUint32(base + SB.writerPid, process.pid, true);
			views.dv.setBigUint64(base + SB.heartbeatAtMs, BigInt(Math.trunc(now())), true);
			views.dv.setUint32(base + SB.leaseMs, SHM_WRITER_LEASE_MS, true);
			views.dv.setBigUint64(base + SB.allocBump, BigInt(allocBump), true);
			views.dv.setUint32(base + SB.objectCount, objectCount, true);
			views.dv.setUint32(base + SB.indexSlotsUsed, slotsUsed, true);
			views.dv.setUint32(base + SB.indexCapacity, options.indexCapacity, true);
			views.dv.setUint32(base + SB.crc, superblockCrcOf(views, copy), true);
		}
	};

	const slotBase = (slot: number) => geometry.indexStart + slot * SHM_SLOT_BYTES;

	const findSlot = (key: bigint): { index: number; state: number; existingKey: bigint } => {
		let index = slotFor(key, options.indexCapacity);
		for (let probe = 0; probe < options.indexCapacity; probe++) {
			const base = slotBase(index);
			const existingKey = views.dv.getBigUint64(base + SLOT.key, true);
			const state = views.u8[base + SLOT.state] ?? SLOT_EMPTY;
			if (state === SLOT_EMPTY || existingKey === key) return { index, state, existingKey };
			index = (index + 1) % options.indexCapacity;
		}
		throw new Error("shm: index is full — raise indexCapacity (segments never compact in place)");
	};

	const readKeyIdAt = (objectOffset: number): { byteLength: number; epoch: number; keyId: string; kind: ShmObjectKind } => {
		const base = geometry.objectAreaStart + objectOffset;
		const keyIdLen = views.u8[base + OBJ.keyIdLen] ?? 0;
		return {
			byteLength: views.dv.getUint32(base + OBJ.byteLength, true),
			epoch: views.dv.getUint16(base + OBJ.epoch, true),
			keyId: readAscii(views.u8, base + OBJ.keyId, keyIdLen),
			kind: KIND_NAME.get(views.u8[base + OBJ.kind] ?? 0) ?? ("corpus-matrix" as ShmObjectKind),
		};
	};

	// Reattach: scan the index for live slots, recover allocBump/objectCount.
	const existing = readSuperblock(views);
	if (existing.status === "ok") {
		const nsOk = readAscii(views.u8, SB.namespaceId, 16);
		if (nsOk === options.namespaceId16) {
			allocBump = Number(views.dv.getBigUint64(SB.allocBump, true));
			objectCount = views.dv.getUint32(SB.objectCount, true);
			slotsUsed = views.dv.getUint32(SB.indexSlotsUsed, true);
			for (let slot = 0; slot < options.indexCapacity; slot++) {
				const base = slotBase(slot);
				if ((views.u8[base + SLOT.state] ?? SLOT_EMPTY) !== SLOT_LIVE) continue;
				const offset = views.dv.getUint32(base + SLOT.offset, true);
				const meta = readKeyIdAt(offset);
				liveByKey.set(meta.keyId, slot);
			}
		}
		// A torn or foreign segment at this name is reinitialized below: the
		// disk store is the source of truth, and createSegment() returned a
		// zeroed mapping only when the segment was born here. A foreign live
		// segment with a valid superblock for another namespace cannot share
		// this name (the name embeds the namespace), so reaching here means
		// CRC-valid leftovers of our own namespace — reattached above.
	}
	if (existing.status === "untrusted") {
		// Fresh or corrupt: reinitialize in place (callers rebuilt state from disk).
		liveByKey.clear();
		allocBump = 0;
		objectCount = 0;
		slotsUsed = 0;
		views.u8.fill(0, geometry.indexStart, geometry.objectAreaStart);
	}
	seq = 0;
	writeSuperblock();

	return {
		get name() {
			return name;
		},
		publish(identity, kind, payload) {
			if (closed) throw new Error("shm: writer is closed");
			if (identity.length > KEY_ID_MAX) throw new Error(`shm: identity too long (${identity.length} > ${KEY_ID_MAX})`);
			const payloadEnd = allocBump + SHM_OBJECT_HEADER_BYTES + payload.length;
			if (geometry.objectAreaStart + payloadEnd > options.segmentBytes) throw new Error("shm: object area exhausted — allocate a larger segment");
			const { key, tag } = identityKeyTag(identity);
			const { index } = findSlot(key);

			// seq odd: in-flight. A concurrent reader retrying the seqlock sees
			// this and re-reads; nobody is blocked (design §4.3).
			seq += 1;
			writeSuperblock();

			const epoch = epochFor(identity) + 1;
			const objectOffset = allocBump;
			const base = geometry.objectAreaStart + objectOffset;
			const padTo = SHM_OBJECT_AREA_ALIGN - ((SHM_OBJECT_HEADER_BYTES + payload.length) % SHM_OBJECT_AREA_ALIGN || SHM_OBJECT_AREA_ALIGN);
			views.u8[base + OBJ.kind] = KIND_CODE[kind];
			views.dv.setUint16(base + OBJ.epoch, epoch, true);
			views.dv.setUint32(base + OBJ.byteLength, payload.length, true);
			views.u8[base + OBJ.keyIdLen] = identity.length;
			writeAscii(views.u8, base + OBJ.keyId, identity);
			views.dv.setUint32(base + OBJ.payloadChecksum, crc32c(payload), true);
			views.u8.set(payload, base + SHM_OBJECT_HEADER_BYTES);
			allocBump = objectOffset + SHM_OBJECT_HEADER_BYTES + payload.length + padTo;
			objectCount += 1;

			// Two-phase publish: everything about the object is on the page
			// *before* the slot says live. The slot's state byte is the seal.
			const sb = slotBase(index);
			views.u8[sb + SLOT.state] = SLOT_PUBLISHING;
			views.dv.setBigUint64(sb + SLOT.key, key, true);
			views.dv.setUint32(sb + SLOT.tag, tag, true);
			views.u8[sb + SLOT.kind] = KIND_CODE[kind];
			views.dv.setUint16(sb + SLOT.epoch, epoch, true);
			views.dv.setUint32(sb + SLOT.offset, objectOffset, true);
			views.u8[sb + SLOT.state] = SLOT_LIVE;
			slotsUsed += liveByKey.has(identity) ? 0 : 1;
			liveByKey.set(identity, index);

			seq += 1;
			writeSuperblock();
			return { epoch, identity, kind };
		},
		liveIdentities() {
			return [...liveByKey.keys()];
		},
		refreshHeartbeat() {
			if (closed) return;
			writeSuperblock();
		},
		close() {
			closed = true;
			mapping.detach();
		},
	};
}

/** Writer lease: how stale a heartbeat may be before another writer may take over (design §4.5). */
export const SHM_WRITER_LEASE_MS = 30_000;

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export type ShmLookupResult = {
	auditChecksumOk: boolean | null; // null unless auditVerify asked for it
	byteLength: number;
	epoch: number;
	kind: ShmObjectKind;
	/** Zero-copy view into the segment. Valid until the mapping is detached. */
	payload: Uint8Array;
};

export type ShmSegmentReader = {
	readonly generation: number;
	readonly name: string;
	readonly segmentBytes: number;
	lookup(identity: string, options?: { auditVerify?: boolean }): ShmLookupResult | null;
	/** "in-flight" means a publish overlapped the read and retries also failed. */
	validate(): { status: "ok" } | { reason: string; status: "in-flight" | "untrusted" };
	detach(): void;
};

const SEQLOCK_RETRIES = 4;

export function attachShmSegmentReader(options: {
	bindings: ShmBindings;
	expect?: { generation?: number; indexCapacity?: number; namespaceId16?: string };
	name: string;
}): ShmSegmentReader | { reason: string; status: "missing" | "untrusted" } {
	const mapping = options.bindings.openSegment(options.name);
	if (mapping === null) return { reason: "segment does not exist (cold start)", status: "missing" };
	const views = viewsOf(mapping.buffer);

	const snapshot = (): { allocBump: number; capacity: number; generation: number; namespaceId16: string; objectCount: number; segmentBytes: number; seq: number } | { reason: string; status: "in-flight" | "untrusted" } => {
		for (let attempt = 0; attempt < SEQLOCK_RETRIES; attempt++) {
			const chosen = chooseCopy(views);
			if (chosen === null) return { reason: "no superblock copy passes CRC with our magic", status: "untrusted" };
			const { base, seq } = chosen;
			if (seq % 2 === 1) continue; // publish in flight; retry
			const state = {
				allocBump: Number(views.dv.getBigUint64(base + SB.allocBump, true)),
				capacity: views.dv.getUint32(base + SB.indexCapacity, true),
				generation: views.dv.getUint32(base + SB.generation, true),
				namespaceId16: readAscii(views.u8, base + SB.namespaceId, 16),
				objectCount: views.dv.getUint32(base + SB.objectCount, true),
				segmentBytes: Number(views.dv.getBigUint64(base + SB.segmentBytes, true)),
				seq,
			};
			// Re-read after the payload-bearing fields: an unchanged, even seq means
			// no publish straddled this snapshot (seqlock read protocol).
			const after = chooseCopy(views);
			if (after === null) return { reason: "superblock disappeared between reads", status: "untrusted" };
			if (after.seq === seq && seq % 2 === 0) return state;
		}
		return { reason: `superblock seq stayed odd or moved across ${SEQLOCK_RETRIES} reads`, status: "in-flight" };
	};

	const geometryFrom = (capacity: number, segmentBytes: number) => segmentGeometry(capacity, segmentBytes);

	const state0 = snapshot();
	if ("status" in state0) {
		// In-flight at attach time is reported as untrusted: the caller drops the
		// mapping and uses the file path for this round; the next attach retries.
		return { reason: `attach snapshot: ${state0.reason}`, status: state0.status === "in-flight" ? "untrusted" : state0.status };
	}
	const snap = state0;
	if (snap.segmentBytes !== mapping.buffer.byteLength) {
		return { reason: `segment size drift (superblock ${snap.segmentBytes}, mapping ${mapping.buffer.byteLength})`, status: "untrusted" };
	}
	if (options.expect?.namespaceId16 !== undefined && snap.namespaceId16 !== options.expect.namespaceId16) {
		return { reason: `namespace mismatch (found ${snap.namespaceId16})`, status: "untrusted" };
	}
	if (options.expect?.generation !== undefined && snap.generation !== options.expect.generation) {
		return { reason: `generation mismatch (found ${snap.generation})`, status: "untrusted" };
	}
	if (options.expect?.indexCapacity !== undefined && snap.capacity !== options.expect.indexCapacity) {
		return { reason: `index capacity mismatch (found ${snap.capacity})`, status: "untrusted" };
	}
	const geometry = geometryFrom(snap.capacity, snap.segmentBytes);

	let detached = false;
	return {
		get generation() {
			return snap.generation;
		},
		get name() {
			return options.name;
		},
		get segmentBytes() {
			return snap.segmentBytes;
		},
		lookup(identity, lookupOptions) {
			if (detached) return null;
			if (identity.length > KEY_ID_MAX) return null;
			const { key, tag } = identityKeyTag(identity);
			let index = slotFor(key, snap.capacity);
			for (let probe = 0; probe < snap.capacity; probe++) {
				const sb = geometry.indexStart + index * SHM_SLOT_BYTES;
				const slotState = views.u8[sb + SLOT.state] ?? SLOT_EMPTY;
				if (slotState === SLOT_EMPTY) return null; // linear probing: past the chain's end
				if (slotState === SLOT_LIVE && views.dv.getBigUint64(sb + SLOT.key, true) === key) {
					if (views.dv.getUint32(sb + SLOT.tag, true) !== tag) return null; // tag guard: 32-bit collision defense
					const objectOffset = views.dv.getUint32(sb + SLOT.offset, true);
					const base = geometry.objectAreaStart + objectOffset;
					const keyIdLen = views.u8[base + OBJ.keyIdLen] ?? 0;
					if (readAscii(views.u8, base + OBJ.keyId, keyIdLen) !== identity) return null; // full identity check
					const byteLength = views.dv.getUint32(base + OBJ.byteLength, true);
					const payload = views.u8.subarray(base + SHM_OBJECT_HEADER_BYTES, base + SHM_OBJECT_HEADER_BYTES + byteLength);
					return {
						auditChecksumOk: lookupOptions?.auditVerify === true ? crc32c(payload) === views.dv.getUint32(base + OBJ.payloadChecksum, true) : null,
						byteLength,
						epoch: views.dv.getUint16(base + OBJ.epoch, true),
						kind: KIND_NAME.get(views.u8[base + OBJ.kind] ?? 0) ?? "corpus-matrix",
						payload,
					};
				}
				index = (index + 1) % snap.capacity;
			}
			return null;
		},
		validate() {
			const again = snapshot();
			if ("status" in again) {
				return again.status === "in-flight" ? { reason: again.reason, status: "in-flight" } : { reason: again.reason, status: "untrusted" };
			}
			return { status: "ok" };
		},
		detach() {
			if (detached) return;
			detached = true;
			mapping.detach();
		},
	};
}

function chooseCopy(views: SegmentViews): { base: number; seq: number } | null {
	let best: { base: number; seq: number } | null = null;
	for (const copy of [0, 1] as const) {
		const base = copy * 4096;
		if (readAscii(views.u8, base + SB.magic, 8) !== SHM_MAGIC) continue;
		if (superblockCrcOf(views, copy) !== views.dv.getUint32(base + SB.crc, true)) continue;
		const seq = views.dv.getUint32(base + SB.seq, true);
		if (best === null || seq > best.seq) best = { base, seq };
	}
	return best;
}

// ---------------------------------------------------------------------------
// Orphan reaping (design §4.5): our prefix only, never a global /dev/shm scan
// ---------------------------------------------------------------------------

/**
 * Remove this namespace's segments other than `keepGeneration` (and segments
 * newer than it — a reap never deletes the future). Returns what was removed.
 * PostgreSQL DSM discipline: only names our `SHM_NAME_PREFIX` and our
 * namespace, so nothing else on the host is ever touched.
 */
export function reapShmSegments(options: {
	bindings: ShmBindings;
	keepGeneration: number;
	namespaceId16: string;
	/** Injected clock; defaults to Date.now. */
	now?: () => number;
}): string[] {
	const removed: string[] = [];
	for (const name of options.bindings.listOwnSegments()) {
		const parsed = parseShmSegmentName(name);
		if (parsed === null || parsed.namespaceId16 !== options.namespaceId16) continue;
		if (parsed.generation >= options.keepGeneration) continue;
		if (options.bindings.unlink(name)) removed.push(name);
	}
	return removed;
}

/** Convenience: classify a reader-attach failure for metering (`shm-miss` reasons). */
export function describeAttachFailure(failure: { reason: string; status: string }): string {
	return `${failure.status}/${classifyShmAttachFailure(failure.reason)}`;
}
