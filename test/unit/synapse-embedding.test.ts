import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { startEmbeddingStub } from "../support/embedding-stub-server.ts";
import type { StubEmbeddingServer } from "../support/embedding-stub-server.ts";
import type { SynapseEmbeddingConfig } from "../../src/synapse/config.ts";
import { createMeteringLog, readMeteringLog, type MeteringEvent, type MeteringIdentity } from "../../src/synapse/metering.ts";
import { createEmbeddingClient } from "../../src/synapse/embedding.ts";

let root = "";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-embedding-"));
});

afterEach(() => {
	fs.rmSync(root, { force: true, recursive: true });
});

const identity: MeteringIdentity = {
	agent: "test",
	attempt: 1,
	mode: "synapse",
	nodeId: "node-1",
	runId: "run-1",
	sessionId: "session-1",
	snapshotId: null,
};

function baseConfig(server: StubEmbeddingServer, dim: number): SynapseEmbeddingConfig {
	return {
		dim,
		endpoint: `http://127.0.0.1:${server.port}/v1/embeddings`,
		keyEnv: "SILICONFLOW_API_KEY",
		model: "BAAI/bge-m3",
		provider: "siliconflow",
	};
}

function embeddingCalls(events: readonly MeteringEvent[]) {
	return events.filter((event): event is Extract<MeteringEvent, { kind: "embedding-call" }> => event.kind === "embedding-call");
}

