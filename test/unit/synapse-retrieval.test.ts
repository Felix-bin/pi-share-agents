import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccessScope } from "../../src/synapse/access.ts";
import type { MemoryRecord } from "../../src/synapse/memory-store.ts";
import { KEYWORD_WEIGHT, searchMemories, TAG_WEIGHT, tokenize } from "../../src/synapse/retrieval.ts";
import type { MemoryEmbeddingRef } from "../../src/synapse/memory-store.ts";

function scope(overrides: Partial<AccessScope> = {}): AccessScope {
	return {
		agent: overrides.agent ?? "retriever",
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
		embedding: null,
		contentId: "a".repeat(64),
		createdAt: overrides.createdAt ?? "2026-09-16T00:00:00.000Z",
		kind: "evidence",
		memoryId: overrides.memoryId ?? id,
		provenance: { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "s" },
		recordStatus: "active",
		source: overrides.source === undefined ? { byteLength: 1, digest: "c".repeat(64), path: "src/a.ts" } : overrides.source,
		summary: overrides.summary ?? "",
		tags: overrides.tags ?? [],
		taskTopic: overrides.taskTopic ?? "topic-a",
	};
}

describe("synapse tokenisation", () => {
	it("splits latin words case-insensitively", () => {
		assert.deepEqual(tokenize("Residual Encoder residual"), ["encoder", "residual"]);
	});

	it("treats each han character as its own token so cjk text is searchable", () => {
		assert.deepEqual(tokenize("共享记忆"), ["享", "共", "忆", "记"]);
	});

	it("drops punctuation instead of folding it into neighbouring words", () => {
		assert.deepEqual(tokenize("state-plane, v1.1"), ["1", "plane", "state", "v1"]);
	});

	it("is a stable set: repeated terms appear once, order is sorted", () => {
		assert.deepEqual(tokenize("b a b"), ["a", "b"]);
	});
});

describe("synapse keyword and tag scoring", () => {
	it("weights keyword overlap and tag overlap by the configured split", () => {
		assert.equal(KEYWORD_WEIGHT + TAG_WEIGHT, 1);
		const hit = record({ summary: "residual encoder", tags: ["state"] });
		const [result] = searchMemories({ query: { tags: ["state"], text: "residual encoder" }, records: [hit], scope: scope() });
		assert.ok(result);
		assert.equal(result.score, KEYWORD_WEIGHT * 1 + TAG_WEIGHT * 1);
		assert.equal(result.components.keyword, 1);
		assert.equal(result.components.tag, 1);
	});

	it("marks the semantic component unavailable while no embedding provider is wired", () => {
		const [result] = searchMemories({ query: { text: "residual" }, records: [record({ summary: "residual" })], scope: scope() });
		assert.equal(result?.components.semantic, "unavailable");
	});

	it("scores a record independently of the rest of the library", () => {
		// Deliberately not BM25: an IDF term would make this score drift as the
		// store grows, and a past run's log could no longer be recomputed.
		const target = record({ summary: "residual encoder" });
		const alone = searchMemories({ query: { text: "residual" }, records: [target], scope: scope() });
		const crowded = searchMemories({
			query: { text: "residual" },
			records: [target, record({ summary: "residual everywhere" }), record({ summary: "residual again" })],
			scope: scope(),
		});
		assert.equal(crowded.find((entry) => entry.record.memoryId === target.memoryId)?.score, alone[0]?.score);
	});

	it("ranks by score and breaks ties by memory id", () => {
		const first = record({ memoryId: "1".repeat(64), summary: "residual" });
		const second = record({ memoryId: "2".repeat(64), summary: "residual" });
		const ranked = searchMemories({ query: { text: "residual" }, records: [second, first], scope: scope() });
		assert.deepEqual(
			ranked.map((entry) => entry.record.memoryId),
			[first.memoryId, second.memoryId],
		);
	});

	it("omits records with no overlap at all", () => {
		const results = searchMemories({ query: { text: "residual" }, records: [record({ summary: "无关内容" })], scope: scope() });
		assert.deepEqual(results, []);
	});

	it("matches on the task topic as well as the summary", () => {
		const hit = record({ summary: "", taskTopic: "residual-calibration" });
		assert.equal(searchMemories({ query: { text: "residual calibration" }, records: [hit], scope: scope() }).length, 1);
	});

	it("applies the requested limit after ranking", () => {
		const records = [record({ summary: "residual encoder" }), record({ summary: "residual" }), record({ summary: "residual" })];
		const limited = searchMemories({ limit: 2, query: { text: "residual encoder" }, records, scope: scope() });
		assert.equal(limited.length, 2);
		assert.equal(limited[0]?.record.summary, "residual encoder");
	});

	it("returns nothing for an empty query rather than the whole library", () => {
		assert.deepEqual(searchMemories({ query: { text: "   " }, records: [record({ summary: "residual" })], scope: scope() }), []);
	});
});

