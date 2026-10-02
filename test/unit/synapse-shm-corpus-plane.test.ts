import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildCorpus } from "../../src/synapse/corpus.ts";
import { createContentStore, type ContentStore } from "../../src/synapse/content-store.ts";
import { SYNAPSE_VECTOR_MEDIA_TYPE } from "../../src/synapse/embedding.ts";
import { createMeteringLog, readMeteringLog, type MeteringIdentity, type MeteringLog } from "../../src/synapse/metering.ts";
import { createInMemoryShmBindings, resetInMemoryShmSegments, type ShmBindings } from "../../src/synapse/shm-bindings.ts";
import { corpusObjectId, createShmCorpusPlane, resetShmCorpusPlanes, shmCorpusPlaneFor } from "../../src/synapse/shm-corpus-plane.ts";
import { loadCorpusVectors, retrieveWithState, type StateRetrievalDeps } from "../../src/synapse/state-retrieval.ts";
import { createDeterministicEmbedder } from "../support/deterministic-embedder.ts";

/**
 * The corpus-resident shared-memory plane (P6-3).
 *
 * The pinned property, before any performance claim: the plane's loader and
 * the file loader produce the *same corpus* — chunk ids, chunk meta, previews
 * and every vector — because a faster loader that changed one byte would
 * change what the ranking measures. The deep comparison below is what lets
 * `retrieveWithState` accept the seam blindly.
 */

const DIM = 8;
const SOURCE_COMMIT = "f".repeat(40);
const NS = "0123456789abcdef";

let storageRoot = "";
let corpusRoot = "";
let corpusSnapshotId = "";
let contentStore: ContentStore = createContentStore("");
let logPath = "";
let log: MeteringLog = createMeteringLog("");

const embedder = createDeterministicEmbedder(DIM);

function identity(): MeteringIdentity {
	return { agent: "retriever", attempt: 1, mode: "synapse", nodeId: "n1", runId: "run-1", sessionId: "sess-1", snapshotId: null };
}

function deps(overrides: Partial<StateRetrievalDeps> = {}): StateRetrievalDeps {
	return { contentStore, metering: { identity: identity(), log }, storageRoot, ...overrides };
}

beforeEach(async () => {
	resetInMemoryShmSegments();
	storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-shmcorpus-"));
	corpusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-shmcorpus-src-"));
	logPath = path.join(storageRoot, "metering.jsonl");
	log = createMeteringLog(logPath);
	contentStore = createContentStore(storageRoot);
	for (const [name, text] of [
		["src/a.md", "# alpha\nshared memory plane observation one\n"],
		["src/b.md", "# beta\ncoordination as compression observation two\n"],
		["src/c.md", "# gamma\nresidual quantisation observation three\n"],
	] as const) {
		const target = path.join(corpusRoot, name);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, text);
	}
	const built = await buildCorpus({ corpusRoot, embedder, sourceCommit: SOURCE_COMMIT, storageRoot });
	corpusSnapshotId = built.corpusSnapshotId;
});

afterEach(() => {
	fs.rmSync(storageRoot, { force: true, recursive: true });
	fs.rmSync(corpusRoot, { force: true, recursive: true });
	resetInMemoryShmSegments();
});

function eventsOf(kind: string): number {
	return readMeteringLog(logPath).filter((event) => event.kind === kind).length;
}

