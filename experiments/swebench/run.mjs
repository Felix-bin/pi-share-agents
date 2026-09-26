#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { startLlmProxy } from "../bench/llm-proxy.mjs";
import { ARMS, DELEGATION_TOOLS, loadInstances, sha256, taskPrompt, validPatch } from "./matrix.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultOut = path.join(repo, "experiments/data/swebench");
const defaultPi = path.resolve(repo, "../pi-web/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
	setGlobalDispatcher(new EnvHttpProxyAgent());
}
const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = parseArgs(process.argv.slice(2));
const runDir = path.join(args.out, "runs", args.id);
const active = new Set();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
	for (const pid of active) { try { process.kill(-pid, "SIGTERM"); } catch {} }
	process.exitCode = 130;
});

function parseArgs(argv) {
	const out = { dataset: null, out: defaultOut, id: null, ids: [], limit: null, timeoutMs: 45 * 60_000, dryRun: false, pi: fs.existsSync(defaultPi) ? defaultPi : "pi" };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--dry-run") { out.dryRun = true; continue; }
		const value = argv[++i];
		if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
		if (flag === "--dataset") out.dataset = path.resolve(value);
		else if (flag === "--out") out.out = path.resolve(value);
		else if (flag === "--id") out.id = value;
		else if (flag === "--ids") out.ids = value.split(",").filter(Boolean);
		else if (flag === "--limit") out.limit = Number(value);
		else if (flag === "--timeout-ms") out.timeoutMs = Number(value);
		else if (flag === "--pi") out.pi = value;
		else throw new Error(`unknown option ${flag}`);
	}
	if (!out.dataset || !out.id || !/^[\w.-]+$/.test(out.id)) throw new Error("--dataset and safe --id are required");
	if (!Number.isInteger(out.timeoutMs) || out.timeoutMs < 1000) throw new Error("invalid --timeout-ms");
	if (out.limit !== null && (!Number.isInteger(out.limit) || out.limit < 1)) throw new Error("invalid --limit");
	return out;
}

function command(cmd, argv, opts = {}) {
	const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
	if (r.status !== 0) throw new Error(`${cmd} ${argv.slice(0, 3).join(" ")} failed: ${r.stderr || r.error || r.stdout}`);
	return r.stdout.trim();
}

function piCommand(argv) {
	return args.pi.endsWith(".js") ? [process.execPath, [args.pi, ...argv]] : [args.pi, argv];
}

function installed(arm) {
	const dir = path.join(args.out, "agent", arm);
	const meta = JSON.parse(fs.readFileSync(path.join(dir, "installed.json"), "utf8"));
	if (!fs.existsSync(meta.entry)) throw new Error(`${arm} extension missing: ${meta.entry}`);
	if (arm === "share" && meta.commit && meta.commit !== command("git", ["rev-parse", "HEAD"], { cwd: repo })) {
		throw new Error("local share extension commit changed; rerun prepare.mjs before this experiment");
	}
	return { dir, ...meta };
}

function modelCatalog(agentDir, proxy) {
	const file = path.join(agentDir, "models.json");
	const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
	const provider = catalog.providers?.deepseek;
	if (!provider?.models?.some((m) => m.id === "deepseek-flash")) throw new Error("deepseek-flash model missing");
	provider.baseUrl = proxy.baseUrlFor("pi");
	provider.apiKey = "bench-proxy-key";
	fs.writeFileSync(file, JSON.stringify(catalog, null, 2));
	fs.chmodSync(file, 0o600);
}

function configureShare(agentDir, key) {
	const configDir = path.join(agentDir, "extensions", "subagent");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
		asyncByDefault: false,
		synapse: { mode: "synapse", memory: "project", autoDistill: true,
			storageRoot: path.join(runDir, "state", key) },
	}, null, 2));
}

function ensureMirror(slug) {
	const dest = path.join(args.out, "repos", `${slug.replace("/", "__")}.git`);
	if (!fs.existsSync(dest)) {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		command("git", ["clone", "--bare", `https://github.com/${slug}.git`, dest]);
	}
	return dest;
}

