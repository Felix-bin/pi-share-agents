#!/usr/bin/env node
/**
 * Fixed-corpus builder (task card P3-3).
 *
 * Embeds a frozen source snapshot deterministically and writes
 * <storageRoot>/corpus/<corpusSnapshotId>/{chunks.json,vectors.f32,meta.json}.
 * The snapshot id is a pure function of source commit, window/overlap and the
 * chunk set, so it does not depend on the vectors at all.
 *
 * Embedding modes:
 *  - default: SiliconFlow (reads the key from --key-env, default
 *    SILICONFLOW_API_KEY); without a key the script prints SKIP and exits 0,
 *    exactly like the P3-1 probe.
 *  - --offline-stub: a deterministic sha256 embedder, for demos without
 *    credentials. The snapshot id is authoritative; the vector bytes are
 *    placeholders and the output says so.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { buildCorpus, SYNAPSE_CORPUS_MAX_WHOLE_FILE_BYTES } from "../src/synapse/corpus.ts";
import { createSiliconFlowEmbedder } from "../src/synapse/embedding.ts";

function usageAndExit(message) {
	console.error(message);
	console.error("usage: node scripts/build-corpus.mjs --source <dir> --source-commit <sha> --storage-root <dir>");
	console.error("       [--window 200] [--overlap 40] [--allowlist .md,.ts,.py,.json,.yaml,.txt]");
	console.error("       [--offline-stub | --endpoint <url> --key-env <name> --model <id> --dim <n>]");
	process.exit(2);
}

const args = process.argv.slice(2);
const flagsWithValue = new Set(["--source", "--source-commit", "--storage-root", "--window", "--overlap", "--allowlist", "--endpoint", "--key-env", "--model", "--dim"]);
const booleanFlags = new Set(["--offline-stub"]);
const seenValueFlags = new Set();
for (let index = 0; index < args.length; index += 1) {
	const token = args[index];
	if (token === undefined || !token.startsWith("--")) continue;
	if (booleanFlags.has(token)) continue;
	if (flagsWithValue.has(token)) {
		// A repeated flag would silently pick the first value; that is exactly
		// the kind of quiet divergence this script refuses elsewhere.
		if (seenValueFlags.has(token)) usageAndExit(`duplicate flag: ${token}`);
		seenValueFlags.add(token);
		index += 1;
		continue;
	}
	// A typo'd flag (say --offlin-stub) must fail loudly, not silently change
	// which embedding path the script takes.
	usageAndExit(`unknown flag: ${token}`);
}
function takeValue(flag) {
	const index = args.indexOf(flag);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) usageAndExit(`missing value for ${flag}`);
	return value;
}

const source = takeValue("--source");
const sourceCommit = takeValue("--source-commit");
const storageRoot = takeValue("--storage-root");
if (source === undefined || sourceCommit === undefined || storageRoot === undefined) {
	usageAndExit("--source, --source-commit and --storage-root are required");
}
const windowLines = Number(takeValue("--window") ?? 200);
const overlapLines = Number(takeValue("--overlap") ?? 40);
const allowlistArg = takeValue("--allowlist");
const allowlist = allowlistArg === undefined ? undefined : allowlistArg.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
const offlineStub = args.includes("--offline-stub");
const endpoint = takeValue("--endpoint") ?? "https://api.siliconflow.cn/v1/embeddings";
const keyEnv = takeValue("--key-env") ?? "SILICONFLOW_API_KEY";
const model = takeValue("--model") ?? "BAAI/bge-m3";
const dim = Number(takeValue("--dim") ?? 1024);

// Mirrors test/support/deterministic-embedder.ts (kept separate on purpose:
// the stub must never be exported from src/).
function createOfflineStubEmbedder(stubDim) {
	const vectorOf = (text) => {
		const values = new Float32Array(stubDim);
		for (let index = 0; index < stubDim; index += 1) {
			const digest = createHash("sha256").update(`${index}:${text}`, "utf-8").digest();
			values[index] = (digest[index % digest.length] ?? 0) / 255 - 0.5;
		}
		let normSquared = 0;
		for (const value of values) normSquared += value * value;
		const norm = Math.sqrt(normSquared);
		for (let index = 0; index < stubDim; index += 1) values[index] /= norm;
		return values;
	};
	return {
		async embedBatch(texts) {
			return texts.map((text) => ({ cached: false, latencyMs: 0, promptTokens: null, vector: vectorOf(text) }));
		},
		async embedQuery(text) {
			return { cached: false, latencyMs: 0, promptTokens: null, vector: vectorOf(text) };
		},
		representationId: "deterministic-test/sha256/v1",
	};
}

let embedder;
let vectorMode;
if (offlineStub) {
	embedder = createOfflineStubEmbedder(8);
	vectorMode = "stub";
} else {
	const key = (process.env[keyEnv] ?? "").trim();
	if (key.length === 0) {
		console.log(`SKIP: ${keyEnv} is not set; no network call was made. Use --offline-stub for a credentials-free demo.`);
		process.exit(0);
	}
	embedder = createSiliconFlowEmbedder({ dim, endpoint, keyEnv, model, provider: "siliconflow" }, { key });
	vectorMode = "real";
}

try {
	const result = await buildCorpus({
		allowlist,
		corpusRoot: source,
		embedder,
		overlapLines,
		sourceCommit,
		storageRoot,
		windowLines,
	});
	// POSIX separators in the report: the path is display identity, and a mixed
	// separator style breaks naive log parsing.
	const storageDir = path.join(storageRoot, "corpus", result.corpusSnapshotId).split(path.sep).join("/");
	console.log(
		JSON.stringify(
			{
				alreadyPresent: result.alreadyPresent,
				chunkCount: result.chunks.length,
				corpusSnapshotId: result.corpusSnapshotId,
				maxChunkBytes: result.maxChunkBytes,
				skippedFiles: result.skippedFiles,
				sourceCommit,
				storageDir,
				vectorBytes: result.vectorBytes,
				vectors: vectorMode,
			},
			null,
			2,
		),
	);
	if (vectorMode === "stub") {
		// stderr, so a machine reader can parse stdout as pure JSON.
		console.error("STUB VECTORS (offline mode): the snapshot id is authoritative; vectors.f32 holds placeholders, not provider output.");
	}
	if (result.maxChunkBytes > SYNAPSE_CORPUS_MAX_WHOLE_FILE_BYTES) {
		console.error(
			`WARNING: the largest chunk is ${result.maxChunkBytes} bytes, above the ${SYNAPSE_CORPUS_MAX_WHOLE_FILE_BYTES}-byte whole-file budget; sliding windows may exceed the provider's embedding input limit (card P3-3 measures the budget in bytes, windows in lines).`,
		);
	}
} catch (error) {
	console.error(`corpus build failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
