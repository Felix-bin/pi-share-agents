#!/usr/bin/env node
// Runs every sampled SWE-QA question on the three arms concurrently (spec §2). Metering is offline: analyze.mjs.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { startLlmProxy } from "../bench/llm-proxy.mjs";
import { ARMS, MODEL, PARENT_TOOLS, evidenceName, loadSample, sha256, taskPrompt } from "./matrix.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultOut = path.join(repo, "experiments/data/sweqa");
const defaultPi = path.resolve(repo, "../pi-web/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
	setGlobalDispatcher(new EnvHttpProxyAgent());
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = parseArgs(process.argv.slice(2));
const runDir = path.join(args.out, "runs", args.id);
// Outside this repository, so no parent-directory walk reaches experiments/data or this repo's AGENTS.md.
const workRoot = path.join(os.tmpdir(), "pi-sweqa", args.id);
const active = new Set();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
	for (const pid of active) { try { process.kill(-pid, "SIGTERM"); } catch {} }
	process.exitCode = 130;
});

function parseArgs(argv) {
	const out = { sample: null, out: defaultOut, id: null, ids: [], limit: null,
		timeoutMs: 20 * 60_000, dryRun: false, pi: defaultPi };
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
		else throw new Error(`unknown option ${flag}`);
	}
	out.sample ??= path.join(out.out, "sample.jsonl");
	if (!out.id || !/^[\w.-]+$/.test(out.id)) throw new Error("a safe --id is required");
	if (!Number.isInteger(out.timeoutMs) || out.timeoutMs < 1000) throw new Error("invalid --timeout-ms");
	if (out.limit !== null && (!Number.isInteger(out.limit) || out.limit < 1)) throw new Error("invalid --limit");
	if (!fs.existsSync(out.pi)) throw new Error(`Pi CLI missing: ${out.pi}`);
	return out;
}

function command(cmd, argv, opts = {}) {
	const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
	if (r.status !== 0) throw new Error(`${cmd} ${argv.slice(0, 3).join(" ")} failed: ${r.stderr || r.error || r.stdout}`);
	return r.stdout.trim();
}

// Node scripts run under this node; anything else (a test double) is executed directly.
const piLaunch = (argv) => (args.pi.endsWith(".js") ? [process.execPath, [args.pi, ...argv]] : [args.pi, argv]);

function installed(arm) {
	const dir = path.join(args.out, "agent", arm);
	const meta = JSON.parse(fs.readFileSync(path.join(dir, "installed.json"), "utf8"));
	if (!fs.existsSync(meta.entry)) throw new Error(`${arm} extension missing: ${meta.entry}`);
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
	fs.chmodSync(file, 0o600);
}

function configureShare(agentDir, storageRoot) {
	const configDir = path.join(agentDir, "extensions", "subagent");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
		asyncByDefault: false,
		synapse: { mode: "synapse", memory: "project", autoDistill: true, storageRoot },
	}, null, 2));
}

