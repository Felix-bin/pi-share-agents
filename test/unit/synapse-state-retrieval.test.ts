import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AccessScope } from "../../src/synapse/access.ts";
import { buildCorpus, type CorpusChunk } from "../../src/synapse/corpus.ts";
import { createContentStore, type ContentStore } from "../../src/synapse/content-store.ts";
import { SYNAPSE_VECTOR_MEDIA_TYPE } from "../../src/synapse/embedding.ts";
import type { StateRef } from "../../src/synapse/envelope.ts";
import { createMemoryService, type MemoryService } from "../../src/synapse/memory-service.ts";
import { createMeteringLog, readMeteringLog, type MeteringIdentity, type MeteringLog } from "../../src/synapse/metering.ts";
import type { PredictedBase } from "../../src/synapse/predict-base.ts";
import { chooseStatePayload } from "../../src/synapse/state-payload.ts";
import { cosineSimilarity, retrieveWithState, type StateRetrievalDeps } from "../../src/synapse/state-retrieval.ts";
import { createDeterministicEmbedder } from "../support/deterministic-embedder.ts";

/**
 * Task card P3-4: the receiving side consumes a state vector against the fixed
 * corpus. Every fixture here is built from the published corpus files — the
 * query vector is lifted from vectors.f32 rather than re-embedded, which is the
 * property under test: consumption decodes what arrived, it never re-embeds.
 */

const DIM = 8;
const SOURCE_COMMIT = "f".repeat(40);

let storageRoot = "";
let corpusRoot = "";
let worktree = "";
let contentStore: ContentStore = createContentStore("");
let corpusSnapshotId = "";
let chunks: CorpusChunk[] = [];
let logPath = "";
let log: MeteringLog = createMeteringLog("");

const embedder = createDeterministicEmbedder(DIM);

function identity(): MeteringIdentity {
	return { agent: "retriever", attempt: 1, mode: "synapse", nodeId: "n1", runId: "run-1", sessionId: "sess-1", snapshotId: null };
}

function deps(overrides: Partial<StateRetrievalDeps> = {}): StateRetrievalDeps {
	return { contentStore, metering: { identity: identity(), log }, storageRoot, ...overrides };
}

function writeCorpusSource(relPath: string, text: string): void {
	const target = path.join(corpusRoot, relPath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, text);
}

/** The published vector of chunk `index`, read back from vectors.f32 little-endian. */
function chunkVector(index: number): Float32Array {
	const bytes = fs.readFileSync(path.join(storageRoot, "corpus", corpusSnapshotId, "vectors.f32"));
	const vector = new Float32Array(DIM);
	for (let element = 0; element < DIM; element += 1) {
		vector[element] = bytes.readFloatLE(index * DIM * 4 + element * 4);
	}
	return vector;
}

/** Publishes a vector as a state payload and returns the envelope material that names it. */
function stateRefOf(vector: Float32Array, representationId = embedder.representationId): StateRef {
	const buffer = Buffer.alloc(vector.length * 4);
	for (const [index, value] of vector.entries()) buffer.writeFloatLE(value, index * 4);
	const payloadId = contentStore.put(new Uint8Array(buffer), SYNAPSE_VECTOR_MEDIA_TYPE);
	return { baseMemoryId: null, byteLength: buffer.byteLength, dim: vector.length, encoding: "float32-vector", payloadId, representationId, sha256: payloadId };
}

/**
 * Publishes a residual computed against `base` and returns the envelope material
 * that names it. The base itself is NOT published as a state payload: a residual
 * is decodable only from the receiver's own memory, so the tests supply it
 * through the `baseVectorFor` seam exactly as the receiver's store does.
 */
function deltaStateRefOf(vector: Float32Array, base: PredictedBase): StateRef {
	const choice = chooseStatePayload({ base, fullVector: vector, representationId: embedder.representationId });
	assert.equal(choice.encoding, "delta", "the fixture must actually produce a residual");
	const payloadId = contentStore.put(choice.payload, "application/x-synapse-delta");
	return {
		baseMemoryId: choice.baseMemoryId,
		byteLength: choice.payload.byteLength,
		dim: vector.length,
		encoding: "delta",
		payloadId,
		representationId: embedder.representationId,
		sha256: payloadId,
	};
}

