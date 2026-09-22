#!/usr/bin/env node
/**
 * P50M memory-reuse three-arm runner (preregistration 2026-09-21:
 * docs/experiments/P50M-memory-reuse-preregistration-20260921.md — frozen BEFORE
 * any P50M data).
 *
 *   node --experimental-strip-types scripts/p50m-runner.mjs seed  <expDir>
 *   node --experimental-strip-types scripts/p50m-runner.mjs run   <expDir> --arm A|B|C [--pairs 1-60] [--attempts 3]
 *
 * Sequence: the v4 family's 30 tasks × 2 passes (run 1-30 first pass, run
 * 31-60 verbatim replay). Arms (preregistration §2):
 *   A — synapse, memory wiped by the device after EVERY round (cold control);
 *   B — synapse, memory accumulated by the device distiller after every round
 *       (rule-based, no LLM — preregistration §3) and recalled/handed over in
 *       later rounds;
 *   C — text mode, the same distilled lines appended to notes.md in the work
 *       tree; the task text points the child at the file.
 *
 * Everything else (CLI, model, embedding, corpus, agent, timeouts, validity
 * rules per arm) is the p50 device verbatim; this file is a separate script so
 * the frozen p50-runner.mjs SHA stays untouched.
 *
 * The API key is read from synapse/.env into the environment, never printed.
 */
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIN_REPO = REPO.replaceAll("\\", "/");
const SCRIPT_SRC = (rel) => `file:///${WIN_REPO}/scripts/${rel}`;
const SRC = (rel) => `file:///${WIN_REPO}/src/synapse/${rel}`;

const CLI = "D:/Users/oobbee/tools/pi-cli/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const EXP_ROOT = "D:/操作系统开源大赛/synapse/_state";
const WORK_DIR = path.join(EXP_ROOT, "p45-runs", "work");
const NOTES_FILE = path.join(WORK_DIR, "notes.md");
const CORPUS_SRC = path.join(EXP_ROOT, "p45-runs", "store", "corpus", "c4b1279d58ae01e6b855e2c5b5cb01037c6e722d7d8132139528c2c32a585e1a");
const CORPUS_ID = "c4b1279d58ae01e6b855e2c5b5cb01037c6e722d7d8132139528c2c32a585e1a";
const ENV_FILE = "D:/操作系统开源大赛/synapse/.env";

const EMBEDDING = {
	provider: "paratera",
	endpoint: "https://llmapi.paratera.com/v1/embeddings",
	model: "GLM-Embedding-3",
	dim: 1024,
	keyEnv: "PARATERA_API_KEY",
};
const REPRESENTATION_ID = `${EMBEDDING.provider}/${EMBEDDING.model}/${EMBEDDING.dim}`;
const MODEL = { provider: "paratera", id: "DeepSeek-V4-Flash" };
const STEER_PREFIX = "The delegating agent handed over a retrieval state";
const NOTES_HINT = "Previous findings from earlier runs are in notes.md — read it if useful.";

const SETUP_TIMEOUT_MS = 30_000;
const ROUND_TIMEOUT_MS = 300_000;
const DISTILL_MAX_CHARS = 400;

const log = (message) => console.log(`[p50m ${new Date().toISOString().slice(11, 19)}] ${message}`);

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

function ensureKey(dotenv) {
	const value = dotenv[EMBEDDING.keyEnv] ?? process.env[EMBEDDING.keyEnv];
	if (value === undefined || value.length === 0) throw new Error(`${EMBEDDING.keyEnv} not present`);
	process.env[EMBEDDING.keyEnv] = value;
}

const sha256 = (text) => createHash("sha256").update(text, "utf-8").digest("hex");
const sha256File = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function copyTree(src, dst) {
	fs.mkdirSync(dst, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const from = path.join(src, entry.name);
		const to = path.join(dst, entry.name);
		if (entry.isDirectory()) copyTree(from, to);
		else fs.copyFileSync(from, to);
	}
}

function listFiles(dir) {
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(full));
		else out.push(full);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Device distillation (preregistration §3 — rule-based, frozen, no LLM).
