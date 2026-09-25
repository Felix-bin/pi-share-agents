#!/usr/bin/env node
/**
 * P50 A/B runner (communication-efficiency, preregistration 2026-09-21).
 *
 *   node --experimental-strip-types experiments/legacy/p50-runner.mjs seed <expDir>
 *   node --experimental-strip-types experiments/legacy/p50-runner.mjs run  <expDir> --arm SYN|TXT [--pairs 1-30] [--attempts 3]
 *
 * One experiment directory holds ONE arm. `seed` builds an EMPTY-memory store
 * (namespace + corpus copy, NO record embedding — the v3 seeds overlapped task
 * answers, preregistration §1). `run` drives the real pi CLI one process per
 * round exactly like the p45 device, with:
 *   SYN — mode "synapse", memory "project" (empty store), delta omitted;
 *   TXT — mode "text" (memory defaults off), the M3 pure-text baseline mode.
 * TXT rounds are valid WITHOUT any state events: ledger + task-span end +
 * delegate delivery + zero errors + empty-memory drift.
 *
 * The API key is read from synapse/.env into the environment, never printed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WIN_REPO = REPO.replaceAll("\\", "/");
const SCRIPT_SRC = (rel) => `file:///${WIN_REPO}/experiments/legacy/${rel}`;

const CLI = "D:/Users/oobbee/tools/pi-cli/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const EXP_ROOT = "D:/操作系统开源大赛/synapse/_state";
const WORK_DIR = path.join(EXP_ROOT, "p45-runs", "work");
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
const MODEL = { provider: "paratera", id: "DeepSeek-V4-Flash" };
const STEER_PREFIX = "The delegating agent handed over a retrieval state";

const SETUP_TIMEOUT_MS = 30_000;
const ROUND_TIMEOUT_MS = 300_000;

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

const log = (message) => console.log(`[p50] ${new Date().toISOString()} ${message}`);

/** The synapse config for one arm; the ONLY difference between arms is `mode`. */
function synapseConfigFor(arm, storageRoot) {
	const config = {
		mode: arm === "SYN" ? "synapse" : "text",
		corpusSnapshotId: CORPUS_ID,
		storageRoot: storageRoot.replaceAll("\\", "/"),
		embedding: { ...EMBEDDING },
	};
	if (arm === "SYN") config.memory = "project";
	// TXT: memory omitted — config.ts defaults text mode to memory off (the M3 baseline).
	return config;
}

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

function writeSynapseConfig(agentDir, arm, storageRoot) {
	const dir = path.join(agentDir, "extensions", "subagent");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify({ synapse: synapseConfigFor(arm, storageRoot) }, null, "\t")}\n`, "utf-8");
}

/** One pi RPC process, one prompt pair — identical mechanics to the p45 device, plus text-mode support. */
function runPiRound({ agentDir, tempRoot, task, meteringDir, known, roundLog, mode }) {
	fs.rmSync(tempRoot, { force: true, recursive: true });
	fs.mkdirSync(tempRoot, { recursive: true });
	const lines = [];
	const child = spawn(
		process.execPath,
		[CLI, "-e", path.join(REPO, "index.ts"), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--mode", "rpc", "--provider", MODEL.provider, "--model", MODEL.id],
		{ cwd: WORK_DIR, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENTS_TEMP_ROOT: tempRoot }, stdio: ["pipe", "pipe", "pipe"] },
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
			// Text mode writes NO metering ledger at all (probe, 2026-09-21: store
			// holds only corpus + namespace) — completion, usage and the final
			// answer all come from the RPC log's final subagent-slash-result.
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
			// SYN: the host's final result message (with the child's answer for the
			// judge) lands shortly after the span ends — give it a short window
			// before the kill takes the process down.
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
			result.wallMs = Date.now() - runSentAt;
			return result;
		} finally {
			child.kill();
		}
	})();
}

/** The child's final answer + usage from the host's final subagent-slash-result line (both arms, same source). */
function parseFinalResult(finalLine) {
	if (finalLine === null || finalLine === undefined) return null;
	let message;
	try {
		message = JSON.parse(finalLine).message;
	} catch {
		return null;
	}
	if (message === undefined || typeof message !== "object") return null;
	// Belt and braces: some message shapes carry usage outside the content string.
	const detailUsage = message.details?.result?.details?.results?.[0]?.usage ?? null;
	const content = typeof message.content === "string" ? message.content : "";
	// The content embeds "Return:\n{…}" as text; extract that JSON object with a
	// string-aware brace count (the output field itself may contain braces).
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
	const { readMeteringLog } = await import(`file:///${WIN_REPO}/src/synapse/metering.ts`);
	return readMeteringLog(meteringFile);
}