describe("the pinned equivalence: segment loader vs file loader", () => {
	it("produces the identical corpus (ids, meta, previews, every vector value)", () => {
		const bindings = createInMemoryShmBindings();
		const writerSide = createShmCorpusPlane({ bindings, namespaceId16: NS });
		assert.deepEqual(writerSide.publishCorpus(storageRoot, corpusSnapshotId), { published: true });

		const fileCorpus = loadCorpusVectors(storageRoot, corpusSnapshotId, DIM, embedder.representationId);
		const shmCorpus = writerSide.loadCorpusVectors(corpusSnapshotId, DIM, embedder.representationId);
		assert.ok(shmCorpus !== null, "published corpus must be resident");
		assert.deepEqual(shmCorpus.chunkIds, fileCorpus.chunkIds);
		assert.deepEqual(shmCorpus.chunkMeta, fileCorpus.chunkMeta);
		assert.deepEqual(shmCorpus.previews, fileCorpus.previews);
		assert.equal(shmCorpus.vectors.length, fileCorpus.vectors.length);
		for (let index = 0; index < fileCorpus.vectors.length; index += 1) {
			assert.deepEqual([...(shmCorpus.vectors[index] ?? [])], [...(fileCorpus.vectors[index] ?? [])], `vector ${index} differs`);
		}
		writerSide.close();
	});

	it("ranks identically through retrieveWithState (the ranking cannot tell the loaders apart)", () => {
		const bindings = createInMemoryShmBindings();
		const plane = createShmCorpusPlane({ bindings, metering: { identity: identity(), log }, namespaceId16: NS });
		assert.deepEqual(plane.publishCorpus(storageRoot, corpusSnapshotId), { published: true });

		// A query vector lifted from the published corpus (the P3-4 fixture
		// pattern): consumption decodes what arrived, it never re-embeds.
		const bytes = fs.readFileSync(path.join(storageRoot, "corpus", corpusSnapshotId, "vectors.f32"));
		const query = new Float32Array(DIM);
		for (let element = 0; element < DIM; element += 1) query[element] = bytes.readFloatLE(1 * DIM * 4 + element * 4);
		const buffer = Buffer.alloc(DIM * 4);
		for (const [index, value] of query.entries()) buffer.writeFloatLE(value, index * 4);
		const payloadId = contentStore.put(new Uint8Array(buffer), SYNAPSE_VECTOR_MEDIA_TYPE);
		const stateRef = { baseMemoryId: null, byteLength: buffer.byteLength, dim: DIM, encoding: "float32-vector" as const, payloadId, representationId: embedder.representationId, sha256: payloadId };

		const viaFile = retrieveWithState(deps(), { corpusSnapshotId, k: 3, stateRef });
		const viaShm = retrieveWithState(deps({ loadCorpus: (snapshot, dim, rep) => plane.loadCorpusVectors(snapshot, dim, rep) }), { corpusSnapshotId, k: 3, stateRef });
		assert.deepEqual(
			viaShm.hits.map((hit) => hit.chunkId),
			viaFile.hits.map((hit) => hit.chunkId),
		);
		assert.deepEqual(
			viaShm.hits.map((hit) => hit.cosine),
			viaFile.hits.map((hit) => hit.cosine),
		);
		// The hit event proves this ranking actually served from the segment.
		assert.ok(eventsOf("shm-hit") >= 1);
		assert.ok(eventsOf("shm-attach") >= 1);
		plane.close();
	});
});

