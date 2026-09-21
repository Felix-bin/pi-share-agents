#!/usr/bin/env node
/**
 * P4-5 A/B runner (stage E evaluation rig). Drives the real pi CLI, one RPC
 * process per round, through the same chain the functional pass proved:
 * /synapse-setup -> /run retriever <task>, with the extension loaded from this
 * repository and an isolated agent dir per arm.
 *
 *   node --experimental-strip-types scripts/p45-runner.mjs seed  <expDir>
 *   node --experimental-strip-types scripts/p45-runner.mjs run   <expDir> [--n 30] [--pairs 1-30] [--attempts 3]
 *
 * `seed` builds ONE seed store — corpus copied from the paratera-built snapshot
 * plus SEED_RECORDS embedded through the real provider — which `run` then copies
 * bit-identically into store-S2 and store-R1, so no arm can hold vectors the
 * other lacks. The manifest head is written before any round runs and is never
 * rewritten; per-attempt facts are appended to rounds.jsonl.
 *
 * The API key is read from synapse/.env, passed to child processes through the
 * environment, and never printed or written anywhere.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIN_REPO = REPO.replaceAll("\\", "/");
const SRC = (name) => `file:///${WIN_REPO}/src/synapse/${name}`;
const SCRIPT_SRC = (rel) => `file:///${WIN_REPO}/scripts/${rel}`;

const CLI = "D:/Users/oobbee/tools/pi-cli/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const EXP_ROOT = "D:/操作系统开源大赛/synapse/_state/p45-runs";
const WORK_DIR = path.join(EXP_ROOT, "work");
const CORPUS_SRC = path.join(EXP_ROOT, "store", "corpus", "c4b1279d58ae01e6b855e2c5b5cb01037c6e722d7d8132139528c2c32a585e1a");
const CORPUS_ID = "c4b1279d58ae01e6b855e2c5b5cb01037c6e722d7d8132139528c2c32a585e1a";
const ENV_FILE = "D:/操作系统开源大赛/synapse/.env";

const EMBEDDING = {
	provider: "paratera",
	endpoint: "https://llmapi.paratera.com/v1/embeddings",
	model: "GLM-Embedding-3",
	dim: 1024,
	keyEnv: "PARATERA_API_KEY",
};
const MODEL = { provider: "paratera", id: "DeepSeek-V4-Flash" };
const STEER_PREFIX = "The delegating agent handed over a retrieval state";

const SETUP_TIMEOUT_MS = 30_000;
const ROUND_TIMEOUT_MS = 300_000;

/** Parses KEY=VALUE lines; values are returned, never logged. */
function loadDotEnv(file) {
	const out = {};
	for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
	}
	return out;
}

/**
 * Makes the key reachable to this process's own embedder (seeding) and asserts
 * it for child processes. The value is only ever assigned, never logged.
 */
function ensureKey(dotenv) {
	const value = dotenv[EMBEDDING.keyEnv] ?? process.env[EMBEDDING.keyEnv];
	if (value === undefined || value.length === 0) throw new Error(`${EMBEDDING.keyEnv} not present in ${ENV_FILE} or the environment`);
	process.env[EMBEDDING.keyEnv] = value;
}

function sha256(text) {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

function sha256File(file) {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** name:sha pairs of a memory directory, for the seed-identity digest. */
function seedMemorySnapshotEntries(dir) {
	return listFiles(dir).map((file) => `${path.basename(file)}:${sha256File(file)}`);
}

/**
 * Recursive copy built from readdir + copyFileSync. Node 22's fs.cpSync crashes
 * natively (no exception, exit 127) on this machine whenever the SOURCE
 * directory path contains non-ASCII characters — every store in this experiment
 * lives under D:/操作系统开源大赛/… — while both primitives it wraps work fine.
 */
function copyTree(src, dst) {
	fs.mkdirSync(dst, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const from = path.join(src, entry.name);
		const to = path.join(dst, entry.name);
		if (entry.isDirectory()) copyTree(from, to);
		else fs.copyFileSync(from, to);
	}
}

function log(message) {
	console.log(`[p45] ${new Date().toISOString()} ${message}`);
}

/** The synapse config one arm runs with; S2 omits the delta key entirely. */
function synapseConfigFor(arm, storageRoot, stateVerify, vectorCache) {
	const config = {
		mode: "synapse",
		memory: "project",
		corpusSnapshotId: CORPUS_ID,
		storageRoot: storageRoot.replaceAll("\\", "/"),
		embedding: { ...EMBEDDING },
	};
	if (arm === "R1") config.delta = true;
	// Batch B (§15 登记四): stateVerify is set on BOTH arms identically, as §12
	// requires; the default (key omitted) stays "off".
	if (stateVerify !== undefined) config.stateVerify = stateVerify;
	// Batch C (§17): vectorCache on BOTH arms identically (§11); default omitted (false).
	if (vectorCache) config.vectorCache = true;
	return config;
}

/** pi provider catalog for the isolated agent dir; the key stays in the env. */
function writeModelsJson(agentDir) {
	const models = {
		providers: {
			paratera: {
				name: "Paratera (并行智算云)",
				baseUrl: "https://llmapi.paratera.com/v1",
				api: "openai-completions",
				apiKey: `$${EMBEDDING.keyEnv}`,
				compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
				models: [
					{
						id: MODEL.id,
						name: "DeepSeek V4 Flash (Paratera)",
						reasoning: false,
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 16384,
						cost: { input: 0.14, output: 0.28, cacheRead: 0.03, cacheWrite: 0.14 },
					},
				],
			},
		},
	};
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify(models, null, "\t")}\n`, "utf-8");
}

function writeSynapseConfig(agentDir, arm, storageRoot, stateVerify, vectorCache) {
	const dir = path.join(agentDir, "extensions", "subagent");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify({ synapse: synapseConfigFor(arm, storageRoot, stateVerify, vectorCache) }, null, "\t")}\n`, "utf-8");
}