/**
 * Arm-specific validity (preregistration §5):
 *  - TXT: NO state events are expected — text mode publishes nothing on the
 *    state plane; validity is ledger + task-span end + delegate delivery +
 *    zero errors.
 *  - SYN: the p45 S2 rules — one float32 state send, prepared/sent/consumed
 *    aligned, zero errors.
 */
function validateRound(events, arm) {
	const problems = [];
	const errors = events.filter((event) => event.kind === "error");
	const ended = events.some((event) => event.kind === "task-span" && event.phase === "end");
	const delegate = events.filter((event) => event.kind === "message-delivered" && (event.textBytes ?? 0) > 0);
	if (!ended) problems.push("no task-span end");
	if (delegate.length === 0) problems.push("delegate message-delivered ok=0");
	if (errors.length > 0) problems.push(`errors=[${errors.map((event) => `${event.category}:${String(event.detail).slice(0, 60)}`).join("; ")}]`);
	if (arm === "SYN") {
		const prepares = events.filter((event) => event.kind === "state-prepare" && event.ok);
		const okSends = events.filter((event) => event.kind === "state-send" && event.ok);
		const consumes = events.filter((event) => event.kind === "state-consume" && event.ok);
		if (prepares.length !== okSends.length) problems.push(`prepare/send misaligned (${prepares.length}/${okSends.length})`);
		if (okSends.length === 0) problems.push("state-send ok=0");
		if (consumes.length === 0) problems.push("state-consume ok=0");
		const send = okSends[0];
		if (send !== undefined && send.encoding !== "float32-vector") problems.push(`SYN encoding=${send.encoding}`);
	} else if (events.some((event) => event.kind === "state-send")) {
		problems.push("TXT arm produced a state-send (mode not text?)");
	}
	return { problems };
}

