#!/usr/bin/env node
/**
 * SYNAPSE continuous related-task benchmark (plan A2).
 *
 *   node --experimental-strip-types scripts/synapse-bench/runner.mjs \
 *     [--groups G1,G2] [--rounds 10] [--arms TXT,SYN] [--attempts 2] \
 *     [--provider <p>] [--model <m>] [--pi-cli <cli.js>] [--out <dir>] [--id <experimentId>] \
 *     [--env-file <.env>] [--round-timeout-ms 1800000] [--dry-run]
 *
 * Two task families (families/g1-openeuler.json, families/g2-codebase.json) of
 * ten tasks each, where task N builds on task N-1's conclusion. Each round runs
 * the four-role pipeline (planner → retriever → executor → summarizer) through
 * the real pi CLI in RPC mode with this repository's extension loaded; the
 * prompt is the prompts/role-pipeline.md template expanded here (deterministic,
 * and independent of --no-prompt-templates). The prompt carries the task text
 * only, never the previous round's answer: cross-round reuse can come only from
 * the shared store (both arms keep theirs across rounds AND across G1 → G2) or
 * from the text handoff inside one pipeline.
 *
 * Arms differ only in the synapse block:
 *   TXT — {mode:"text",    memory:"project"}                   memory bodies inlined as text
 *   SYN — {mode:"synapse", memory:"project", autoDistill:true} references + state plane (+ embedding when a key exists)
 *   SYN0 (optional, --arms TXT,SYN,SYN0) — {mode:"synapse", memory:"off"}: protocol without memory.
 *        NOTE: memory off issues no child contract, so SYN0 writes no metering ledger.
 * Both arms set asyncByDefault:false so the parent normally blocks on each
 * stage. A model may still pass async:true explicitly (observed: a workflow
 * script dispatched in the background), so completion also waits for the
 * extension's async-run widget to go idle, every stage task-span to close, and
 * the parent's wake-up turn to settle.
 *
 * Order: per group, per round, arms interleaved (TXT r1, SYN r1, TXT r2, …) to
 * reduce provider drift between arms. Every attempt is kept under evidence/.
 *
 * Secrets: the env file is read into the environment and never printed; the
 * copied auth.json / models.json stay inside the experiment's agent dirs.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const importRepo = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const FAMILY_FILES = { G1: path.join(HERE, "families", "g1-openeuler.json"), G2: path.join(HERE, "families", "g2-codebase.json") };
const TEMPLATE_FILE = path.join(REPO, "prompts", "role-pipeline.md");
const PIPELINE_ROLES = ["planner", "retriever", "executor", "summarizer"];
const ARMS = ["TXT", "SYN", "SYN0"];
// Arms whose config issues no child contract, so the extension writes no
// metering ledger at all (child-contract.ts: memory off → null contract).
const LEDGERLESS_ARMS = new Set(["SYN0"]);
const SILICONFLOW_EMBEDDING = {
	provider: "siliconflow",
	endpoint: "https://api.siliconflow.cn/v1/embeddings",
	model: "BAAI/bge-m3",
	dim: 1024,
	keyEnv: "SILICONFLOW_API_KEY",
};
const PARATERA_EMBEDDING = {
	provider: "paratera",
	endpoint: "https://llmapi.paratera.com/v1/embeddings",
	model: "GLM-Embedding-3",
	dim: 1024,
	keyEnv: "PARATERA_API_KEY",
};
// The working tree copy the agents read: everything an agent may cite, nothing
// that would change pi's own behaviour (.pi project settings) or bloat the copy.
const WORK_COPY_EXCLUDE = new Set(["node_modules", ".git", ".pi", ".commandcode", ".greptile"]);
const COPIED_AGENT_FILES = ["auth.json", "models.json", "settings.json"];

// pi runs in its own process group (detached) so a round's whole tree — the
// parent and every stage child — can be stopped together, including when the
// runner itself is interrupted.
const LIVE_CHILDREN = new Set();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		for (const pid of LIVE_CHILDREN) {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				// already gone
			}
		}
		console.error(`[synbench] ${signal}: stopped ${LIVE_CHILDREN.size} pi process group(s); partial results stay in rounds.jsonl`);
		process.exit(130);
	});
}

const log = (message) => console.log(`[synbench ${new Date().toISOString().slice(11, 19)}] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text) => createHash("sha256").update(text, "utf-8").digest("hex");
const sha256File = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf-8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");

// ---------------------------------------------------------------------------
// Options.
// ---------------------------------------------------------------------------

function userAgentDir() {
	const env = process.env.PI_CODING_AGENT_DIR?.trim();
	if (env) return path.resolve(env.startsWith("~/") ? path.join(os.homedir(), env.slice(2)) : env);
	return path.join(os.homedir(), ".pi", "agent");
}

function parseArgs(argv) {
	const options = {
		arms: ["TXT", "SYN"],
		attempts: 2,
		dryRun: false,
		envFile: null,
		groups: ["G1", "G2"],
		id: null,
		model: null,
		out: null,
		piCli: null,
		provider: null,
		roundTimeoutMs: 30 * 60_000,
		rounds: 10,
	};
	const list = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = () => {
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
			index += 1;
			return next;
		};
		if (flag === "--dry-run") options.dryRun = true;
		else if (flag === "--arms") options.arms = list(value()).map((arm) => arm.toUpperCase());
		else if (flag === "--groups") options.groups = list(value()).map((group) => group.toUpperCase());
		else if (flag === "--rounds") options.rounds = Number(value());
		else if (flag === "--attempts") options.attempts = Number(value());
		else if (flag === "--round-timeout-ms") options.roundTimeoutMs = Number(value());
		else if (flag === "--provider") options.provider = value();
		else if (flag === "--model") options.model = value();
		else if (flag === "--pi-cli") options.piCli = path.resolve(value());
		else if (flag === "--out") options.out = path.resolve(value());
		else if (flag === "--id") options.id = value();
		else if (flag === "--env-file") options.envFile = path.resolve(value());
		else if (flag === "--help" || flag === "-h") {
			console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf-8").split("\n").slice(1, 9).join("\n"));
			process.exit(0);
		} else throw new Error(`unknown option ${flag}`);
	}
	for (const arm of options.arms) if (!ARMS.includes(arm)) throw new Error(`--arms accepts ${ARMS.join(", ")} (got ${arm})`);
	for (const group of options.groups) if (!(group in FAMILY_FILES)) throw new Error(`--groups accepts G1 and G2 (got ${group})`);
	if (!Number.isInteger(options.rounds) || options.rounds < 1 || options.rounds > 10) throw new Error("--rounds must be an integer in 1..10");
	if (!Number.isInteger(options.attempts) || options.attempts < 1) throw new Error("--attempts must be a positive integer");
	if (!Number.isFinite(options.roundTimeoutMs) || options.roundTimeoutMs < 10_000) throw new Error("--round-timeout-ms must be >= 10000");
	return options;
}

function loadDotEnv(file) {
	const out = {};
	for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		let value = trimmed.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		out[trimmed.slice(0, eq).trim().replace(/^export\s+/, "")] = value;
	}
	return out;
}

// ---------------------------------------------------------------------------
// pi CLI resolution: --pi-cli, else `pi` on PATH resolved to its JS entry, else
// the pi-coding-agent that the sibling pi-web checkout installs.
// ---------------------------------------------------------------------------

function isWindowsMountOnWsl(file) {
	return process.platform === "linux" && /^\/mnt\/[a-z]\//i.test(file);
}

function binFromPackageDir(packageDir) {
	const manifest = path.join(packageDir, "package.json");
	if (!fs.existsSync(manifest)) return null;
	const pkg = readJson(manifest);
	const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
	if (typeof bin !== "string") return null;
	const cli = path.join(packageDir, bin);
	return fs.existsSync(cli) ? cli : null;
}

/** The JS entry behind one `pi` found on PATH, or a reason it cannot be used. */
function jsEntryForPathBinary(candidate) {
	let real;
	try {
		real = fs.realpathSync(candidate);
	} catch {
		return { reason: "unresolvable" };
	}
	if (isWindowsMountOnWsl(real)) return { reason: `Windows install under ${path.dirname(real)} (WSL /mnt path) skipped` };
	if (/\.(c|m)?js$/.test(real)) return { cli: real };
	// An npm shell shim: `exec node "$basedir/node_modules/.../cli.js"`.
	let text = "";
	try {
		text = fs.readFileSync(real, "utf-8").slice(0, 4096);
	} catch {
		return { reason: "unreadable" };
	}
	const match = text.match(/\$basedir\/(node_modules\/[^"'\s]+\.m?js)/);
	if (match) {
		const cli = path.join(path.dirname(real), match[1]);
		if (isWindowsMountOnWsl(cli)) return { reason: `Windows install under ${path.dirname(real)} (WSL /mnt path) skipped` };
		if (fs.existsSync(cli)) return { cli };
	}
	return { reason: "native binary or unrecognised shim (pass --pi-cli)" };
}

function resolvePiCli(explicit) {
	const skipped = [];
	if (explicit) {
		if (!fs.existsSync(explicit)) throw new Error(`--pi-cli does not exist: ${explicit}`);
		return { cli: explicit, source: "--pi-cli", skipped };
	}
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "pi");
		if (!fs.existsSync(candidate)) continue;
		const entry = jsEntryForPathBinary(candidate);
		if (entry.cli) return { cli: entry.cli, source: `PATH (${candidate})`, skipped };
		skipped.push(`${candidate}: ${entry.reason}`);
	}
	const fallbackPackage = path.resolve(REPO, "..", "pi-web", "node_modules", "@earendil-works", "pi-coding-agent");
	const cli = binFromPackageDir(fallbackPackage);
	if (cli) return { cli, source: `pi-web fallback (${fallbackPackage})`, skipped };
	throw new Error(`no pi CLI found (PATH candidates: ${skipped.join("; ") || "none"}; fallback ${fallbackPackage} missing); pass --pi-cli`);
}

function piVersionOf(cli) {
	let dir = path.dirname(cli);
	for (let depth = 0; depth < 5; depth += 1) {
		const manifest = path.join(dir, "package.json");
		if (fs.existsSync(manifest)) {
			try {
				const pkg = readJson(manifest);
				if (pkg.name && pkg.version) return `${pkg.name}@${pkg.version}`;
			} catch {
				// keep walking up
			}
		}
		dir = path.dirname(dir);
	}
	return "unavailable";
}

// ---------------------------------------------------------------------------
// Arm setup.
// ---------------------------------------------------------------------------

function synapseBlockFor(arm, storageRoot, embedding) {
	if (arm === "TXT") return { mode: "text", memory: "project", storageRoot };
	if (arm === "SYN0") {
		// Protocol without memory: isolates the memory effect against SYN.
		const block = { mode: "synapse", memory: "off", storageRoot };
		if (embedding !== null) block.embedding = { ...embedding };
		return block;
	}
	const block = { mode: "synapse", memory: "project", autoDistill: true, storageRoot };
	if (embedding !== null) block.embedding = { ...embedding };
	return block;
}

function armConfigFor(arm, expDir, embedding) {
	// asyncByDefault:false on both arms: each stage blocks the parent, so the
	// parent's settled event is the pipeline's end rather than its dispatch.
	return { asyncByDefault: false, synapse: synapseBlockFor(arm, path.join(expDir, `store-${arm}`), embedding) };
}

/** SiliconFlow when /synapse-setup stored a key (or the env has one), else Paratera from the env, else none. */
function resolveEmbedding(sourceAgentDir) {
	const credentials = path.join(sourceAgentDir, "synapse", "credentials.json");
	if (process.env[SILICONFLOW_EMBEDDING.keyEnv]) return { embedding: { ...SILICONFLOW_EMBEDDING }, keySource: "env" };
	if (fs.existsSync(credentials)) return { embedding: { ...SILICONFLOW_EMBEDDING }, keySource: "credentials.json (copied into each agentDir)" };
	if (process.env[PARATERA_EMBEDDING.keyEnv]) return { embedding: { ...PARATERA_EMBEDDING }, keySource: "env" };
	return { embedding: null, keySource: null };
}

function copyTree(src, dst, exclude = new Set()) {
	fs.mkdirSync(dst, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		if (exclude.has(entry.name)) continue;
		const from = path.join(src, entry.name);
		const to = path.join(dst, entry.name);
		if (entry.isDirectory()) copyTree(from, to);
		else if (entry.isFile()) fs.copyFileSync(from, to);
	}
}

function prepareArm({ arm, expDir, sourceAgentDir, embedding }) {
	const agentDir = path.join(expDir, `agent-${arm}`);
	fs.mkdirSync(agentDir, { recursive: true });
	const copied = [];
	for (const name of COPIED_AGENT_FILES) {
		const from = path.join(sourceAgentDir, name);
		if (!fs.existsSync(from)) continue;
		fs.copyFileSync(from, path.join(agentDir, name));
		fs.chmodSync(path.join(agentDir, name), 0o600);
		copied.push(name);
	}
	// pi downloads fd/rg into <agentDir>/bin when missing; reuse the user's copies.
	const bin = path.join(sourceAgentDir, "bin");
	if (fs.existsSync(bin)) {
		copyTree(bin, path.join(agentDir, "bin"));
		for (const name of fs.readdirSync(path.join(agentDir, "bin"))) fs.chmodSync(path.join(agentDir, "bin", name), 0o755);
		copied.push("bin/");
	}
	// The embedding key /synapse-setup stored (credentials.ts reads
	// <agentDir>/synapse/credentials.json when the env var is absent).
	const credentials = path.join(sourceAgentDir, "synapse", "credentials.json");
	if (fs.existsSync(credentials)) {
		fs.mkdirSync(path.join(agentDir, "synapse"), { recursive: true });
		fs.copyFileSync(credentials, path.join(agentDir, "synapse", "credentials.json"));
		fs.chmodSync(path.join(agentDir, "synapse", "credentials.json"), 0o600);
		copied.push("synapse/credentials.json");
	}
	const configDir = path.join(agentDir, "extensions", "subagent");
	fs.mkdirSync(configDir, { recursive: true });
	writeJson(path.join(configDir, "config.json"), armConfigFor(arm, expDir, embedding));
	fs.mkdirSync(path.join(expDir, `store-${arm}`), { recursive: true });
	const workDir = path.join(expDir, `work-${arm}`, "pi-share-agents");
	if (!fs.existsSync(workDir)) copyTree(REPO, workDir, WORK_COPY_EXCLUDE);
	return { agentDir, configPath: path.join(configDir, "config.json"), copied, storeDir: path.join(expDir, `store-${arm}`), workDir };
}

// ---------------------------------------------------------------------------
// Prompt.
// ---------------------------------------------------------------------------

function expandRolePipeline(template, task) {
	const body = template.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
	return body.replaceAll("$ARGUMENTS", task).replaceAll("$@", task);
}

// ---------------------------------------------------------------------------
// Metering snapshot.
// ---------------------------------------------------------------------------

function meteringSnapshot(meteringDir) {
	const snapshot = new Map();
	if (!fs.existsSync(meteringDir)) return snapshot;
	for (const name of fs.readdirSync(meteringDir)) {
		if (!name.endsWith(".jsonl")) continue;
		const stat = fs.statSync(path.join(meteringDir, name));
		snapshot.set(name, { mtimeMs: stat.mtimeMs, size: stat.size });
	}
	return snapshot;
}

function changedSince(before, meteringDir) {
	const after = meteringSnapshot(meteringDir);
	const changed = [];
	for (const [name, stat] of after) {
		const prior = before.get(name);
		if (prior === undefined || prior.size !== stat.size || prior.mtimeMs !== stat.mtimeMs) changed.push({ name, offset: prior?.size ?? 0 });
	}
	return changed.sort((a, b) => a.name.localeCompare(b.name));
}

/** Span balance over the ledgers this round touched: open spans mean a stage is still running. */
function openSpans(meteringDir, before) {
	let open = 0;
	let files = 0;
	for (const { name, offset } of changedSince(before, meteringDir)) {
		files += 1;
		let raw = "";
		try {
			raw = fs.readFileSync(path.join(meteringDir, name), "utf-8").slice(offset);
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			if (!line.includes('"task-span"')) continue;
			if (line.includes('"phase":"start"')) open += 1;
			else if (line.includes('"phase":"end"')) open -= 1;
		}
	}
	return { files, open };
}

// ---------------------------------------------------------------------------
// One pi RPC round.
// ---------------------------------------------------------------------------

function runPiRound({ cli, provider, model, agentDir, workDir, tempRoot, prompt, roundLog, meteringDir, before, timeoutMs }) {
	fs.rmSync(tempRoot, { force: true, recursive: true });
	fs.mkdirSync(tempRoot, { recursive: true });
	const args = [cli, "-e", path.join(REPO, "index.ts"), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--mode", "rpc"];
	if (provider) args.push("--provider", provider);
	if (model) args.push("--model", model);
	const child = spawn(process.execPath, args, {
		cwd: workDir,
		detached: true,
		// NODE_USE_ENV_PROXY: Node's fetch ignores https_proxy unless asked; the
		// proxy variables themselves are inherited unchanged.
		env: { ...process.env, NODE_USE_ENV_PROXY: "1", PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENTS_TEMP_ROOT: tempRoot },
		stdio: ["pipe", "pipe", "pipe"],
	});
	LIVE_CHILDREN.add(child.pid);
	child.on("exit", () => LIVE_CHILDREN.delete(child.pid));
	const listeners = new Set();
	const counts = { messageUpdates: 0, lines: 0 };
	let exited = null;
	child.on("exit", (code, signal) => {
		exited = { code, signal };
	});
	child.on("error", (error) => {
		exited = { code: null, error: String(error?.message ?? error), signal: null };
	});
	// Strict LF framing (rpc.md): split on "\n" only and hold the partial tail.
	const makeSink = (prefix, parse) => {
		let carry = "";
		return (chunk) => {
			carry += String(chunk);
			let at;
			while ((at = carry.indexOf("\n")) !== -1) {
				const line = carry.slice(0, at).replace(/\r$/, "");
				carry = carry.slice(at + 1);
				if (line.trim().length === 0) continue;
				counts.lines += 1;
				let parsed = null;
				if (parse) {
					try {
						parsed = JSON.parse(line);
					} catch {
						parsed = null;
					}
				}
				// Streaming deltas duplicate message_end content; they are counted, not logged.
				if (parsed?.type === "message_update") counts.messageUpdates += 1;
				else fs.appendFileSync(roundLog, `${prefix}${line}\n`, "utf-8");
				if (parsed !== null) for (const listener of listeners) listener(parsed);
			}
		};
	};
	child.stdout.on("data", makeSink("", true));
	child.stderr.on("data", makeSink("ERR ", false));
	const send = (command) => {
		if (exited === null) child.stdin.write(`${JSON.stringify(command)}\n`);
	};
	const request = (command, waitMs) =>
		new Promise((resolve) => {
			const timer = setTimeout(() => {
				listeners.delete(onEvent);
				resolve(null);
			}, waitMs);
			const onEvent = (event) => {
				if (event.type === "response" && event.id === command.id) {
					clearTimeout(timer);
					listeners.delete(onEvent);
					resolve(event);
				}
			};
			listeners.add(onEvent);
			send(command);
		});
	const killTree = () => {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			try {
				child.kill("SIGTERM");
			} catch {
				// already gone
			}
		}
	};

	return (async () => {
		const result = { usedBackgroundRuns: null, ready: false, setup: null, accepted: false, settled: false, timedOut: false, wallMs: null, usage: null, stats: null, answer: null, exited: null, counts, problems: [] };
		let settledCount = 0;
		let lastSettledAt = 0;
		let lastEventAt = Date.now();
		let agentRunning = false;
		// Background (async) subagent runs: the parent settles when it dispatches
		// them and is woken again when they finish. The extension's async widget
		// snapshot is the host's own view of what is still running.
		const asyncState = { active: false, ever: false, idleSince: 0 };
		const onAny = (event) => {
			lastEventAt = Date.now();
			if (event.type === "agent_start") agentRunning = true;
			if (event.type === "agent_settled") {
				agentRunning = false;
				settledCount += 1;
				lastSettledAt = Date.now();
			}
			if (event.type === "extension_ui_request" && event.method === "setWidget" && event.widgetKey === "subagent-async") {
				const line = (event.widgetLines ?? []).find((entry) => typeof entry === "string" && entry.startsWith("PI_SUBAGENT_ASYNC_JSON:"));
				let active = false;
				if (line !== undefined) {
					try {
						const snapshot = JSON.parse(line.slice("PI_SUBAGENT_ASYNC_JSON:".length));
						active = (snapshot.runs ?? []).some((run) => !["complete", "completed", "failed", "cancelled", "canceled", "error", "stopped", "done"].includes(String(run.state)));
					} catch {
						active = asyncState.active;
					}
				}
				if (active) {
					asyncState.active = true;
					asyncState.ever = true;
				} else if (asyncState.active) {
					asyncState.active = false;
					asyncState.idleSince = Date.now();
				}
			}
		};
		listeners.add(onAny);
		try {
			// Ready = the RPC loop answers a command (not a fixed sleep).
			const readyDeadline = Date.now() + 90_000;
			while (!result.ready && Date.now() < readyDeadline && exited === null) {
				result.ready = (await request({ id: `ready-${Date.now()}`, type: "get_state" }, 5_000)) !== null;
			}
			if (!result.ready) {
				result.problems.push(exited ? `pi exited before RPC was ready (${JSON.stringify(exited)})` : "RPC did not answer get_state within 90s");
				return result;
			}
			// Pre-flight report (informational): what the extension resolved for this arm.
			const setup = await request({ id: "setup", message: "/synapse-setup", type: "prompt" }, 30_000);
			result.setup = setup === null ? "no-response" : setup.success === false ? `rejected: ${setup.error ?? "unknown"}` : "ok";
			// Let the setup command's own run (if it started one) settle first.
			const setupQuiet = Date.now() + 15_000;
			while (agentRunning && Date.now() < setupQuiet) await sleep(250);
			const settledBefore = settledCount;

			const sentAt = Date.now();
			const accepted = await request({ id: "run", message: prompt, type: "prompt" }, 60_000);
			result.accepted = accepted !== null && accepted.success !== false;
			if (!result.accepted) {
				result.problems.push(accepted === null ? "run prompt was not acknowledged within 60s" : `run prompt rejected: ${accepted.error ?? "unknown"}`);
				result.wallMs = Date.now() - sentAt;
				return result;
			}
			const deadline = sentAt + timeoutMs;
			// Done = the parent settled after the run prompt, no background run is
			// active, every stage span this round opened is closed, nothing has
			// streamed for a short quiet window, and — when background runs were
			// used — the parent has been woken and settled again after they ended
			// (or 90 s passed without a wake-up).
			while (Date.now() < deadline) {
				await sleep(1_000);
				if (exited !== null) {
					result.problems.push(`pi exited during the round (${JSON.stringify(exited)})`);
					break;
				}
				if (settledCount <= settledBefore || agentRunning || asyncState.active) continue;
				const spans = openSpans(meteringDir, before);
				if (spans.open > 0) continue;
				if (Date.now() - lastEventAt < 3_000) continue;
				if (asyncState.ever && lastSettledAt < asyncState.idleSince && Date.now() - asyncState.idleSince < 90_000) continue;
				result.settled = true;
				result.usedBackgroundRuns = asyncState.ever;
				break;
			}
			result.wallMs = Date.now() - sentAt;
			if (!result.settled && exited === null) {
				result.timedOut = Date.now() >= deadline;
				if (result.timedOut) result.problems.push(`round timed out after ${timeoutMs} ms`);
				await request({ id: "abort", type: "abort" }, 10_000);
			}
			if (exited === null) {
				const stats = await request({ id: "stats", type: "get_session_stats" }, 15_000);
				if (stats?.success !== false && stats?.data) {
					result.stats = stats.data;
					const tokens = stats.data.tokens ?? {};
					result.usage = {
						cacheRead: tokens.cacheRead ?? null,
						cacheWrite: tokens.cacheWrite ?? null,
						cost: stats.data.cost ?? null,
						input: tokens.input ?? null,
						output: tokens.output ?? null,
					};
				}
				const answer = await request({ id: "answer", type: "get_last_assistant_text" }, 15_000);
				if (answer?.success !== false && typeof answer?.data?.text === "string") result.answer = answer.data.text;
			}
			return result;
		} finally {
			listeners.delete(onAny);
			killTree();
			const gone = Date.now() + 5_000;
			while (exited === null && Date.now() < gone) await sleep(100);
			if (exited === null) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// already gone
				}
			}
			result.exited = exited;
		}
	})();
}