function service(pinned?: string | null): MemoryService {
	const scope: AccessScope = { agent: "retriever", namespaceId: "0123456789abcdef", pathPrefixes: [""], write: false };
	return createMemoryService({
		corpusSnapshotId: pinned === undefined ? corpusSnapshotId : pinned,
		provenance: { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "sess-1" },
		scope,
		storeRoot: storageRoot,
		worktreeRoot: worktree,
	});
}

beforeEach(async () => {
	storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-state-"));
	corpusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-corpus-"));
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-statewt-"));
	logPath = path.join(storageRoot, "metering.jsonl");
	log = createMeteringLog(logPath);
	contentStore = createContentStore(storageRoot);
	writeCorpusSource("src/a.md", "# alpha\nshared memory plane observation one\n");
	writeCorpusSource("src/b.md", "# beta\ncoordination as compression observation two\n");
	writeCorpusSource("src/c.md", "# gamma\nresidual quantisation observation three\n");
	const built = await buildCorpus({ corpusRoot, embedder, sourceCommit: SOURCE_COMMIT, storageRoot });
	chunks = built.chunks;
	corpusSnapshotId = built.corpusSnapshotId;
});

afterEach(() => {
	fs.rmSync(storageRoot, { force: true, recursive: true });
	fs.rmSync(corpusRoot, { force: true, recursive: true });
	fs.rmSync(worktree, { force: true, recursive: true });
});

describe("cosineSimilarity", () => {
	it("measures agreement, and refuses to compare two widths", () => {
		assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0])), 1);
		assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1])), 0);
		// Two spaces are not comparable element-wise: a number produced anyway would be
		// read as agreement between vectors that never shared a coordinate system.
		assert.throws(() => cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0])), /representation-mismatch/);
		assert.throws(() => cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 0])), /integrity/);
	});
});

describe("state retrieval over a published corpus (P3-4)", () => {
	it("ranks the chunk whose vector arrived as the state top-1 (true consumption)", () => {
		const stateRef = stateRefOf(chunkVector(1));
		const result = retrieveWithState(deps(), { corpusSnapshotId, k: 3, stateRef });
		const top = result.hits[0];
		assert.ok(top, "a three-chunk corpus with k=3 must return hits");
		assert.equal(top.chunkId, chunks[1]?.chunkId);
		assert.ok(Math.abs(top.cosine - 1) < 1e-6, `cosine to itself must be 1, got ${top.cosine}`);
		assert.equal(top.path, chunks[1]?.path);
		assert.equal(result.corpusSnapshotId, corpusSnapshotId);
		assert.equal(result.representationId, embedder.representationId);
	});

	it("carries each hit's first text line as a recognition anchor (O6)", () => {
		const stateRef = stateRefOf(chunkVector(1));
		const result = retrieveWithState(deps(), { corpusSnapshotId, k: 3, stateRef });
		// The fixtures write chunks as "# <name>\n<observation>"; the preview is the
		// first non-empty line, so a hit renders an anchor the child can recognise
		// before it reads — never the body.
		assert.equal(result.hits[0]?.preview, "# beta");
		for (const hit of result.hits) assert.ok(typeof hit.preview === "string" && hit.preview.length > 0);
	});

	it("moves the top-1 when the query vector is orthogonal to the previous winner (AC-05 unit form)", () => {
		const winner = chunkVector(1);
		const seed = chunkVector(0);
		let dot = 0;
		for (let index = 0; index < DIM; index += 1) dot += seed[index]! * winner[index]!;
		const orthogonal = new Float32Array(DIM);
		let normSquared = 0;
		for (let index = 0; index < DIM; index += 1) {
			orthogonal[index] = seed[index]! - dot * winner[index]!;
			normSquared += orthogonal[index]! * orthogonal[index]!;
		}
		const norm = Math.sqrt(normSquared);
		assert.ok(norm > 1e-6, "fixture: the first two chunk vectors must not be parallel");
		for (let index = 0; index < DIM; index += 1) orthogonal[index] = orthogonal[index]! / norm;
		const result = retrieveWithState(deps(), { corpusSnapshotId, k: 3, stateRef: stateRefOf(orthogonal) });
		const top = result.hits[0];
		assert.ok(top);
		assert.notEqual(top.chunkId, chunks[1]?.chunkId);
		const runnerUp = result.hits.find((hit) => hit.chunkId === chunks[1]?.chunkId);
		assert.ok(runnerUp, "the deposed winner still ranks somewhere");
		assert.ok(Math.abs(runnerUp.cosine) < 1e-6, `orthogonality must show as ~0 cosine, got ${runnerUp.cosine}`);
	});

	it("rejects a tampered sha256 without returning any candidate", () => {
		const stateRef = { ...stateRefOf(chunkVector(1)), sha256: "0".repeat(64) };
		assert.throws(() => retrieveWithState(deps(), { corpusSnapshotId, k: 3, stateRef }), /integrity/);
		const consumeEvents = readMeteringLog(logPath).filter((event) => event.kind === "state-consume");
		assert.equal(consumeEvents.length, 0, "a rejected payload must not be metered as consumed");
	});

	it("reports a representation mismatch instead of re-embedding under another model", () => {
		const stateRef = stateRefOf(chunkVector(1), "siliconflow/other-model/1024");
		assert.throws(
			() => retrieveWithState(deps(), { corpusSnapshotId, k: 3, stateRef }),
			/representation-mismatch: .*other-model/,
		);
	});

	it("reports a missing corpus snapshot as object-unavailable", () => {
		const stateRef = stateRefOf(chunkVector(1));
		assert.throws(() => retrieveWithState(deps(), { corpusSnapshotId: "1".repeat(64), k: 3, stateRef }), /object-unavailable: corpus/);
	});

	it("rejects stateId and query supplied together (exactly one wins)", () => {
		const stateRef = stateRefOf(chunkVector(1));
		assert.throws(() => service().search({ k: 3, query: "anything", stateId: stateRef.payloadId, stateRef }), /query-required: supply exactly one/);
	});

	it("requires the envelope's stateRef whenever stateId is supplied", () => {
		assert.throws(() => service().search({ stateId: "a".repeat(64) }), /stateRef-required/);
	});

	it("rejects a stateId that names a different object than its stateRef", () => {
		const stateRef = stateRefOf(chunkVector(1));
		assert.throws(() => service().search({ k: 3, stateId: stateRefOf(chunkVector(0)).payloadId, stateRef }), /integrity: stateId/);
	});
});

