import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AccessScope } from "../../src/synapse/access.ts";
import { createContentStore } from "../../src/synapse/content-store.ts";
import { createSiliconFlowEmbedder, SYNAPSE_VECTOR_MEDIA_TYPE, type Embedder } from "../../src/synapse/embedding.ts";
import { createMeteringLog, readMeteringLog, type MeteringEvent, type MeteringIdentity, type MeteringLog } from "../../src/synapse/metering.ts";
import { startEmbeddingStub } from "../support/embedding-stub-server.ts";
import {
	createMemoryService,
	SYNAPSE_DEFAULT_SEARCH_K,
	SYNAPSE_MAX_GET_BYTES,
	SYNAPSE_MAX_SEARCH_K,
	SYNAPSE_MAX_SUMMARY_BYTES,
	type MemoryService,
} from "../../src/synapse/memory-service.ts";
import { createMemoryStore } from "../../src/synapse/memory-store.ts";

let storeRoot = "";
let worktree = "";
let clock = 0;

function scope(overrides: Partial<AccessScope> = {}): AccessScope {
	return {
		agent: overrides.agent ?? "retriever",
		namespaceId: "0123456789abcdef",
		pathPrefixes: overrides.pathPrefixes ?? [""],
		write: overrides.write ?? true,
	};
}

function service(overrides: { scope?: AccessScope } = {}): MemoryService {
	return createMemoryService({
		now: () => new Date(clock),
		provenance: { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "sess-1" },
		scope: overrides.scope ?? scope(),
		storeRoot,
		worktreeRoot: worktree,
	});
}

function writeSource(relPath: string, text: string): void {
	const target = path.join(worktree, relPath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, text);
}

beforeEach(() => {
	storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-svc-"));
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-svcwt-"));
	clock = Date.UTC(2026, 8, 16, 0, 0, 0);
});

afterEach(() => {
	fs.rmSync(storeRoot, { force: true, recursive: true });
	fs.rmSync(worktree, { force: true, recursive: true });
});

describe("synapse_write.remember", () => {
	it("records the host identity and refuses to take it from the caller", async () => {
		const written = await service().remember({
			content: "残差编码在连续任务中收缩",
			kind: "evidence",
			operationId: "op-1",
			summary: "残差收缩观察",
			tags: ["residual"],
			topic: "delta",
		});
		assert.equal(written.record.provenance.agent, "retriever");
		assert.equal(written.record.provenance.sessionId, "sess-1");
		assert.equal(written.record.taskTopic, "delta");
	});

	it("marks a sourced observation and a derived conclusion differently, and neither as accepted", async () => {
		writeSource("src/a.ts", "export const a = 1;\n");
		const observed = await service().remember({
			content: "文件内容摘录",
			kind: "evidence",
			operationId: "op-obs",
			sourcePath: "src/a.ts",
			summary: "来自源码的观察",
			tags: [],
			topic: "code",
		});
		const derived = await service().remember({
			content: "综合以上材料的结论",
			kind: "conclusion",
			operationId: "op-derived",
			summary: "推导出的结论",
			tags: [],
			topic: "code",
		});
		assert.equal(observed.record.assurance, "observation");
		assert.equal(derived.record.assurance, "derived");
		// There is no third value: a record cannot claim it was accepted.
		assert.equal(JSON.stringify(observed).includes("verified"), false);
	});

	it("captures the source fingerprint so the record can be invalidated later", async () => {
		writeSource("src/a.ts", "export const a = 1;\n");
		const written = await service().remember({
			content: "摘录",
			kind: "evidence",
			operationId: "op-1",
			sourcePath: "src/a.ts",
			summary: "观察",
			tags: [],
			topic: "code",
		});
		assert.equal(written.record.source?.path, "src/a.ts");
		assert.match(written.record.source?.digest ?? "", /^[0-9a-f]{64}$/);
	});

	it("refuses to claim a source that does not exist", async () => {
		await assert.rejects(
			async () =>
				service().remember({
					content: "摘录",
					kind: "evidence",
					operationId: "op-1",
					sourcePath: "src/absent.ts",
					summary: "观察",
					tags: [],
					topic: "code",
				}),
			/source-missing/,
		);
	});

	it("refuses a source outside the caller's granted prefixes", async () => {
		writeSource("secrets/keys.env", "TOKEN=1");
		await assert.rejects(
			async () =>
				service({ scope: scope({ pathPrefixes: ["src"] }) }).remember({
					content: "摘录",
					kind: "evidence",
					operationId: "op-1",
					sourcePath: "secrets/keys.env",
					summary: "观察",
					tags: [],
					topic: "code",
				}),
			/not-authorised/,
		);
	});

	it("rejects a write from a read-only role before touching the store", async () => {
		await assert.rejects(
			async () =>
				service({ scope: scope({ write: false }) }).remember({
					content: "摘录",
					kind: "evidence",
					operationId: "op-1",
					summary: "观察",
					tags: [],
					topic: "code",
				}),
			/not-authorised/,
		);
		assert.equal(fs.existsSync(path.join(storeRoot, "memory")), false);
	});

	it("rejects a summary above the byte limit rather than truncating it", async () => {
		await assert.rejects(
			async () =>
				service().remember({
					content: "x",
					kind: "evidence",
					operationId: "op-1",
					summary: "验".repeat(SYNAPSE_MAX_SUMMARY_BYTES),
					tags: [],
					topic: "code",
				}),
			/summary-too-large/,
		);
	});
});