function vectorBytes(vector: Float32Array): Buffer {
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

describe("siliconflow embedder", () => {
	it("decodes, validates, normalizes and meters a valid response", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([3, 4, 0, 0], { promptTokens: 11 });
			const meteringPath = path.join(root, "metering.jsonl");
			const metering = createMeteringLog(meteringPath);
			const embedder = createEmbeddingClient(baseConfig(server, 4), {
				identity,
				key: "test-key-0123456789abcdef",
				metering,
			});
			const result = await embedder.embedQuery("查询文本");
			assert.equal(result.cached, false);
			assert.equal(result.promptTokens, 11);
			assert.ok(result.latencyMs >= 0);
			const norm = Math.hypot(...result.vector);
			assert.ok(Math.abs(norm - 1) <= 1e-6, `expected unit norm, got ${norm}`);
			assert.equal(result.vector.length, 4);
			assert.ok(Math.abs(result.vector[0]! - 0.6) <= 1e-6);
			assert.ok(Math.abs(result.vector[1]! - 0.8) <= 1e-6);
			assert.equal(embedder.representationId, "siliconflow/BAAI/bge-m3/4");

			const request = server.requests[0]!;
			assert.equal(request.auth, "Bearer test-key-0123456789abcdef");
			assert.equal(request.contentType, "application/json");
			// SAFETY: the body is JSON the embedder under test serialized for this captured request.
			const body = JSON.parse(request.body) as { encoding_format: string; input: string; model: string };
			assert.equal(body.input, "查询文本");
			assert.equal(body.encoding_format, "base64");
			assert.equal(body.model, "BAAI/bge-m3");

			const call = embeddingCalls(readMeteringLog(meteringPath));
			assert.equal(call.length, 1);
			assert.equal(call[0]!.ok, true);
			assert.equal(call[0]!.requests, 1);
			assert.equal(call[0]!.inputTokens, 11);
		} finally {
			await server.close();
		}
	});

	it("rejects a vector whose dimension disagrees with the configuration", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([1, 2, 3, 4, 5]);
			const embedder = createEmbeddingClient(baseConfig(server, 4), { key: "test-key-0123456789abcdef" });
			await assert.rejects(() => embedder.embedQuery("文本"), /dimension/);
		} finally {
			await server.close();
		}
	});

	it("rejects vectors containing non-finite values", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([1, Number.NaN, 0, 0]);
			const embedder = createEmbeddingClient(baseConfig(server, 4), { key: "test-key-0123456789abcdef" });
			await assert.rejects(() => embedder.embedQuery("文本"), /finite/);
			server.respondWithVector([1, Number.POSITIVE_INFINITY, 0, 0]);
			await assert.rejects(() => embedder.embedQuery("文本"), /finite/);
		} finally {
			await server.close();
		}
	});

	it("rejects a zero-norm vector", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([0, 0, 0, 0]);
			const embedder = createEmbeddingClient(baseConfig(server, 4), { key: "test-key-0123456789abcdef" });
			await assert.rejects(() => embedder.embedQuery("文本"), /norm/);
		} finally {
			await server.close();
		}
	});

	it("serves the second identical query from cache with a single network request", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([3, 4, 0, 0]);
			const embedder = createEmbeddingClient(baseConfig(server, 4), { key: "test-key-0123456789abcdef" });
			const first = await embedder.embedQuery("重复查询");
			const second = await embedder.embedQuery("重复查询");
			assert.equal(server.requests.length, 1);
			assert.equal(second.cached, true);
			assert.ok(vectorBytes(second.vector).equals(vectorBytes(first.vector)));
			assert.equal(second.promptTokens, first.promptTokens);
		} finally {
			await server.close();
		}
	});

	it("surfaces an http failure without leaking the response body", async () => {
		const server = await startEmbeddingStub();
		try {
			server.setHandler((_request, response) => {
				response.statusCode = 500;
				response.end("SECRET-BODY-MARKER");
			});
			const meteringPath = path.join(root, "metering-failed.jsonl");
			const metering = createMeteringLog(meteringPath);
			const embedder = createEmbeddingClient(baseConfig(server, 4), {
				identity,
				key: "test-key-0123456789abcdef",
				metering,
			});
			await assert.rejects(
				() => embedder.embedQuery("文本"),
				(error: Error) => error.message.includes("500") && !error.message.includes("SECRET-BODY-MARKER"),
			);
			const call = embeddingCalls(readMeteringLog(meteringPath));
			assert.equal(call.length, 1);
			assert.equal(call[0]!.ok, false);
		} finally {
			await server.close();
		}
	});

	it("hits the persistent L2 cache across simulated new processes", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([3, 4, 0, 0], { promptTokens: 5 });
			const storageRoot = path.join(root, "storage");
			const config = baseConfig(server, 4);
			const firstProcess = createEmbeddingClient(config, { key: "test-key-0123456789abcdef", storageRoot });
			const stored = await firstProcess.embedQuery("跨进程查询");
			assert.equal(server.requests.length, 1);

			const secondProcess = createEmbeddingClient(config, { key: "test-key-0123456789abcdef", storageRoot });
			const replayed = await secondProcess.embedQuery("跨进程查询");
			assert.equal(server.requests.length, 1);
			assert.equal(replayed.cached, true);
			assert.equal(replayed.promptTokens, 5);
			assert.ok(vectorBytes(replayed.vector).equals(vectorBytes(stored.vector)));
		} finally {
			await server.close();
		}
	});

	it("embeds a fixed batch for corpus building and caches each entry", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([1, 0, 0, 0]);
			const embedder = createEmbeddingClient(baseConfig(server, 4), { key: "test-key-0123456789abcdef" });
			const results = await embedder.embedBatch(["甲", "乙", "甲"]);
			assert.equal(results.length, 3);
			assert.equal(results[0]!.cached, false);
			assert.equal(results[1]!.cached, false);
			assert.equal(results[2]!.cached, true);
			assert.equal(server.requests.length, 1);
			// SAFETY: the body is JSON the embedder under test serialized for this captured request.
			const body = JSON.parse(server.requests[0]!.body) as { input: string[] };
			assert.deepEqual(body.input, ["甲", "乙"]);
		} finally {
			await server.close();
		}
	});

	it("rejects a payload that is not a whole number of float32 values", async () => {
		const server = await startEmbeddingStub();
		try {
			const truncated = Buffer.alloc(17).toString("base64");
			server.setHandler((_request, response) => {
				response.statusCode = 200;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ data: [{ embedding: truncated, index: 0 }], model: "BAAI/bge-m3", object: "list" }));
			});
			const embedder = createEmbeddingClient(baseConfig(server, 4), { key: "test-key-0123456789abcdef" });
			await assert.rejects(() => embedder.embedQuery("文本"), /whole number of float32/);
		} finally {
			await server.close();
		}
	});

	it("isolates cached vectors from caller mutation", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([3, 4, 0, 0]);
			const embedder = createEmbeddingClient(baseConfig(server, 4), { key: "test-key-0123456789abcdef" });
			const first = await embedder.embedQuery("可变向量");
			const before = first.vector[0]!;
			const cached = await embedder.embedQuery("可变向量");
			first.vector[0] = 999;
			const afterMutation = await embedder.embedQuery("可变向量");
			assert.equal(cached.vector[0]!, before);
			assert.equal(afterMutation.vector[0]!, before);
			assert.equal(server.requests.length, 1);
		} finally {
			await server.close();
		}
	});

	it("isolates batch results from each other and from the cache", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([3, 4, 0, 0]);
			const embedder = createEmbeddingClient(baseConfig(server, 4), { key: "test-key-0123456789abcdef" });
			const results = await embedder.embedBatch(["同文", "异文", "同文"]);
			const before = results[0]!.vector[0]!;
			results[0]!.vector[0] = 999;
			assert.equal(results[2]!.vector[0]!, before);
			const replayed = await embedder.embedQuery("同文");
			assert.equal(replayed.vector[0]!, before);
			assert.equal(server.requests.length, 1);
		} finally {
			await server.close();
		}
	});

	it("splits batches larger than the fixed limit into sequential requests", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([1, 0, 0, 0]);
			const embedder = createEmbeddingClient(baseConfig(server, 4), { key: "test-key-0123456789abcdef" });
			const texts = Array.from({ length: 33 }, (_unused, index) => `条目${index}`);
			const results = await embedder.embedBatch(texts);
			assert.equal(results.length, 33);
			for (const [index, result] of results.entries()) {
				assert.equal(result.vector.length, 4, `slot ${index}`);
				assert.equal(result.cached, false);
			}
			assert.equal(server.requests.length, 2);
			// SAFETY: the bodies are JSON the embedder under test serialized for these captured requests.
			const first = JSON.parse(server.requests[0]!.body) as { input: string[] };
			// SAFETY: same wire format as the first captured request.
			const second = JSON.parse(server.requests[1]!.body) as { input: string[] };
			assert.equal(first.input.length, 32);
			assert.equal(second.input.length, 1);
			assert.deepEqual([...first.input], texts.slice(0, 32));
			assert.deepEqual([...second.input], texts.slice(32));
		} finally {
			await server.close();
		}
	});

	it("rejects empty input and returns an empty batch unchanged", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([1, 0, 0, 0]);
			const embedder = createEmbeddingClient(baseConfig(server, 4), { key: "test-key-0123456789abcdef" });
			await assert.rejects(() => embedder.embedQuery(""), /non-empty/);
			await assert.rejects(() => embedder.embedBatch(["有", ""]), /non-empty/);
			assert.deepEqual(await embedder.embedBatch([]), []);
			assert.equal(server.requests.length, 0);
		} finally {
			await server.close();
		}
	});
});

