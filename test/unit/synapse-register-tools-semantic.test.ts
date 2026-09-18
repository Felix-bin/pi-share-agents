import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveSynapseConfig } from "../../src/synapse/config.ts";
import { registerSynapseTools, type SynapseToolsRegistration } from "../../src/synapse/register-tools.ts";
import { startEmbeddingStub, type StubEmbeddingServer } from "../support/embedding-stub-server.ts";

/**
 * Product-seam proof for the semantic read path: the tools a session actually
 * registers must reach the embedding provider through `createSynapseService`,
 * not through a hand-built service in a test. The key arrives only through the
 * environment, exactly as it would in a real deployment; its absence must
 * degrade the read tool to the unavailable marker rather than fail it.
 */

const TEST_KEY_ENV = "SYNAPSE_TEST_EMBEDDING_KEY";

type SearchPayload = {
	results: { components: { semantic: number | "unavailable" }; memoryId: string }[];
	semantic: "ok" | "unavailable";
};

let agentDir = "";
let worktree = "";
let server: StubEmbeddingServer;
let operationCounter = 0;

beforeEach(async () => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-tools-agent-"));
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-tools-wt-"));
	server = await startEmbeddingStub();
	process.env[TEST_KEY_ENV] = "test-key-0123456789abcdef";
	operationCounter = 0;
});

afterEach(async () => {
	delete process.env[TEST_KEY_ENV];
	await server.close();
	fs.rmSync(agentDir, { force: true, recursive: true });
	fs.rmSync(worktree, { force: true, recursive: true });
});

function register(withEmbedding: boolean): SynapseToolsRegistration {
	const embedding = withEmbedding
		? {
				dim: 2,
				endpoint: `http://127.0.0.1:${server.port}/v1/embeddings`,
				keyEnv: TEST_KEY_ENV,
				model: "BAAI/bge-m3",
				provider: "siliconflow",
			}
		: undefined;
	const config = resolveSynapseConfig(embedding === undefined ? { mode: "synapse" } : { embedding, mode: "synapse" });
	return registerSynapseTools(
		{ registerTool: () => undefined },
		{
			agentDir,
			config,
			nextOperationId: () => `op-${(operationCounter += 1)}`,
			resolveContext: () => ({
				provenance: { agent: "tool-test", attempt: 1, runId: "run-tool", sessionId: "sess-tool" },
				scope: { agent: "tool-test", pathPrefixes: [""], write: true },
				worktreeRoot: worktree,
			}),
		},
	);
}

describe("synapse tool wiring with a configured embedding provider", () => {
	it("remembers and recalls through the registered tools with a measured semantic component", async () => {
		server.respondWithVectorForInput((input) => (input.includes("主题乙") ? [0, 1] : [1, 0]));
		const registration = register(true);
		if (!registration.registered) throw new Error("expected the tools to register");
		await registration.write({ action: "remember", content: "甲正文", summary: "甲摘要", topic: "主题甲" });
		await registration.write({ action: "remember", content: "乙正文", summary: "乙摘要", topic: "主题乙" });
		const found = await registration.read({ action: "search", query: "语义查询" });
		// SAFETY: details is the very payload toolOutput serialised, produced by the executor under test.
		const payload = found.details as SearchPayload;
		assert.equal(payload.semantic, "ok");
		assert.equal(payload.results.length, 1);
		const topComponent = payload.results[0]!.components.semantic;
		assert.notEqual(topComponent, "unavailable");
		// SAFETY: the component union is number | "unavailable" and the marker is excluded above.
		assert.ok((topComponent as number) > 0.99);
		// The remember embeds and the query embed all reached the provider through
		// the tool path; distinct texts never share a cache entry.
		assert.ok(server.requests.length >= 2, `expected provider calls through the tool path, saw ${server.requests.length}`);
	});

	it("degrades to the unavailable marker when the key is absent, without failing the tool", async () => {
		delete process.env[TEST_KEY_ENV];
		const registration = register(true);
		if (!registration.registered) throw new Error("expected the tools to register");
		await registration.write({ action: "remember", content: "正文", summary: "residual 观察", topic: "residual" });
		const found = await registration.read({ action: "search", query: "residual" });
		// SAFETY: details is the very payload toolOutput serialised, produced by the executor under test.
		const payload = found.details as SearchPayload;
		assert.equal(payload.semantic, "unavailable");
		assert.equal(payload.results.length, 1);
		assert.equal(payload.results[0]!.components.semantic, "unavailable");
		assert.equal(server.requests.length, 0);
	});
});