describe("synapse_read.search", () => {
	async function seed(instance: MemoryService, summary: string, operationId: string, sourcePath?: string): Promise<string> {
		return (await instance.remember({ content: summary, kind: "evidence", operationId, sourcePath, summary, tags: ["seed"], topic: "topic-a" }))
			.record.memoryId;
	}

	it("finds a record written by one agent from another agent's session", async () => {
		const writer = createMemoryService({
			now: () => new Date(clock),
			provenance: { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "sess-1" },
			scope: scope(),
			storeRoot,
			worktreeRoot: worktree,
		});
		const written = await seed(writer, "residual encoder 观察", "op-1");
		const reader = createMemoryService({
			now: () => new Date(clock),
			provenance: { agent: "executor", attempt: 1, runId: "run-2", sessionId: "sess-2" },
			scope: scope({ agent: "executor" }),
			storeRoot,
			worktreeRoot: worktree,
		});
		const found = reader.search({ query: "residual encoder" });
		assert.equal(found.results[0]?.memoryId, written);
		assert.equal(found.semantic, "unavailable");
	});

	it("returns summaries and provenance without the body", async () => {
		const instance = service();
		await seed(instance, "residual encoder 观察", "op-1");
		const [hit] = instance.search({ query: "residual" }).results;
		assert.ok(hit);
		assert.equal(hit.summary, "residual encoder 观察");
		assert.equal(hit.sourceAgent, "retriever");
		assert.equal("content" in hit, false);
	});

	it("defaults k to 5 and rejects a k above the ceiling", async () => {
		const instance = service();
		for (let index = 0; index < 8; index += 1) await seed(instance, `residual ${index}`, `op-${index}`);
		assert.equal(instance.search({ query: "residual" }).results.length, SYNAPSE_DEFAULT_SEARCH_K);
		assert.equal(instance.search({ k: 8, query: "residual" }).results.length, 8);
		assert.throws(() => instance.search({ k: SYNAPSE_MAX_SEARCH_K + 1, query: "residual" }), /k-out-of-range/);
	});

	it("requires the envelope's stateRef material before state retrieval is attempted", async () => {
		assert.throws(() => service().search({ stateId: "a".repeat(64) }), /stateRef-required/);
	});

	it("requires exactly one of query or stateId", async () => {
		assert.throws(() => service().search({}), /query-required/);
	});

	it("hides a record the caller may not read, including its summary", async () => {
		writeSource("secrets/keys.env", "TOKEN=1");
		const privileged = service();
		await seed(privileged, "residual 机密观察", "op-secret", "secrets/keys.env");
		const restricted = service({ scope: scope({ pathPrefixes: ["src"] }) });
		const found = restricted.search({ query: "residual" });
		assert.deepEqual(found.results, []);
		assert.equal(JSON.stringify(found).includes("机密"), false);
	});

	it("excludes historical records unless they are asked for", async () => {
		const instance = service();
		const oldId = await seed(instance, "residual 旧版", "op-old");
		clock += 1000;
		const newId = await seed(instance, "residual 新版", "op-new");
		instance.supersede({ newId, oldId, reason: "source-changed" });
		assert.deepEqual(
			instance.search({ query: "residual" }).results.map((entry) => entry.memoryId),
			[newId],
		);
		const history = instance.search({ includeHistorical: true, query: "residual" });
		assert.equal(history.results.length, 2);
		assert.equal(history.results.find((entry) => entry.memoryId === oldId)?.historical, true);
	});
});