/**
 * One pi RPC process, one prompt pair. Sends /synapse-setup first (the
 * pre-flight the runbook requires: it reports the resolved embedder), then the
 * /run command. The /run prompt's RPC response arrives when the child STARTS —
 * measured here: the response and the "running" status share a timestamp — so
 * completion is observed on the metering ledger instead: the run's file
 * appearing is the child session opening, and its `task-span end` line is the
 * receipt the close writes. Every stdout/stderr line lands in the round log.
 */
function runPiRound({ agentDir, tempRoot, task, meteringDir, known, roundLog }) {
	fs.rmSync(tempRoot, { force: true, recursive: true });
	fs.mkdirSync(tempRoot, { recursive: true });
	const lines = [];
	const child = spawn(
		process.execPath,
		[CLI, "-e", path.join(REPO, "index.ts"), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--mode", "rpc", "--provider", MODEL.provider, "--model", MODEL.id],
		{ cwd: WORK_DIR, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENTS_TEMP_ROOT: tempRoot }, stdio: ["pipe", "pipe", "pipe"] },
	);
	const append = (prefix, chunk) => {
		for (const line of String(chunk).split("\n")) {
			if (line.trim().length === 0) continue;
			lines.push(`${prefix}${line}`);
			fs.appendFileSync(roundLog, `${prefix}${line}\n`, "utf-8");
		}
	};
	child.stdout.on("data", (chunk) => append("", chunk));
	child.stderr.on("data", (chunk) => append("ERR ", chunk));

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	const awaitResponse = (id, timeoutMs) =>
		new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			const onData = (chunk) => {
				for (const line of String(chunk).split("\n")) {
					if (!line.includes('"response"')) continue;
					try {
						const parsed = JSON.parse(line);
						if (parsed?.id === id && parsed.type === "response") {
							clearTimeout(timer);
							child.stdout.off("data", onData);
							resolve(true);
							return;
						}
					} catch {
						// A non-JSON line simply is not the response we wait for.
					}
				}
			};
			child.stdout.on("data", onData);
		});

	return (async () => {
		const result = { setup: false, runId: null, completed: false };
		try {
			// The extension needs a moment to register before the first command.
			await sleep(6_000);
			child.stdin.write(`${JSON.stringify({ id: "setup", message: "/synapse-setup", type: "prompt" })}\n`);
			result.setup = await awaitResponse("setup", SETUP_TIMEOUT_MS);
			if (!result.setup) return result;
			child.stdin.write(`${JSON.stringify({ id: "run", message: `/run ${task}`, type: "prompt" })}\n`);
			// Start: a new metering ledger appears (task-span start opens it).
			const startDeadline = Date.now() + 90_000;
			while (Date.now() < startDeadline) {
				await sleep(1_000);
				const files = fs.existsSync(meteringDir) ? fs.readdirSync(meteringDir).filter((name) => name.endsWith(".jsonl") && !known.has(name)) : [];
				if (files.length > 0) {
					result.runId = files[0].slice(0, -".jsonl".length);
					break;
				}
			}
			if (result.runId === null) return result;
			// Completion: the receipt path writes the task-span end event. A ledger
			// without it is a half-written account — tail events (a late restore or
			// error) may still be missing, so the attempt is invalid, not "probably
			// fine": validity is decided in the round loop from this flag.
			const ledger = path.join(meteringDir, `${result.runId}.jsonl`);
			const endDeadline = Date.now() + ROUND_TIMEOUT_MS;
			while (Date.now() < endDeadline) {
				await sleep(1_500);
				try {
					const raw = fs.readFileSync(ledger, "utf-8");
					if (raw.includes('"kind":"task-span"') && raw.includes('"phase":"end"')) {
						result.completed = true;
						break;
					}
				} catch {
					// Not written yet; the start poll saw it, so this is a race on flush.
				}
			}
			// Final writes (receipt, transcript tail) flush synchronously; a short
			// grace keeps the kill out of their way.
			await sleep(1_500);
			return result;
		} finally {
			child.kill();
		}
	})();
}

function listFiles(dir, filter) {
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(full, filter));
		else if (filter === undefined || filter(full)) out.push(full);
	}
	return out;
}

/**
 * The child transcript is the only place the steer message — the M8 (c) account
 * and the ③ evidence — exists. It is looked up under the round's temp root by
 * the run id and the fixed steer prefix, and copied verbatim into evidence.
 */
