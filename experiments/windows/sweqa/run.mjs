#!/usr/bin/env node
// Windows port of experiments/openeuler/sweqa/run.mjs: the same four arms, frozen conditions and evidence layout
// (spec §2), with the platform layer rewritten. Metering, scoring and reporting are the openEuler scripts, which
// read `platform: "win32"` from the manifest.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { startLlmProxy } from "../../openeuler/sweqa/llm-proxy.mjs";
import { ARMS, MODEL, PARENT_TOOLS, SHARE_ARMS, evidenceName, loadSample, sha256, taskPrompt } from "../../openeuler/sweqa/matrix.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const defaultOut = path.join(repo, "experiments/data/sweqa-windows");
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
// bsdtar ships with Windows and takes drive-letter paths; Git's GNU tar reads "C:" as a remote host.
const TAR = path.join(systemRoot, "System32", "tar.exe");
if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
	setGlobalDispatcher(new EnvHttpProxyAgent());
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = parseArgs(process.argv.slice(2));
const runDir = path.join(args.out, "runs", args.id);
// Outside this repository, so no parent-directory walk reaches experiments/data or this repo's AGENTS.md.
const workRoot = path.join(args.workRoot, args.id);
const active = new Set();
// Windows has no process groups: a child's whole tree is ended through taskkill.
const killTree = (pid) => spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
	for (const pid of active) killTree(pid);
	process.exitCode = 130;
});

function parseArgs(argv) {
	const out = { sample: null, out: defaultOut, id: null, ids: [], limit: null, workRoot: path.join(os.tmpdir(), "pi-sweqa"),
		timeoutMs: 20 * 60_000, dryRun: false, pi: null };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--dry-run") { out.dryRun = true; continue; }
		const value = argv[++i];
		if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
		if (flag === "--sample") out.sample = path.resolve(value);
		else if (flag === "--out") out.out = path.resolve(value);
		else if (flag === "--id") out.id = value;
		else if (flag === "--ids") out.ids = value.split(",").filter(Boolean);
		else if (flag === "--limit") out.limit = Number(value);
		else if (flag === "--timeout-ms") out.timeoutMs = Number(value);
		else if (flag === "--pi") out.pi = path.resolve(value);
		else if (flag === "--work-root") out.workRoot = path.resolve(value);
		else throw new Error(`unknown option ${flag}`);
	}
	out.sample ??= path.join(out.out, "sample.jsonl");
	// prepare.mjs installs the pinned CLI here.
	out.pi ??= path.join(out.out, "pi", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	if (!out.id || !/^[\w.-]+$/.test(out.id)) throw new Error("a safe --id is required");
	if (!Number.isInteger(out.timeoutMs) || out.timeoutMs < 1000) throw new Error("invalid --timeout-ms");
	if (out.limit !== null && (!Number.isInteger(out.limit) || out.limit < 1)) throw new Error("invalid --limit");
	if (!fs.existsSync(out.pi)) throw new Error(`Pi CLI missing (run prepare.mjs): ${out.pi}`);
	if (out.workRoot === repo || out.workRoot.startsWith(`${repo}${path.sep}`)) throw new Error("--work-root must be outside this repository");
	return out;
}

function command(cmd, argv, opts = {}) {
	const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts });
	if (r.status !== 0) throw new Error(`${cmd} ${argv.slice(0, 3).join(" ")} failed: ${r.stderr || r.error || r.stdout}`);
	return r.stdout.trim();
}

// The arm's installed package is loaded whole (extensions, skills, prompt templates); nothing else is.
// The parent holds only the delegation tool. Context files stay off: no AGENTS.md from above the attempt.
const LAUNCH = ["--no-themes", "--no-context-files", "--no-session", "--offline", "--mode", "rpc",
	"--provider", MODEL.provider, "--model", MODEL.id, "--thinking", MODEL.thinking];
const launchFor = (arm) => [...LAUNCH, "--tools", PARENT_TOOLS[arm].join(",")];

// Node scripts run under this node; anything else (a test double) is executed directly.
const piLaunch = (argv) => (/\.[cm]?js$/.test(args.pi) ? [process.execPath, [args.pi, ...argv]] : [args.pi, argv]);