// The rule itself lives in the product (src/synapse/auto-distill.ts) so the
// arms and the shipped mechanism cannot drift apart; the runner imports it and
// only decides WHERE each arm's distillate lands (nothing for B — the product
// writes on delegation close; notes.md for C; wipe for A).
// ---------------------------------------------------------------------------

async function loadDistillMemoryLines() {
	const { distillMemoryLines } = await import(SRC("auto-distill.ts"));
	return distillMemoryLines;
}

async function loadExecutePendingDistill() {
	const mod = await import(SRC("auto-distill.ts"));
	return mod.executePendingDistill;
}

/** Arm C: the same lines as an append-only plain-text notes file. */
function distillIntoNotes(taskIndex, round, lines) {
	if (lines.length === 0) return;
	const stamp = new Date().toISOString();
	const block = [`<!-- p50m round ${round} task ${taskIndex + 1} at ${stamp} -->`, ...lines.map((line) => `- [task ${taskIndex + 1}] ${line}`), ""].join("\n");
	fs.appendFileSync(NOTES_FILE, block, "utf-8");
}

/** Arm A: the cold control must finish every round with an empty memory dir. */
function wipeMemory(storeRoot) {
	fs.rmSync(path.join(storeRoot, "memory"), { force: true, recursive: true });
	fs.rmSync(path.join(storeRoot, "supersessions"), { force: true, recursive: true });
}

// ---------------------------------------------------------------------------
// Pi round driver — the p50 device verbatim (spawn, /synapse-setup, /run,
// completion detection per mode, final-answer extraction).
// ---------------------------------------------------------------------------

function runPiRound({ agentDir, tempRoot, task, meteringDir, known, roundLog, mode, onBeforeKill }) {
	fs.rmSync(tempRoot, { force: true, recursive: true });
	fs.mkdirSync(tempRoot, { recursive: true });
	// Spawn shape is the p50 device verbatim (rpc mode, the extension loaded via
	// -e, agent dir and temp root by env) — an earlier hand-rolled spawn here
	// used different flags and never reached /synapse-setup, which is exactly
	// the failure the single-round smoke exists to catch.
	const lines = [];
	const child = spawn(
		process.execPath,
		[CLI, "-e", path.join(REPO, "index.ts"), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--mode", "rpc", "--provider", MODEL.provider, "--model", MODEL.id],
		{ cwd: WORK_DIR, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENTS_TEMP_ROOT: tempRoot }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
	);
	// Line-buffered: a chunk boundary can split a long RPC line (the final
	// result runs to tens of KB) and appending the halves separately makes both
	// unparseable — hold the partial tail until its newline arrives.
	let carry = "";
	const append = (prefix, chunk) => {
		carry += String(chunk);
		let at;
		while ((at = carry.indexOf("\n")) !== -1) {
			const line = carry.slice(0, at);
			carry = carry.slice(at + 1);
			if (line.trim().length === 0) continue;
			lines.push(`${prefix}${line}`);
			fs.appendFileSync(roundLog, `${prefix}${line}\n`, "utf-8");
		}
	};
	child.stdout.on("data", (chunk) => append("", chunk));
	child.stderr.on("data", (chunk) => append("ERR ", chunk));
	child.on("exit", (code) => fs.appendFileSync(roundLog, `CHILD-EXIT at ${new Date().toISOString()} code=${code}\n`, "utf-8"));
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
		const result = { setup: false, runId: null, completed: false, okFalse: false, wallMs: null, finalLine: null };
		try {
			await sleep(6_000);
			child.stdin.write(`${JSON.stringify({ id: "setup", message: "/synapse-setup", type: "prompt" })}\n`);
			result.setup = await awaitResponse("setup", SETUP_TIMEOUT_MS);
			if (!result.setup) return result;
			const runSentAt = Date.now();
			child.stdin.write(`${JSON.stringify({ id: "run", message: `/run ${task}`, type: "prompt" })}\n`);
			if (mode === "txt") {
				const endDeadline = Date.now() + ROUND_TIMEOUT_MS;
				while (Date.now() < endDeadline) {
					await sleep(1_500);
					const raw = fs.existsSync(roundLog) ? fs.readFileSync(roundLog, "utf-8") : "";
					const finalLine = raw.split("\n").filter((l) => l.includes("subagent-slash-result") && l.includes("Workflow completed")).pop();
					if (finalLine !== undefined) {
						result.completed = true;
						result.finalLine = finalLine;
						break;
					}
					if (raw.split("\n").some((l) => l.includes("subagent-slash-result") && l.includes('"ok":false'))) {
						result.okFalse = true;
						break;
					}
				}
				result.wallMs = Date.now() - runSentAt;
				return result;
			}
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
			const answerDeadline = Date.now() + 30_000;
			while (Date.now() < answerDeadline) {
				await sleep(1_000);
				const raw = fs.existsSync(roundLog) ? fs.readFileSync(roundLog, "utf-8") : "";
				const finalLine = raw.split("\n").filter((l) => l.includes("subagent-slash-result") && l.includes("Workflow completed")).pop();
				if (finalLine !== undefined) {
					result.finalLine = finalLine;
					break;
				}
			}
			// The host distills on delegation close AFTER the final result message
			// lands (fire-and-forget embedding calls) — killing here would cut the
			// writes off mid-flight. The arm's grace hook decides when the host has
			// had long enough; interactive sessions never face this because the
			// host outlives the delegation.
			if (onBeforeKill) await onBeforeKill();
			result.wallMs = Date.now() - runSentAt;
			return result;
		} finally {
			child.kill();
		}
	})();
}