describe("state retrieval service wiring", () => {
	it("serves the stateId path through search and searchSemantic with the same top-1", async () => {
		const stateRef = stateRefOf(chunkVector(2));
		const syncHit = service().search({ k: 3, stateId: stateRef.payloadId, stateRef });
		const asyncHit = await service().searchSemantic({ k: 3, stateId: stateRef.payloadId, stateRef });
		for (const result of [syncHit, asyncHit]) {
			// A state search returns corpus hits, never the memory ranking shape.
			assert.equal("semantic" in result, false);
			assert.equal(result.hits[0]?.chunkId, chunks[2]?.chunkId);
		}
	});

	it("refuses state retrieval when no corpus snapshot is pinned", () => {
		const stateRef = stateRefOf(chunkVector(1));
		const unpinned = service(null);
		assert.throws(() => unpinned.search({ k: 3, stateId: stateRef.payloadId, stateRef }), /synapse\.corpusSnapshotId/);
	});

	it("records exactly one state-consume event carrying payload, corpus and k", () => {
		const stateRef = stateRefOf(chunkVector(1));
		retrieveWithState(deps(), { corpusSnapshotId, k: 2, stateRef });
		const events = readMeteringLog(logPath).filter((event) => event.kind === "state-consume");
		assert.equal(events.length, 1);
		const consume = events[0];
		assert.ok(consume, "the single state-consume event must be present");
		assert.equal(consume.kind, "state-consume");
		assert.equal(consume.ok, true);
		assert.equal(consume.payloadId, stateRef.payloadId);
		assert.equal(consume.stateId, stateRef.payloadId);
		assert.equal(consume.corpusSnapshotId, corpusSnapshotId);
		assert.equal(consume.k, 2);
		assert.equal(consume.payloadBytes, stateRef.byteLength);
		assert.equal(consume.representationId, embedder.representationId);
	});

	it("meters the service path too: a stateId search records its own state-consume event", () => {
		const stateRef = stateRefOf(chunkVector(1));
		const scope: AccessScope = { agent: "retriever", namespaceId: "0123456789abcdef", pathPrefixes: [""], write: false };
		const metered = createMemoryService({
			corpusSnapshotId,
			metering: { identity: identity(), log },
			provenance: { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "sess-1" },
			scope,
			storeRoot: storageRoot,
			worktreeRoot: worktree,
		});
		const state = metered.search({ k: 3, stateId: stateRef.payloadId, stateRef });
		// SAFETY: a state search returns the corpus retrieval shape, never the memory ranking shape.
		assert.equal("semantic" in state, false);
		const events = readMeteringLog(logPath).filter((event) => event.kind === "state-consume");
		assert.equal(events.length, 1);
		assert.equal(events[0]?.corpusSnapshotId, corpusSnapshotId);
	});
});

