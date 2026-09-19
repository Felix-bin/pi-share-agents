#!/usr/bin/env node
/**
 * Reserved-round recorder for the delta calibration (task card P4-2).
 *
 * It walks the frozen G1 snapshot's chunks in canonical order and, per round,
 * asks the retrieval path which shared-memory record a delta would encode
 * against (P4-3's prediction) and records the pair (query vector Y, base vector
 * B, corpusSnapshotId) as one JSONL line. Rounds are labelled RESERVED- so the
 * formal G1 runs cannot absorb them: the calibration set has to stay disjoint
 * from the evaluation set, which is the whole point of reserving rounds.
 *
 * Two properties make the recording usable as calibration input. The base comes
 * from `MemoryService.predictBase`, so it is the same order the production
 * sender will use — a re-implemented selector here would have calibrated a rule
 * no run applies. And the memory store is a real one: every round writes its
 * finding through the ordinary `remember` path, so later rounds rank against
 * persisted, digest-verified records rather than a fixture.
 *
 * Vector values are written to the output file only. Nothing prints a vector,
 * and the summary reports counts and digests so the log can be pasted anywhere.
 *
 * A recording is append-only: existing lines are never rewritten. Re-running
 * with --append resumes after the last completed round, which matters because a
 * round costs two provider calls and this provider drops requests.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildCorpus } from "../src/synapse/corpus.ts";
import { createSiliconFlowEmbedder } from "../src/synapse/embedding.ts";
import { createMemoryService } from "../src/synapse/memory-service.ts";
import { SYNAPSE_DEFAULT_MAX_LOADED_RECORDS } from "../src/synapse/memory-store.ts";

const FLAGS_WITH_VALUE = new Set([
	"--allowlist",
	"--corpus-source",
	"--dim",
	"--endpoint",
	"--key-env",
	"--mode",
	"--model",
	"--out",
	"--overlap",
	"--rounds",
	"--source-commit",
	"--storage-root",
	"--window",
]);
const BOOLEAN_FLAGS = new Set(["--append"]);
const ARGS = process.argv.slice(2);

function usageAndExit(message) {
	console.error(message);
	console.error("usage: node scripts/record-delta-pairs.mjs --corpus-source <dir> --source-commit <sha> --mode <progression|followup>");
	console.error("       --storage-root <dir> --out <file.jsonl> [--rounds 240] [--window 40] [--overlap 8]");
	console.error("       [--allowlist .json,.md,.py,.ts,.txt,.yaml] [--endpoint <url>] [--key-env <name>]");
	console.error("       [--model <id>] [--dim <n>] [--append]");
	process.exit(2);
}

const seenValueFlags = new Set();
for (let index = 0; index < ARGS.length; index += 1) {
	const token = ARGS[index];
	if (token === undefined || !token.startsWith("--")) continue;
	if (BOOLEAN_FLAGS.has(token)) continue;
	if (FLAGS_WITH_VALUE.has(token)) {
		if (seenValueFlags.has(token)) usageAndExit(`duplicate flag: ${token}`);
		seenValueFlags.add(token);
		index += 1;
		continue;
	}
	usageAndExit(`unknown flag: ${token}`);
}

function takeValue(flag) {
	const index = ARGS.indexOf(flag);
	if (index === -1) return undefined;
	const value = ARGS[index + 1];
	if (value === undefined || value.startsWith("--")) usageAndExit(`missing value for ${flag}`);
	return value;
}

function requireValue(flag) {
	const value = takeValue(flag);
	if (value === undefined) usageAndExit(`${flag} is required`);
	return value;
}

const corpusSource = requireValue("--corpus-source");
const sourceCommit = requireValue("--source-commit");
const storageRoot = requireValue("--storage-root");
const outPath = requireValue("--out");
// Required, not defaulted: the two registers produce very different similarity
// distributions, so a recording that does not say which one it is cannot be
// compared with another.
const mode = requireValue("--mode");
const rounds = Number(takeValue("--rounds") ?? 240);
const windowLines = Number(takeValue("--window") ?? 40);
const overlapLines = Number(takeValue("--overlap") ?? 8);
const allowlistArg = takeValue("--allowlist");
const allowlist = allowlistArg === undefined ? undefined : allowlistArg.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
const append = ARGS.includes("--append");
const endpoint = takeValue("--endpoint") ?? "https://api.siliconflow.cn/v1/embeddings";
const keyEnv = takeValue("--key-env") ?? "SILICONFLOW_API_KEY";
const model = takeValue("--model") ?? "BAAI/bge-m3";
const dim = Number(takeValue("--dim") ?? 1024);

if (!Number.isInteger(rounds) || rounds < 1) usageAndExit(`--rounds must be a positive integer, got ${rounds}`);
if (mode !== "progression" && mode !== "followup") usageAndExit(`--mode must be progression or followup, got ${JSON.stringify(mode)}`);

/**
 * G1's task package asks an agent to investigate a frozen snapshot in both
 * registers — 调查 (open a new file) and 追问 (ask again about the same
 * material) — and they stress a residual very differently, so a recording picks
 * one and says so.
 *
 * - progression: one round per chunk in canonical order. Each round opens the
 *   next chunk while memory still holds the previous one, which is the
 *   topic-change end of the distribution.
 * - followup: two rounds per chunk, the second asking about the same chunk's
 *   second half after the first filed a finding about its first half. That is
 *   AC-17's controlled condition — consecutive queries about the same material,
 *   from the second round on — and it is where a predicted base is supposed to
 *   be close enough for a residual to pay.
 */