describe("synapse_read.get", () => {
	async function seedWithSource(instance: MemoryService, text: string): Promise<string> {
		writeSource("src/a.ts", text);
		return (await instance.remember({
			content: text,
			kind: "evidence",
			operationId: "op-1",
			sourcePath: "src/a.ts",
			summary: "观察",
			tags: [],
			topic: "code",
		})).record.memoryId;
	}

	it("returns the verified body and the next offset", async () => {
		const instance = service();
		const memoryId = await seedWithSource(instance, "0123456789");
		const page = instance.get({ limitBytes: 4, memoryId });
		assert.equal(page.text, "0123");
		assert.equal(page.nextOffsetBytes, 4);
		assert.equal(instance.get({ memoryId, offsetBytes: 4 }).text, "456789");
	});

	it("never splits a multi-byte character across pages", async () => {
		const instance = service();
		await seedWithSource(instance, "记忆复用");
		const memoryId = instance.search({ query: "观察" }).results[0]?.memoryId ?? "";
		const first = instance.get({ limitBytes: 4, memoryId });
		assert.equal(first.text, "记");
		assert.equal(instance.get({ memoryId, offsetBytes: first.nextOffsetBytes }).text, "忆复用");
	});

	it("caps a single page even when a larger limit is requested", async () => {
		const instance = service();
		const memoryId = await seedWithSource(instance, "x".repeat(SYNAPSE_MAX_GET_BYTES * 2));
		const page = instance.get({ limitBytes: SYNAPSE_MAX_GET_BYTES * 2, memoryId });
		assert.equal(page.text.length, SYNAPSE_MAX_GET_BYTES);
		assert.equal(page.totalBytes, SYNAPSE_MAX_GET_BYTES * 2);
	});

	it("refuses to read a record outside the caller's grant", async () => {
		writeSource("secrets/keys.env", "TOKEN=1");
		const memoryId = (await service().remember({
			content: "TOKEN=1",
			kind: "evidence",
			operationId: "op-1",
			sourcePath: "secrets/keys.env",
			summary: "观察",
			tags: [],
			topic: "secret",
		})).record.memoryId;
		assert.throws(() => service({ scope: scope({ pathPrefixes: ["src"] }) }).get({ memoryId }), /not-authorised/);
	});

	it("refuses a historical record unless it is explicitly allowed", async () => {
		const instance = service();
		const oldId = await seedWithSource(instance, "旧的正文");
		clock += 1000;
		const newId = (await instance.remember({
			content: "新的正文",
			kind: "evidence",
			operationId: "op-new",
			summary: "新观察",
			tags: [],
			topic: "code",
		})).record.memoryId;
		instance.supersede({ newId, oldId, reason: "source-changed" });
		assert.throws(() => instance.get({ memoryId: oldId }), /historical/);
		const allowed = instance.get({ allowHistorical: true, memoryId: oldId });
		assert.equal(allowed.text, "旧的正文");
		assert.equal(allowed.historical, true);
	});
});

describe("source validity through the service", () => {
	it("reports a record as stale after an uncommitted edit to its source", async () => {
		const instance = service();
		writeSource("src/a.ts", "export const a = 1;\n");
		const memoryId = (await instance.remember({
			content: "export const a = 1;\n",
			kind: "evidence",
			operationId: "op-1",
			sourcePath: "src/a.ts",
			summary: "观察",
			tags: [],
			topic: "code",
		})).record.memoryId;
		assert.equal(instance.search({ query: "观察" }).results[0]?.validity, "current");

		writeSource("src/a.ts", "export const a = 2;\n");
		const [hit] = instance.search({ query: "观察" }).results;
		// Still findable, but no longer usable as current evidence.
		assert.equal(hit?.validity, "stale");
		assert.equal(instance.get({ memoryId }).validity, "stale");
	});

	it("reports unavailable when the source is gone", async () => {
		const instance = service();
		writeSource("src/a.ts", "export const a = 1;\n");
		await instance.remember({ content: "x", kind: "evidence", operationId: "op-1", sourcePath: "src/a.ts", summary: "观察", tags: [], topic: "code" });
		fs.rmSync(path.join(worktree, "src/a.ts"));
		assert.equal(instance.search({ query: "观察" }).results[0]?.validity, "unavailable");
	});

	it("leaves a sourceless conclusion current, since no source can contradict it", async () => {
		const instance = service();
		await instance.remember({ content: "结论", kind: "conclusion", operationId: "op-1", summary: "推导", tags: [], topic: "code" });
		assert.equal(instance.search({ query: "推导" }).results[0]?.validity, "current");
	});
});

const meteringIdentity: MeteringIdentity = {
	agent: "test",
	attempt: 1,
	mode: "synapse",
	nodeId: "node-1",
	runId: "run-emb",
	sessionId: "session-emb",
	snapshotId: null,
};

function embeddingCalls(events: readonly MeteringEvent[]) {
	return events.filter((event): event is Extract<MeteringEvent, { kind: "embedding-call" }> => event.kind === "embedding-call");
}

function vectorIoWrites(events: readonly MeteringEvent[]) {
	return events.filter((event): event is Extract<MeteringEvent, { kind: "object-io" }> => event.kind === "object-io" && event.direction === "write");
}