// Pi's bash tool looks for Git Bash under %ProgramFiles% first (pi-coding-agent getShellConfig).
function gitBash() {
	for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
		const bash = path.join(base, "Git", "bin", "bash.exe");
		if (fs.existsSync(bash)) return bash;
	}
	throw new Error("Git Bash not found under %ProgramFiles%\\Git: Pi's bash tool needs it on Windows");
}

function installed(arm) {
	const dir = path.join(args.out, "agent", arm);
	const meta = JSON.parse(fs.readFileSync(path.join(dir, "installed.json"), "utf8"));
	if (!fs.existsSync(meta.entry)) throw new Error(`${arm} extension missing: ${meta.entry}`);
	// Pi loads whatever the agent directory has installed; each arm must hold exactly its own package.
	const packages = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).packages ?? [];
	if (packages.length !== 1) throw new Error(`${arm} agent directory must install exactly one package, found ${packages.length}`);
	for (const bin of ["rg.exe", "fd.exe"]) if (!fs.existsSync(path.join(dir, "bin", bin))) throw new Error(`${arm} lacks bin/${bin}; rerun prepare.mjs`);
	return { dir, ...meta, commit: undefined };
}

function modelCatalog(agentDir, proxy) {
	const file = path.join(agentDir, "models.json");
	const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
	const provider = catalog.providers?.[MODEL.provider];
	if (!provider?.models?.some((m) => m.id === MODEL.id)) throw new Error(`${MODEL.id} model missing`);
	provider.baseUrl = proxy.baseUrlFor("pi");
	provider.apiKey = "bench-proxy-key";
	fs.writeFileSync(file, JSON.stringify(catalog, null, 2));
}

function configureShare(agentDir, storageRoot) {
	const configDir = path.join(agentDir, "extensions", "subagent");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
		asyncByDefault: false,
		synapse: { mode: "synapse", memory: "project", autoDistill: true, storageRoot },
	}, null, 2));
}

// A hard link where the volume allows it, a copy otherwise (symbolic links need Developer Mode on Windows).
function linkOrCopy(from, to) {
	try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
}

// PATH is this directory plus the Windows system directories: `pi` is the pinned CLI (every call logged, as pi.cmd
// for Windows callers and as a shell script for Git Bash), `node` is this node, rg and fd are the arm's own copies.
// Git Bash puts its own tools on PATH when it starts. claude, codex and cursor-agent are missing on every arm.
function binDir(dir, log, agentDir) {
	fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	fs.mkdirSync(dir, { recursive: true });
	const [bin, pre] = piLaunch([]);
	fs.writeFileSync(path.join(dir, "pi.cmd"), `@echo off\r\n>>"${log}" echo(%*\r\n${[bin, ...pre].map((s) => `"${s}"`).join(" ")} %*\r\n`);
	const posix = (p) => p.replace(/\\/g, "/");
	const quote = (s) => `'${posix(s).replace(/'/g, `'\\''`)}'`;
	fs.writeFileSync(path.join(dir, "pi"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(log)}\nexec ${[bin, ...pre].map(quote).join(" ")} "$@"\n`);
	linkOrCopy(process.execPath, path.join(dir, "node.exe"));
	for (const tool of ["rg.exe", "fd.exe"]) linkOrCopy(path.join(agentDir, "bin", tool), path.join(dir, tool));
	return [dir, path.join(systemRoot, "System32"), systemRoot, path.join(systemRoot, "System32", "Wbem")].join(";");
}

// Only the variables Windows processes and Git Bash need, plus the attempt's own TMP/TEMP/TMPDIR and APPDATA
// (the pi-subagents lineage keeps run state and artifacts under os.tmpdir(); nothing may land in the real profile).
const SYSTEM_ENV = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
	"ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME",
	"USERNAME", "USERDOMAIN", "LANG", "LC_ALL", "TERM", "TZ"];
function childEnv(agentDir, pathValue, tmpDir) {
	const env = { PATH: pathValue, PI_CODING_AGENT_DIR: agentDir, NODE_USE_ENV_PROXY: "0", TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir,
		APPDATA: path.join(tmpDir, "appdata", "roaming"), LOCALAPPDATA: path.join(tmpDir, "appdata", "local") };
	for (const key of SYSTEM_ENV) if (process.env[key]) env[key] = process.env[key];
	fs.mkdirSync(env.APPDATA, { recursive: true });
	fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
	return env;
}