function extractSteer(tempRoot, runId) {
	for (const file of listFiles(tempRoot)) {
		if (fs.statSync(file).size > 50 * 1024 * 1024) continue;
		let raw;
		try {
			raw = fs.readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		if (!raw.includes(STEER_PREFIX) || !raw.includes(runId)) continue;
		for (const line of raw.split("\n")) {
			if (!line.includes(STEER_PREFIX)) continue;
			try {
				const parsed = JSON.parse(line);
				if (parsed.runId !== runId) continue;
				const text = parsed.message?.content?.[0]?.text ?? parsed.text;
				if (typeof text === "string" && text.startsWith(STEER_PREFIX)) return { record: line, text, transcript: file };
			} catch {
				// The transcript holds non-JSON lines too; only records parse.
			}
		}
	}
	return null;
}

/** Parses the metering JSONL with the product's own reader, so the evidence and the aggregate cannot disagree on syntax. */
async function readEvents(meteringFile) {
	const { readMeteringLog } = await import(SRC("metering.ts"));
	return readMeteringLog(meteringFile);
}

/**
 * A round is valid when the state plane actually crossed and was consumed, and
 * the steer evidence exists. Anything else is "ran but did not measure": per the
 * runbook that is a failed attempt, never a zero. The pre-registration §2
 * condition 4 is applied literally: state-prepare and state-send counts must be
 * equal, so a budget expiry (prepared, never sent) and a resend round (sent
 * twice, prepared once) are both invalid by the frozen text. Recovery hops that
 * do not change the counts remain valid measured behaviour, but any error event
 * invalidates — the recovery paths that succeed record a hop, not an error.
 */
function validateRound(events, arm) {
	const prepares = events.filter((event) => event.kind === "state-prepare" && event.ok);
	const sends = events.filter((event) => event.kind === "state-send");
	const okSends = sends.filter((event) => event.ok);
	const consumes = events.filter((event) => event.kind === "state-consume" && event.ok);
	const errors = events.filter((event) => event.kind === "error");
	const problems = [];
	if (prepares.length !== okSends.length) problems.push(`prepare/send misaligned: prepare=${prepares.length}, send-ok=${okSends.length} (§2 cond.4)`);
	if (okSends.length === 0) problems.push("state-send ok=0");
	if (consumes.length === 0) problems.push("state-consume ok=0");
	if (errors.length > 0) problems.push(`errors=[${errors.map((event) => `${event.category}:${String(event.detail).slice(0, 60)}`).join("; ")}]`);
	const send = okSends[0];
	if (send !== undefined) {
		if (arm === "S2" && send.encoding !== "float32-vector") problems.push(`S2 encoding=${send.encoding}`);
		if (arm === "R1" && send.encoding !== "delta" && send.fallbackReason === undefined) problems.push("R1 neither delta nor fallbackReason");
	}
	return { encoding: send?.encoding ?? null, fallbackReason: send?.fallbackReason ?? null, problems };
}

async function cmdSeed(expDir) {
	if (!fs.existsSync(CORPUS_SRC)) throw new Error(`corpus source missing: ${CORPUS_SRC}`);
	ensureKey(loadDotEnv(ENV_FILE));

	const store = path.join(expDir, "store-seed");
	fs.rmSync(store, { force: true, recursive: true });
	fs.mkdirSync(store, { recursive: true });

	const { resolveStorageRoot, ensureNamespace } = await import(SRC("namespace.ts"));
	const resolved = resolveStorageRoot({ agentDir: path.join(expDir, "agent-seed"), override: store, worktreePath: WORK_DIR });
	ensureNamespace(resolved);

	// The snapshot id is content-addressed over source+chunking, so a byte copy
	// of the paratera-built corpus IS the frozen corpus — no re-embedding.
	copyTree(CORPUS_SRC, path.join(store, "corpus", CORPUS_ID));
	log(`corpus copied (${CORPUS_ID.slice(0, 8)}…)`);

	const { resolveConfiguredEmbedder } = await import(SRC("embedding.ts"));
	const embedder = resolveConfiguredEmbedder({ ...EMBEDDING }, store);
	if (embedder === undefined) throw new Error("embedder could not be built from config + env (is the key in .env?)");

	const { createMemoryService } = await import(SRC("memory-service.ts"));
	const { SEED_RECORDS } = await import(SCRIPT_SRC("p45-family.mjs"));
	const service = createMemoryService({
		embedder,
		provenance: { agent: "parent", attempt: 1, runId: "p45-seed", sessionId: "p45-seed" },
		scope: { agent: "parent", namespaceId: resolved.namespaceId, pathPrefixes: [""], write: true },
		storeRoot: store,
		worktreeRoot: WORK_DIR,
	});
	const records = [];
	for (const [index, seed] of SEED_RECORDS.entries()) {
		const written = await service.remember({
			content: seed.content,
			kind: "evidence",
			operationId: `p45-seed-${index + 1}`,
			summary: seed.summary,
			tags: seed.tags,
			topic: seed.topic,
		});
		records.push({ memoryId: written.record.memoryId, topic: seed.topic, hasVector: written.record.embedding !== null && written.record.embedding !== undefined });
		log(`seeded ${index + 1}/${SEED_RECORDS.length}: ${seed.topic}`);
	}
	fs.writeFileSync(path.join(expDir, "seed-manifest.json"), `${JSON.stringify({ store, namespaceId: resolved.namespaceId, records, createdAt: new Date().toISOString() }, null, "\t")}\n`, "utf-8");
	log(`seed store ready: ${store} (${records.length} records)`);
}

function parseRange(spec, max) {
	if (spec === undefined) return Array.from({ length: max }, (_, i) => i + 1);
	if (/^\d+$/.test(spec)) return [Number(spec)];
	const [lo, hi] = spec.split("-").map(Number);
	if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi < lo) throw new Error(`bad --pairs: ${spec}`);
	return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/**
 * The base pool must stay identical across arms and rounds. The retriever's role
 * prompt invites synapse_write, and a child that records a finding silently
 * changes both the base pool and every later round's delegate section — so the
 * tasks forbid writes AND every attempt is checked by byte-comparing the whole
 * memory directory against the seed (a supersede edits a record in place, so
 * names alone are not enough). A store that moved is an invalid attempt, and
 * the working store is restored from the seed so later rounds keep the
 * controlled condition; the attempt's own evidence was already copied and
 * stays as archived.
 */
function seedMemorySnapshotOf(expDir) {
	return new Map(listFiles(path.join(expDir, "store-seed", "memory")).map((file) => [path.basename(file), sha256File(file)]));
}

function memoryDriftOf(expDir, arm, seedMemorySnapshot) {
	const dir = path.join(expDir, `store-${arm}`, "memory");
	const current = new Map(listFiles(dir).map((file) => [path.basename(file), null]));
	const problems = [];
	for (const [name, seedDigest] of seedMemorySnapshot) {
		const live = path.join(dir, name);
		if (!fs.existsSync(live)) {
			problems.push(`record ${name.slice(0, 8)}… disappeared`);
			continue;
		}
		if (sha256File(live) !== seedDigest) problems.push(`record ${name.slice(0, 8)}… was modified`);
	}
	for (const name of current.keys()) if (!seedMemorySnapshot.has(name)) problems.push(`record ${name.slice(0, 8)}… was added`);
	return problems;
}

function restoreMemoryOf(expDir, arm) {
	const dir = path.join(expDir, `store-${arm}`, "memory");
	fs.rmSync(dir, { force: true, recursive: true });
	copyTree(path.join(expDir, "store-seed", "memory"), dir);
}

/**
 * Post-round processing shared by both devices: validation, steer extraction,
 * evidence copy, drift check, record append. Extracted verbatim from the
 * v2/v3 per-round loop so the resident device (§17) finalises identically.
 */
async function finalizeRound({ expDir, arm, round, attempt, attemptStartedAt, outcome, seedMemorySnapshot, tempRoot }) {
	const meteringDir = path.join(expDir, `store-${arm}`, "metering");
	const roundsPath = path.join(expDir, "rounds.jsonl");
	const evidenceDir = path.join(expDir, "evidence", arm, `round-${String(round).padStart(2, "0")}`, `attempt-${attempt}`);
	fs.rmSync(evidenceDir, { force: true, recursive: true });
	fs.mkdirSync(evidenceDir, { recursive: true });
	const record = { arm, round, attempt, taskIndex: round - 1, startedAt: attemptStartedAt.toISOString(), runIds: [], valid: false, problems: [], encoding: null, fallbackReason: null, steer: null };
	try {
		if (!outcome.setup) {
			record.problems.push("/synapse-setup did not answer");
		} else if (outcome.runId === null) {
			record.problems.push("no metering ledger appeared (child did not start)");
		} else {
			const runId = outcome.runId;
			record.runIds.push(runId);
			const meteringFile = path.join(meteringDir, `${runId}.jsonl`);
			const events = await readEvents(meteringFile);
			// A ledger whose first event predates this attempt is an orphan —
			// a process an earlier kill did not take with it, still appending.
			const firstTs = events[0]?.ts;
			if (firstTs !== undefined && Date.parse(firstTs) < attemptStartedAt.getTime() - 2_000) {
				record.problems.push(`ledger predates this attempt (first event ${firstTs} < spawn ${attemptStartedAt.toISOString()})`);
			}
			if (!outcome.completed) record.problems.push("no task-span end within budget (ledger may be truncated)");
			const validation = validateRound(events, arm);
			record.problems.push(...validation.problems);
			record.encoding = validation.encoding;
			record.fallbackReason = validation.fallbackReason;
			const steer = extractSteer(tempRoot, runId);
			if (steer === null && record.problems.length === 0) record.problems.push("steer message not found in transcript");
			// top5 stores CHUNK IDENTITIES, not the steer lines verbatim: the lines
			// carry per-arm cosine scores that differ whenever the vectors differ,
			// and comparing them would disagree with the corrected ③ (§14).
			record.steer = steer === null ? null : { bytes: Buffer.byteLength(steer.text, "utf-8"), top5: steer.text.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.replace(/^(- .+) \(cosine .*\)$/, "$1")) };
			const drift = memoryDriftOf(expDir, arm, seedMemorySnapshot);
			if (drift.length > 0) {
				record.problems.push(`base pool diverged: ${drift.join("; ")}`);
				restoreMemoryOf(expDir, arm);
			}
			// Evidence, copied before any verdict is drawn: metering, envelopes, steer, config.
			fs.copyFileSync(meteringFile, path.join(evidenceDir, `${runId}.jsonl`));
			const envelopes = path.join(expDir, `store-${arm}`, "envelopes", runId);
			if (fs.existsSync(envelopes)) copyTree(envelopes, path.join(evidenceDir, "envelopes"));
			if (steer !== null) {
				fs.writeFileSync(path.join(evidenceDir, "steer-message.txt"), `${steer.record}\n`, "utf-8");
				fs.copyFileSync(steer.transcript, path.join(evidenceDir, "child-transcript.jsonl"));
			}
			fs.copyFileSync(path.join(expDir, `agent-${arm}`, "extensions", "subagent", "config.json"), path.join(evidenceDir, "synapse-config.json"));
			record.valid = record.problems.length === 0;
		}
	} catch (error) {
		record.problems.push(`runner error: ${error instanceof Error ? error.message : String(error)}`);
	}
	fs.appendFileSync(roundsPath, `${JSON.stringify(record)}\n`, "utf-8");
	log(`round ${round} arm ${arm} attempt ${attempt}: ${record.valid ? "VALID" : `invalid (${record.problems.join("; ")})`}`);
	return record;
}

