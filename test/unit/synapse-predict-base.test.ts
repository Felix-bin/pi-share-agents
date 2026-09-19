import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AccessScope } from "../../src/synapse/access.ts";
import type { Embedder } from "../../src/synapse/embedding.ts";
import type { MemoryEmbeddingRef, MemoryRecord } from "../../src/synapse/memory-store.ts";
import { createMemoryService, type MemoryService, type MemoryValidity } from "../../src/synapse/memory-service.ts";
import { selectPredictedBase } from "../../src/synapse/predict-base.ts";
import type { SemanticScoring } from "../../src/synapse/retrieval.ts";
import { createDeterministicEmbedder } from "../support/deterministic-embedder.ts";

const REPRESENTATION_ID = "siliconflow/BAAI/bge-m3/2";

function scope(overrides: Partial<AccessScope> = {}): AccessScope {
	return {
		agent: overrides.agent ?? "parent",
		namespaceId: "0123456789abcdef",
		pathPrefixes: overrides.pathPrefixes ?? [""],
		write: false,
	};
}

let counter = 0;

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	counter += 1;
	const id = counter.toString(16).padStart(64, "0");
	return {
		assurance: "observation",
		contentId: "a".repeat(64),
		createdAt: "2026-09-19T00:00:00.000Z",
		embedding: overrides.embedding ?? null,
		kind: "evidence",
		memoryId: overrides.memoryId ?? id,
		provenance: { agent: "parent", attempt: 1, runId: "run-1", sessionId: "s" },
		recordStatus: "active",
		source: overrides.source === undefined ? { byteLength: 1, digest: "c".repeat(64), path: "src/a.ts" } : overrides.source,
		summary: overrides.summary ?? "",
		tags: overrides.tags ?? [],
		taskTopic: overrides.taskTopic ?? "topic-a",
	};
}

const VECTOR_REF: MemoryEmbeddingRef = { dim: 2, objectId: "b".repeat(64), representationId: REPRESENTATION_ID };

/** A two-dimensional vector makes each cosine in these tests exactly readable. */
function vector(x: number, y: number): Float32Array {
	return Float32Array.from([x, y]);
}

/** A fixed id so a test can name the record it expects back without echoing the generator. */
const HEAD_ID = "1".repeat(64);
const TAIL_ID = "2".repeat(64);