function worktree(instance, arm) {
	const mirror = ensureMirror(instance.repo);
	const dest = path.join(runDir, "work", instance.instance_id, arm);
	if (!fs.existsSync(dest)) {
		try { command("git", [`--git-dir=${mirror}`, "cat-file", "-e", `${instance.base_commit}^{commit}`]); }
		catch { command("git", [`--git-dir=${mirror}`, "fetch", "origin", instance.base_commit]); }
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		command("git", [`--git-dir=${mirror}`, "worktree", "add", "--detach", dest, instance.base_commit]);
	}
	if (command("git", ["rev-parse", "HEAD"], { cwd: dest }) !== instance.base_commit) throw new Error("wrong base commit");
	if (command("git", ["status", "--porcelain"], { cwd: dest })) throw new Error(`worktree dirty before run: ${dest}`);
	return dest;
}

function extractPatch(cwd) {
	command("git", ["add", "-N", "--", "."], { cwd });
	const result = spawnSync("git", ["diff", "--binary", "HEAD", "--"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(`git diff failed: ${result.stderr || result.error}`);
	return result.stdout;
}

function analyzeEvents(events, tool) {
	const calls = [], deliveries = [];
	let answer = "";
	for (const event of events) {
		if (event.type === "message_end" && event.message?.role === "assistant") {
			for (const part of event.message.content ?? []) {
				if (part.type === "toolCall" && part.name === tool) calls.push({
					id: part.id, bytes: Buffer.byteLength(JSON.stringify(part.arguments ?? {})), arguments: part.arguments,
				});
			}
			const text = (event.message.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
			if (text) answer = text;
		}
		if (event.type === "tool_execution_end" && event.toolName === tool) deliveries.push({
			id: event.toolCallId, bytes: Buffer.byteLength(JSON.stringify(event.result?.content ?? [])),
			error: event.isError === true || event.result?.isError === true,
		});
	}
	return { calls, deliveries, answer, delegationCount: deliveries.filter((x) => !x.error).length,
		observedHandoffBytes: calls.reduce((n, x) => n + x.bytes, 0) + deliveries.reduce((n, x) => n + x.bytes, 0) };
}

async function piAttempt({ arm, setup, cwd, prompt, evidence, timeoutMs }) {
	const logFile = path.join(evidence, "pi-rpc.jsonl");
	const [piBin, piArgs] = piCommand(["-e", setup.entry, "--no-extensions", "--no-skills", "--no-prompt-templates",
		"--no-themes", "--no-context-files", "--no-session", "--offline", "--mode", "rpc", "--provider", "deepseek",
		"--model", "deepseek-flash", "--thinking", "high"]);
	const child = spawn(piBin, piArgs, {
		// Pi only talks to the local recorder. The recorder alone uses the host's upstream proxy.
		cwd, env: { ...process.env, PI_CODING_AGENT_DIR: setup.dir, NODE_USE_ENV_PROXY: "0",
			HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "" },
		stdio: ["pipe", "pipe", "pipe"], detached: true,
	});
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
				if (event.type !== "message_update") {
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
		const until = Date.now() + timeoutMs;
		while (!settled && !exited && Date.now() < until) await sleep(200);
		if (!settled) throw new Error(exited ? `Pi exited (${exitCode})` : "Pi timed out");
		// The task requires foreground delegation. A short quiet interval lets the last tool event arrive.
		await sleep(500);
		return { ...analyzeEvents(events, DELEGATION_TOOLS[arm]), wallMs: Date.now() - started, problem: null };
	} catch (error) {
		return { ...analyzeEvents(events, DELEGATION_TOOLS[arm]), wallMs: Date.now() - started, problem: String(error) };
	} finally {
		fs.writeFileSync(path.join(evidence, "pi-stderr.log"), stderr);
		if (!exited) { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); } }
	}
}

function summarizeCalls(calls) {
	const usage = Object.fromEntries(usageKeys.map((key) => [key, 0]));
	let missing = 0;
	for (const call of calls) {
		if (call.path !== "/chat/completions") continue;
		if (!call.usage || call.usage === "unavailable") { missing++; continue; }
		for (const key of usageKeys) usage[key] += call.usage[key] ?? 0;
	}
	return { ...usage, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		calls: calls.filter((c) => c.path === "/chat/completions").length, missing };
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
	const all = loadInstances(args.dataset, args.ids);
	const instances = args.limit === null ? all : all.slice(0, args.limit);
	const setups = Object.fromEntries(ARMS.map((arm) => [arm, installed(arm)]));
	const [piBin, piArgs] = piCommand(["--version"]);
	const piVersion = command(piBin, piArgs);
	if (!/^\d+\.\d+\.\d+/.test(piVersion)) throw new Error(`Pi version probe failed: ${JSON.stringify(piVersion)}`);
	const manifest = { id: args.id, datasetPath: args.dataset, datasetSha256: sha256(args.dataset),
		matrixSha256: sha256(path.join(repo, "experiments/swebench/matrix.mjs")),
		runnerSha256: sha256(fileURLToPath(import.meta.url)),
		instances: instances.map((x) => x.instance_id), arms: setups, piVersion,
		model: "deepseek/deepseek-flash", timeoutMs: args.timeoutMs, policy: "one foreground delegation minimum", createdAt: new Date().toISOString() };
	if (args.dryRun) { console.log(JSON.stringify(manifest, null, 2)); return; }
	const apiKey = resolveApiKey();
	fs.mkdirSync(runDir, { recursive: true });
	const manifestFile = path.join(runDir, "manifest.json");
	if (fs.existsSync(manifestFile)) {
		const prior = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
		for (const field of ["datasetSha256", "matrixSha256", "runnerSha256", "piVersion", "model", "timeoutMs", "policy"]) {
			if (JSON.stringify(prior[field]) !== JSON.stringify(manifest[field])) throw new Error(`run manifest changed: ${field}`);
		}
		if (JSON.stringify(prior.instances) !== JSON.stringify(manifest.instances) || JSON.stringify(prior.arms) !== JSON.stringify(manifest.arms)) throw new Error("run matrix changed");
	} else fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
	for (const instance of instances) for (const arm of ARMS) {
		if (process.exitCode) return;
		const key = `${instance.instance_id}/${arm}`;
		const evidence = path.join(runDir, "evidence", instance.instance_id, arm);
		const resultFile = path.join(evidence, "result.json");
		if (fs.existsSync(resultFile)) continue;
		fs.mkdirSync(evidence, { recursive: true });
		console.log(`[swebench] ${key}`);
		let proxy;
		let completedWorktree = null;
		try {
			const cwd = worktree(instance, arm);
			proxy = await startLlmProxy({ upstreamBaseUrl: "https://api.deepseek.com", apiKey, roles: ["pi"],
				logFile: path.join(evidence, "llm-calls.jsonl") });
			modelCatalog(setups[arm].dir, proxy);
			if (arm === "share") configureShare(setups[arm].dir, `${instance.instance_id}/${arm}`);
			const prompt = taskPrompt(instance);
			fs.writeFileSync(path.join(evidence, "prompt.md"), prompt);
			const attempt = await piAttempt({ arm, setup: setups[arm], cwd, prompt, evidence, timeoutMs: args.timeoutMs });
			const patch = extractPatch(cwd);
			fs.writeFileSync(path.join(evidence, "patch.diff"), patch);
			fs.writeFileSync(path.join(evidence, "answer.md"), attempt.answer);
			const usage = summarizeCalls(proxy.calls());
			const problem = attempt.problem ?? (attempt.delegationCount < 1 ? "no completed delegation"
				: !validPatch(patch) ? "empty or invalid patch" : usage.calls === 0 || usage.missing > 0 ? "missing provider usage" : null);
			const result = { instance_id: instance.instance_id, arm, valid: problem === null,
				problem,
				delegationCount: attempt.delegationCount, observedHandoffBytes: attempt.observedHandoffBytes,
				handoffCoverage: "parent RPC tool calls and results only", wallMs: attempt.wallMs,
				usage, patchSha256: sha256(path.join(evidence, "patch.diff")),
			};
			fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
			completedWorktree = cwd;
			console.log(`[swebench] ${key}: ${result.valid ? "valid" : result.problem}`);
		} catch (error) {
			fs.writeFileSync(resultFile, JSON.stringify({ instance_id: instance.instance_id, arm, valid: false,
				problem: String(error), usage: proxy ? summarizeCalls(proxy.calls()) : null }, null, 2));
			console.error(`[swebench] ${key}: ${error}`);
		} finally {
			if (proxy) await proxy.close();
			if (completedWorktree !== null) {
				const mirror = path.join(args.out, "repos", `${instance.repo.replace("/", "__")}.git`);
				try { command("git", [`--git-dir=${mirror}`, "worktree", "remove", "--force", completedWorktree]); }
				catch (error) { console.error(`[swebench] worktree cleanup failed: ${error}`); }
			}
		}
	}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