function roundsOf(chunk) {
	const head = mode === "followup" ? Math.ceil(chunk.text.length / 2) : chunk.text.length;
	const first = chunk.text.slice(0, head);
	const roundA = { queryText: `${chunk.path}\n${first.slice(0, QUERY_HEAD_CHARS)}`, summary: first.slice(0, SUMMARY_HEAD_CHARS), suffix: "a" };
	if (mode === "progression") return [roundA];
	const second = chunk.text.slice(head);
	return [roundA, { queryText: `${chunk.path}\n${second.slice(0, QUERY_HEAD_CHARS)}`, summary: second.slice(0, SUMMARY_HEAD_CHARS), suffix: "b" }];
}

/** The query a round asks: the file it is about, then the opening of its text. */
const QUERY_HEAD_CHARS = 600;
/** The finding a round files; bounded well under the service's 2048-byte summary cap. */
const SUMMARY_HEAD_CHARS = 400;

const key = (process.env[keyEnv] ?? "").trim();
if (key.length === 0) {
	console.log(`SKIP: ${keyEnv} is not set; no network call was made and no recording was written.`);
	process.exit(0);
}

/**
 * This provider intermittently holds a request past the client's 30s timeout —
 * three consecutive corpus builds died that way, and the same request succeeded
 * moments later. The wrapper retries without touching the client, and a retry
 * is nearly free: the embedder keeps what already came back, so only the texts
 * still missing go out again.
 */
function withRetry(inner, attempts) {
	let call = 0;
	async function retrying(label, run) {
		let last;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			try {
				const value = await run();
				return value;
			} catch (error) {
				last = error;
				call += 1;
				const detail = error instanceof Error ? error.message : String(error);
				console.error(`${label} attempt ${attempt + 1}/${attempts} failed: ${detail}`);
				if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 8000)));
			}
		}
		throw last instanceof Error ? last : new Error(String(last));
	}
	return {
		embedBatch(texts) {
			return retrying(`batch(${texts.length})`, () => inner.embedBatch(texts));
		},
		embedQuery(text) {
			call += 1;
			return retrying(`query#${call}`, () => inner.embedQuery(text));
		},
		representationId: inner.representationId,
	};
}

function vectorToBase64(vector) {
	return Buffer.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)).toString("base64");
}