function parseFinalResult(finalLine) {
	if (finalLine === null || finalLine === undefined) return null;
	let message;
	try {
		message = JSON.parse(finalLine).message;
	} catch {
		return null;
	}
	if (message === undefined || typeof message !== "object") return null;
	const detailUsage = message.details?.result?.details?.results?.[0]?.usage ?? null;
	const content = typeof message.content === "string" ? message.content : "";
	const returnAt = content.indexOf("Return:");
	if (returnAt === -1) return { runId: null, usage: detailUsage, output: null };
	const start = content.indexOf("{", returnAt);
	if (start === -1) return { runId: null, usage: detailUsage, output: null };
	let depth = 0;
	let inString = false;
	let escaped = false;
	let end = -1;
	for (let index = start; index < content.length; index += 1) {
		const ch = content[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				end = index;
				break;
			}
		}
	}
	if (end === -1) return { runId: null, usage: detailUsage, output: null };
	let returned;
	try {
		returned = JSON.parse(content.slice(start, end + 1));
	} catch {
		return { runId: null, usage: detailUsage, output: null };
	}
	return {
		runId: typeof returned.runId === "string" ? returned.runId : null,
		usage: returned.usage ?? detailUsage,
		output: typeof returned.output === "string" ? returned.output : null,
	};
}

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

async function readEvents(meteringFile) {
	const { readMeteringLog } = await import(SRC("metering.ts"));
	return readMeteringLog(meteringFile);
}