// ---------------------------------------------------------------------------
// Metering totals (slimmed aggregateMetering over the round's runs).
// ---------------------------------------------------------------------------

function slimTotals(totals) {
	return {
		capability: totals.capability,
		control: totals.control,
		duration: { totalMs: totals.duration.totalMs, unfinishedTasks: totals.duration.unfinishedTasks },
		embedding: totals.embedding,
		errors: totals.errors,
		fullAccountBytes: totals.fullAccount.bytes,
		memory: totals.memory,
		messages: totals.messages,
		model: totals.model,
		state: { consumed: totals.state.consumed, failedSends: totals.state.failedSends, prepared: totals.state.prepared, received: totals.state.received, restoreCount: totals.state.restoreCount, sent: totals.state.sent, sentBytes: totals.state.sentBytes, deltaPayloadBytes: totals.state.deltaPayloadBytes },
		storage: totals.storage,
		text: totals.text,
	};
}

async function collectMetering({ meteringDir, before, startedAt, evidenceDir }) {
	const { readMeteringLog, aggregateMetering } = await importRepo("src/synapse/metering.ts");
	const changed = changedSince(before, meteringDir);
	const runs = [];
	const allEvents = [];
	const problems = [];
	const cutoff = startedAt.getTime() - 2_000;
	for (const { name } of changed) {
		const file = path.join(meteringDir, name);
		let events;
		try {
			events = readMeteringLog(file);
		} catch (error) {
			problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		// A ledger appended across rounds contributes only this round's rows.
		const mine = events.filter((event) => Date.parse(event.ts) >= cutoff);
		if (mine.length === 0) continue;
		const runId = name.slice(0, -".jsonl".length);
		const agents = [...new Set(mine.map((event) => event.agent))].sort();
		const perRun = aggregateMetering(mine);
		runs.push({ agents, durationMs: perRun.duration.totalMs, events: mine.length, modes: [...new Set(mine.map((event) => event.mode))], runId });
		allEvents.push(...mine);
		fs.mkdirSync(path.join(evidenceDir, "metering"), { recursive: true });
		fs.writeFileSync(path.join(evidenceDir, "metering", name), `${mine.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf-8");
	}
	const totals = allEvents.length === 0 ? null : slimTotals(aggregateMetering(allEvents));
	const agents = [...new Set(allEvents.map((event) => event.agent))].sort();
	return { agents, problems, runs, totals };
}

// ---------------------------------------------------------------------------
// Manifest helpers.
// ---------------------------------------------------------------------------

function gitIdentity() {
	const sha = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf-8" });
	const dirty = spawnSync("git", ["-C", REPO, "status", "--porcelain"], { encoding: "utf-8" });
	return {
		dirty: sha.status === 0 ? (dirty.stdout ?? "").split("\n").filter(Boolean) : "unavailable",
		sha: sha.status === 0 ? sha.stdout.trim() : "unavailable",
	};
}

function defaultModelFrom(sourceAgentDir) {
	try {
		const settings = readJson(path.join(sourceAgentDir, "settings.json"));
		return { model: settings.defaultModel ?? null, provider: settings.defaultProvider ?? null };
	} catch {
		return { model: null, provider: null };
	}
}

function loadFamilies(groups) {
	const families = {};
	for (const group of groups) {
		const file = FAMILY_FILES[group];
		const family = readJson(file);
		if (family.group !== group) throw new Error(`${file} declares group ${family.group}, expected ${group}`);
		if (!Array.isArray(family.tasks) || family.tasks.length !== 10) throw new Error(`${file} must hold exactly 10 tasks`);
		family.tasks.forEach((task, index) => {
			if (task.index !== index + 1) throw new Error(`${file} task ${index} has index ${task.index}`);
		});
		families[group] = { family, file, sha256: sha256File(file) };
	}
	return families;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.envFile) {
		if (!fs.existsSync(options.envFile)) throw new Error(`--env-file not found: ${options.envFile}`);
		const values = loadDotEnv(options.envFile);
		for (const [key, value] of Object.entries(values)) process.env[key] = value;
		log(`env file loaded: ${Object.keys(values).length} keys (values not printed)`);
	}
	const sourceAgentDir = userAgentDir();
	const defaults = defaultModelFrom(sourceAgentDir);
	const provider = options.provider ?? defaults.provider;
	const model = options.model ?? defaults.model;
	const pi = resolvePiCli(options.piCli);
	const outRoot = options.out ?? path.join(sourceAgentDir, "synapse", "experiments");
	const experimentId = options.id ?? `synbench-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
	const expDir = path.join(outRoot, experimentId);
	const families = loadFamilies(options.groups);
	const template = fs.readFileSync(TEMPLATE_FILE, "utf-8");
	const { embedding, keySource } = resolveEmbedding(sourceAgentDir);
	const { resolveSynapseConfig } = await importRepo("src/synapse/config.ts");
	const armConfigs = Object.fromEntries(options.arms.map((arm) => [arm, armConfigFor(arm, expDir, embedding)]));
	// Validate each synapse block with the product's own resolver before anything runs.
	for (const [arm, config] of Object.entries(armConfigs)) resolveSynapseConfig(config.synapse);

	const plan = [];
	for (const group of options.groups) {
		for (let round = 1; round <= options.rounds; round += 1) {
			for (const arm of options.arms) plan.push({ arm, group, round, title: families[group].family.tasks[round - 1].title });
		}
	}

	const manifestPath = path.join(expDir, "manifest.json");
	if (!options.dryRun && fs.existsSync(manifestPath)) throw new Error(`manifest already exists — an experiment is never restarted in place: ${manifestPath}`);
	fs.mkdirSync(expDir, { recursive: true });
	const manifest = {
		experimentId,
		createdAt: new Date().toISOString(),
		dryRun: options.dryRun,
		code: { repo: REPO, ...gitIdentity() },
		pi: { cli: pi.cli, source: pi.source, skipped: pi.skipped, version: piVersionOf(pi.cli) },
		node: process.version,
		platform: { arch: process.arch, platform: process.platform, release: os.release() },
		provider: provider ?? "unavailable",
		model: model ?? "unavailable",
		arms: options.arms.map((arm) => ({ arm, config: armConfigs[arm] })),
		groups: options.groups.map((group) => ({ group, title: families[group].family.title, file: path.relative(REPO, families[group].file), familySha256: families[group].sha256, tasks: families[group].family.tasks.length })),
		rounds: options.rounds,
		attempts: options.attempts,
		roundTimeoutMs: options.roundTimeoutMs,
		semantic: embedding === null ? "unavailable" : "ok",
		embedding: embedding === null ? null : { provider: embedding.provider, model: embedding.model, dim: embedding.dim, endpoint: embedding.endpoint, keyEnv: embedding.keyEnv, keySource, representationId: `${embedding.provider}/${embedding.model}/${embedding.dim}` },
		semanticNote: embedding === null ? "no embedding key (no <agentDir>/synapse/credentials.json, SILICONFLOW_API_KEY or PARATERA_API_KEY): SYN runs keyword+tag retrieval only, no state vectors" : "SYN/SYN0 carry the embedding block; TXT never does (text mode is the pure-text baseline)",
		order: "per group, per round, arms interleaved; store kept across rounds and across groups",
		prompt: { template: path.relative(REPO, TEMPLATE_FILE), templateSha256: sha256(template), expansion: "frontmatter stripped, $@/$ARGUMENTS replaced by the task text; the previous answer is never included" },
		launch: { flags: ["-e", "<repo>/index.ts", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--mode", "rpc"], cwd: "<exp>/work-<arm>/pi-share-agents (repo snapshot without node_modules/.git/.pi)", copiedAgentFiles: COPIED_AGENT_FILES },
		completion: "RPC agent_settled after the run prompt + async-run widget idle + all task-spans opened this round closed + 3 s quiet (+ a settle after background runs ended, or 90 s); else --round-timeout-ms",
		validity: "pipeline settled (no timeout, answer present) and >= 1 metering run written during the round (not required for SYN0: memory off writes no ledger)",
		scripts: { "runner.mjs": sha256File(fileURLToPath(import.meta.url)) },
		plan: plan.map(({ arm, group, round }) => `${group}/r${String(round).padStart(2, "0")}/${arm}`),
	};
	writeJson(manifestPath, manifest);
	log(`experiment ${experimentId} → ${expDir}`);
	log(`pi ${manifest.pi.version} via ${pi.source}; model ${provider}/${model}; semantic ${manifest.semantic}`);
	for (const skip of pi.skipped) log(`  skipped pi candidate: ${skip}`);
	if (options.dryRun) {
		for (const step of plan) log(`  plan ${step.group} r${String(step.round).padStart(2, "0")} ${step.arm}: ${step.title}`);
		log(`dry run: ${plan.length} rounds × up to ${options.attempts} attempts planned; manifest written, nothing spawned`);
		return;
	}
	if (!provider || !model) throw new Error("no provider/model: pass --provider/--model or set defaultProvider/defaultModel in settings.json");

	const roundsPath = path.join(expDir, "rounds.jsonl");
	const progressPath = path.join(expDir, "progress.ndjson");
	fs.appendFileSync(roundsPath, "");
	const progress = (entry) => fs.appendFileSync(progressPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf-8");
	const arms = Object.fromEntries(options.arms.map((arm) => [arm, prepareArm({ arm, expDir, sourceAgentDir, embedding })]));
	for (const [arm, setup] of Object.entries(arms)) log(`arm ${arm}: agentDir ${setup.agentDir} (copied ${setup.copied.join(", ") || "nothing"}), store ${setup.storeDir}`);

	try {
		for (const step of plan) {
			const { arm, group, round } = step;
			const task = families[group].family.tasks[round - 1];
			const setup = arms[arm];
			const meteringDir = path.join(setup.storeDir, "metering");
			for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
				const evidenceDir = path.join(expDir, "evidence", arm, group, `round-${String(round).padStart(2, "0")}`, `attempt-${attempt}`);
				fs.rmSync(evidenceDir, { force: true, recursive: true });
				fs.mkdirSync(evidenceDir, { recursive: true });
				fs.copyFileSync(setup.configPath, path.join(evidenceDir, "synapse-config.json"));
				const prompt = expandRolePipeline(template, task.task);
				fs.writeFileSync(path.join(evidenceDir, "prompt.md"), `${prompt}\n`, "utf-8");
				const before = meteringSnapshot(meteringDir);
				const startedAt = new Date();
				progress({ type: "round-start", arm, group, round, attempt });
				log(`${group} r${round} ${arm} attempt ${attempt}: ${task.title}`);
				const record = { arm, group, round, attempt, taskIndex: task.index, startedAt: startedAt.toISOString(), runIds: [], valid: false, problems: [], warnings: [], wallMs: null, usage: null, answerBytes: null, agents: [], roles: null, runs: [], totals: null, memory: "unavailable", setup: null };
				try {
					const outcome = await runPiRound({
						before,
						cli: pi.cli,
						model,
						provider,
						agentDir: setup.agentDir,
						meteringDir,
						prompt,
						roundLog: path.join(evidenceDir, "pi-rpc.log"),
						tempRoot: path.join(expDir, "tmp", `${arm}-${group}-${round}-${attempt}`),
						timeoutMs: options.roundTimeoutMs,
						workDir: setup.workDir,
					});
					record.problems.push(...outcome.problems);
					record.wallMs = outcome.wallMs;
					record.usage = outcome.usage;
					record.setup = outcome.setup;
					record.rpc = { lines: outcome.counts.lines, messageUpdates: outcome.counts.messageUpdates, exited: outcome.exited, usedBackgroundRuns: outcome.usedBackgroundRuns ?? null };
					if (outcome.answer !== null) {
						record.answerBytes = Buffer.byteLength(outcome.answer, "utf-8");
						fs.writeFileSync(path.join(evidenceDir, "answer.md"), `${outcome.answer}\n`, "utf-8");
					}
					if (outcome.stats !== null) writeJson(path.join(evidenceDir, "session-stats.json"), outcome.stats);
					const metering = await collectMetering({ before, evidenceDir, meteringDir, startedAt });
					record.problems.push(...metering.problems.map((problem) => `metering: ${problem}`));
					record.runIds = metering.runs.map((run) => run.runId);
					record.runs = metering.runs;
					record.agents = metering.agents;
					record.totals = metering.totals;
					const mem = metering.totals?.memory;
					record.memory = mem === undefined ? "unavailable" : { queries: mem.queries, reuses: mem.reuses, crossAgentReuses: mem.crossAgentReuses, hitRate: mem.hitRate, distilled: mem.distilled };
					const rolesSeen = PIPELINE_ROLES.filter((role) => metering.agents.includes(role));
					record.roles = { expected: PIPELINE_ROLES, seen: rolesSeen };
					if (rolesSeen.length < PIPELINE_ROLES.length) record.warnings.push(`pipeline roles metered ${rolesSeen.length}/4 (${rolesSeen.join(",") || "none"})`);
					if (!outcome.settled) record.problems.push("pipeline did not settle");
					if (outcome.answer === null) record.problems.push("no final assistant text");
					if (record.runIds.length === 0) {
						if (LEDGERLESS_ARMS.has(arm)) record.warnings.push("no metering ledger: memory off issues no child contract, so this arm writes none by design");
						else record.problems.push("no metering run written during the round");
					}
					if (outcome.usage === null) record.warnings.push("session usage unavailable (get_session_stats did not answer)");
					record.valid = record.problems.length === 0;
				} catch (error) {
					record.problems.push(`runner error: ${error instanceof Error ? error.message : String(error)}`);
				}
				fs.appendFileSync(roundsPath, `${JSON.stringify(record)}\n`, "utf-8");
				progress({ type: "round-end", arm, group, round, attempt, valid: record.valid, wallMs: record.wallMs });
				log(`${group} r${round} ${arm} attempt ${attempt}: ${record.valid ? "VALID" : `invalid (${record.problems.join("; ")})`} wall=${record.wallMs}ms runs=${record.runIds.length} agents=${record.agents.join(",")}`);
				if (record.valid) break;
			}
		}
		for (const arm of options.arms) progress({ type: "arm-done", arm });
		progress({ type: "experiment-done" });
		log(`experiment complete: ${expDir}`);
	} catch (error) {
		progress({ type: "error", detail: error instanceof Error ? error.message : String(error) });
		throw error;
	}
}

main().catch((error) => {
	console.error(`[synbench] fatal: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
