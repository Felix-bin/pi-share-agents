/**
 * External-framework arms (CREWAI, AUTOGEN) for synapse-bench (spec
 * 2026-09-25-synapse-external-framework-arms §5).
 *
 * The runner schedules these arms beside the pi arms, in the same batch; this
 * module runs one attempt:
 *
 *   1. start the recording proxy (llm-proxy.mjs) in front of the external
 *      arms' own provider (EXTERNAL_PROVIDER: DeepSeek's official API, not
 *      pi's provider config), with the parameters pi would send per role there;
 *   2. start the tool server (tool-server.mjs): pi's own tools, cwd = the arm's
 *      worktree copy, PATH with the same prepend the pi arms get;
 *   3. write round-spec.json and run the framework's harness in the frameworks
 *      venv, each role pointed at <proxy>/<role>/v1 with a dummy key;
 *   4. read back answer.md, handoffs.jsonl and the call log, and sum the usage
 *      the provider reported, per role.
 *
 * Nothing about orchestration or hand-over is decided here: the harness runs
 * the framework's default, and handoffs.jsonl only records what it did.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { piParamProfile, startLlmProxy } from "./llm-proxy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const EXTERNAL_DIR = path.join(HERE, "external");
export const FRAMEWORKS_PYTHON = path.join(REPO, "experiments", "data", "frameworks-venv", "bin", "python");
export const EXTERNAL_ARMS = {
	CREWAI: { framework: "crewai", harness: "run_crewai.py", orchestration: "Process.sequential, one Task per role, no context= (CrewAI default context passing)", params: { max_iter: "default (25)", memory: false, planning: false } },
	AUTOGEN: { framework: "autogen-agentchat", harness: "run_autogen.py", orchestration: "RoundRobinGroupChat, default broadcast, MaxMessageTermination(5)", params: { max_tool_iterations: 25, reflect_on_tool_use: true } },
};
// The external arms are not pi, so they do not take pi's provider: they call
// DeepSeek's official OpenAI-compatible API directly. The key comes from the
// environment or the git-ignored experiments/data/external.env, never the repo.
export const EXTERNAL_PROVIDER = {
	name: "deepseek",
	baseUrl: "https://api.deepseek.com",
	model: "deepseek-flash",
	modelName: "DeepSeek-V4.1-Flash",
	keyEnv: "EXTERNAL_LLM_API_KEY",
	keyFile: path.join(REPO, "experiments", "data", "external.env"),
};
const PIPELINE_ROLES = ["planner", "retriever", "executor", "summarizer"];
const PI_ONLY_TOOLS = new Set(["contact_supervisor"]);
const MEMORY_SECTION = "Shared memory, when it is enabled";

const sha256File = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf-8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)) : []);

/**
 * One role for a framework: agents/<role>.md with the two pi-only parts cut
 * mechanically — the shared-memory section (its line up to the next blank line)
 * and every list item naming contact_supervisor — and pi-only tools dropped.
 */