describe("state payload integrity guards", () => {
	it("refuses an all-zero vector: cosine against it is undefined", () => {
		const stateRef = stateRefOf(new Float32Array(DIM));
		assert.throws(() => retrieveWithState(deps(), { corpusSnapshotId, k: 3, stateRef }), /integrity: .*zero/);
	});

	it("refuses a payload holding a non-finite value", () => {
		const vector = chunkVector(0);
		vector[3] = Number.NaN;
		const stateRef = stateRefOf(vector);
		assert.throws(() => retrieveWithState(deps(), { corpusSnapshotId, k: 3, stateRef }), /integrity: .*non-finite/);
	});

	it("refuses a payload whose byte length contradicts the envelope", () => {
		const stateRef = stateRefOf(chunkVector(1));
		const truncated = { ...stateRef, byteLength: stateRef.byteLength - 4 };
		assert.throws(() => retrieveWithState(deps(), { corpusSnapshotId, k: 3, stateRef: truncated }), /integrity: .*declared/);
	});

	it("consumes a residual against a base rebuilt from memory (P4-4)", () => {
		const query = chunkVector(1);
		const base: PredictedBase = { memoryId: "b".repeat(64), representationId: embedder.representationId, vector: chunkVector(1) };
		const stateRef = deltaStateRefOf(query, base);
		// The residual is smaller than the vector it replaces, so the path is worth
		// taking at all; the ranking is what must survive the round trip.
		assert.ok(stateRef.byteLength < DIM * 4);
		const result = retrieveWithState(
			deps({ baseVectorFor: (memoryId) => (memoryId === base.memoryId ? base.vector : null) }),
			{ corpusSnapshotId, k: 3, stateRef },
		);
		assert.equal(result.hits[0]?.chunkId, chunks[1]?.chunkId);
		// Consumption is metered with the encoding that crossed, so delta payload
		// bytes can be told apart from a full vector's in the aggregate.
		const consumed = readMeteringLog(logPath).filter((event) => event.kind === "state-consume");
		assert.equal(consumed.length, 1);
		assert.equal(consumed[0]?.encoding, "delta");
	});

	it("treats a base the receiver cannot rebuild as unavailability, not as corruption", () => {
		const query = chunkVector(1);
		const base: PredictedBase = { memoryId: "b".repeat(64), representationId: embedder.representationId, vector: chunkVector(1) };
		const stateRef = deltaStateRefOf(query, base);
		// A residual whose bytes verify but whose base is gone is a different failure
		// from a corrupt payload: the message can be recovered by re-sending a full
		// vector, and the category is what lets the caller know that.
		assert.throws(() => retrieveWithState(deps({ baseVectorFor: () => null }), { corpusSnapshotId, k: 3, stateRef }), /object-unavailable: base memory/);
	});

	it("treats a missing base seam as unavailability rather than reading the base from the envelope", () => {
		const query = chunkVector(1);
		const base: PredictedBase = { memoryId: "b".repeat(64), representationId: embedder.representationId, vector: chunkVector(1) };
		const stateRef = deltaStateRefOf(query, base);
		assert.throws(() => retrieveWithState(deps(), { corpusSnapshotId, k: 3, stateRef }), /object-unavailable: base memory/);
	});

	it("refuses a base whose width contradicts dim, so no residual is decoded against the wrong vector", () => {
		const query = chunkVector(1);
		const base: PredictedBase = { memoryId: "b".repeat(64), representationId: embedder.representationId, vector: chunkVector(1) };
		const stateRef = deltaStateRefOf(query, base);
		const short = new Float32Array(DIM - 1);
		assert.throws(
			() => retrieveWithState(deps({ baseVectorFor: () => short }), { corpusSnapshotId, k: 3, stateRef }),
			/integrity: base width/,
		);
	});

	it("refuses a delta stateRef that names no base at all", () => {
		const stateRef = { ...stateRefOf(chunkVector(1)), baseMemoryId: null, encoding: "delta" as const };
		assert.throws(
			() => retrieveWithState(deps({ baseVectorFor: () => chunkVector(1) }), { corpusSnapshotId, k: 3, stateRef }),
			/integrity: .*without a baseMemoryId/,
		);
	});

	it("detects a corrupted corpus vectors file through its published digest", () => {
		const stateRef = stateRefOf(chunkVector(1));
		const vectorsPath = path.join(storageRoot, "corpus", corpusSnapshotId, "vectors.f32");
		const bytes = fs.readFileSync(vectorsPath);
		bytes[0] = bytes[0]! ^ 0xff;
		fs.writeFileSync(vectorsPath, bytes);
		assert.throws(() => retrieveWithState(deps(), { corpusSnapshotId, k: 3, stateRef }), /integrity: .*vectors/);
	});

	it("detects a rewritten meta.json that no longer names its own directory", () => {
		const stateRef = stateRefOf(chunkVector(1));
		const metaPath = path.join(storageRoot, "corpus", corpusSnapshotId, "meta.json");
		fs.writeFileSync(metaPath, "{}");
		assert.throws(() => retrieveWithState(deps(), { corpusSnapshotId, k: 3, stateRef }), /integrity: corpus/);
	});

	it("classifies a meta.json that parses to a non-object as corruption, not absence", () => {
		const stateRef = stateRefOf(chunkVector(1));
		const metaPath = path.join(storageRoot, "corpus", corpusSnapshotId, "meta.json");
		fs.writeFileSync(metaPath, "null");
		assert.throws(() => retrieveWithState(deps(), { corpusSnapshotId, k: 3, stateRef }), /integrity: .*unreadable meta/);
	});

	it("keeps the store's own integrity category when the CAS object no longer matches its digest", () => {
		const stateRef = stateRefOf(chunkVector(1));
		const objectPath = contentStore.objectPath(stateRef.payloadId);
		const bytes = fs.readFileSync(objectPath);
		bytes[0] = bytes[0]! ^ 0xff;
		fs.writeFileSync(objectPath, bytes);
		assert.throws(() => retrieveWithState(deps(), { corpusSnapshotId, k: 3, stateRef }), /integrity: object/);
	});

	it("refuses a non-positive or fractional k instead of truncating silently", () => {
		const stateRef = stateRefOf(chunkVector(1));
		assert.throws(() => retrieveWithState(deps(), { corpusSnapshotId, k: 0, stateRef }), /k-out-of-range/);
		assert.throws(() => retrieveWithState(deps(), { corpusSnapshotId, k: 2.5, stateRef }), /k-out-of-range/);
	});

	it("refuses a corpus snapshot id that is not 64 lowercase hex before any path use", () => {
		const stateRef = stateRefOf(chunkVector(1));
		assert.throws(() => retrieveWithState(deps(), { corpusSnapshotId: "../../escape", k: 3, stateRef }), /invalid corpus snapshot id/);
	});
});

describe("state retrieval ordering", () => {
	it("breaks cosine ties by ascending chunkId", async () => {
		fs.rmSync(corpusRoot, { force: true, recursive: true });
		writeCorpusSource("docs/a.md", "identical body means an identical vector\n");
		writeCorpusSource("docs/b.md", "identical body means an identical vector\n");
		const built = await buildCorpus({ corpusRoot, embedder, sourceCommit: SOURCE_COMMIT, storageRoot });
		chunks = built.chunks;
		corpusSnapshotId = built.corpusSnapshotId;
		const stateRef = stateRefOf(chunkVector(0));
		const result = retrieveWithState(deps(), { corpusSnapshotId, k: 2, stateRef });
		assert.equal(result.hits.length, 2);
		assert.equal(result.hits[0]?.cosine, result.hits[1]?.cosine);
		assert.ok(result.hits[0]!.chunkId < result.hits[1]!.chunkId);
	});

	it("caps the ranking at k", () => {
		const stateRef = stateRefOf(chunkVector(0));
		const result = retrieveWithState(deps(), { corpusSnapshotId, k: 1, stateRef });
		assert.equal(result.hits.length, 1);
	});
});