describe("residency behaviour", () => {
	it("misses (null) before anything is published, and the caller falls back", () => {
		const bindings = createInMemoryShmBindings();
		const plane = createShmCorpusPlane({ bindings, metering: { identity: identity(), log }, namespaceId16: NS });
		assert.equal(plane.loadCorpusVectors(corpusSnapshotId, DIM, embedder.representationId), null);
		assert.equal(eventsOf("shm-miss"), 1);
		// The file path is what the caller uses on that null — proven by the
		// pinned test's sibling, asserted here as the fallback contract.
		assert.ok(loadCorpusVectors(storageRoot, corpusSnapshotId, DIM, embedder.representationId).vectors.length > 0);
		plane.close();
	});

	it("serves a second plane instance (a second process) with zero publish on its side", () => {
		const writerSide = createShmCorpusPlane({ bindings: createInMemoryShmBindings(), namespaceId16: NS });
		assert.deepEqual(writerSide.publishCorpus(storageRoot, corpusSnapshotId), { published: true });
		const readerSide = createShmCorpusPlane({ bindings: createInMemoryShmBindings(), metering: { identity: identity(), log }, namespaceId16: NS });
		const corpus = readerSide.loadCorpusVectors(corpusSnapshotId, DIM, embedder.representationId);
		assert.ok(corpus !== null);
		assert.deepEqual(corpus.chunkIds, loadCorpusVectors(storageRoot, corpusSnapshotId, DIM, embedder.representationId).chunkIds);
		assert.equal(readerSide.stats().publishes, 0, "a reader never publishes");
		assert.equal(readerSide.stats().hits, 1);
		writerSide.close();
		readerSide.close();
	});

	it("publish is idempotent and republishing identical bytes is a no-op", () => {
		const bindings = createInMemoryShmBindings();
		const plane = createShmCorpusPlane({ bindings, namespaceId16: NS });
		assert.deepEqual(plane.publishCorpus(storageRoot, corpusSnapshotId), { published: true });
		assert.equal(plane.stats().publishes, 1);
		assert.deepEqual(plane.publishCorpus(storageRoot, corpusSnapshotId), { published: true });
		assert.equal(plane.stats().publishes, 1, "the idempotent skip must not count a second publish");
		plane.close();
	});

	it("refuses to publish when the files no longer match their published digests", () => {
		const bindings = createInMemoryShmBindings();
		const plane = createShmCorpusPlane({ bindings, namespaceId16: NS });
		const vectorsPath = path.join(storageRoot, "corpus", corpusSnapshotId, "vectors.f32");
		fs.writeFileSync(vectorsPath, Buffer.from("tampered"));
		const result = plane.publishCorpus(storageRoot, corpusSnapshotId);
		assert.equal(result.published, false);
		assert.match((result as { reason: string }).reason, /digest mismatch|unreadable/);
		plane.close();
	});

	it("misses cleanly on a wrong representation instead of serving mismatched bytes", () => {
		const bindings = createInMemoryShmBindings();
		const plane = createShmCorpusPlane({ bindings, metering: { identity: identity(), log }, namespaceId16: NS });
		assert.deepEqual(plane.publishCorpus(storageRoot, corpusSnapshotId), { published: true });
		// A different representation id derives different object identities, so the
		// lookup misses before any comparison happens — no partial reads, no
		// cross-space ranking, just a miss and the file-path fallback.
		assert.equal(plane.loadCorpusVectors(corpusSnapshotId, DIM, "some-other-representation"), null);
		assert.equal(eventsOf("shm-miss"), 1);
		plane.close();
	});
});