export function externalRole(markdown) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
	if (match === null) throw new Error("role file has no frontmatter");
	const front = Object.fromEntries(match[1].split("\n").map((line) => /^([A-Za-z]+):\s*(.*)$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
	const kept = [];
	let skipping = false;
	for (const line of match[2].split("\n")) {
		if (line.startsWith(MEMORY_SECTION)) skipping = true;
		if (skipping) {
			if (line.trim() === "") skipping = false;
			continue;
		}
		if (/^\s*-\s/.test(line) && line.includes("contact_supervisor")) continue;
		kept.push(line);
	}
	return {
		name: front.name,
		description: front.description,
		thinking: front.thinking,
		tools: front.tools.split(",").map((tool) => tool.trim()).filter((tool) => tool && !PI_ONLY_TOOLS.has(tool)),
		prompt: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
	};
}

export function externalRoles() {
	return PIPELINE_ROLES.map((role) => externalRole(fs.readFileSync(path.join(REPO, "agents", `${role}.md`), "utf-8")));
}

/** The pi-coding-agent package directory above a pi CLI entry. */
export function piPackageDirOf(cli) {
	let dir = path.dirname(cli);
	for (let depth = 0; depth < 6; depth += 1) {
		const manifest = path.join(dir, "package.json");
		if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf-8")).name === "@earendil-works/pi-coding-agent") return dir;
		dir = path.dirname(dir);
	}
	throw new Error(`no @earendil-works/pi-coding-agent package above ${cli}`);
}

/** The external arms' key: the environment first, else the git-ignored key file; null when neither has it. */
export function resolveExternalKey(provider = EXTERNAL_PROVIDER) {
	if (process.env[provider.keyEnv]) return { key: process.env[provider.keyEnv], source: `env ${provider.keyEnv}` };
	if (fs.existsSync(provider.keyFile)) {
		const line = fs.readFileSync(provider.keyFile, "utf-8").split("\n").find((entry) => entry.startsWith(`${provider.keyEnv}=`));
		const key = line?.slice(provider.keyEnv.length + 1).trim();
		if (key) return { key, source: path.relative(REPO, provider.keyFile) };
	}
	return null;
}

/** What the manifest records about an external arm; --resume refuses when any of it changed. */
export function externalArmConfig(arm) {
	const spec = EXTERNAL_ARMS[arm];
	const lock = path.join(EXTERNAL_DIR, "requirements.lock");
	const versions = Object.fromEntries(fs.readFileSync(lock, "utf-8").split("\n").map((line) => /^(crewai|autogen-agentchat|autogen-core|autogen-ext|openai)==(.+)$/.exec(line.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
	const files = [`external/${spec.harness}`, "external/common.py", "external/requirements.lock", "tool-server.mjs", "llm-proxy.mjs", "external-arm.mjs"];
	return {
		external: {
			provider: { name: EXTERNAL_PROVIDER.name, baseUrl: EXTERNAL_PROVIDER.baseUrl, model: EXTERNAL_PROVIDER.model, modelName: EXTERNAL_PROVIDER.modelName, keyEnv: EXTERNAL_PROVIDER.keyEnv },
			framework: spec.framework,
			orchestration: spec.orchestration,
			params: spec.params,
			versions,
			sha256: Object.fromEntries(files.map((rel) => [rel, sha256File(path.join(HERE, rel))])),
			roles: externalRoles().map(({ name, description, thinking, tools, prompt }) => ({ name, description, thinking, tools, promptSha256: createHash("sha256").update(prompt).digest("hex") })),
		},
	};
}

function spawnGroup(command, args, options, liveChildren) {
	const child = spawn(command, args, { ...options, detached: true });
	liveChildren.add(child.pid);
	child.on("exit", () => liveChildren.delete(child.pid));
	return child;
}

function killGroup(child, signal = "SIGTERM") {
	try {
		process.kill(-child.pid, signal);
	} catch {
		// already gone
	}
}

function waitExit(child, timeoutMs) {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve({ code: child.exitCode, signal: child.signalCode, timedOut: false });
			return;
		}
		const timer = timeoutMs === null ? null : setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), timeoutMs);
		child.once("exit", (code, signal) => {
			if (timer !== null) clearTimeout(timer);
			resolve({ code, signal, timedOut: false });
		});
		child.once("error", (error) => {
			if (timer !== null) clearTimeout(timer);
			resolve({ code: null, signal: null, timedOut: false, error: String(error?.message ?? error) });
		});
	});
}

async function startToolServer({ piPackageDir, workDir, env, sessionId, logFile, liveChildren }) {
	const out = fs.openSync(logFile, "a");
	const child = spawnGroup(process.execPath, [path.join(HERE, "tool-server.mjs"), "--pi", piPackageDir, "--cwd", workDir, "--session", sessionId], { cwd: workDir, env, stdio: ["ignore", "pipe", out] }, liveChildren);
	const port = await new Promise((resolve, reject) => {
		let text = "";
		const timer = setTimeout(() => reject(new Error("tool server did not report a port within 30 s")), 30_000);
		child.stdout.on("data", (chunk) => {
			text += chunk;
			const at = text.indexOf("\n");
			if (at !== -1) {
				clearTimeout(timer);
				resolve(JSON.parse(text.slice(0, at)).port);
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`tool server exited (${code}) before listening`));
		});
	});
	return { child, url: `http://127.0.0.1:${port}` };
}

/** Per-role and total usage from the call log; null totals when any successful call's usage was not reported. */
export function summarizeCalls(calls) {
	const perRole = {};
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let unavailable = 0;
	for (const call of calls) {
		if (call.path !== "/chat/completions") continue;
		const slot = (perRole[call.role] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, errors: 0 });
		slot.calls += 1;
		if (call.error) {
			slot.errors += 1;
			continue;
		}
		if (call.usage === "unavailable" || call.usage === undefined) {
			unavailable += 1;
			continue;
		}
		for (const key of Object.keys(total)) {
			slot[key] += call.usage[key];
			total[key] += call.usage[key];
		}
	}
	return { perRole, total: unavailable > 0 ? null : total, unavailableCalls: unavailable };
}

/**
 * Runs one attempt of an external arm. Returns what the runner records; throws
 * only on a harness setup error it cannot turn into a problem. `endpoint`
 * overrides EXTERNAL_PROVIDER (tests point it at a local stub).
 */