/** SYN-arm validity is the p45 S2 rule set, verbatim from the p50 device. */
function validateRound(events) {
	const problems = [];
	const errors = events.filter((event) => event.kind === "error");
	const ended = events.some((event) => event.kind === "task-span" && event.phase === "end");
	const delegate = events.filter((event) => event.kind === "message-delivered" && (event.textBytes ?? 0) > 0);
	if (!ended) problems.push("no task-span end");
	if (delegate.length === 0) problems.push("delegate message-delivered ok=0");
	if (errors.length > 0) problems.push(`errors=[${errors.map((event) => `${event.category}:${String(event.detail).slice(0, 60)}`).join("; ")}]`);
	const prepares = events.filter((event) => event.kind === "state-prepare" && event.ok);
	const okSends = events.filter((event) => event.kind === "state-send" && event.ok);
	const consumes = events.filter((event) => event.kind === "state-consume" && event.ok);
	if (prepares.length !== okSends.length) problems.push(`prepare/send misaligned (${prepares.length}/${okSends.length})`);
	if (okSends.length === 0) problems.push("state-send ok=0");
	if (consumes.length === 0) problems.push("state-consume ok=0");
	const send = okSends[0];
	if (send !== undefined && send.encoding !== "float32-vector") problems.push(`SYN encoding=${send.encoding}`);
	return { problems };
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

async function cmdSeed(expDir) {
	if (!fs.existsSync(CORPUS_SRC)) throw new Error(`corpus source missing: ${CORPUS_SRC}`);
	const store = path.join(expDir, "store-seed");
	fs.rmSync(store, { force: true, recursive: true });
	fs.mkdirSync(store, { recursive: true });
	const { resolveStorageRoot, ensureNamespace } = await import(SRC("namespace.ts"));
	const resolved = resolveStorageRoot({ agentDir: path.join(expDir, "agent-seed"), override: store, worktreePath: WORK_DIR });
	ensureNamespace(resolved);
	copyTree(CORPUS_SRC, path.join(store, "corpus", CORPUS_ID));
	log(`corpus copied (${CORPUS_ID.slice(0, 8)}…); memory intentionally EMPTY (preregistration §1)`);
	fs.writeFileSync(path.join(expDir, "seed-manifest.json"), `${JSON.stringify({ store, namespaceId: resolved.namespaceId, records: [], createdAt: new Date().toISOString() }, null, "\t")}\n`, "utf-8");
	log(`seed store ready: ${store} (0 records)`);
}

function parseRange(spec, max) {
	if (spec === undefined) return Array.from({ length: max }, (_, i) => i + 1);
	if (/^\d+$/.test(spec)) return [Number(spec)];
	const [lo, hi] = spec.split("-").map(Number);
	if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi < lo) throw new Error(`bad --pairs: ${spec}`);
	return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

function writeModelsJson(agentDir) {
	// The p50 device's models.json verbatim (providers map at the agentDir root).
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

function synapseConfigFor(arm, store) {
	// The p50 device's arm config verbatim; the ONLY intended differences are
	// B's autoDistill switch (the product mechanism under test) and C being the
	// text-mode baseline. No extra keys: the plugin's config validator is
	// fail-fast on unknown fields.
	const config = {
		mode: arm === "C" ? "text" : "synapse",
		autoDistill: arm === "B",
		corpusSnapshotId: CORPUS_ID,
		storageRoot: store.replaceAll("\\", "/"),
		embedding: { ...EMBEDDING },
	};
	if (arm !== "C") config.memory = "project";
	// C: memory omitted — config.ts defaults text mode to memory off (the M3 baseline).
	return config;
}

function writeSynapseConfig(agentDir, arm, store) {
	fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), `${JSON.stringify({ synapse: synapseConfigFor(arm, store) }, null, "\t")}\n`, "utf-8");
}

