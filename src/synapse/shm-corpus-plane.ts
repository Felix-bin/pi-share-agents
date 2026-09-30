/**
 * The corpus-resident shared-memory plane (design v1 §5.2, P6-3).
 *
 * What this closes: every state consumption today pays the full file path —
 * `readFileSync` of `vectors.f32` + `chunks.json` + `meta.json`, a SHA-256 over
 * both payload files, and a per-float decode loop — on every call, because the
 * task processes are short-lived and no in-process cache survives them (P4-5
 * v4 proved it with writer PIDs). This module keeps the *same bytes* resident
 * in a named POSIX segment: the first process that loads a corpus from disk
 * publishes the three files' bytes; every later process in the namespace
 * answers `loadCorpusVectors` from the segment with zero file I/O.
 *
 * Disk stays the source of truth (design §4.4). Publishing re-reads the files
 * through the same verification the file path does (meta digests checked), and
 * the segment is a materialized view an auditor can drop at any moment: if
 * anything about a lookup smells — segment missing, magic wrong, namespace
 * mismatch — the plane returns null and the caller uses the file path it
 * always had. Degradation is a return value, never an exception.
 *
 * What the read path skips, and why that is sound: the file path re-verifies
 * SHA-256 on every read because a file can be rewritten behind its back. A
 * segment object, once published, is immutable by protocol (append-only
 * object area, sealed slot), and the segment's trust boundary is the same
 * host-user boundary the files have. So verification happens once, at
 * publish; reads check the object header's identity and the cheap invariants
 * (representationId, dim, chunk-count agreement, all-zero refusal). The
 * optional `auditVerify` re-runs CRC32C over the payload for audits.
 *
 * Equivalence with the file path is not claimed, it is pinned: the unit test
 * builds a corpus on disk, loads it both ways, and deep-compares chunk ids,
 * chunk meta, previews and every vector — the ranking cannot tell the loaders
 * apart. `previewOf` is imported from `state-retrieval.ts` for exactly this
 * reason: a second preview implementation would drift.
 *
 * Single-writer scope (an honest v1 boundary, spec revision 2026-09-30): the
 * design's `writer.lock` file lock is not implemented. The publisher here is
 * whoever first loads a corpus while the plane is enabled; the E0/E1s rigs
 * guarantee one writer process by construction, and the plane refuses to
 * publish when the segment already holds the corpus (idempotent skip), so
 * concurrent first-loads at worst duplicate work into the same immutable
 * objects, never partial state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { previewOf, type LoadedCorpus } from "./state-retrieval.ts";
import type { StoredCorpusMeta } from "./corpus.ts";
import type { MeteringIdentity, MeteringLog, MeteringPayload } from "./metering.ts";
import { attachShmSegmentReader, createOrAttachShmSegmentWriter, segmentGeometry, type ShmSegmentReader, type ShmSegmentWriter } from "./shm-segment.ts";
import { shmSegmentName, type ShmBindings } from "./shm-bindings.ts";

/** Design §2 defaults; index 128 slots is ample for corpus objects (3 per snapshot). */
export const SHM_CORPUS_DEFAULT_INDEX_CAPACITY = 128;

export type ShmCorpusPlaneStats = { attachFailures: string[]; hits: number; misses: number; publishes: number };

export type ShmCorpusPlane = {
	/**
	 * Segment-backed corpus loader for `StateRetrievalDeps.loadCorpus`. Null =
	 * not resident (caller falls back to the file path). Throws only on
	 * integrity failures *inside* a resident object — the file path throws on
	 * the same data, so behaviour stays comparable.
	 */
	loadCorpusVectors(corpusSnapshotId: string, expectedDim: number, representationId: string): LoadedCorpus | null;
	/** Read the corpus files from disk (fully verified) and publish them into the segment. Idempotent. */
	publishCorpus(storageRoot: string, corpusSnapshotId: string): { published: true } | { published: false; reason: string };
	stats(): ShmCorpusPlaneStats;
	close(): void;
};