export async function runExternalAttempt({ arm, task, workDir, agentDir, evidenceDir, piPackageDir, pathPrepend, timeoutMs, liveChildren, exhaustedPattern, sessionId, endpoint = null }) {
	const spec = EXTERNAL_ARMS[arm];
	const roles = externalRoles();
	const efforts = Object.fromEntries(roles.map((role) => [role.name, role.thinking]));
	const target = endpoint ?? (() => {
		const resolved = resolveExternalKey();
		if (resolved === null) throw new Error(`no key for the external arms: set ${EXTERNAL_PROVIDER.keyEnv} or write it to ${EXTERNAL_PROVIDER.keyFile}`);
		return { provider: EXTERNAL_PROVIDER.name, baseUrl: EXTERNAL_PROVIDER.baseUrl, model: EXTERNAL_PROVIDER.model, apiKey: resolved.key };
	})();
	const { provider, model } = target;
	const profile = piParamProfile({ provider, baseUrl: target.baseUrl, efforts });
	const callLog = path.join(evidenceDir, "llm-calls.jsonl");
	const harnessLog = path.join(evidenceDir, "harness.log");
	const result = { provider, model, wallMs: null, answer: null, exit: null, timedOut: false, problems: [], exhausted: [], perRole: {}, usage: null, unavailableCalls: 0, handoffs: [], harnessMeta: null, profile: { format: profile.format, reasoningContent: profile.reasoningContent } };
	if (!fs.existsSync(FRAMEWORKS_PYTHON)) {
		result.problems.push(`frameworks venv missing (${FRAMEWORKS_PYTHON}); run experiments/bench/prepare-public-data.sh`);
		return result;
	}
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		NO_PROXY: "127.0.0.1,localhost",
		no_proxy: "127.0.0.1,localhost",
		PYTHONUNBUFFERED: "1",
		...(pathPrepend === null ? {} : { PATH: `${pathPrepend}${path.delimiter}${process.env.PATH ?? ""}` }),
	};
	const proxy = await startLlmProxy({ upstreamBaseUrl: target.baseUrl, apiKey: target.apiKey, roles: roles.map((role) => role.name), logFile: callLog, paramsFor: profile.paramsFor, reasoningContent: profile.reasoningContent });
	let tools = null;
	let harness = null;
	const startedAt = Date.now();
	try {
		tools = await startToolServer({ piPackageDir, workDir, env, sessionId, logFile: harnessLog, liveChildren });
		const roundSpec = {
			arm,
			framework: spec.framework,
			model,
			task,
			roles: roles.map(({ name, description, tools: toolNames, prompt }) => ({ name, description, tools: toolNames, prompt })),
			endpoints: Object.fromEntries(roles.map((role) => [role.name, proxy.baseUrlFor(role.name)])),
			toolServer: tools.url,
			outDir: evidenceDir,
		};
		const specFile = path.join(evidenceDir, "round-spec.json");
		fs.writeFileSync(specFile, `${JSON.stringify(roundSpec, null, "\t")}\n`, "utf-8");
		const out = fs.openSync(harnessLog, "a");
		harness = spawnGroup(FRAMEWORKS_PYTHON, [path.join(EXTERNAL_DIR, spec.harness), specFile], { cwd: EXTERNAL_DIR, env, stdio: ["ignore", out, out] }, liveChildren);
		const exit = await waitExit(harness, timeoutMs);
		result.wallMs = Date.now() - startedAt;
		result.exit = exit;
		if (exit.timedOut) {
			result.timedOut = true;
			result.problems.push(`round timed out after ${timeoutMs} ms`);
		} else if (exit.code !== 0) {
			const tail = fs.existsSync(harnessLog) ? fs.readFileSync(harnessLog, "utf-8").trim().split("\n").slice(-8).join(" | ").slice(-1200) : "";
			result.problems.push(`harness exited ${exit.code ?? exit.signal ?? exit.error}: ${tail}`);
		}
	} catch (error) {
		result.problems.push(`external arm setup: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		for (const child of [harness, tools?.child]) {
			if (!child) continue;
			killGroup(child);
			const gone = await waitExit(child, 5_000);
			if (gone.timedOut) killGroup(child, "SIGKILL");
		}
		await proxy.close();
	}
	const answerFile = path.join(evidenceDir, "answer.md");
	if (fs.existsSync(answerFile)) {
		const text = fs.readFileSync(answerFile, "utf-8").replace(/\n$/, "");
		result.answer = text.trim().length > 0 ? text : null;
	}
	const metaFile = path.join(evidenceDir, "harness-meta.json");
	if (fs.existsSync(metaFile)) result.harnessMeta = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
	result.handoffs = readJsonl(path.join(evidenceDir, "handoffs.jsonl")).map(({ from, to, kind, bytes }) => ({ from, to, kind, bytes }));
	const calls = readJsonl(callLog);
	const summary = summarizeCalls(calls);
	result.perRole = summary.perRole;
	result.usage = summary.total;
	result.unavailableCalls = summary.unavailableCalls;
	for (const call of calls) if (call.error && exhaustedPattern.test(`${call.error.status} ${call.error.message}`)) result.exhausted.push(`${call.error.status} ${call.error.message}`.slice(0, 200));
	result.exhausted = [...new Set(result.exhausted)];
	return result;
}