describe("synapse_write.remember embedding", () => {
	it("stores a float32 vector object and references it from the record when an embedder is configured", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([3, 4, 0, 0], { promptTokens: 9 });
			const meteringPath = path.join(storeRoot, "metering.jsonl");
			const metering = createMeteringLog(meteringPath);
			const embedder = createSiliconFlowEmbedder(
				{ dim: 4, endpoint: `http://127.0.0.1:${server.port}/v1/embeddings`, keyEnv: "SILICONFLOW_API_KEY", model: "BAAI/bge-m3", provider: "siliconflow" },
				{ identity: meteringIdentity, key: "test-key-0123456789abcdef", metering },
			);
			const svc = createMemoryService({
				embedder,
				metering: { identity: meteringIdentity, log: metering },
				now: () => new Date(clock),
				provenance: { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "sess-1" },
				scope: scope(),
				storeRoot,
				worktreeRoot: worktree,
			});
			const written = await svc.remember({
				content: "正文内容",
				kind: "evidence",
				operationId: "op-emb-1",
				summary: "摘要内容",
				tags: [],
				topic: "主题甲",
			});
			assert.ok(written.record.embedding !== null, "record must carry an embedding reference");
			const ref = written.record.embedding!;
			assert.equal(ref.dim, 4);
			assert.equal(ref.representationId, "siliconflow/BAAI/bge-m3/4");
			const cas = createContentStore(storeRoot);
			assert.ok(/^[0-9a-f]{64}$/.test(ref.objectId));
			assert.equal(cas.read(ref.objectId).byteLength, 16);
			assert.equal(cas.mediaTypeOf(ref.objectId), SYNAPSE_VECTOR_MEDIA_TYPE);
			// The embedded text is the deterministic concatenation topic + newline + summary.
			// SAFETY: the body is JSON the embedder under test serialized for this captured request.
			const body = JSON.parse(server.requests[0]!.body) as { input: string };
			assert.equal(body.input, "主题甲\n摘要内容");
			const events = readMeteringLog(meteringPath);
			assert.equal(embeddingCalls(events).length, 1);
			const io = vectorIoWrites(events);
			assert.equal(io.length, 1);
			assert.equal(io[0]!.bytes, 16);
		} finally {
			await server.close();
		}
	});

	it("records embedding as null and never calls out when no embedder is configured", async () => {
		const server = await startEmbeddingStub();
		try {
			const written = await service().remember({
				content: "无嵌入配置的记录",
				kind: "evidence",
				operationId: "op-noemb",
				summary: "摘要",
				tags: [],
				topic: "主题",
			});
			assert.equal(written.record.embedding, null);
			// The stub exists to prove the negative: nothing reached the network.
			assert.equal(server.requests.length, 0);
		} finally {
			await server.close();
		}
	});

	it("re-remembering the same operation embeds once and lands on the same record", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([3, 4, 0, 0]);
			const meteringPath = path.join(storeRoot, "metering-idem.jsonl");
			const metering = createMeteringLog(meteringPath);
			const embedder = createSiliconFlowEmbedder(
				{ dim: 4, endpoint: `http://127.0.0.1:${server.port}/v1/embeddings`, keyEnv: "SILICONFLOW_API_KEY", model: "BAAI/bge-m3", provider: "siliconflow" },
				{ identity: meteringIdentity, key: "test-key-0123456789abcdef", metering },
			);
			const svc = createMemoryService({
				embedder,
				metering: { identity: meteringIdentity, log: metering },
				now: () => new Date(clock),
				provenance: { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "sess-1" },
				scope: scope(),
				storeRoot,
				worktreeRoot: worktree,
			});
			const noTags: string[] = [];
			const input = {
				content: "重复记录的内容",
				kind: "evidence" as const,
				operationId: "op-idem",
				summary: "重复记录的摘要",
				tags: noTags,
				topic: "主题乙",
			};
			const first = await svc.remember(input);
			const second = await svc.remember(input);
			assert.equal(second.record.memoryId, first.record.memoryId);
			assert.equal(server.requests.length, 1);
			assert.ok(second.record.embedding !== null && first.record.embedding !== null);
			assert.equal(second.record.embedding.objectId, first.record.embedding.objectId);
			// The vector object write is metered once: the retry landed on the stored
			// object and wrote no new bytes, and the embed was served from cache.
			const events = readMeteringLog(meteringPath);
			assert.equal(embeddingCalls(events).length, 1);
			assert.equal(vectorIoWrites(events).length, 1);
		} finally {
			await server.close();
		}
	});

	it("propagates an embedding failure instead of silently storing null", async () => {
		const server = await startEmbeddingStub();
		try {
			server.setHandler((_request, response) => {
				response.statusCode = 503;
				response.end("unavailable");
			});
			const embedder = createSiliconFlowEmbedder(
				{ dim: 4, endpoint: `http://127.0.0.1:${server.port}/v1/embeddings`, keyEnv: "SILICONFLOW_API_KEY", model: "BAAI/bge-m3", provider: "siliconflow" },
				{ key: "test-key-0123456789abcdef" },
			);
			const svc = createMemoryService({
				embedder,
				now: () => new Date(clock),
				provenance: { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "sess-1" },
				scope: scope(),
				storeRoot,
				worktreeRoot: worktree,
			});
			await assert.rejects(() => svc.remember({ content: "正文", kind: "evidence", operationId: "op-fail", summary: "摘要", tags: [], topic: "主题" }), /503/);
		} finally {
			await server.close();
		}
	});

	it("loads records written before the embedding field existed as embedding null", async () => {
		const written = await service().remember({
			content: "旧格式记录",
			kind: "evidence",
			operationId: "op-legacy",
			summary: "旧摘要",
			tags: [],
			topic: "旧主题",
		});
		const recordFile = path.join(storeRoot, "memory", `${written.record.memoryId}.json`);
		// SAFETY: the file was written by this test from a record the service just published.
		const legacy = JSON.parse(fs.readFileSync(recordFile, "utf-8")) as { embedding?: unknown };
		assert.ok("embedding" in legacy);
		delete legacy.embedding;
		fs.writeFileSync(recordFile, JSON.stringify(legacy), "utf-8");
		const reloaded = createMemoryStore(storeRoot, { contentStore: createContentStore(storeRoot) }).get(written.record.memoryId);
		assert.equal(reloaded.embedding, null);
	});
});