async function cmdRun(expDir, options) {
	ensureKey(loadDotEnv(ENV_FILE));
	const arm = options.arm;
	if (!["A", "B", "C"].includes(arm)) throw new Error(`--arm must be A, B, or C (got ${arm})`);
	const distillMemoryLines = await loadDistillMemoryLines();
	const executePendingDistill = await loadExecutePendingDistill();
	const seedStore = path.join(expDir, "store-seed");
	if (!fs.existsSync(seedStore)) throw new Error(`seed store missing — run the seed command first (${seedStore})`);
	const { TASKS, AGENT } = await import(SCRIPT_SRC("p50-family.mjs"));
	const familySha = sha256File(path.join(REPO, "scripts", "p50-family.mjs"));
	const rounds = parseRange(options.pairs, TASKS.length * 2);
	const taskOf = (round) => TASKS[(round - 1) % TASKS.length];
	const passOf = (round) => (round <= TASKS.length ? 1 : 2);
	const seedMemoryFiles = listFiles(path.join(seedStore, "memory"));
	if (seedMemoryFiles.length > 0) throw new Error(`seed store must hold ZERO memory records (found ${seedMemoryFiles.length}); re-run seed`);
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
				createdAt: new Date().toISOString(),
				preregistration: "pi-share-agents/docs/experiments/P50M-memory-reuse-preregistration-20260921.md (frozen BEFORE any P50M data)",
				arm,
				armMeaning: arm === "A" ? "cold: device wipes memory after every round" : arm === "B" ? "warm-structured: device distills evidence into shared memory" : "warm-text: device appends the same distillate to notes.md",
				armConfig: synapseConfigFor(arm, path.join(expDir, `store-${arm}`)),
				code: { sha: sha.stdout?.trim() ?? null, dirty: (dirty.stdout ?? "").trim().split("\n").filter(Boolean) },
				pi: { cli: CLI, version: piVersion.stdout?.trim() ?? null },
				node: process.version,
				model: `${MODEL.provider}/${MODEL.id}`,
				embedding: { ...EMBEDDING, representationId: REPRESENTATION_ID },
				corpusSnapshotId: CORPUS_ID,
				worktreePath: WORK_DIR.replaceAll("\\", "/"),
				familySha256: familySha,
				scripts: {
					"p50-family.mjs": familySha,
					"p50m-runner.mjs": sha256File(path.join(REPO, "scripts", "p50m-runner.mjs")),
					"p50m-preregistration": sha256File(path.join(REPO, "docs", "experiments", "P50M-memory-reuse-preregistration-20260921.md")),
				},
				sequence: { passes: 2, tasksPerPass: TASKS.length, replay: "runs 31-60 replay tasks 1-30 verbatim" },
				distiller: { mode: "rule-based (no LLM)", source: "src/synapse/auto-distill.ts (product) — ESTABLISHED block, else output bullets", armB: "product switch synapse.autoDistill on delegation close", armC: "runner appends the same rule's lines to notes.md", armA: "device wipes memory after every round" },
				n: options.n,
				roundsPlanned: rounds,
				switches: {
					"synapse.delta": "key omitted in every arm (default false — the residual line is closed)",
					"synapse.stateVerify": "key omitted (default off)",
					"synapse.vectorCache": "key omitted (default off)",
					"synapse.search.k": 5,
					SYNAPSE_STATE_BUDGET_MS: 8000,
				},
				retryPolicy: "up to 3 attempts per round; every attempt kept under evidence/; first valid attempt enters the tables",
				statsPlan: "paired differences (arm vs arm at aggregation): percentile bootstrap B=10000 seed 20260921; intervals beside every difference; crossing zero must be stated",
			},
			null,
			"\t",
		)}\n`,
		"utf-8",
	);

	fs.rmSync(path.join(expDir, `store-${arm}`), { force: true, recursive: true });
	copyTree(seedStore, path.join(expDir, `store-${arm}`));
	writeModelsJson(path.join(expDir, `agent-${arm}`));
	writeSynapseConfig(path.join(expDir, `agent-${arm}`), arm, path.join(expDir, `store-${arm}`));
	if (arm === "C") {
		// One shared notes file for the whole sequence; the device clears it once
		// per experiment directory so a re-seeded experiment never inherits the
		// previous one's memory.
		if (fs.existsSync(NOTES_FILE)) fs.rmSync(NOTES_FILE, { force: true });
	}
	const roundsPath = path.join(expDir, "rounds.jsonl");
	fs.appendFileSync(roundsPath, "");
	const meteringDir = path.join(expDir, `store-${arm}`, "metering");
	const mode = arm === "C" ? "txt" : "syn";
	for (const round of rounds) {
		const taskIndex = (round - 1) % TASKS.length;
		const baseTask = `${AGENT}[output=false] ${taskOf(round)}`;
		const task = arm === "C" ? `${baseTask} ${NOTES_HINT}` : baseTask;
		for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
			const evidenceDir = path.join(expDir, "evidence", `round-${String(round).padStart(2, "0")}`, `attempt-${attempt}`);
			fs.rmSync(evidenceDir, { force: true, recursive: true });
			fs.mkdirSync(evidenceDir, { recursive: true });
			const roundLog = path.join(evidenceDir, "pi-rpc.log");
			const known = new Set(fs.existsSync(meteringDir) ? fs.readdirSync(meteringDir) : []);
			const attemptStartedAt = new Date();
			log(`arm ${arm} round ${round} (pass ${passOf(round)}, task ${taskIndex + 1}) attempt ${attempt}: ${taskOf(round).slice(0, 50)}…`);
			const outcome = await runPiRound({
				agentDir: path.join(expDir, `agent-${arm}`),
				tempRoot: path.join(expDir, "tmp", `${arm}-${round}-${attempt}`),
				task,
				meteringDir,
				known,
				roundLog,
				mode,
			});
			const final = parseFinalResult(outcome.finalLine);
			const record = { arm, round, pass: passOf(round), taskIndex, attempt, startedAt: attemptStartedAt.toISOString(), runIds: [], valid: false, problems: [], steer: null, distilled: 0, wallMs: outcome.wallMs, usage: final?.usage ?? null, answerBytes: final?.output === null || final?.output === undefined ? null : Buffer.byteLength(final.output, "utf-8") };
			const runId = outcome.runId ?? final?.runId;
			if (final?.output !== null && final?.output !== undefined) fs.writeFileSync(path.join(evidenceDir, "answer.md"), `${final.output}\n`, "utf-8");
			try {
				if (!outcome.setup) {
					record.problems.push("/synapse-setup did not answer");
				} else if (outcome.okFalse) {
					record.problems.push("host reported the run as ok:false");
				} else if (mode === "txt") {
					if (!outcome.completed) record.problems.push("no Workflow-completed within budget");
					if (runId !== null) record.runIds.push(runId);
					if (final === null || final.usage === null) record.problems.push("usage not present in the final result");
					if (final?.output === null || final?.output === undefined) record.problems.push("final answer not present in the final result");
					const childLog = listFiles(path.join(expDir, "tmp", `${arm}-${round}-${attempt}`)).find((file) => path.basename(file).startsWith("subagent-log-"));
					if (childLog !== undefined) fs.copyFileSync(childLog, path.join(evidenceDir, path.basename(childLog)));
					fs.copyFileSync(path.join(expDir, `agent-${arm}`, "extensions", "subagent", "config.json"), path.join(evidenceDir, "synapse-config.json"));
					record.valid = record.problems.length === 0;
				} else if (outcome.runId === null) {
					record.problems.push("no metering ledger appeared (child did not start)");
				} else {
					record.runIds.push(runId);
					const meteringFile = path.join(meteringDir, `${runId}.jsonl`);
					const events = await readEvents(meteringFile);
					const firstTs = events[0]?.ts;
					if (firstTs !== undefined && Date.parse(firstTs) < attemptStartedAt.getTime() - 2_000) {
						record.problems.push(`ledger predates this attempt (first event ${firstTs} < spawn ${attemptStartedAt.toISOString()})`);
					}
					if (!outcome.completed) record.problems.push("no task-span end within budget (ledger may be truncated)");
					record.problems.push(...validateRound(events).problems);
					const steer = extractSteer(path.join(expDir, "tmp", `${arm}-${round}-${attempt}`), runId);
					if (steer === null && record.problems.length === 0) record.problems.push("steer message not found in transcript");
					record.steer = steer === null ? null : { bytes: Buffer.byteLength(steer.text, "utf-8") };
					if (final === null || final.usage === null) record.problems.push("usage not present in the final result");
					fs.copyFileSync(meteringFile, path.join(evidenceDir, `${runId}.jsonl`));
					const envelopeDir = path.join(expDir, `store-${arm}`, "envelopes", runId);
					if (fs.existsSync(envelopeDir)) copyTree(envelopeDir, path.join(evidenceDir, "envelopes"));
					if (steer !== null) {
						fs.writeFileSync(path.join(evidenceDir, "steer-message.txt"), `${steer.record}\n`, "utf-8");
						fs.copyFileSync(steer.transcript, path.join(evidenceDir, "child-transcript.jsonl"));
					}
					record.valid = record.problems.length === 0;
				}
			} catch (error) {
				record.problems.push(`runner exception: ${String(error?.message ?? error).slice(0, 200)}`);
			}
			// The device-side memory step runs on the first VALID attempt's own
			// products only (preregistration §3). Arm B's memory writes go through
			// the PRODUCT path in two hops: the host queued the distill intent at
			// delegation close (outbox, synapse.autoDistill), and the runner now
			// EXECUTES it via the product's executePendingDistill — extraction,
			// embedding and store writes are product code either way.
			if (record.valid) {
				const answerFile = path.join(evidenceDir, "answer.md");
				const evidenceText = fs.existsSync(answerFile) ? fs.readFileSync(answerFile, "utf-8") : "";
				const lines = distillMemoryLines(evidenceText);
				record.distilled = lines.length;
				if (arm === "A") {
					// The product never queued (its switch is off for A); the wipe is a
					// belt-and-braces guard against any stray record.
					wipeMemory(path.join(expDir, `store-${arm}`));
				} else if (arm === "C") {
					distillIntoNotes(taskIndex, round, lines);
				} else if (arm === "B") {
					const pendingDir = path.join(expDir, "store-B", "distill-pending");
					for (const pendingFile of fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).filter((name) => name.endsWith(".json")) : []) {
						const full = path.join(pendingDir, pendingFile);
						const result = await executePendingDistill(full, {
							embed: async (text) => {
								const resp = await fetch(EMBEDDING.endpoint, {
									method: "POST",
									headers: { "content-type": "application/json", authorization: `Bearer ${process.env[EMBEDDING.keyEnv] ?? ""}` },
									body: JSON.stringify({ model: EMBEDDING.model, input: [text], dimensions: EMBEDDING.dim }),
									signal: AbortSignal.timeout(30_000),
								});
								if (!resp.ok) throw new Error(`embedding API ${resp.status}`);
								const data = await resp.json();
								const vector = data?.data?.[0]?.embedding;
								if (!Array.isArray(vector) || vector.length !== EMBEDDING.dim) throw new Error(`embedding returned ${Array.isArray(vector) ? vector.length : "no"} dims, expected ${EMBEDDING.dim}`);
								return Float32Array.from(vector);
							},
							representationId: REPRESENTATION_ID,
						});
						log(`arm B executed distill intent ${pendingFile}: ${result.written} line(s), ${result.withoutVector} without vector`);
					}
				}
			}
			fs.appendFileSync(roundsPath, `${JSON.stringify(record)}\n`, "utf-8");
			log(`arm ${arm} round ${round} attempt ${attempt}: valid=${record.valid} problems=${record.problems.length} distilled=${record.distilled}`);
			if (record.valid) break;
		}
	}
	log(`arm ${arm} done: ${rounds.length} rounds planned; rounds.jsonl at ${roundsPath}`);
}

async function main() {
	const argv = process.argv.slice(2);
	const command = argv[0];
	const expDir = argv[1] ? path.resolve(argv[1]) : null;
	if (!expDir || !["seed", "run"].includes(command)) {
		console.error("usage: p50m-runner.mjs seed <expDir> | run <expDir> --arm A|B|C [--pairs 1-60] [--attempts 3]");
		process.exit(2);
	}
	const options = { arm: null, attempts: 3, pairs: undefined, n: null };
	for (let i = 2; i < argv.length; i += 2) {
		const flag = argv[i];
		if (flag === "--arm") options.arm = argv[i + 1];
		else if (flag === "--attempts") options.attempts = Number(argv[i + 1]);
		else if (flag === "--pairs") options.pairs = argv[i + 1];
		else if (flag === "--n") options.n = argv[i + 1];
		else throw new Error(`unknown flag ${flag}`);
	}
	fs.mkdirSync(expDir, { recursive: true });
	if (command === "seed") await cmdSeed(expDir);
	else await cmdRun(expDir, options);
}

await main();