async function cmdRun(expDir, options) {
	ensureKey(loadDotEnv(ENV_FILE));
	const seedStore = path.join(expDir, "store-seed");
	if (!fs.existsSync(seedStore)) throw new Error(`seed store missing — run the seed command first (${seedStore})`);

	const { SEED_RECORDS, TASKS, AGENT } = await import(SCRIPT_SRC("p45-family.mjs"));
	const familySha = sha256File(path.join(REPO, "scripts", "p45-family.mjs"));
	const scriptsDigest = {
		"p45-family.mjs": familySha,
		"p45-runner.mjs": sha256File(path.join(REPO, "scripts", "p45-runner.mjs")),
		"p45-aggregate.mjs": sha256File(path.join(REPO, "scripts", "p45-aggregate.mjs")),
	};
	// The seed store's identity: the digest of its manifest plus one digest over
	// the memory files, so a re-run of `seed` between manifest and rounds cannot
	// silently hand the arms a different vector pool.
	const seedManifestPath = path.join(expDir, "seed-manifest.json");
	const seedMemoryDigest = [...seedMemorySnapshotEntries(path.join(seedStore, "memory"))].sort().join("\n");
	const seedIdentity = {
		seedManifestSha256: sha256File(seedManifestPath),
		seedMemorySha256: sha256(seedMemoryDigest),
	};
	const pairs = parseRange(options.pairs, options.n);
	const sha = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf-8" });
	const dirty = spawnSync("git", ["-C", REPO, "status", "--porcelain"], { encoding: "utf-8" });
	const piVersion = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf-8" });

	// The frozen head: written before the first round and never rewritten.
	const manifestPath = path.join(expDir, "manifest.json");
	if (fs.existsSync(manifestPath)) throw new Error(`manifest already exists — a started experiment is never restarted in place: ${manifestPath}`);
	fs.writeFileSync(
		manifestPath,
		`${JSON.stringify(
			{
				experimentId: path.basename(expDir),
				createdAt: new Date().toISOString(),
				preregistration: "pi-share-agents/docs/experiments/AC-17-acceptance-preregistration-20260919.md (incl. §9–§13 revisions, all before any P4-5 data)",
				runbook: "synapse/_state/P45-执行runbook-20260920.md",
				code: { sha: sha.stdout?.trim() ?? null, dirty: (dirty.stdout ?? "").trim().split("\n").filter(Boolean) },
				pi: { cli: CLI, version: piVersion.stdout?.trim() ?? null },
				node: process.version,
				model: `${MODEL.provider}/${MODEL.id}`,
				embedding: { ...EMBEDDING, representationId: `${EMBEDDING.provider}/${EMBEDDING.model}/${EMBEDDING.dim}` },
				corpusSnapshotId: CORPUS_ID,
				corpusSource: `byte copy of ${CORPUS_SRC.replaceAll("\\", "/")} (built 2026-09-20 with the same provider; snapshot id is source+chunking only)`,
				worktreePath: WORK_DIR.replaceAll("\\", "/"),
				familySha256: familySha,
				scripts: scriptsDigest,
				seedIdentity,
				seedRecords: SEED_RECORDS.length,
				seedStore: "store-seed built once (corpus copy + 12 records through the real embedder); each arm receives a bit-identical copy",
				n: options.n,
				roundsPlanned: pairs,
				tasks: TASKS,
				arms: {
					S2: { "synapse.delta": "key omitted (default false) — full vector" },
					R1: { "synapse.delta": true },
				},
				switches: {
					"synapse.vectorCache": "key omitted in both arms (default false — the frozen cold-base convention)",
					"synapse.stateVerify": options.stateVerify === undefined ? "key omitted in both arms (default off)" : `${options.stateVerify} on BOTH arms (§15 登记四 batch B — §12 requires manifest declaration + both arms identical)`,
					"synapse.stateRecovery": "key omitted in both arms (default resend-then-text)",
					SYNAPSE_STATE_BUDGET_MS: 2500,
				},
				embeddingCacheState: "cold for each arm's first attempt at a task: arms start from the same seed-store copy whose embedding cache holds only the 12 record texts (none is a task query); a RETRIED attempt re-embeds the same query against a warm L2 cache — embedding calls are reported as calls/tokens and never enter ②, so this affects only the embeddingCalls column",
				retryPolicy: "up to 3 attempts per (arm, round); every attempt is kept under evidence/; only rounds valid in BOTH arms enter the paired tables",
				sequence: pairs.flatMap((round) => [
					{ arm: "S2", round, taskIndex: round - 1 },
					{ arm: "R1", round, taskIndex: round - 1 },
				]),
				statsPlan: "② paired differences: percentile bootstrap, B=10000, seed 20260920; ③ ordered top-5 agreement: Clopper-Pearson exact interval + exact binomial test; intervals must accompany every ② difference and crossing zero must be stated",
			},
			null,
			"\t",
		)}\n`,
		"utf-8",
	);

	// One arm store per arm, bit-identical copies of the seed store.
	for (const arm of ["S2", "R1"]) {
		fs.rmSync(path.join(expDir, `store-${arm}`), { force: true, recursive: true });
		copyTree(seedStore, path.join(expDir, `store-${arm}`));
		writeModelsJson(path.join(expDir, `agent-${arm}`));
		writeSynapseConfig(path.join(expDir, `agent-${arm}`), arm, path.join(expDir, `store-${arm}`), options.stateVerify, options.vectorCache);
	}
	const seedMemorySnapshot = seedMemorySnapshotOf(expDir);
	fs.appendFileSync(path.join(expDir, "rounds.jsonl"), "");

	for (const round of pairs) {
		const task = TASKS[round - 1];
		if (task === undefined) throw new Error(`task ${round} missing from the family`);
		for (const arm of ["S2", "R1"]) {
			const meteringDir = path.join(expDir, `store-${arm}`, "metering");
			for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
				const evidenceDir = path.join(expDir, "evidence", arm, `round-${String(round).padStart(2, "0")}`, `attempt-${attempt}`);
				fs.rmSync(evidenceDir, { force: true, recursive: true });
				fs.mkdirSync(evidenceDir, { recursive: true });
				const roundLog = path.join(evidenceDir, "pi-rpc.log");
				const known = new Set(fs.existsSync(meteringDir) ? fs.readdirSync(meteringDir) : []);
				const attemptStartedAt = new Date();
				log(`round ${round} arm ${arm} attempt ${attempt}: ${task.slice(0, 60)}…`);
				const outcome = await runPiRound({
					agentDir: path.join(expDir, `agent-${arm}`),
					tempRoot: path.join(expDir, "tmp", `${arm}-${round}-${attempt}`),
					// [output=false] disables the host's single-output instruction: that
					// instruction appends a per-run output path (arm name + UUID) to the
					// task text, which made the two arms embed DIFFERENT query texts in
					// every round of the n30 run and contaminated ③'s reference (K3
					// P0-2, preregistration §14). With it disabled the state query is
					// byte-identical across arms, as the frozen family file claims.
					task: `${AGENT}[output=false] ${task}`,
					meteringDir,
					known,
					roundLog,
				});
				const record = await finalizeRound({ expDir, arm, round, attempt, attemptStartedAt, outcome, seedMemorySnapshot, tempRoot: path.join(expDir, "tmp", `${arm}-${round}-${attempt}`) });
				if (record.valid) break;
			}
		}
	}
	log(`experiment data complete: ${expDir}`);
}

