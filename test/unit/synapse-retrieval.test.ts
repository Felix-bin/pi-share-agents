import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccessScope } from "../../src/synapse/access.ts";
import type { MemoryRecord } from "../../src/synapse/memory-store.ts";
import { KEYWORD_WEIGHT, searchMemories, TAG_WEIGHT, tokenize } from "../../src/synapse/retrieval.ts";

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