// Each attempt runs on a copy of the arm's installed agent directory, outside this repository: an agent that
// finds PI_CODING_AGENT_DIR sees no experiment data next to it, and nothing Pi or a package writes there
// (sessions, run history) carries over to the next question. Only what loads the package is copied.
const AGENT_FILES = ["settings.json", "models.json", "bin", "npm"];
function attemptAgentDir(setup, dest) {
	fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of AGENT_FILES) {
		const from = path.join(setup.dir, entry);
		if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, entry), { recursive: true, verbatimSymlinks: true });
	}
	// A local package is recorded relative to the installed directory; the copy must point at it absolutely.
	const settingsFile = path.join(dest, "settings.json");
	const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
	settings.packages = settings.packages.map((p) => (typeof p === "string" && !p.startsWith("npm:") ? path.resolve(setup.dir, p) : p));
	fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
	return dest;
}

function exportRepo(item, dest) {
	const tar = path.join(args.out, "snapshots", `${item.name}-${item.commit}.tar`);
	if (!fs.existsSync(tar)) throw new Error(`snapshot missing (run prepare.mjs): ${tar}`);
	fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	fs.mkdirSync(path.join(dest, item.name), { recursive: true });
	command(TAR, ["-xf", tar, "-C", path.join(dest, item.name)]);
}

