import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SYNAPSE_KEY_ENV, writeStoredKey } from "../../src/synapse/credentials.ts";
import { resolveConfiguredEmbedder } from "../../src/synapse/embedding.ts";

/**
 * Where the embedding key comes from.
 *
 * The plugin guides a user to `/synapse-setup key`, which stores the key outside
 * the transcript. If the embedder that the run actually builds reads only the
 * environment, that guidance is a trap: the status line reports a configured
 * fingerprint while every embedder stays absent, and semantic retrieval plus the
 * whole state plane go quietly unused. These tests pin the fallback — and, just
 * as importantly, pin that it does not reach into a stored credential for a
 * configuration that names some other variable.
 */

const ENDPOINT = "http://127.0.0.1:1/v1/embeddings";

let storageRoot = "";
let agentDir = "";
let previousAgentDir: string | undefined;
let previousKey: string | undefined;

function embeddingFor(keyEnv: string) {
	return { dim: 8, endpoint: ENDPOINT, keyEnv, model: "BAAI/bge-m3", provider: "siliconflow" };
}

beforeEach(() => {
	storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-embstore-"));
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-embagent-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	previousKey = process.env[SYNAPSE_KEY_ENV];
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env[SYNAPSE_KEY_ENV];
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousKey === undefined) delete process.env[SYNAPSE_KEY_ENV];
	else process.env[SYNAPSE_KEY_ENV] = previousKey;
	fs.rmSync(storageRoot, { force: true, recursive: true });
	fs.rmSync(agentDir, { force: true, recursive: true });
});

describe("configured embedder key resolution", () => {
	it("builds the embedder from the stored key when the environment has none", () => {
		writeStoredKey(agentDir, "stored-key");
		const embedder = resolveConfiguredEmbedder(embeddingFor(SYNAPSE_KEY_ENV), storageRoot);
		assert.notEqual(embedder, undefined, "a stored key must be enough: /synapse-setup key is the guide's own path");
	});

	it("still reads the environment variable when one is set", () => {
		process.env[SYNAPSE_KEY_ENV] = "env-key";
		const embedder = resolveConfiguredEmbedder(embeddingFor(SYNAPSE_KEY_ENV), storageRoot);
		assert.notEqual(embedder, undefined);
	});

	it("never reads a stored credential for a differently-named variable", () => {
		// The guard that keeps a test's own key variable from reaching into the
		// user's credentials file: only the canonical name may fall back.
		writeStoredKey(agentDir, "stored-key");
		const embedder = resolveConfiguredEmbedder(embeddingFor("SYNAPSE_SOME_OTHER_KEY"), storageRoot);
		assert.equal(embedder, undefined, "a non-canonical variable must not unlock the stored key");
	});

	it("returns nothing when neither the environment nor the store has a key", () => {
		assert.equal(resolveConfiguredEmbedder(embeddingFor(SYNAPSE_KEY_ENV), storageRoot), undefined);
	});
});