/**
 * Device v4 (§17): ONE pi process per arm runs the whole sequence. The
 * process-level state (the record-vector cache, the probe TTL, the in-process
 * embedding L1) survives across rounds — exactly the condition the hot-base
 * row needs to stop being derived. Rounds still get fresh runId ledgers and
 * per-round drift checks. NO RETRIES: a retry would reuse the warmed cache and
 * destroy the round-1-cold / round-2-hot structure the device exists to
 * measure; invalid rounds are disclosed as-is.
 */
async function cmdRunResident(expDir, options) {
	ensureKey(loadDotEnv(ENV_FILE));
	const seedStore = path.join(expDir, "store-seed");
	if (!fs.existsSync(seedStore)) throw new Error(`seed store missing — run the seed command first (${seedStore})`);

	const { SEED_RECORDS, TASKS, AGENT } = await import(SCRIPT_SRC("p45-family.mjs"));
	const familySha = sha256File(path.join(REPO, "scripts", "p45-family.mjs"));
	const scriptsDigest = {
		"p45-family.mjs": familySha,
		"p45-runner.mjs": sha256File(path.join(REPO, "scripts", "p45-runner.mjs")),
		"p45-aggregate.mjs": sha256File(path.join(REPO, "scripts", "p45-aggregate.mjs")),
	};
	const seedManifestPath = path.join(expDir, "seed-manifest.json");
	const seedMemoryDigest = [...seedMemorySnapshotEntries(path.join(seedStore, "memory"))].sort().join("\n");
	const seedIdentity = {
		seedManifestSha256: sha256File(seedManifestPath),
		seedMemorySha256: sha256(seedMemoryDigest),
	};
	const pairs = parseRange(options.pairs, options.n);
	const sha = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf-8" });
	const dirty = spawnSync("git", ["-C", REPO, "status", "--porcelain"], { encoding: "utf-8" });
	const piVersion = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf-8" });

	const manifestPath = path.join(expDir, "manifest.json");
	if (fs.existsSync(manifestPath)) throw new Error(`manifest already exists — a started experiment is never restarted in place: ${manifestPath}`);
	fs.writeFileSync(
		manifestPath,
		`${JSON.stringify(
			{
				experimentId: path.basename(expDir),
				device: "v4-resident: ONE pi process per arm, rounds sequential (§17); process-level vector cache and probe TTL survive across rounds — the hot-base condition",
				createdAt: new Date().toISOString(),
				preregistration: "pi-share-agents/docs/experiments/AC-17-acceptance-preregistration-20260919.md (incl. §9–§17 revisions; §17 froze this device BEFORE any v4 data)",
				runbook: "synapse/_state/P45-执行runbook-20260920.md",
				code: { sha: sha.stdout?.trim() ?? null, dirty: (dirty.stdout ?? "").trim().split("\n").filter(Boolean) },
				pi: { cli: CLI, version: piVersion.stdout?.trim() ?? null },
				node: process.version,
				model: `${MODEL.provider}/${MODEL.id}`,
				embedding: { ...EMBEDDING, representationId: `${EMBEDDING.provider}/${EMBEDDING.model}/${EMBEDDING.dim}` },
				corpusSnapshotId: CORPUS_ID,
				corpusSource: `byte copy of ${CORPUS_SRC.replaceAll("\\", "/")} (built 2026-09-20 with the same provider; snapshot id is source+chunking only)`,
				worktreePath: WORK_DIR.replaceAll("\\", "/"),
				familySha256: familySha,
				scripts: scriptsDigest,
				seedIdentity,
				seedRecords: SEED_RECORDS.length,
				seedStore: "store-seed built once (corpus copy + 12 records through the real embedder); each arm receives a bit-identical copy",
				n: options.n,
				roundsPlanned: pairs,
				tasks: TASKS,
				arms: {
					S2: { "synapse.delta": "key omitted (default false) — full vector", "synapse.vectorCache": true },
					R1: { "synapse.delta": true, "synapse.vectorCache": true },
				},
				switches: {
					"synapse.vectorCache": "true in BOTH arms (§17 hot-base measurement; §11 requires both arms identical — the arm difference stays delta alone)",
					"synapse.stateVerify": "key omitted in both arms (default off)",
					"synapse.stateRecovery": "key omitted in both arms (default resend-then-text)",
					SYNAPSE_STATE_BUDGET_MS: 2500,
				},
				embeddingCacheState: "cold for round 1 of each arm (fresh process, seed-store copy whose cache holds only the 12 record texts); rounds 2+ run in the SAME process with the L1 warm for nothing (each round is a new query text) and the process vector cache warm for the 12 record vectors",
				retryPolicy: "none (resident device: a retry would reuse the warmed process cache and break the round-1-cold / round-2-hot structure); invalid rounds are disclosed, never repeated",
				sequence: pairs.flatMap((round) => [
					{ arm: "S2", round, taskIndex: round - 1 },
					{ arm: "R1", round, taskIndex: round - 1 },
				]),
				executionOrder: "per arm: one process runs its rounds back-to-back (all S2 rounds, then all R1 rounds) — the sequence field lists the pairing, not the wall-clock order",
				statsPlan: "same as the v3 manifest: ② paired percentile bootstrap B=10000 seed 20260920; ③ Clopper-Pearson exact interval; the hot row is now MEASURED as rounds 2+, reported separately from round 1",
			},
			null,
			"\t",
		)}\n`,
		"utf-8",
	);

	for (const arm of ["S2", "R1"]) {
		fs.rmSync(path.join(expDir, `store-${arm}`), { force: true, recursive: true });
		copyTree(seedStore, path.join(expDir, `store-${arm}`));
		writeModelsJson(path.join(expDir, `agent-${arm}`));
		writeSynapseConfig(path.join(expDir, `agent-${arm}`), arm, path.join(expDir, `store-${arm}`), options.stateVerify, true);
	}
	const seedMemorySnapshot = seedMemorySnapshotOf(expDir);
	fs.appendFileSync(path.join(expDir, "rounds.jsonl"), "");

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	for (const arm of ["S2", "R1"]) {
		const tempRoot = path.join(expDir, "tmp", `resident-${arm}`);
		fs.rmSync(tempRoot, { force: true, recursive: true });
		fs.mkdirSync(tempRoot, { recursive: true });
		const processLog = path.join(expDir, `evidence`, `${arm}-resident-process.log`);
		fs.mkdirSync(path.join(expDir, "evidence"), { recursive: true });
		fs.rmSync(processLog, { force: true });
		const meteringDir = path.join(expDir, `store-${arm}`, "metering");
		const child = spawn(
			process.execPath,
			[CLI, "-e", path.join(REPO, "index.ts"), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--mode", "rpc", "--provider", MODEL.provider, "--model", MODEL.id],
			{ cwd: WORK_DIR, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(expDir, `agent-${arm}`), PI_SUBAGENTS_TEMP_ROOT: tempRoot }, stdio: ["pipe", "pipe", "pipe"] },
		);
		const append = (prefix, chunk) => {
			for (const line of String(chunk).split("\n")) {
				if (line.trim().length === 0) continue;
				fs.appendFileSync(processLog, `${prefix}${line}\n`, "utf-8");
			}
		};
		child.stdout.on("data", (chunk) => append("", chunk));
		child.stderr.on("data", (chunk) => append("ERR ", chunk));
		const awaitResponse = (id, timeoutMs) =>
			new Promise((resolve) => {
				const timer = setTimeout(() => resolve(false), timeoutMs);
				const onData = (chunk) => {
					for (const line of String(chunk).split("\n")) {
						if (!line.includes('"response"')) continue;
						try {
							const parsed = JSON.parse(line);
							if (parsed?.id === id && parsed.type === "response") {
								clearTimeout(timer);
								child.stdout.off("data", onData);
								resolve(true);
								return;
							}
						} catch {
							// A non-JSON line simply is not the response we wait for.
						}
					}
				};
				child.stdout.on("data", onData);
			});
		try {
			await sleep(6_000);
			child.stdin.write(`${JSON.stringify({ id: "setup", message: "/synapse-setup", type: "prompt" })}\n`);
			const setupOk = await awaitResponse("setup", SETUP_TIMEOUT_MS);
			if (!setupOk) throw new Error(`arm ${arm}: /synapse-setup did not answer`);
			for (const round of pairs) {
				const task = TASKS[round - 1];
				if (task === undefined) throw new Error(`task ${round} missing from the family`);
				const known = new Set(fs.existsSync(meteringDir) ? fs.readdirSync(meteringDir) : []);
				const attemptStartedAt = new Date();
				log(`[resident] arm ${arm} round ${round}: ${task.slice(0, 60)}…`);
				child.stdin.write(`${JSON.stringify({ id: `run-${round}`, message: `/run ${AGENT}[output=false] ${task}`, type: "prompt" })}\n`);
				let runId = null;
				const startDeadline = Date.now() + 90_000;
				while (Date.now() < startDeadline) {
					await sleep(1_000);
					const files = fs.existsSync(meteringDir) ? fs.readdirSync(meteringDir).filter((name) => name.endsWith(".jsonl") && !known.has(name)) : [];
					if (files.length > 0) {
						runId = files[0].slice(0, -".jsonl".length);
						break;
					}
				}
				let completed = false;
				if (runId !== null) {
					const ledger = path.join(meteringDir, `${runId}.jsonl`);
					const endDeadline = Date.now() + ROUND_TIMEOUT_MS;
					while (Date.now() < endDeadline) {
						await sleep(1_500);
						try {
							const raw = fs.readFileSync(ledger, "utf-8");
							if (raw.includes('"kind":"task-span"') && raw.includes('"phase":"end"')) {
								completed = true;
								break;
							}
						} catch {
							// Not written yet; the start poll saw it, so this is a race on flush.
						}
					}
				}
				await sleep(1_500);
				await finalizeRound({ expDir, arm, round, attempt: 1, attemptStartedAt, outcome: { setup: true, runId, completed }, seedMemorySnapshot, tempRoot });
			}
		} finally {
			child.kill();
		}
	}
	log(`experiment data complete (resident): ${expDir}`);
}