// PATH is this directory plus the system bins: `pi` is the pinned CLI (every call logged), `node` is this node.
// claude, codex and cursor-agent are therefore missing on every arm (spec §2.2).
function binDir(dir, log) {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const [bin, pre] = piLaunch([]);
	const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
	fs.writeFileSync(path.join(dir, "pi"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(log)}\nexec ${[bin, ...pre].map(quote).join(" ")} "$@"\n`);
	fs.chmodSync(path.join(dir, "pi"), 0o755);
	fs.symlinkSync(process.execPath, path.join(dir, "node"));
	return `${dir}:/usr/local/bin:/usr/bin:/bin`;
}

function childEnv(agentDir, pathValue) {
	const env = { PATH: pathValue, PI_CODING_AGENT_DIR: agentDir, NODE_USE_ENV_PROXY: "0" };
	for (const key of ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TZ", "SHELL", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
	return env;
}

function exportRepo(item, dest) {
	const tar = path.join(args.out, "snapshots", `${item.name}-${item.commit}.tar`);
	if (!fs.existsSync(tar)) throw new Error(`snapshot missing (run prepare.mjs): ${tar}`);
	fs.rmSync(dest, { recursive: true, force: true });
	fs.mkdirSync(path.join(dest, item.name), { recursive: true });
	command("tar", ["-xf", tar, "-C", path.join(dest, item.name)]);
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

async function piAttempt({ arm, setup, cwd, prompt, evidence, env }) {
	const logFile = path.join(evidence, "pi-rpc.jsonl");
	const [piBin, piArgs] = piLaunch(["-e", setup.entry, "--no-extensions", "--no-skills", "--no-prompt-templates",
		"--no-themes", "--no-context-files", "--no-session", "--offline", "--mode", "rpc", "--provider", MODEL.provider,
		"--model", MODEL.id, "--thinking", MODEL.thinking, "--tools", PARENT_TOOLS[arm].join(",")]);
	const child = spawn(piBin, piArgs, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
	if (child.pid) active.add(child.pid);
	let carry = "", stderr = "", exited = false, exitCode = null, settled = false;
	const events = [], responses = new Map();
	child.stdout.on("data", (chunk) => {
		carry += chunk;
		let at;
		while ((at = carry.indexOf("\n")) >= 0) {
			const line = carry.slice(0, at); carry = carry.slice(at + 1);
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
		if (!exited) { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); } }
	}
}

async function runArm(item, arm, setup, apiKey) {
	const name = evidenceName(item.id), attemptKey = `${name}/${arm}`;
	const evidence = path.join(runDir, "evidence", name, arm);
	const resultFile = path.join(evidence, "result.json");
	if (fs.existsSync(resultFile)) return;
	fs.rmSync(evidence, { recursive: true, force: true });
	fs.mkdirSync(evidence, { recursive: true });
	const cwd = path.join(workRoot, name, arm), storageRoot = path.join(workRoot, ".state", name, arm);
	const base = { id: item.id, arm, workRoot: cwd, storageRoot, attemptKey };
	console.log(`[sweqa] ${attemptKey}`);
	let proxy;
	try {
		exportRepo(item, cwd);
		fs.rmSync(storageRoot, { recursive: true, force: true });
		proxy = await startLlmProxy({ upstreamBaseUrl: "https://api.deepseek.com", apiKey, roles: ["pi"], logFile: path.join(evidence, "llm-calls.jsonl") });
		modelCatalog(setup.dir, proxy);
		if (arm === "share") configureShare(setup.dir, storageRoot);
		const prompt = taskPrompt(item);
		fs.writeFileSync(path.join(evidence, "prompt.md"), prompt);
		const invocations = path.join(evidence, "pi-invocations.log");
		fs.writeFileSync(invocations, "");
		const env = childEnv(setup.dir, binDir(path.join(workRoot, ".bin", name, arm), invocations));
		const attempt = await piAttempt({ arm, setup, cwd, prompt, evidence, env });
		fs.writeFileSync(path.join(evidence, "answer.md"), attempt.answer);
		const problem = attempt.problem ?? (attempt.answer.trim() ? null : "empty answer");
		fs.writeFileSync(resultFile, JSON.stringify({ ...base, problem, wallMs: attempt.wallMs,
			childPiLaunches: fs.readFileSync(invocations, "utf8").split("\n").filter(Boolean).length }, null, 2));
		console.log(`[sweqa] ${attemptKey}: ${problem ?? "finished"}`);
	} catch (error) {
		fs.writeFileSync(resultFile, JSON.stringify({ ...base, problem: String(error) }, null, 2));
		console.error(`[sweqa] ${attemptKey}: ${error}`);
	} finally {
		if (proxy) await proxy.close();
		if (fs.existsSync(storageRoot)) fs.cpSync(storageRoot, path.join(evidence, "state"), { recursive: true });
		for (const dir of [cwd, storageRoot]) fs.rmSync(dir, { recursive: true, force: true });
	}
}

function resolveApiKey() {
	if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
	const catalog = path.join(os.homedir(), ".pi", "agent", "models.json");
	if (fs.existsSync(catalog)) {
		const key = JSON.parse(fs.readFileSync(catalog, "utf8")).providers?.deepseek?.apiKey;
		if (typeof key === "string" && key.trim()) return key;
	}
	throw new Error("DeepSeek API key missing: set DEEPSEEK_API_KEY or configure Pi's deepseek provider");
}

async function main() {
	if (command("git", ["status", "--porcelain", "--", "index.ts", "src", "package.json", "package-lock.json"], { cwd: repo })) {
		throw new Error("local share extension source is dirty; commit product changes before a frozen run");
	}
	const all = loadSample(args.sample, args.ids);
	const items = args.limit === null ? all : all.slice(0, args.limit);
	const setups = Object.fromEntries(ARMS.map((arm) => [arm, installed(arm)]));
	const [piBin, piArgs] = piLaunch(["--version"]);
	const piVersion = command(piBin, piArgs);
	if (!/^\d+\.\d+\.\d+/.test(piVersion)) throw new Error(`Pi version probe failed: ${JSON.stringify(piVersion)}`);
	const here = path.dirname(fileURLToPath(import.meta.url));
	// The share arm loads this checkout; what is frozen is its product source, not the experiment commits around it.
	const shareSource = Object.fromEntries(["src", "index.ts", "package.json", "package-lock.json"]
		.map((p) => [p, command("git", ["rev-parse", `HEAD:${p}`], { cwd: repo })]));
	const manifest = { id: args.id, samplePath: args.sample, sampleSha256: sha256(args.sample),
		matrixSha256: sha256(path.join(here, "matrix.mjs")), runnerSha256: sha256(fileURLToPath(import.meta.url)),
		instances: items.map((x) => x.id), arms: setups, shareSource, headCommit: command("git", ["rev-parse", "HEAD"], { cwd: repo }), piCli: args.pi, piVersion, model: `${MODEL.provider}/${MODEL.id}`,
		thinking: MODEL.thinking, parentTools: PARENT_TOOLS, timeoutMs: args.timeoutMs, repoRoot: repo,
		path: "<bin>:/usr/local/bin:/usr/bin:/bin", concurrency: "arms of one question in parallel", createdAt: new Date().toISOString() };
	if (args.dryRun) { console.log(JSON.stringify(manifest, null, 2)); return; }
	const apiKey = resolveApiKey();
	fs.mkdirSync(runDir, { recursive: true });
	const manifestFile = path.join(runDir, "manifest.json");
	if (fs.existsSync(manifestFile)) {
		const prior = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
		for (const field of ["sampleSha256", "matrixSha256", "runnerSha256", "piVersion", "model", "thinking", "timeoutMs", "instances", "arms", "shareSource", "parentTools"]) {
			if (JSON.stringify(prior[field]) !== JSON.stringify(manifest[field])) throw new Error(`run manifest changed: ${field}`);
		}
	} else fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
	for (const item of items) {
		if (process.exitCode) return;
		await Promise.all(ARMS.map((arm) => runArm(item, arm, setups[arm], apiKey)));
	}
	fs.rmSync(workRoot, { recursive: true, force: true });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