describe("publish-side degradation and lifecycle (audit 2026-10-01: an attempt, never a gate)", () => {
	it("a throwing segment layer degrades to {published:false}, disables further attempts, and never escapes", () => {
		const inner = createInMemoryShmBindings();
		const bindings: ShmBindings = {
			...inner,
			createSegment(_name: string, _bytes: number): never {
				// ENOSPC-shaped: what shm_open/ftruncate report on a full /dev/shm.
				throw new Error("shm: shm_open(O_CREAT) failed (ret -1, errno 28)");
			},
		};
		const plane = createShmCorpusPlane({ bindings, namespaceId16: NS });
		const first = plane.publishCorpus(storageRoot, corpusSnapshotId);
		assert.equal(first.published, false);
		assert.match((first as { reason: string }).reason, /disabled for this process after failure/);
		const second = plane.publishCorpus(storageRoot, corpusSnapshotId);
		assert.equal(second.published, false, "a disabled plane must not retry on every service construction");
		assert.match((second as { reason: string }).reason, /disabled for this process/);
		assert.equal(plane.stats().publishFailures.length, 1);
		assert.equal(plane.loadCorpusVectors(corpusSnapshotId, DIM, embedder.representationId), null, "no segment exists; the loader misses cleanly");
		plane.close();
	});

	it("refuses to mint a segment the tmpfs cannot hold (capacity precheck, design §8.2)", () => {
		const inner = createInMemoryShmBindings();
		let createCalls = 0;
		const bindings: ShmBindings = {
			...inner,
			capacityBytes: () => 4096,
			createSegment(name: string, bytes: number) {
				createCalls += 1;
				return inner.createSegment(name, bytes);
			},
		};
		const plane = createShmCorpusPlane({ bindings, namespaceId16: NS });
		const result = plane.publishCorpus(storageRoot, corpusSnapshotId);
		assert.equal(result.published, false);
		assert.match((result as { reason: string }).reason, /insufficient shm capacity/);
		assert.equal(createCalls, 0, "the precheck must refuse before shm_open, not after a stray name entry exists");
		assert.equal(plane.stats().publishFailures.length, 1);
		plane.close();
		// The other two conclusions: `null` (host cannot tell) proceeds — every
		// other test in this file runs on the fake, whose capacityBytes() is null.
	});

	it("a published snapshot is never re-read: later publishes succeed with the corpus files deleted", () => {
		const plane = createShmCorpusPlane({ bindings: createInMemoryShmBindings(), namespaceId16: NS });
		assert.deepEqual(plane.publishCorpus(storageRoot, corpusSnapshotId), { published: true });
		const expected = loadCorpusVectors(storageRoot, corpusSnapshotId, DIM, embedder.representationId).chunkIds;
		fs.rmSync(path.join(storageRoot, "corpus"), { recursive: true });
		// Before the fix this re-read the files (and failed on them) on every
		// service construction; the memoized skip must not need them at all.
		assert.deepEqual(plane.publishCorpus(storageRoot, corpusSnapshotId), { published: true });
		assert.equal(plane.stats().publishes, 1);
		const corpus = plane.loadCorpusVectors(corpusSnapshotId, DIM, embedder.representationId);
		assert.ok(corpus !== null, "the segment is the resident copy now that the files are gone");
		assert.deepEqual(corpus.chunkIds, expected);
		plane.close();
	});

	it("an exception inside the segment layer reports itself as a miss, never escapes the loader", () => {
		const inner = createInMemoryShmBindings();
		const bindings: ShmBindings = {
			...inner,
			openSegment(_name: string): never {
				throw new Error("simulated attach explosion");
			},
		};
		const plane = createShmCorpusPlane({ bindings, metering: { identity: identity(), log }, namespaceId16: NS });
		assert.equal(plane.loadCorpusVectors(corpusSnapshotId, DIM, embedder.representationId), null);
		assert.equal(eventsOf("shm-miss"), 1);
		assert.ok(plane.stats().attachFailures.some((entry) => entry.startsWith("loader-exception:")));
		plane.close();
	});

	it("the registry hands a later metered consumer attribution over a plane created unmetered", () => {
		resetShmCorpusPlanes();
		try {
			const unmetered = shmCorpusPlaneFor(NS, storageRoot, corpusSnapshotId, { bindings: createInMemoryShmBindings() });
			assert.ok(unmetered !== null);
			assert.deepEqual(unmetered.publishCorpus(storageRoot, corpusSnapshotId), { published: true });
			// The host-tool path created the plane with no metering; the delegation
			// consumer then claims it — its shm events must land in the ledger.
			const metered = shmCorpusPlaneFor(NS, storageRoot, corpusSnapshotId, { bindings: createInMemoryShmBindings(), metering: { identity: identity(), log } });
			assert.ok(metered === unmetered, "one plane per (storageRoot, namespace) per process");
			assert.ok(metered.loadCorpusVectors(corpusSnapshotId, DIM, embedder.representationId) !== null);
			assert.ok(eventsOf("shm-hit") >= 1, "consumption after adoption is metered");
		} finally {
			resetShmCorpusPlanes();
		}
	});
});