describe("synapse predicted base", () => {
	it("skips a higher-ranked record with no vector and takes the next ranked one", () => {
		const keywordOnly = record({ memoryId: HEAD_ID, summary: "residual encoder", taskTopic: "residual" });
		const vectorBacked = record({
			embedding: VECTOR_REF,
			memoryId: TAIL_ID,
			summary: "residual",
			taskTopic: "residual",
		});
		const selected = selectPredictedBase({
			query: { text: "residual encoder" },
			records: [keywordOnly, vectorBacked],
			scope: scope(),
			semantic: { queryVector: vector(1, 0), recordVectors: new Map([[TAIL_ID, vector(0, 1)]]) },
			validityOf: () => "current",
		});
		// The keyword-only record outranks the vector-backed one (0.3 vs 0.15), so a
		// selector that reordered by "has a vector" would still pass here only by
		// accident; the assertion that matters is which record came back.
		assert.equal(selected?.memoryId, TAIL_ID);
	});

	it("keeps retrieval order instead of re-ranking candidates by cosine", () => {
		const rankedFirst = record({ embedding: VECTOR_REF, memoryId: HEAD_ID, summary: "residual encoder", taskTopic: "residual" });
		const closerAngle = record({ embedding: VECTOR_REF, memoryId: TAIL_ID, summary: "甲乙丙丁", taskTopic: "戊己" });
		const selected = selectPredictedBase({
			query: { text: "residual encoder" },
			records: [rankedFirst, closerAngle],
			scope: scope(),
			semantic: {
				queryVector: vector(1, 0),
				recordVectors: new Map([
					[HEAD_ID, vector(0.9, Math.sqrt(1 - 0.81))],
					[TAIL_ID, vector(1, 0)],
				]),
			},
			validityOf: () => "current",
		});
		// rankedFirst scores 0.3 * 1 + 0.5 * 0.9 = 0.75 and closerAngle scores
		// 0.3 * 0 + 0.5 * 1 = 0.5, so the ranking names a base whose angle is *worse*
		// than the runner-up's. A selector that took the nearest vector would answer
		// TAIL_ID and stop matching the order the retrieval path reports.
		assert.equal(selected?.memoryId, HEAD_ID);
	});

	it("follows the semantic ranking rather than a keyword-only one", () => {
		const keywordHeavy = record({ embedding: VECTOR_REF, memoryId: HEAD_ID, summary: "residual encoder", taskTopic: "residual" });
		const semanticallyClose = record({ embedding: VECTOR_REF, memoryId: TAIL_ID, summary: "甲乙丙丁", taskTopic: "戊己" });
		const selected = selectPredictedBase({
			query: { text: "residual encoder" },
			records: [keywordHeavy, semanticallyClose],
			scope: scope(),
			semantic: {
				queryVector: vector(1, 0),
				recordVectors: new Map([
					[HEAD_ID, vector(0, 1)],
					[TAIL_ID, vector(1, 0)],
				]),
			},
			validityOf: () => "current",
		});
		// Both records carry a vector, so the two rankings disagree on the winner:
		// keyword-first would answer HEAD_ID (0.3 vs 0), semantic-first answers TAIL_ID
		// (0.5 vs 0.3). Calibration pairs are only faithful when this order is kept.
		assert.equal(selected?.memoryId, TAIL_ID);
	});

	it("skips a record whose source is no longer current", () => {
		const stale = record({ embedding: VECTOR_REF, memoryId: HEAD_ID, summary: "residual encoder", taskTopic: "residual" });
		const current = record({ embedding: VECTOR_REF, memoryId: TAIL_ID, summary: "residual", taskTopic: "residual" });
		const validity = new Map<string, MemoryValidity>([
			[HEAD_ID, "stale"],
			[TAIL_ID, "current"],
		]);
		const selected = selectPredictedBase({
			query: { text: "residual encoder" },
			records: [stale, current],
			scope: scope(),
			semantic: {
				queryVector: vector(1, 0),
				recordVectors: new Map([
					[HEAD_ID, vector(1, 0)],
					[TAIL_ID, vector(1, 0)],
				]),
			},
			validityOf: (candidate) => validity.get(candidate.memoryId) ?? "unavailable",
		});
		assert.equal(selected?.memoryId, TAIL_ID);
	});

	it("never selects a record the caller's scope does not cover", () => {
		const denied = record({
			embedding: VECTOR_REF,
			memoryId: HEAD_ID,
			source: { byteLength: 1, digest: "c".repeat(64), path: "secrets/a.ts" },
			summary: "residual encoder",
			taskTopic: "residual",
		});
		const allowed = record({ embedding: VECTOR_REF, memoryId: TAIL_ID, summary: "residual", taskTopic: "residual" });
		const selected = selectPredictedBase({
			query: { text: "residual encoder" },
			records: [denied, allowed],
			scope: scope({ pathPrefixes: ["src/"] }),
			semantic: {
				queryVector: vector(1, 0),
				recordVectors: new Map([
					[HEAD_ID, vector(1, 0)],
					[TAIL_ID, vector(1, 0)],
				]),
			},
			validityOf: () => "current",
		});
		assert.equal(selected?.memoryId, TAIL_ID);
	});

	it("returns null when no candidate has a usable vector", () => {
		const noVector = record({ memoryId: HEAD_ID, summary: "residual encoder", taskTopic: "residual" });
		const foreignSpace = record({ embedding: VECTOR_REF, memoryId: TAIL_ID, summary: "residual encoder", taskTopic: "residual" });
		assert.equal(
			selectPredictedBase({
				query: { text: "residual encoder" },
				records: [noVector, foreignSpace],
				scope: scope(),
				semantic: { queryVector: vector(1, 0), recordVectors: new Map() },
				validityOf: () => "current",
			}),
			null,
		);
	});

	it("returns null when no query vector is available to rank with", () => {
		const backed = record({ embedding: VECTOR_REF, memoryId: HEAD_ID, summary: "residual encoder", taskTopic: "residual" });
		assert.equal(
			selectPredictedBase({
				query: { text: "residual encoder" },
				records: [backed],
				scope: scope(),
				validityOf: () => "current",
			}),
			null,
		);
	});

	it("refuses a record that declares no vector even when the map carries one for it", () => {
		const unflagged = record({ memoryId: HEAD_ID, summary: "residual encoder", taskTopic: "residual" });
		const selected = selectPredictedBase({
			query: { text: "residual encoder" },
			records: [unflagged],
			scope: scope(),
			// The record's own `embedding` field is what makes a vector claim, and it is
			// the only place the returned representation id can come from. A caller-built
			// map that disagrees with the record must answer null, not read a
			// representation id off a record that carries none.
			semantic: { queryVector: vector(1, 0), recordVectors: new Map([[HEAD_ID, vector(1, 0)]]) },
			validityOf: () => "current",
		});
		assert.equal(selected, null);
	});

	it("reports the base's representation id from the record that supplied it", () => {
		const backed = record({ embedding: VECTOR_REF, memoryId: HEAD_ID, summary: "residual", taskTopic: "residual" });
		const selected = selectPredictedBase({
			query: { text: "residual" },
			records: [backed],
			scope: scope(),
			semantic: { queryVector: vector(1, 0), recordVectors: new Map([[HEAD_ID, vector(0, 1)]]) },
			validityOf: () => "current",
		});
		assert.equal(selected?.representationId, REPRESENTATION_ID);
		assert.notEqual(selected?.vector, undefined);
	});

	it("hands back a copy so a caller cannot mutate the vector it was given", () => {
		const backed = record({ embedding: VECTOR_REF, memoryId: HEAD_ID, summary: "residual", taskTopic: "residual" });
		const stored = vector(0, 1);
		const semantic: SemanticScoring = { queryVector: vector(1, 0), recordVectors: new Map([[HEAD_ID, stored]]) };
		const selected = selectPredictedBase({
			query: { text: "residual" },
			records: [backed],
			scope: scope(),
			semantic,
			validityOf: () => "current",
		});
		assert.ok(selected);
		selected.vector[0] = 99;
		assert.equal(stored[0], 0);
		assert.deepEqual([...selected.vector], [99, 1]);
	});

	it("answers the same record twice for the same input", () => {
		const first = record({ embedding: VECTOR_REF, memoryId: HEAD_ID, summary: "residual encoder", taskTopic: "residual" });
		const second = record({ embedding: VECTOR_REF, memoryId: TAIL_ID, summary: "residual encoder", taskTopic: "residual" });
		const input = {
			query: { text: "residual encoder" },
			records: [first, second],
			scope: scope(),
			semantic: {
				queryVector: vector(1, 0),
				recordVectors: new Map([
					[HEAD_ID, vector(1, 0)],
					[TAIL_ID, vector(1, 0)],
				]),
			},
			validityOf: (): MemoryValidity => "current",
		};
		assert.equal(selectPredictedBase(input)?.memoryId, HEAD_ID);
		assert.equal(selectPredictedBase(input)?.memoryId, HEAD_ID);
	});
});