const [, , command, expDirArg, ...rest] = process.argv;
const options = { n: 30, attempts: 3 };
for (let index = 0; index < rest.length; index += 1) {
	const key = rest[index];
	if (key === "--resident") {
		options.resident = true;
		continue;
	}
	if (key === "--vector-cache") {
		options.vectorCache = true;
		continue;
	}
	const value = rest[index + 1];
	index += 1;
	if (key === "--n" || key === "--attempts") options[key.slice(2)] = Number(value);
	else if (key === "--pairs") options.pairs = value;
	else if (key === "--state-verify") options.stateVerify = value;
	else throw new Error(`unknown option ${key}`);
}
if (options.stateVerify !== undefined && !["off", "reembed"].includes(options.stateVerify)) throw new Error(`bad --state-verify: ${options.stateVerify}`);
if (command !== "seed" && command !== "run") {
	console.error("usage: p45-runner.mjs seed|run <expDir> [--n 30] [--pairs 1-30] [--attempts 3] [--state-verify reembed] [--vector-cache] [--resident]");
	process.exit(2);
}
if (options.resident && options.vectorCache === undefined) throw new Error("--resident requires --vector-cache (§17 froze the resident device with the cache on in both arms)");
const expDir = path.resolve(expDirArg);
fs.mkdirSync(expDir, { recursive: true });
if (command === "seed") await cmdSeed(expDir);
else if (options.resident) await cmdRunResident(expDir, options);
else await cmdRun(expDir, options);