/** Deterministic 64-hex identity for one of a snapshot's three segment objects. */
export function corpusObjectId(snapshotId: string, representationId: string, part: "chunks" | "matrix" | "meta"): string {
	return createHash("sha256").update(part).update("\n").update(snapshotId).update("\n").update(representationId).digest("hex");
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function normOf(vector: Float32Array): number {
	let sum = 0;
	for (const value of vector) sum += value * value;
	return Math.sqrt(sum);
}

/**
 * The corpus bytes resident in the segment are the files' bytes, exactly —
 * `vectors.f32`, `chunks.json`, `meta.json` — so the segment is a materialized
 * view in the most literal sense and `publishCorpus` can verify against the
 * same published digests the file path trusts.
 */
function readCorpusFiles(storageRoot: string, corpusSnapshotId: string): { chunksBytes: Buffer; matrixBytes: Buffer; meta: StoredCorpusMeta } | { error: string } {
	const corpusDir = path.join(storageRoot, "corpus", corpusSnapshotId);
	let meta: StoredCorpusMeta;
	try {
		meta = JSON.parse(fs.readFileSync(path.join(corpusDir, "meta.json"), "utf-8")) as StoredCorpusMeta;
	} catch {
		return { error: `corpus snapshot ${corpusSnapshotId} is not published under ${storageRoot}` };
	}
	let matrixBytes: Buffer;
	let chunksBytes: Buffer;
	try {
		matrixBytes = fs.readFileSync(path.join(corpusDir, "vectors.f32"));
		chunksBytes = fs.readFileSync(path.join(corpusDir, "chunks.json"));
	} catch {
		return { error: `corpus snapshot ${corpusSnapshotId} files unreadable` };
	}
	// The same verification the file path performs on every read, done once here.
	if (sha256Hex(matrixBytes) !== meta.vectorsSha256) return { error: `vectors.f32 digest mismatch for ${corpusSnapshotId}` };
	if (sha256Hex(chunksBytes) !== meta.chunksSha256) return { error: `chunks.json digest mismatch for ${corpusSnapshotId}` };
	return { chunksBytes, matrixBytes, meta };
}

type ResidentCorpus = {
	chunksBytes: Uint8Array;
	matrixBytes: Uint8Array;
	metaBytes: Uint8Array;
};

export function createShmCorpusPlane(options: {
	bindings: ShmBindings;
	generation?: number;
	indexCapacity?: number;
	metering?: { identity: MeteringIdentity; log: MeteringLog };
	namespaceId16: string;
	segmentBytes?: number;
}): ShmCorpusPlane {
	const generation = options.generation ?? 0;
	const indexCapacity = options.indexCapacity ?? SHM_CORPUS_DEFAULT_INDEX_CAPACITY;
	const name = shmSegmentName(options.namespaceId16, generation);
	const stats: ShmCorpusPlaneStats = { attachFailures: [], hits: 0, misses: 0, publishes: 0 };
	let writer: ShmSegmentWriter | null = null;
	let readerHandle: ShmSegmentReader | null = null;
	let closed = false;

	const meter = (payload: MeteringPayload) => {
		options.metering?.log.record(options.metering.identity, payload);
	};

	const readerFor = (): ShmSegmentReader | null => {
		if (closed) return null;
		if (readerHandle !== null) return readerHandle;
		const startedAt = process.hrtime.bigint();
		const attached = attachShmSegmentReader({ bindings: options.bindings, expect: { generation, namespaceId16: options.namespaceId16 }, name });
		const attachMicros = Number(process.hrtime.bigint() - startedAt) / 1000;
		if ("status" in attached) {
			// missing (cold start) is the common case; untrusted is a torn/foreign
			// segment. Both degrade to the file path; the reason rides the stats.
			if (stats.attachFailures.length < 16) stats.attachFailures.push(`${attached.status}: ${attached.reason}`);
			return null;
		}
		readerHandle = attached;
		meter({ attachMicros: +attachMicros.toFixed(1), kind: "shm-attach", namespaceId: options.namespaceId16, segmentBytes: attached.segmentBytes });
		return readerHandle;
	};

	const resident = (snapshotId: string, representationId: string, auditVerify = false): ResidentCorpus | null => {
		const segment = readerFor();
		if (segment === null) return null;
		const meta = segment.lookup(corpusObjectId(snapshotId, representationId, "meta"), { auditVerify });
		const matrix = segment.lookup(corpusObjectId(snapshotId, representationId, "matrix"), { auditVerify });
		const chunks = segment.lookup(corpusObjectId(snapshotId, representationId, "chunks"), { auditVerify });
		if (meta === null || matrix === null || chunks === null) return null;
		return { chunksBytes: chunks.payload, matrixBytes: matrix.payload, metaBytes: meta.payload };
	};

	void writer;

	return {
		loadCorpusVectors(corpusSnapshotId, expectedDim, representationId) {
			if (closed) return null;
			const found = resident(corpusSnapshotId, representationId);
			if (found === null) {
				stats.misses += 1;
				meter({ kind: "shm-miss", corpusSnapshotId, namespaceId: options.namespaceId16, purpose: "corpus" });
				return null;
			}
			// From here the shape checks mirror the file path's, so a resident
			// object fails the way the same corrupt bytes on disk would.
			let meta: StoredCorpusMeta;
			try {
				meta = JSON.parse(new TextDecoder().decode(found.metaBytes)) as StoredCorpusMeta;
			} catch {
				stats.misses += 1;
				meter({ kind: "shm-invalid", corpusSnapshotId, namespaceId: options.namespaceId16, reason: "meta-bytes-unparseable" });
				return null;
			}
			if (meta.corpusSnapshotId !== corpusSnapshotId || meta.representationId !== representationId || meta.dim !== expectedDim) {
				stats.misses += 1;
				meter({ kind: "shm-invalid", corpusSnapshotId, namespaceId: options.namespaceId16, reason: "meta-mismatch" });
				return null;
			}
			let chunks: { chunkId: string; endLine: number; path: string; startLine: number; text: string }[];
			try {
				chunks = JSON.parse(new TextDecoder().decode(found.chunksBytes)) as typeof chunks;
			} catch {
				stats.misses += 1;
				meter({ kind: "shm-invalid", corpusSnapshotId, namespaceId: options.namespaceId16, reason: "chunks-bytes-unparseable" });
				return null;
			}
			if (!Array.isArray(chunks) || chunks.length !== meta.chunkCount || found.matrixBytes.byteLength !== meta.chunkCount * meta.dim * 4) {
				stats.misses += 1;
				meter({ kind: "shm-invalid", corpusSnapshotId, namespaceId: options.namespaceId16, reason: "chunk-count-disagreement" });
				return null;
			}
			// Zero-copy: one Float32Array over the matrix bytes, chunk rows as
			// subarray views. The file path decodes per chunk; the pinned test
			// proves the values identical. Little-endian is the segment's fixed
			// byte order, and x86-64/ARM64 Node builds both read Float32Array LE.
			const matrix = new Float32Array(found.matrixBytes.buffer, found.matrixBytes.byteOffset, found.matrixBytes.byteLength / 4);
			const vectors: Float32Array[] = [];
			for (let index = 0; index < chunks.length; index += 1) {
				const vector = matrix.subarray(index * meta.dim, (index + 1) * meta.dim);
				if (normOf(vector) === 0) {
					stats.misses += 1;
					meter({ kind: "shm-invalid", corpusSnapshotId, namespaceId: options.namespaceId16, reason: `all-zero-vector:${chunks[index]?.chunkId ?? index}` });
					return null;
				}
				vectors.push(vector);
			}
			stats.hits += 1;
			meter({ kind: "shm-hit", corpusSnapshotId, logicalBytes: found.matrixBytes.byteLength + found.chunksBytes.byteLength + found.metaBytes.byteLength, namespaceId: options.namespaceId16, purpose: "corpus" });
			return {
				chunkIds: chunks.map((chunk) => chunk.chunkId),
				chunkMeta: chunks.map(({ endLine, path: chunkPath, startLine }) => ({ endLine, path: chunkPath, startLine })),
				previews: chunks.map((chunk) => previewOf(chunk.text ?? "")),
				vectors,
			};
		},
		publishCorpus(storageRoot, corpusSnapshotId) {
			if (closed) return { published: false, reason: "plane closed" };
			const files = readCorpusFiles(storageRoot, corpusSnapshotId);
			if ("error" in files) return { published: false, reason: files.error };
			if (files.meta.corpusSnapshotId !== corpusSnapshotId) {
				return { published: false, reason: `corpus snapshot directory ${corpusSnapshotId} holds meta naming ${files.meta.corpusSnapshotId}` };
			}
			if (writer === null) {
				// Sized from the payload at hand: the three objects plus headers and
				// index, with the same headroom `segmentBytesFor` budgets.
				const metaBytes = new TextEncoder().encode(JSON.stringify(files.meta));
				const payloadBytes = files.matrixBytes.byteLength + files.chunksBytes.byteLength + metaBytes.byteLength;
				const bytes =
					options.segmentBytes ??
					segmentGeometry(indexCapacity, 1 << 30).objectAreaStart + (Math.ceil((payloadBytes * 1.2) / 4096) + 2) * 4096;
				writer = createOrAttachShmSegmentWriter({ bindings: options.bindings, epochOf: () => 0, generation, indexCapacity, namespaceId16: options.namespaceId16, segmentBytes: Math.max(bytes, 1 << 20) });
			}
			const representationId = files.meta.representationId;
			// Idempotent skip: if a previous publish already made all three objects
			// live, republishing would only bump epochs for identical bytes.
			if (resident(corpusSnapshotId, representationId) !== null) return { published: true };
			writer.publish(corpusObjectId(corpusSnapshotId, representationId, "matrix"), "corpus-matrix", new Uint8Array(files.matrixBytes));
			writer.publish(corpusObjectId(corpusSnapshotId, representationId, "chunks"), "corpus-chunks", new Uint8Array(files.chunksBytes));
			writer.publish(corpusObjectId(corpusSnapshotId, representationId, "meta"), "corpus-meta", new TextEncoder().encode(JSON.stringify(files.meta)));
			stats.publishes += 1;
			return { published: true };
		},
		stats() {
			return { ...stats, attachFailures: [...stats.attachFailures] };
		},
		close() {
			if (closed) return;
			closed = true;
			readerHandle?.detach();
			readerHandle = null;
			writer?.close();
			writer = null;
		},
	};
}