describe("synapse memory service predicted base", () => {
	let storeRoot = "";
	let worktree = "";

	beforeEach(() => {
		storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-predict-"));
		worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-predict-wt-"));
	});

	afterEach(() => {
		fs.rmSync(storeRoot, { force: true, recursive: true });
		fs.rmSync(worktree, { force: true, recursive: true });
	});

	function service(embedder?: Embedder): MemoryService {
		return createMemoryService({
			embedder,
			provenance: { agent: "parent", attempt: 1, runId: "run-1", sessionId: "sess-1" },
			scope: { agent: "parent", namespaceId: "0123456789abcdef", pathPrefixes: [""], write: true },
			storeRoot,
			worktreeRoot: worktree,
		});
	}

	function remember(svc: MemoryService, operationId: string, summary: string): Promise<{ record: MemoryRecord }> {
		return svc.remember({ content: `${summary} 正文`, kind: "evidence", operationId, summary, tags: [], topic: "residual" });
	}

	function countingEmbedder(inner: Embedder, counter: { calls: number }): Embedder {
		return {
			async embedBatch(texts: readonly string[]): ReturnType<Embedder["embedBatch"]> {
				counter.calls += 1;
				return inner.embedBatch(texts);
			},
			async embedQuery(text: string): ReturnType<Embedder["embedQuery"]> {
				counter.calls += 1;
				return inner.embedQuery(text);
			},
			representationId: inner.representationId,
		};
	}

	it("names the first ranked record that carries a vector, reading it out of the store", async () => {
		// Written while no embedder was configured, so this record keeps ranking on
		// its text alone and can never carry a base.
		const unbacked = await remember(service(), "op-unbacked", "residual encoder 观察");
		const embedder = createDeterministicEmbedder(4);
		const svc = service(embedder);
		const backed = await remember(svc, "op-backed", "residual");
		const base = await svc.predictBase({ text: "residual encoder" });
		assert.notEqual(base?.memoryId, unbacked.record.memoryId);
		assert.equal(base?.memoryId, backed.record.memoryId);
		assert.equal(base?.representationId, embedder.representationId);
		assert.equal(base?.vector.length, 4);
	});

	it("answers null over a store where no record carries a vector", async () => {
		await remember(service(), "op-unbacked", "residual encoder");
		const counter = { calls: 0 };
		const svc = service(countingEmbedder(createDeterministicEmbedder(4), counter));
		assert.equal(await svc.predictBase({ text: "residual encoder" }), null);
		// No usable base can be named, so the query must not be embedded either: a
		// paid call whose only consumer is a selection that cannot succeed is waste.
		assert.equal(counter.calls, 0);
	});

	it("answers null instead of failing when a stored vector's dimension disagrees with the query's", async () => {
		// Same representation id, different width: the record claims a space the query
		// vector does not share, so the two cannot be compared at all.
		const wide = createDeterministicEmbedder(8, "deterministic-test/sha256/v1");
		await remember(service(wide), "op-wide", "residual encoder");
		const narrow = createDeterministicEmbedder(4, "deterministic-test/sha256/v1");
		assert.equal(await service(narrow).predictBase({ text: "residual encoder" }), null);
	});

	it("answers null without an embedder, since there is no query vector to rank with", async () => {
		const svc = service(createDeterministicEmbedder(4));
		await remember(svc, "op-backed", "residual encoder");
		assert.equal(await service().predictBase({ text: "residual encoder" }), null);
	});

	it("propagates an embedding failure instead of naming a base from a keyword order", async () => {
		const embedder = createDeterministicEmbedder(4);
		await remember(service(embedder), "op-backed", "residual encoder");
		const offline: Embedder = {
			async embedBatch(): Promise<never> {
				throw new Error("provider down");
			},
			async embedQuery(): Promise<never> {
				throw new Error("provider down");
			},
			representationId: embedder.representationId,
		};
		// The store does hold a usable base; only the query vector is unavailable.
		// Answering null here would let a caller record a base chosen from a keyword
		// order, which is exactly the order the calibration did not measure.
		await assert.rejects(service(offline).predictBase({ text: "residual encoder" }), /provider down/u);
	});
});