function sha256(text) {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

const embedder = withRetry(createSiliconFlowEmbedder({ dim, endpoint, keyEnv, model, provider: "siliconflow" }, { key, storageRoot }), 5);

// A recording is a sequence of rounds that grows a shared memory, and a round's
// base is whatever that memory ranks first. Starting from a store that already
// holds records from an earlier experiment would base the opening rounds on
// material the sequence never wrote — the recorded pairs would describe a
// different run. Resuming is the one legitimate exception: --append continues
// the very sequence those records belong to.
const memoryDir = path.join(storageRoot, "memory");
const leftoverRecords = fs.existsSync(memoryDir) ? fs.readdirSync(memoryDir).filter((entry) => entry.endsWith(".json")).length : 0;
if (!append && leftoverRecords > 0) {
	console.error(
		`refusing to start a fresh recording: ${memoryDir} already holds ${leftoverRecords} records, so the opening rounds would rank against a memory this sequence did not build (move the store aside, or pass --append to continue that sequence)`,
	);
	process.exit(2);
}

// The corpus is a P3-3 artifact and buildCorpus is idempotent, so this call is a
// verification when the snapshot already exists and a publication when it does
// not — one command still covers the whole recording.
const corpus = await buildCorpus({ allowlist, corpusRoot: corpusSource, embedder, overlapLines, sourceCommit, storageRoot, windowLines });
console.error(
	`corpus ${corpus.corpusSnapshotId} chunks=${corpus.chunks.length} alreadyPresent=${corpus.alreadyPresent} maxChunkBytes=${corpus.maxChunkBytes}`,
);

// The round budget counts rounds, not chunks: one chunk makes two rounds in
// followup mode, and both recordings then cover the same amount of work.
const plan = [];
for (const chunk of corpus.chunks) {
	for (const round of roundsOf(chunk)) {
		if (plan.length >= rounds) break;
		plan.push({ chunk, ...round, roundId: `RESERVED-G1-${chunk.chunkId}-${round.suffix}` });
	}
	if (plan.length >= rounds) break;
}
if (plan.length < rounds) {
	console.error(`note: the corpus yields ${plan.length} rounds at this mode, fewer than the ${rounds} requested`);
}
// Base selection ranks the records the store will list, and the store lists only
// the newest SYNAPSE_DEFAULT_MAX_LOADED_RECORDS of them. Past that, early rounds
// would quietly stop being candidates for later ones and the recorded sequence
// would not be the one a real run produces.
if (plan.length > SYNAPSE_DEFAULT_MAX_LOADED_RECORDS) {
	console.error(`refusing to record ${plan.length} rounds: the memory store lists at most ${SYNAPSE_DEFAULT_MAX_LOADED_RECORDS} records, so later rounds could not rank against the earliest ones`);
	process.exit(2);
}

const alreadyRecorded = new Set();
const header = {
	corpusSnapshotId: corpus.corpusSnapshotId,
	dim,
	kind: "header",
	mode,
	model,
	overlapLines,
	representationId: embedder.representationId,
	roundsPlanned: rounds,
	sourceCommit,
	windowLines,
};
if (fs.existsSync(outPath)) {
	const existing = fs.readFileSync(outPath, "utf-8").split("\n").filter((line) => line.trim().length > 0);
	if (!append) {
		console.error(`refusing to touch ${outPath}: it already holds ${existing.length} lines (pass --append to resume)`);
		process.exit(2);
	}
	for (const line of existing) {
		let parsed;
		try {
			// SAFETY: the file is this script's own append-only output; a line that no longer parses is corruption, not shape to guess at.
			parsed = JSON.parse(line);
		} catch {
			console.error(`refusing to resume ${outPath}: a line does not parse as JSON`);
			process.exit(2);
		}
		if (parsed.roundId !== undefined) alreadyRecorded.add(parsed.roundId);
	}
	// Appending rounds recorded against a different corpus or representation would
	// produce a file whose rows are not comparable, which is worse than a refusal.
	const first = existing.find((line) => line.includes('"kind":"header"'));
	if (first !== undefined) {
		// SAFETY: the header is this script's own JSON, written from `header` above.
		const stored = JSON.parse(first);
		for (const field of ["corpusSnapshotId", "dim", "mode", "model", "overlapLines", "representationId", "sourceCommit", "windowLines"]) {
			if (stored[field] !== header[field]) {
				console.error(`refusing to resume ${outPath}: header ${field} is ${JSON.stringify(stored[field])}, this run would write ${JSON.stringify(header[field])}`);
				process.exit(2);
			}
		}
	}
}

const pending = plan.filter((round) => !alreadyRecorded.has(round.roundId));

const service = createMemoryService({
	embedder,
	provenance: { agent: "g1-reserved", attempt: 1, runId: "g1-reserved-20260919", sessionId: "reserved" },
	scope: { agent: "g1-reserved", namespaceId: "0123456789abcdef", pathPrefixes: [""], write: true },
	storeRoot: storageRoot,
	worktreeRoot: corpusSource,
});

function recordOf(round) {
	return {
		content: round.chunk.text,
		kind: "evidence",
		operationId: round.roundId,
		sourcePath: round.chunk.path,
		summary: round.summary,
		tags: [path.extname(round.chunk.path).toLowerCase()],
		topic: round.chunk.path,
	};
}

let coldStarts = 0;
let pairs = 0;
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
if (!append || !fs.existsSync(outPath)) {
	fs.appendFileSync(outPath, `${JSON.stringify(header)}\n`, "utf-8");
}

for (const round of pending) {
	const { chunk, queryText } = round;
	const embedded = await embedder.embedQuery(queryText);
	// The base is read before this round's finding is written, so a round can
	// never predict itself as the base.
	const base = await service.predictBase({ text: queryText });
	if (base === null) coldStarts += 1;
	else pairs += 1;
	// The finding is filed before its line is appended. A crash between the two
	// leaves a round that --append will redo — `remember` is idempotent on the
	// operation id — whereas the other order would leave a recorded round whose
	// record never entered memory, and every later round would then base itself on
	// a memory that differs from the recorded one with nothing to show for it.
	await service.remember(recordOf(round));
	fs.appendFileSync(
		outPath,
		`${JSON.stringify({
			baseMemoryId: base === null ? null : base.memoryId,
			baseVector: base === null ? null : vectorToBase64(base.vector),
			chunkId: chunk.chunkId,
			corpusSnapshotId: corpus.corpusSnapshotId,
			endLine: chunk.endLine,
			path: chunk.path,
			querySha256: sha256(queryText),
			queryText,
			queryVector: vectorToBase64(embedded.vector),
			representationId: embedder.representationId,
			roundId: round.roundId,
			startLine: chunk.startLine,
		})}\n`,
		"utf-8",
	);
}

const digest = createHash("sha256").update(fs.readFileSync(outPath)).digest("hex");
const written = fs
	.readFileSync(outPath, "utf-8")
	.split("\n")
	.filter((line) => line.includes('"roundId"'));
const totalPairs = written.filter((line) => !line.includes('"baseMemoryId":null')).length;
console.error(`this run wrote ${pending.length} rounds (pairs=${pairs}, coldStarts=${coldStarts}) to ${outPath}`);
console.error(`recording now holds ${written.length} rounds, ${totalPairs} of them with a base (cold starts: ${written.length - totalPairs})`);
console.error(`recording sha256=${digest}`);