async function cmdSeed(expDir) {
	if (!fs.existsSync(CORPUS_SRC)) throw new Error(`corpus source missing: ${CORPUS_SRC}`);
	ensureKey(loadDotEnv(ENV_FILE));
	const store = path.join(expDir, "store-seed");
	fs.rmSync(store, { force: true, recursive: true });
	fs.mkdirSync(store, { recursive: true });
	const { resolveStorageRoot, ensureNamespace } = await import(`file:///${WIN_REPO}/src/synapse/namespace.ts`);
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

async function cmdRun(expDir, options) {
	ensureKey(loadDotEnv(ENV_FILE));
	const arm = options.arm;
	if (arm !== "SYN" && arm !== "TXT") throw new Error(`--arm must be SYN or TXT (got ${arm})`);
	const seedStore = path.join(expDir, "store-seed");
	if (!fs.existsSync(seedStore)) throw new Error(`seed store missing — run the seed command first (${seedStore})`);
	const { TASKS, AGENT } = await import(SCRIPT_SRC("p50-family.mjs"));
	const familySha = sha256File(path.join(REPO, "scripts", "p50-family.mjs"));
	const seedMemoryDir = path.join(seedStore, "memory");
	const seedMemoryFiles = fs.existsSync(seedMemoryDir) ? listFiles(seedMemoryDir) : [];
	if (seedMemoryFiles.length > 0) throw new Error(`seed store must hold ZERO memory records for the A/B (found ${seedMemoryFiles.length}); re-run seed`);
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
				createdAt: new Date().toISOString(),
				preregistration: "pi-share-agents/experiments/legacy/records/P50-token-ab-preregistration-20260921.md (frozen BEFORE any P50 data)",
				arm,
				armConfig: synapseConfigFor(arm, path.join(expDir, `store-${arm}`)),
				runbook: "synapse/docs/决赛冲刺-方向校准与对比实验筹备-20260921.md §三/§七",
				code: { sha: sha.stdout?.trim() ?? null, dirty: (dirty.stdout ?? "").trim().split("\n").filter(Boolean) },
				pi: { cli: CLI, version: piVersion.stdout?.trim() ?? null },
				node: process.version,
				model: `${MODEL.provider}/${MODEL.id}`,
				embedding: { ...EMBEDDING, representationId: `${EMBEDDING.provider}/${EMBEDDING.model}/${EMBEDDING.dim}` },
				corpusSnapshotId: CORPUS_ID,
				worktreePath: WORK_DIR.replaceAll("\\", "/"),
				familySha256: familySha,
				scripts: {
					"p50-family.mjs": familySha,
					"p50-runner.mjs": sha256File(path.join(REPO, "scripts", "p50-runner.mjs")),
				},
				seedIdentity: { seedManifestSha256: sha256File(path.join(expDir, "seed-manifest.json")), seedMemorySha256: sha256(seedMemoryFiles.map((file) => `${path.basename(file)}:${sha256File(file)}`).sort().join("\n")) },
				memoryState: "EMPTY by design (0 records; the v3 seeds overlapped task answers — preregistration §1)",
				n: options.n,
				roundsPlanned: pairs,
				tasks: TASKS,
				switches: {
					"synapse.delta": "key omitted in both arms (default false — the residual line is closed)",
					"synapse.stateVerify": "key omitted (default off)",
					"synapse.vectorCache": "key omitted (default off)",
					SYNAPSE_STATE_BUDGET_MS: 2500,
				},
				retryPolicy: "up to 3 attempts per round; every attempt kept under evidence/; first valid attempt enters the tables",
				statsPlan: "① paired differences (TXT−SYN at aggregation): percentile bootstrap B=10000 seed 20260921; intervals beside every difference; crossing zero must be stated",
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
	const seedSnapshot = new Map(seedMemoryFiles.map((file) => [path.basename(file), sha256File(file)]));
	const memoryDrift = () => {
		const dir = path.join(expDir, `store-${arm}`, "memory");
		const current = fs.existsSync(dir) ? listFiles(dir).map((file) => path.basename(file)) : [];
		const problems = [];
		for (const name of current) if (!seedSnapshot.has(name)) problems.push(`record ${name.slice(0, 8)}… was added`);
		return problems;
	};
	fs.appendFileSync(path.join(expDir, "rounds.jsonl"), "");
	const roundsPath = path.join(expDir, "rounds.jsonl");
	const meteringDir = path.join(expDir, `store-${arm}`, "metering");
	for (const round of pairs) {
		const task = TASKS[round - 1];
		if (task === undefined) throw new Error(`task ${round} missing from the family`);
		for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
			const evidenceDir = path.join(expDir, "evidence", `round-${String(round).padStart(2, "0")}`, `attempt-${attempt}`);
			fs.rmSync(evidenceDir, { force: true, recursive: true });
			fs.mkdirSync(evidenceDir, { recursive: true });
			const roundLog = path.join(evidenceDir, "pi-rpc.log");
			const known = new Set(fs.existsSync(meteringDir) ? fs.readdirSync(meteringDir) : []);
			const attemptStartedAt = new Date();
			log(`arm ${arm} round ${round} attempt ${attempt}: ${task.slice(0, 60)}…`);
			const outcome = await runPiRound({
				agentDir: path.join(expDir, `agent-${arm}`),
				tempRoot: path.join(expDir, "tmp", `${arm}-${round}-${attempt}`),
				task: `${AGENT}[output=false] ${task}`,
				meteringDir,
				known,
				roundLog,
				mode: arm === "SYN" ? "syn" : "txt",
			});
			const final = parseFinalResult(outcome.finalLine);
			const record = { arm, round, attempt, taskIndex: round - 1, startedAt: attemptStartedAt.toISOString(), runIds: [], valid: false, problems: [], steer: null, wallMs: outcome.wallMs, usage: final?.usage ?? null, answerBytes: final?.output === null || final?.output === undefined ? null : Buffer.byteLength(final.output, "utf-8") };
			const runId = outcome.runId ?? final?.runId;
			if (final?.output !== null && final?.output !== undefined) fs.writeFileSync(path.join(evidenceDir, "answer.md"), `${final.output}\n`, "utf-8");
			try {
				if (!outcome.setup) {
					record.problems.push("/synapse-setup did not answer");
				} else if (outcome.okFalse) {
					record.problems.push("host reported the run as ok:false");
				} else if (arm === "TXT") {
					// Text mode meters nothing (no ledger by design); validity is the
					// completion signal itself (preregistration §9 addendum).
					if (!outcome.completed) record.problems.push("no Workflow-completed within budget");
					if (runId !== null) record.runIds.push(runId);
					if (final === null || final.usage === null) record.problems.push("usage not present in the final result");
					if (final?.output === null || final?.output === undefined) record.problems.push("final answer not present in the final result");
					const drift = memoryDrift();
					if (drift.length > 0) {
						record.problems.push(`memory drift in the empty store: ${drift.join("; ")}`);
						fs.rmSync(path.join(expDir, `store-${arm}`, "memory"), { force: true, recursive: true });
					}
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
					record.problems.push(...validateRound(events, arm).problems);
					const steer = extractSteer(path.join(expDir, "tmp", `${arm}-${round}-${attempt}`), runId);
					if (steer === null && record.problems.length === 0) record.problems.push("steer message not found in transcript");
					record.steer = steer === null ? null : { bytes: Buffer.byteLength(steer.text, "utf-8") };
					if (final === null || final.usage === null) record.problems.push("usage not present in the final result");
					const drift = memoryDrift();
					if (drift.length > 0) {
						record.problems.push(`memory drift in the empty store: ${drift.join("; ")}`);
						fs.rmSync(path.join(expDir, `store-${arm}`, "memory"), { force: true, recursive: true });
					}
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
			log(`arm ${arm} round ${round} attempt ${attempt}: ${record.valid ? "VALID" : `invalid (${record.problems.join("; ")})`}`);
			if (record.valid) break;
		}
	}
	log(`experiment data complete: ${expDir}`);
}

const [, , command, expDirArg, ...rest] = process.argv;
const options = { n: 30, attempts: 3 };
for (let index = 0; index < rest.length; index += 1) {
	const key = rest[index];
	const value = rest[index + 1];
	if (key === "--arm") {
		options.arm = value;
		index += 1;
	} else if (key === "--n" || key === "--attempts") {
		options[key.slice(2)] = Number(value);
		index += 1;
	} else if (key === "--pairs") {
		options.pairs = value;
		index += 1;
	} else throw new Error(`unknown or incomplete option ${key}`);
}
if (command !== "seed" && command !== "run") {
	console.error("usage: p50-runner.mjs seed <expDir> | run <expDir> --arm SYN|TXT [--pairs 1-30] [--attempts 3]");
	process.exit(2);
}
if (command === "run" && options.arm === undefined) throw new Error("run requires --arm SYN|TXT");
const expDir = path.resolve(expDirArg);
fs.mkdirSync(expDir, { recursive: true });
if (command === "seed") await cmdSeed(expDir);
else await cmdRun(expDir, options);