function lastAnswer(events) {
	let answer = "";
	for (const event of events) {
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		const text = (event.message.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
		if (text.trim()) answer = text;
	}
	return answer;
}

async function piAttempt({ arm, cwd, prompt, evidence, env }) {
	const logFile = path.join(evidence, "pi-rpc.jsonl");
	const [piBin, piArgs] = piLaunch(launchFor(arm));
	const child = spawn(piBin, piArgs, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	if (child.pid) active.add(child.pid);
	let carry = "", stderr = "", exited = false, exitCode = null, settled = false;
	const events = [], responses = new Map();
	child.stdout.on("data", (chunk) => {
		carry += chunk;
		let at;
		while ((at = carry.indexOf("\n")) >= 0) {
			const line = carry.slice(0, at).replace(/\r$/, ""); carry = carry.slice(at + 1);
			try {
				const event = JSON.parse(line);
				if (event.type !== "message_update" && event.type !== "tool_execution_update") {
					events.push(event);
					fs.appendFileSync(logFile, `${line}\n`);
				}
				if (event.type === "response") responses.set(event.id, event);
				if (event.type === "agent_settled") settled = true;
			} catch { fs.appendFileSync(path.join(evidence, "stdout-errors.log"), `${line}\n`); }
		}
	});
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	child.on("exit", (code) => { exited = true; exitCode = code; active.delete(child.pid); });
	child.on("error", (error) => { stderr += String(error); exited = true; active.delete(child.pid); });
	const send = (event) => child.stdin.write(`${JSON.stringify(event)}\n`);
	const response = async (id, ms) => {
		const until = Date.now() + ms;
		while (Date.now() < until && !exited) {
			if (responses.has(id)) return responses.get(id);
			await sleep(100);
		}
		return null;
	};
	const started = Date.now();
	try {
		send({ id: "ready", type: "get_state" });
		if (!await response("ready", 90_000)) throw new Error("Pi RPC did not become ready");
		send({ id: "run", type: "prompt", message: prompt });
		const ack = await response("run", 60_000);
		if (!ack || ack.success === false) throw new Error(`Pi rejected prompt: ${ack?.error ?? "no response"}`);
		const until = Date.now() + args.timeoutMs;
		while (!settled && !exited && Date.now() < until) await sleep(200);
		if (!settled) throw new Error(exited ? `Pi exited (${exitCode})` : "Pi timed out");
		await sleep(500);
		return { answer: lastAnswer(events), wallMs: Date.now() - started, problem: null };
	} catch (error) {
		return { answer: lastAnswer(events), wallMs: Date.now() - started, problem: String(error) };
	} finally {
		fs.writeFileSync(path.join(evidence, "pi-stderr.log"), stderr);
		// Children (share, nico) are separate node processes: end the whole tree, then wait for the exit so that
		// no process still holds files in the attempt's directories when they are copied and removed.
		if (child.pid) killTree(child.pid);
		for (let i = 0; i < 50 && !exited; i++) await sleep(100);
	}
}

// Agents can leave trees they cannot read back or delete (read-only files): restore the owner's access before the
// tree is copied or removed. Symbolic links are left alone.
function unlock(target) {
	let stat;
	try { stat = fs.lstatSync(target); } catch { return; }
	if (stat.isSymbolicLink()) return;
	try { fs.chmodSync(target, stat.mode | (stat.isDirectory() ? 0o700 : 0o600)); } catch {}
	if (!stat.isDirectory()) return;
	let entries = [];
	try { entries = fs.readdirSync(target); } catch {}
	for (const entry of entries) unlock(path.join(target, entry));
}

async function runArm(item, arm, setup, apiKey) {
	const name = evidenceName(item.id), attemptKey = `${name}/${arm}`;
	const evidence = path.join(runDir, "evidence", name, arm);
	const resultFile = path.join(evidence, "result.json");
	if (fs.existsSync(resultFile)) return;
	fs.rmSync(evidence, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	fs.mkdirSync(evidence, { recursive: true });
	const cwd = path.join(workRoot, name, arm), storageRoot = path.join(workRoot, ".state", name, arm), tmpDir = path.join(workRoot, ".tmp", name, arm);
	const agentDir = path.join(workRoot, ".agent", name, arm);
	const base = { id: item.id, arm, workRoot: cwd, storageRoot, tmpDir, agentDir, attemptKey };
	console.log(`[sweqa] ${attemptKey}`);
	let proxy;
	try {
		exportRepo(item, cwd);
		fs.rmSync(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		fs.mkdirSync(tmpDir, { recursive: true });
		attemptAgentDir(setup, agentDir);
		proxy = await startLlmProxy({ upstreamBaseUrl: MODEL.baseUrl, apiKey, roles: ["pi"], logFile: path.join(evidence, "llm-calls.jsonl") });
		modelCatalog(agentDir, proxy);
		if (SHARE_ARMS.includes(arm)) configureShare(agentDir, storageRoot);
		const prompt = taskPrompt(item, arm);
		fs.writeFileSync(path.join(evidence, "prompt.md"), prompt);
		const invocations = path.join(evidence, "pi-invocations.log");
		fs.writeFileSync(invocations, "");
		const env = childEnv(agentDir, binDir(path.join(workRoot, ".bin", name, arm), invocations, agentDir), tmpDir);
		const attempt = await piAttempt({ arm, cwd, prompt, evidence, env });
		fs.writeFileSync(path.join(evidence, "answer.md"), attempt.answer);
		const problem = attempt.problem ?? (attempt.answer.trim() ? null : "empty answer");
		fs.writeFileSync(resultFile, JSON.stringify({ ...base, problem, wallMs: attempt.wallMs, inflightAtEnd: problem ? proxy.inflight() : [],
			childPiLaunches: fs.readFileSync(invocations, "utf8").split(/\r?\n/).filter(Boolean).length }, null, 2));
		console.log(`[sweqa] ${attemptKey}: ${problem ?? "finished"}`);
	} catch (error) {
		fs.writeFileSync(resultFile, JSON.stringify({ ...base, problem: String(error), inflightAtEnd: proxy ? proxy.inflight() : [] }, null, 2));
		console.error(`[sweqa] ${attemptKey}: ${error}`);
	} finally {
		if (proxy) await proxy.close();
		// Evidence handling never aborts the run: a failure is logged beside the evidence and the next attempt goes on.
		const guarded = (step, fn) => {
			try { fn(); } catch (error) { fs.appendFileSync(path.join(evidence, "evidence-errors.log"), `${step}: ${error}\n`); }
		};
		for (const [dir, keep] of [[storageRoot, "state"], [tmpDir, "tmp"]]) {
			if (fs.existsSync(dir)) guarded(`copy ${keep}`, () => { unlock(dir); fs.cpSync(dir, path.join(evidence, keep), { recursive: true, verbatimSymlinks: true }); });
		}
		// What the attempt wrote into its agent directory is evidence; the copied package and binaries are not.
		if (fs.existsSync(agentDir)) guarded("copy agent", () => { unlock(agentDir); fs.cpSync(agentDir, path.join(evidence, "agent"), { recursive: true, verbatimSymlinks: true,
			filter: (src) => !["npm", "bin"].includes(path.relative(agentDir, src).split(path.sep)[0]) }); });
		for (const dir of [cwd, storageRoot, tmpDir, agentDir, path.join(workRoot, ".bin", name, arm)]) {
			guarded(`remove ${dir}`, () => { unlock(dir); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });
		}
	}
}

// Only the recorder holds the key, and only from the environment: it is never written to disk or the manifest.
function resolveApiKey() {
	const key = process.env.COMMANDCODE_API_KEY?.trim();
	if (!key) throw new Error("COMMANDCODE_API_KEY is not set");
	return key;
}

async function main() {
	if (command("git", ["status", "--porcelain", "--", "index.ts", "src", "prompts", "skills", "package.json", "package-lock.json"], { cwd: repo })) {
		throw new Error("local share extension source is dirty; commit product changes before a frozen run");
	}
	if (!fs.existsSync(TAR)) throw new Error(`${TAR} missing`);
	const bash = gitBash();
	const all = loadSample(args.sample, args.ids);
	const items = args.limit === null ? all : all.slice(0, args.limit);
	const setups = Object.fromEntries(ARMS.map((arm) => [arm, installed(arm)]));
	const [piBin, piArgs] = piLaunch(["--version"]);
	const piVersion = command(piBin, piArgs);
	if (!/^\d+\.\d+\.\d+/.test(piVersion)) throw new Error(`Pi version probe failed: ${JSON.stringify(piVersion)}`);
	// The share arm loads this checkout; what is frozen is its product source, not the experiment commits around it.
	const shareSource = Object.fromEntries(["src", "index.ts", "prompts", "skills", "package.json", "package-lock.json"]
		.map((p) => [p, command("git", ["rev-parse", `HEAD:${p}`], { cwd: repo })]));
	const manifest = { id: args.id, platform: "win32", samplePath: args.sample, sampleSha256: sha256(args.sample),
		matrixSha256: sha256(path.resolve(here, "../../openeuler/sweqa/matrix.mjs")), runnerSha256: sha256(fileURLToPath(import.meta.url)),
		instances: items.map((x) => x.id), arms: setups, shareSource, headCommit: command("git", ["rev-parse", "HEAD"], { cwd: repo }), piCli: args.pi, piVersion, model: `${MODEL.provider}/${MODEL.id}`,
		thinking: MODEL.thinking, upstream: MODEL.baseUrl, launch: LAUNCH, parentTools: PARENT_TOOLS,
		timeoutMs: args.timeoutMs, repoRoot: repo, workRoot, gitBash: bash, tar: TAR, os: `${os.type()} ${os.release()}`,
		path: "<bin>;%SystemRoot%\\System32;%SystemRoot%;%SystemRoot%\\System32\\Wbem", concurrency: "arms of one question in parallel", createdAt: new Date().toISOString() };
	if (args.dryRun) { console.log(JSON.stringify(manifest, null, 2)); return; }
	const apiKey = resolveApiKey();
	fs.mkdirSync(runDir, { recursive: true });
	const manifestFile = path.join(runDir, "manifest.json");
	if (fs.existsSync(manifestFile)) {
		const prior = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
		for (const field of ["platform", "sampleSha256", "matrixSha256", "runnerSha256", "piVersion", "model", "thinking", "timeoutMs", "instances", "arms", "shareSource", "launch", "upstream", "parentTools"]) {
			if (JSON.stringify(prior[field]) !== JSON.stringify(manifest[field])) throw new Error(`run manifest changed: ${field}`);
		}
	} else fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
	for (const item of items) {
		if (process.exitCode) return;
		await Promise.all(ARMS.map((arm) => runArm(item, arm, setups[arm], apiKey)));
	}
	unlock(workRoot);
	fs.rmSync(workRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