describe("synapse_read.search semantic integration", () => {
	function stubEmbedder(port: number, dim = 2, metering?: { identity: MeteringIdentity; log: MeteringLog }): Embedder {
		return createSiliconFlowEmbedder(
			{ dim, endpoint: `http://127.0.0.1:${port}/v1/embeddings`, keyEnv: "SILICONFLOW_API_KEY", model: "BAAI/bge-m3", provider: "siliconflow" },
			metering === undefined ? { key: "test-key-0123456789abcdef" } : { identity: metering.identity, key: "test-key-0123456789abcdef", metering: metering.log },
		);
	}

	function semanticService(embedder: Embedder, overrides: { metering?: { identity: MeteringIdentity; log: MeteringLog }; scope?: AccessScope } = {}): MemoryService {
		return createMemoryService({
			embedder,
			metering: overrides.metering,
			now: () => new Date(clock),
			provenance: { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "sess-1" },
			scope: overrides.scope ?? scope(),
			storeRoot,
			worktreeRoot: worktree,
		});
	}

	function rewriteEmbeddingRef(memoryId: string, mutate: (ref: { dim: number; objectId: string; representationId: string }) => void): void {
		const recordFile = path.join(storeRoot, "memory", `${memoryId}.json`);
		// SAFETY: the file was written by the service under test, whose record schema guarantees the embedding reference shape.
		const parsed = JSON.parse(fs.readFileSync(recordFile, "utf-8")) as { embedding: { dim: number; objectId: string; representationId: string } | null };
		assert.ok(parsed.embedding !== null, "record must carry an embedding reference to rewrite");
		mutate(parsed.embedding);
		fs.writeFileSync(recordFile, JSON.stringify(parsed), "utf-8");
	}

	it("recalls records by vector proximity end to end (remember then searchSemantic)", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVectorForInput((input) => (input.includes("主题乙") ? [0, 1] : [1, 0]));
			const embedder = createSiliconFlowEmbedder(
				{ dim: 2, endpoint: `http://127.0.0.1:${server.port}/v1/embeddings`, keyEnv: "SILICONFLOW_API_KEY", model: "BAAI/bge-m3", provider: "siliconflow" },
				{ key: "test-key-0123456789abcdef" },
			);
			const svc = createMemoryService({
				embedder,
				now: () => new Date(clock),
				provenance: { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "sess-1" },
				scope: scope(),
				storeRoot,
				worktreeRoot: worktree,
			});
			const near = await svc.remember({
				content: "甲正文",
				kind: "evidence",
				operationId: "op-sem-a",
				summary: "甲摘要",
				tags: [],
				topic: "主题甲",
			});
			await svc.remember({
				content: "乙正文",
				kind: "evidence",
				operationId: "op-sem-b",
				summary: "乙摘要",
				tags: [],
				topic: "主题乙",
			});
			const result = await svc.searchSemantic({ k: 2, query: "语义查询" });
			assert.equal(result.semantic, "ok");
			assert.equal(result.results[0]?.memoryId, near.record.memoryId);
			const topComponent = result.results[0]?.components.semantic;
			assert.notEqual(topComponent, "unavailable");
			// SAFETY: the component union is number | "unavailable" and the marker is excluded above.
			assert.ok((topComponent as number) > 0.99);
		} finally {
			await server.close();
		}
	});

	it("falls back to keyword ranking and the unavailable marker when no embedder is configured", async () => {
		writeSource("src/a.ts", "export const a = 1;\n");
		const instance = service();
		await instance.remember({
			content: "正文",
			kind: "evidence",
			operationId: "op-sem-fallback",
			sourcePath: "src/a.ts",
			summary: "residual encoder 观察",
			tags: [],
			topic: "residual",
		});
		const semantic = await instance.searchSemantic({ query: "residual encoder" });
		const keyword = instance.search({ query: "residual encoder" });
		assert.equal(semantic.semantic, "unavailable");
		assert.equal(semantic.results.length, keyword.results.length);
		assert.deepEqual(
			semantic.results.map((hit) => hit.memoryId),
			keyword.results.map((hit) => hit.memoryId),
		);
		assert.equal(semantic.results[0]?.components.semantic, "unavailable");
	});

	it("falls back to the unavailable marker when no record carries a usable vector", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([1, 0]);
			writeSource("src/a.ts", "export const a = 1;\n");
			// Written without an embedder, so no record in the store has a vector.
			await service().remember({
				content: "正文",
				kind: "evidence",
				operationId: "op-novec",
				sourcePath: "src/a.ts",
				summary: "residual encoder 观察",
				tags: [],
				topic: "residual",
			});
			const svc = semanticService(stubEmbedder(server.port));
			const result = await svc.searchSemantic({ query: "residual encoder" });
			assert.equal(result.semantic, "unavailable");
			assert.equal(result.results.length, 1);
			assert.equal(result.results[0]?.components.semantic, "unavailable");
			// An empty vector library must not cost an embedding call.
			assert.equal(server.requests.length, 0);
		} finally {
			await server.close();
		}
	});

	it("scores a zero semantic component for a record embedded under another representation", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVectorForInput((input) => (input.includes("主题乙") ? [0, 1] : [1, 0]));
			const svc = semanticService(stubEmbedder(server.port));
			const foreign = await svc.remember({
				content: "甲正文",
				kind: "evidence",
				operationId: "op-foreign",
				summary: "甲摘要",
				tags: [],
				topic: "主题甲",
			});
			await svc.remember({
				content: "乙正文",
				kind: "evidence",
				operationId: "op-domestic",
				summary: "乙摘要",
				tags: [],
				topic: "主题乙",
			});
			// Pointing the reference at a nonexistent object proves the loader
			// never touches it: a read would fail the search instead of scoring zero.
			rewriteEmbeddingRef(foreign.record.memoryId, (ref) => {
				ref.objectId = "0".repeat(64);
				ref.representationId = "siliconflow/other-model/2";
			});
			const result = await svc.searchSemantic({ k: 5, query: "语义查询甲" });
			assert.equal(result.semantic, "ok");
			const foreignHit = result.results.find((hit) => hit.memoryId === foreign.record.memoryId);
			assert.ok(foreignHit, "the keyword-matching record must still rank");
			assert.equal(foreignHit.components.semantic, 0);
		} finally {
			await server.close();
		}
	});

	it("reports a vector object that is not a whole number of float32 values, naming the memory", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([1, 0]);
			const svc = semanticService(stubEmbedder(server.port));
			const written = await svc.remember({
				content: "正文",
				kind: "evidence",
				operationId: "op-bad-bytes",
				summary: "摘要",
				tags: [],
				topic: "主题",
			});
			// A digest-valid object whose length is not a multiple of four bytes.
			const badId = createContentStore(storeRoot).put(new Uint8Array([1, 2, 3]), SYNAPSE_VECTOR_MEDIA_TYPE);
			rewriteEmbeddingRef(written.record.memoryId, (ref) => {
				ref.objectId = badId;
			});
			let caught: unknown;
			try {
				await svc.searchSemantic({ query: "查询" });
			} catch (error) {
				caught = error;
			}
			assert.ok(caught instanceof Error);
			assert.match(caught.message, /integrity/);
			assert.ok(caught.message.includes(written.record.memoryId), "error must name the memory holding the corrupt reference");
		} finally {
			await server.close();
		}
	});

	it("reports a vector object whose float count contradicts the record, naming the memory", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([1, 0]);
			const svc = semanticService(stubEmbedder(server.port));
			const written = await svc.remember({
				content: "正文",
				kind: "evidence",
				operationId: "op-bad-dim",
				summary: "摘要",
				tags: [],
				topic: "主题",
			});
			rewriteEmbeddingRef(written.record.memoryId, (ref) => {
				ref.dim = 3;
			});
			let caught: unknown;
			try {
				await svc.searchSemantic({ query: "查询" });
			} catch (error) {
				caught = error;
			}
			assert.ok(caught instanceof Error);
			assert.match(caught.message, /integrity/);
			assert.ok(caught.message.includes(written.record.memoryId), "error must name the memory holding the corrupt reference");
		} finally {
			await server.close();
		}
	});

	it("returns an empty result for an empty query without spending an embedding call", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([1, 0]);
			const svc = semanticService(stubEmbedder(server.port));
			await svc.remember({
				content: "正文",
				kind: "evidence",
				operationId: "op-empty-q",
				summary: "摘要",
				tags: ["seed"],
				topic: "主题",
			});
			const baseline = server.requests.length;
			const empty = await svc.searchSemantic({ query: "" });
			assert.deepEqual(empty.results, []);
			assert.equal(empty.semantic, "unavailable");
			// A tag-only query still ranks on tags without embedding the empty text.
			const tagged = await svc.searchSemantic({ query: "   ", tags: ["seed"] });
			assert.equal(tagged.semantic, "unavailable");
			assert.equal(tagged.results.length, 1);
			assert.equal(server.requests.length, baseline);
		} finally {
			await server.close();
		}
	});

	it("loads vectors only after authorisation, so a denied record's corrupt object cannot fail the search", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([1, 0]);
			writeSource("secrets/keys.env", "TOKEN=1");
			writeSource("src/a.ts", "export const a = 1;\n");
			const embedder = stubEmbedder(server.port);
			const privileged = semanticService(embedder);
			const secret = await privileged.remember({
				content: "TOKEN=1",
				kind: "evidence",
				operationId: "op-secret",
				sourcePath: "secrets/keys.env",
				summary: "机密观察",
				tags: [],
				topic: "机密主题",
			});
			await privileged.remember({
				content: "公开正文",
				kind: "evidence",
				operationId: "op-public",
				sourcePath: "src/a.ts",
				summary: "公开观察",
				tags: [],
				topic: "公开主题",
			});
			// Corrupt the secret record's vector reference.
			const badId = createContentStore(storeRoot).put(new Uint8Array([1, 2, 3]), SYNAPSE_VECTOR_MEDIA_TYPE);
			rewriteEmbeddingRef(secret.record.memoryId, (ref) => {
				ref.objectId = badId;
			});
			// The privileged caller loads the vector and sees the corruption...
			await assert.rejects(privileged.searchSemantic({ query: "观察" }), /integrity/);
			// ...while the caller without the grant never loads it and ranks fine.
			const restricted = semanticService(embedder, { scope: scope({ pathPrefixes: ["src"] }) });
			const result = await restricted.searchSemantic({ query: "观察" });
			assert.equal(result.semantic, "ok");
			assert.equal(result.results.length, 1);
			assert.notEqual(result.results[0]?.memoryId, secret.record.memoryId);
		} finally {
			await server.close();
		}
	});

	it("meters vector object reads as object-io read events", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([3, 4, 0, 0]);
			const meteringPath = path.join(storeRoot, "metering-read.jsonl");
			const metering = createMeteringLog(meteringPath);
			const svc = semanticService(stubEmbedder(server.port, 4, { identity: meteringIdentity, log: metering }), {
				metering: { identity: meteringIdentity, log: metering },
			});
			await svc.remember({
				content: "正文",
				kind: "evidence",
				operationId: "op-meter-read",
				summary: "摘要",
				tags: [],
				topic: "主题",
			});
			const result = await svc.searchSemantic({ query: "查询" });
			assert.equal(result.semantic, "ok");
			const events = readMeteringLog(meteringPath);
			const reads = events.filter(
				(event): event is Extract<MeteringEvent, { kind: "object-io" }> => event.kind === "object-io" && event.direction === "read",
			);
			assert.equal(reads.length, 1);
			assert.equal(reads[0]!.bytes, 16);
		} finally {
			await server.close();
		}
	});

	it("degrades a vector that contradicts the query dimension despite a matching representation", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVectorForInput((input) => (input.includes("主题乙") ? [0, 1, 0, 0] : [1, 0, 0, 0]));
			const svc = semanticService(stubEmbedder(server.port, 4));
			const tampered = await svc.remember({
				content: "甲正文",
				kind: "evidence",
				operationId: "op-tampered",
				summary: "甲摘要",
				tags: [],
				topic: "主题甲",
			});
			await svc.remember({
				content: "乙正文",
				kind: "evidence",
				operationId: "op-normal",
				summary: "乙摘要",
				tags: [],
				topic: "主题乙",
			});
			// A record claiming 2 floats backed by a digest-valid 2-float object,
			// while its representation id still declares the configured dimension 4.
			const smallId = createContentStore(storeRoot).put(new Uint8Array(new Float32Array([1, 0]).buffer), SYNAPSE_VECTOR_MEDIA_TYPE);
			rewriteEmbeddingRef(tampered.record.memoryId, (ref) => {
				ref.dim = 2;
				ref.objectId = smallId;
			});
			const result = await svc.searchSemantic({ k: 5, query: "语义查询甲" });
			assert.equal(result.semantic, "ok");
			const tamperedHit = result.results.find((hit) => hit.memoryId === tampered.record.memoryId);
			assert.ok(tamperedHit, "the keyword-matching record must still rank");
			assert.equal(tamperedHit.components.semantic, 0);
		} finally {
			await server.close();
		}
	});

	it("does not fail a restricted caller when a denied record's vector object is missing", async () => {
		const server = await startEmbeddingStub();
		try {
			// Distinct vectors per input: identical vectors would make both records
			// reference the same CAS object, and deleting it would break both.
			server.respondWithVectorForInput((input) => (input.includes("机密") ? [1, 0] : [0, 1]));
			writeSource("secrets/keys.env", "TOKEN=1");
			writeSource("src/a.ts", "export const a = 1;\n");
			const embedder = stubEmbedder(server.port);
			const privileged = semanticService(embedder);
			const secret = await privileged.remember({
				content: "TOKEN=1",
				kind: "evidence",
				operationId: "op-secret-missing",
				sourcePath: "secrets/keys.env",
				summary: "机密观察",
				tags: [],
				topic: "机密主题",
			});
			const openRecord = await privileged.remember({
				content: "公开正文",
				kind: "evidence",
				operationId: "op-public-missing",
				sourcePath: "src/a.ts",
				summary: "公开观察",
				tags: [],
				topic: "公开主题",
			});
			// Delete the secret record's vector object outright — the most common
			// corruption shape (partial restore, manual cleanup).
			const cas = createContentStore(storeRoot);
			const secretRef = secret.record.embedding;
			assert.ok(secretRef !== null, "secret record must carry a vector reference");
			const objectPath = cas.objectPath(secretRef.objectId);
			fs.rmSync(objectPath);
			fs.rmSync(objectPath.replace(/\.bin$/, ".meta.json"));
			// The restricted caller never loads the denied record's vector...
			const restricted = semanticService(embedder, { scope: scope({ pathPrefixes: ["src"] }) });
			const result = await restricted.searchSemantic({ query: "观察" });
			assert.equal(result.semantic, "ok");
			assert.deepEqual(result.results.map((hit) => hit.memoryId), [openRecord.record.memoryId]);
			// ...while the privileged caller gets the corruption report naming the memory.
			let caught: unknown;
			try {
				await privileged.searchSemantic({ query: "观察" });
			} catch (error) {
				caught = error;
			}
			assert.ok(caught instanceof Error);
			assert.match(caught.message, /integrity/);
			assert.ok(caught.message.includes(secret.record.memoryId), "error must name the memory whose vector object is missing");
		} finally {
			await server.close();
		}
	});

	it("falls back to keyword ranking with the unavailable marker when the embedding call fails at search time", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([1, 0]);
			const svc = semanticService(stubEmbedder(server.port));
			writeSource("src/a.ts", "export const a = 1;\n");
			await svc.remember({
				content: "正文",
				kind: "evidence",
				operationId: "op-search-outage",
				sourcePath: "src/a.ts",
				summary: "residual encoder 观察",
				tags: [],
				topic: "residual",
			});
			server.setHandler((_request, response) => {
				response.statusCode = 500;
				response.end("provider outage");
			});
			const result = await svc.searchSemantic({ query: "residual encoder" });
			assert.equal(result.semantic, "unavailable");
			const keyword = svc.search({ query: "residual encoder" });
			assert.deepEqual(
				result.results.map((hit) => hit.memoryId),
				keyword.results.map((hit) => hit.memoryId),
			);
			assert.equal(result.results[0]?.components.semantic, "unavailable");
		} finally {
			await server.close();
		}
	});

	it("reports a vector holding a non-finite value, naming the memory", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([1, 0]);
			const svc = semanticService(stubEmbedder(server.port));
			const written = await svc.remember({
				content: "正文",
				kind: "evidence",
				operationId: "op-nan-vector",
				summary: "摘要",
				tags: [],
				topic: "主题",
			});
			const nanId = createContentStore(storeRoot).put(new Uint8Array(new Float32Array([Number.NaN, 0]).buffer), SYNAPSE_VECTOR_MEDIA_TYPE);
			rewriteEmbeddingRef(written.record.memoryId, (ref) => {
				ref.objectId = nanId;
			});
			let caught: unknown;
			try {
				await svc.searchSemantic({ query: "查询" });
			} catch (error) {
				caught = error;
			}
			assert.ok(caught instanceof Error);
			assert.match(caught.message, /integrity/);
			assert.match(caught.message, /non-finite/);
			assert.ok(caught.message.includes(written.record.memoryId), "error must name the memory holding the non-finite vector");
		} finally {
			await server.close();
		}
	});
});