describe("synapse search authorisation", () => {
	it("never returns a summary the caller is not authorised to read", () => {
		const secret = record({ source: { byteLength: 1, digest: "c".repeat(64), path: "secrets/keys.env" }, summary: "residual 机密" });
		const allowed = record({ source: { byteLength: 1, digest: "c".repeat(64), path: "src/a.ts" }, summary: "residual 公开" });
		const results = searchMemories({ query: { text: "residual" }, records: [secret, allowed], scope: scope({ pathPrefixes: ["src"] }) });
		assert.deepEqual(
			results.map((entry) => entry.record.memoryId),
			[allowed.memoryId],
		);
		assert.equal(JSON.stringify(results).includes("机密"), false);
	});

	it("returns nothing at all under an empty scope", () => {
		const results = searchMemories({ query: { text: "residual" }, records: [record({ summary: "residual" })], scope: scope({ pathPrefixes: [] }) });
		assert.deepEqual(results, []);
	});

	it("excludes superseded records unless history is explicitly requested", () => {
		const stale = { ...record({ summary: "residual 旧版" }), recordStatus: "superseded" as const };
		const fresh = record({ summary: "residual 新版" });
		const current = searchMemories({ query: { text: "residual" }, records: [stale, fresh], scope: scope() });
		assert.deepEqual(
			current.map((entry) => entry.record.memoryId),
			[fresh.memoryId],
		);
		const history = searchMemories({ includeSuperseded: true, query: { text: "residual" }, records: [stale, fresh], scope: scope() });
		assert.equal(history.length, 2);
		assert.equal(history.find((entry) => entry.record.memoryId === stale.memoryId)?.historical, true);
	});
});

describe("synapse semantic scoring", () => {
	const vectorRef: MemoryEmbeddingRef = { dim: 2, objectId: "b".repeat(64), representationId: "siliconflow/BAAI/bge-m3/2" };
	const nearId = "e".repeat(64);
	const farId = "f".repeat(64);

	function semanticRecords() {
		const near = record({
			embedding: vectorRef,
			memoryId: nearId,
			summary: "完全不相关的词甲乙丙",
			taskTopic: "无关主题",
		});
		const far = record({
			embedding: vectorRef,
			memoryId: farId,
			summary: "residual encoder 观察",
			taskTopic: "residual",
		});
		return { far, near };
	}

	it("ranks a semantically near record above a keyword-heavy one once vectors take part", () => {
		const { far, near } = semanticRecords();
		const query = { text: "residual encoder" };
		const keywordOnly = searchMemories({ query, records: [far, near], scope: scope() });
		assert.equal(keywordOnly[0]?.record.memoryId, far.memoryId);
		const semantic = searchMemories({
			query,
			records: [far, near],
			scope: scope(),
			semantic: {
				queryVector: new Float32Array([1, 0]),
				recordVectors: new Map([
					[nearId, new Float32Array([1, 0])],
					[farId, new Float32Array([0, 1])],
				]),
			},
		});
		assert.equal(semantic[0]?.record.memoryId, near.memoryId);
		const nearComponent = semantic[0]?.components.semantic;
		assert.notEqual(nearComponent, "unavailable");
		// SAFETY: the component union is number | "unavailable" and the marker is excluded above.
		assert.ok((nearComponent as number) > 0.99);
	});

	it("keeps the keyword-only behaviour and marker when no semantic input is given", () => {
		const { far, near } = semanticRecords();
		const results = searchMemories({ query: { text: "residual encoder" }, records: [far, near], scope: scope() });
		assert.equal(results[0]?.components.semantic, "unavailable");
		assert.ok(results.every((entry) => entry.score === KEYWORD_WEIGHT * entry.components.keyword + TAG_WEIGHT * entry.components.tag));
	});

	it("produces the same ordering for repeated identical semantic queries", () => {
		const { far, near } = semanticRecords();
		const input = {
			query: { text: "residual encoder" },
			records: [far, near],
			scope: scope(),
			semantic: {
				queryVector: new Float32Array([1, 0]),
				recordVectors: new Map([
					[nearId, new Float32Array([1, 0])],
					[farId, new Float32Array([0, 1])],
				]),
			},
		} as const;
		const first = searchMemories(input);
		const second = searchMemories(input);
		assert.deepEqual(
			first.map((entry) => entry.record.memoryId),
			second.map((entry) => entry.record.memoryId),
		);
		assert.deepEqual(
			first.map((entry) => entry.score),
			second.map((entry) => entry.score),
		);
	});

	it("scores the semantic component as zero for records without a vector and keeps them ranked", () => {
		const plain = record({ summary: "residual encoder 无向量", taskTopic: "residual" });
		const results = searchMemories({
			query: { text: "residual encoder" },
			records: [plain],
			scope: scope(),
			semantic: { queryVector: new Float32Array([1, 0]), recordVectors: new Map() },
		});
		assert.equal(results.length, 1);
		assert.equal(results[0]?.components.semantic, 0);
		assert.ok((results[0]?.score ?? 0) > 0);
	});

	it("never returns a record outside the caller's grant, even with the nearest vector", () => {
		const secret = record({
			embedding: vectorRef,
			memoryId: nearId,
			source: { byteLength: 1, digest: "c".repeat(64), path: "secrets/keys.env" },
			summary: "机密观察",
			taskTopic: "机密主题",
		});
		const allowed = record({ embedding: vectorRef, memoryId: farId, summary: "residual encoder 观察", taskTopic: "residual" });
		const results = searchMemories({
			query: { text: "机密" },
			records: [secret, allowed],
			scope: scope({ pathPrefixes: ["src"] }),
			semantic: {
				queryVector: new Float32Array([1, 0]),
				recordVectors: new Map([
					[nearId, new Float32Array([1, 0])],
					[farId, new Float32Array([0.8, 0.6])],
				]),
			},
		});
		// The allowed record must actually score and appear, or the exclusion
		// assertion would pass vacuously on an empty result set.
		assert.ok(results.some((entry) => entry.record.memoryId === farId));
		assert.ok(results.every((entry) => entry.record.memoryId !== nearId));
	});
});