describe("gateway embedder (JSON number arrays)", () => {
	/**
	 * An ordinary OpenAI-compatible gateway — GLM-Embedding-3 through Paratera,
	 * say — returns `embedding` as an array of JSON numbers and ignores
	 * `encoding_format`. The client therefore has to know which shape its provider
	 * speaks, because a base64 request against this endpoint is not a hard failure:
	 * it returns numbers anyway, and they would decode into a plausible wrong
	 * vector if the two formats were not distinguished.
	 */
	function gatewayConfig(server: StubEmbeddingServer, dim: number): SynapseEmbeddingConfig {
		return {
			dim,
			endpoint: `http://127.0.0.1:${server.port}/v1/embeddings`,
			keyEnv: "PARATERA_API_KEY",
			model: "GLM-Embedding-3",
			provider: "paratera",
		};
	}

	it("decodes, validates and normalizes a JSON number array", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithJsonVectorForInput((text) => (text === "alpha" ? [3, 4, 0, 0] : [0, 0, 1, 0]), { promptTokens: 7 });
			const meteringPath = path.join(root, "metering.jsonl");
			const metering = createMeteringLog(meteringPath);
			const embedder = createEmbeddingClient(gatewayConfig(server, 4), { identity, key: "gateway-key", metering });

			const result = await embedder.embedQuery("alpha");
			assert.equal(result.cached, false);
			assert.equal(result.promptTokens, 7);
			// Unit length, and the direction the provider gave: [3,4,0,0]/5. Compared
			// against float32 literals because the stored vector is float32 — a float64
			// literal differs in the last bits, and this is a vector rather than a scalar.
			assert.ok(Math.abs(Math.hypot(...result.vector) - 1) < 1e-6);
			assert.deepEqual([...result.vector], [Math.fround(0.6), Math.fround(0.8), 0, 0]);

			const calls = embeddingCalls(readMeteringLog(meteringPath));
			assert.equal(calls.length, 1);
			assert.equal(calls[0]?.inputTokens, 7);
		} finally {
			await server.close();
		}
	});

	it("does not ask for base64 from a gateway that would not honour it", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithJsonVectorForInput(() => [1, 0, 0, 0]);
			const embedder = createEmbeddingClient(gatewayConfig(server, 4), { key: "gateway-key" });
			await embedder.embedQuery("alpha");
			const body = JSON.parse(server.requests[0]?.body ?? "{}");
			assert.equal(body.encoding_format, undefined, "the parameter states a request the response does not answer");
			assert.equal(body.model, "GLM-Embedding-3");
		} finally {
			await server.close();
		}
	});

	it("reads a batch in request order and keeps the provider's per-request token count", async () => {
		const server = await startEmbeddingStub();
		try {
			// Deliberately out of order: the client must order by `index`, not by arrival.
			server.setHandler((request, response) => {
				const parsed = JSON.parse(request.body) as { input: readonly string[] };
				response.statusCode = 200;
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						data: parsed.input.map((text, index) => ({ embedding: text === "a" ? [1, 0] : [0, 1], index })).reverse(),
						model: "GLM-Embedding-3",
						usage: { prompt_tokens: 3 },
					}),
				);
			});
			const embedder = createEmbeddingClient(gatewayConfig(server, 2), { key: "gateway-key" });
			const results = await embedder.embedBatch(["a", "b"]);
			assert.deepEqual([...results[0]!.vector], [1, 0]);
			assert.deepEqual([...results[1]!.vector], [0, 1]);
		} finally {
			await server.close();
		}
	});

	it("refuses a JSON vector of the wrong width instead of ranking with it", async () => {
		const server = await startEmbeddingStub();
		try {
			server.respondWithJsonVectorForInput(() => [1, 0, 0]);
			const embedder = createEmbeddingClient(gatewayConfig(server, 4), { key: "gateway-key" });
			await assert.rejects(() => embedder.embedQuery("alpha"), /dimension mismatch/);
		} finally {
			await server.close();
		}
	});

	it("refuses a body that is not a number array, and an all-zero vector", async () => {
		const server = await startEmbeddingStub();
		try {
			const embedder = createEmbeddingClient(gatewayConfig(server, 2), { key: "gateway-key" });
			// JSON has no Infinity: a non-finite component cannot travel in this format,
			// so the schema is what refuses it (as null) before any numeric check runs.
			// The dimension and finiteness checks still guard the base64 path, where
			// arbitrary bytes can decode into either.
			server.respondWithJsonVectorForInput(() => [1, Number.POSITIVE_INFINITY]);
			await assert.rejects(() => embedder.embedQuery("alpha"), /expected schema/);
			server.respondWithJsonVectorForInput(() => [0, 0]);
			await assert.rejects(() => embedder.embedQuery("alpha"), /zero norm/);
		} finally {
			await server.close();
		}
	});

	it("refuses a base64 body where the provider speaks JSON numbers", async () => {
		// The two shapes are not interchangeable, so a response in the wrong one is
		// an error rather than something to interpret charitably.
		const server = await startEmbeddingStub();
		try {
			server.respondWithVector([1, 0, 0, 0]);
			const embedder = createEmbeddingClient(gatewayConfig(server, 4), { key: "gateway-key" });
			await assert.rejects(() => embedder.embedQuery("alpha"), /expected schema/);
		} finally {
			await server.close();
		}
	});

	it("every provider the config whitelist accepts has a wire format", async () => {
		const { SYNAPSE_EMBEDDING_PROVIDERS } = await import("../../src/synapse/config.ts");
		const { embeddingWireFormatFor } = await import("../../src/synapse/embedding.ts");
		for (const provider of SYNAPSE_EMBEDDING_PROVIDERS) {
			assert.doesNotThrow(() => embeddingWireFormatFor(provider), `${provider} is accepted by the parser and must be callable`);
		}
		assert.throws(() => embeddingWireFormatFor("not-a-provider"), /no embedding wire format/);
	});
});
