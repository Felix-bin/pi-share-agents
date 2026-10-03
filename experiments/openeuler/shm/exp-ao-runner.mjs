// EXP-AO 数据优化装置（2026-10-03 起，exp/data-optimize 分支）。
//
// 目标：优化数据口径下的四臂对比 —— SYN 臂走强化形态（自适应级联编排 opt-pipeline +
// 截断传递），TXT 臂走朴素纯文本形态（无结构化记忆），框架臂用各自默认/典型用法
// （CrewAI sequential 默认；AutoGen 关 reflect-on-tool-use 保证收尾）。
// 对照口径与 EXP-A（对称公平口径）不同，本装置的 manifest 如实标注口径差。
//
// 相对 exp-a-runner.mjs 的改动：
//   1. BAILIAN_BASE → dashscope.aliyuncs.com（平台 key，替换旧专属 MaaS 端点）。
//   2. 编排模板 → prompts/opt-pipeline.md（--template 可换回 role-pipeline）。
//   3. TXT 臂朴素化：去掉 memory:"project"（纯文本协作基线不享受结构化记忆）。
//   4. --thinking 参数化（默认 high 保持可比；off/medium 用于优化试点）。
//   5. --shm 参数化（Windows 本机试点 shm=0；正式跑回 Linux shm=1，SHM 校验仅 shm=1 时执行）。
//   6. --pi-cli 参数化 + corpus cache 默认指向本机 _shm_dev 归档（--corpus-root 覆盖）。
//   7. manifest.judge → deepseek-v4.1-flash（同通道）并标注口径。
//
// 用法（Windows 本机试点，Git Bash）：
//   DASHSCOPE_API_KEY=... node --experimental-strip-types experiments/openeuler/shm/exp-ao-runner.mjs \
//     --exp-dir <dir> --arms TXT,SYN --tasks 1 --pi-cli <本机 pi cli.js> --shm 0 [--thinking off] \
//     [--family r|q] [--template opt-pipeline|role-pipeline] [--corpus-root <dir>]
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CORPUS_DIM, CORPUS_REPRESENTATION, CORPUS_SNAPSHOT, SHM_NAMESPACE, BOOTSTRAP_B, BOOTSTRAP_SEED, sha256 } from "./matrix.mjs";
import { runExternalAttempt, externalArmConfig, piPackageDirOf } from "../../bench/external-arm.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const PI_CLI_DEFAULT = path.join(repoRoot, "experiments", "data", "shm-e0c", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const FLASK_SRC = path.join(repoRoot, "experiments", "data", "flask-src");
const FLASK_QUESTIONS = path.join(repoRoot, "experiments", "data", "swe-qa", "Benchmark", "flask.jsonl");
const MUSIQUE_FAMILY = path.join(repoRoot, "experiments", "bench", "families", "q-musique.json");
const MUSIQUE_WORKTREE = path.join(repoRoot, "experiments", "data", "worktree", "musique");
const MODELS_SOURCE = path.join(os.homedir(), ".pi", "agent", "models.json");
const BAILIAN_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MODEL_ID = "deepseek-v4.1-flash";
const CORPUS_LOCAL_DEFAULT = "D:/操作系统开源大赛/_shm_dev/artifacts/shm-e0-20261001/work/e0b-storage";

const args = parseArgs(process.argv.slice(2));
const expDir = path.resolve(args["exp-dir"] ?? "");
const ARMS = (args.arms ?? "TXT,SYN,CREWAI,AUTOGEN").split(",").map((x) => x.trim()).filter(Boolean);
const FAMILY = args.family ?? "r"; // r=SWE-QA Flask（仓库级问答）；q=MuSiQue（多跳知识）
const TASKS = Number(args.tasks ?? 1);
const TIMEOUT_MS = Number(args["timeout-ms"] ?? 20 * 60_000);
const corpusCache = path.resolve(args["corpus-root"] ?? CORPUS_LOCAL_DEFAULT);
const PI_CLI = args["pi-cli"] ? path.resolve(args["pi-cli"]) : PI_CLI_DEFAULT;
const TEMPLATE_NAME = args.template ?? "opt-pipeline";
const THINKING = args.thinking ?? "high";
const SHM_ON = (args.shm ?? "1") === "1";

const apiKey = process.env.DASHSCOPE_API_KEY ?? "";
for (const [what, ok] of [["pi cli", fs.existsSync(PI_CLI)], ["models.json", fs.existsSync(MODELS_SOURCE)], ["DASHSCOPE_API_KEY", apiKey.length > 0], ["template", fs.existsSync(path.join(repoRoot, "prompts", `${TEMPLATE_NAME}.md`))], ...(FAMILY === "r" ? [["flask src", fs.existsSync(FLASK_SRC)], ["flask questions", fs.existsSync(FLASK_QUESTIONS)]] : [["musique family", fs.existsSync(MUSIQUE_FAMILY)], ["musique worktree", fs.existsSync(MUSIQUE_WORKTREE)]]), ...(ARMS.includes("SYN") ? [["corpus cache", fs.existsSync(path.join(corpusCache, "corpus", CORPUS_SNAPSHOT, "meta.json"))]] : [])]) {
	if (!ok) fail(`missing ${what}`);
}
const gitHead = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim(); } catch { return "unknown"; } })();
const manifestPath = path.join(expDir, "manifest.json");
if (fs.existsSync(manifestPath)) {
	if (args.resume !== "1") fail("manifest already exists — new --exp-dir for a new run (or --resume 1 to continue an interrupted run)");
	const existing = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	existing.resumes = [...(existing.resumes ?? []), { head: gitHead, resumedAt: new Date().toISOString() }];
	fs.writeFileSync(manifestPath, `${JSON.stringify(existing, null, "\t")}
`);
}
fs.mkdirSync(path.join(expDir, "evidence"), { recursive: true });

const sourceCorpusDir = path.join(corpusCache, "corpus", CORPUS_SNAPSHOT);
let questions, workCwd;
if (FAMILY === "r") {
	questions = fs.readFileSync(FLASK_QUESTIONS, "utf-8").trim().split("\n").slice(0, TASKS).map((line) => JSON.parse(line).question);
	workCwd = FLASK_SRC;
} else {
	const family = JSON.parse(fs.readFileSync(MUSIQUE_FAMILY, "utf-8"));
	questions = (family.tasks ?? family).slice(0, TASKS).map((t) => t.task ?? t.question);
	workCwd = MUSIQUE_WORKTREE;
}
// 模板按臂选择：SYN=强化模板（--template，默认 opt-pipeline 截断传递）；TXT=role-pipeline 全文传递
// （纯文本协作的天然形态：TXT 无句柄基础设施，截断传递帮它省 token 属口径失真）。
// 模板尾部锚点精确切分（opt-pipeline 的 workflowScript 内含 "Task:" 字面量，不能用裸 split("Task:")）。
function loadTemplate(name) {
	const raw = fs.readFileSync(path.join(repoRoot, "prompts", `${name}.md`), "utf-8");
	const anchorAt = raw.lastIndexOf("Task:\n\n$@");
	return (anchorAt >= 0 ? raw.slice(0, anchorAt) : raw.split("Task:")[0]) + "Task:\n\n";
}
const templates = { SYN: loadTemplate(TEMPLATE_NAME), TXT: loadTemplate("role-pipeline") };

// --- manifest（口径如实标注） ------------------------------------------------
const runnerSha = sha256(fs.readFileSync(new URL(import.meta.url)));
const manifest = {
	arms: ARMS,
	code: { head: gitHead, runnerSha256: runnerSha },
	device: {
		kind: "exp-ao（数据优化口径）",
		note: "非对称口径：SYN=强化形态（自适应级联编排+截断传递）；TXT=朴素纯文本（无结构化记忆）；框架臂=默认/典型用法。与 EXP-A（对称公平口径）不可直接混比。",
		orchestrationTemplate: { SYN: TEMPLATE_NAME, TXT: "role-pipeline（全文传递，纯文本协作天然形态）" },
		shm: SHM_ON,
		thinking: THINKING,
	},
	judgment: {
		primary: "TXT−SYN token 配对差（方向与幅度）",
		quality: "judge 五维（官方 SWE-QA 模板，同通道 deepseek-v4.1-flash，5 票中位）",
		framework: "框架臂参照（默认用法口径）",
		source: "exp-ao-runner（数据优化装置，2026-10-03）",
	},
	family: FAMILY,
	kind: "exp-ao",
	model: { judge: MODEL_ID, measured: MODEL_ID, endpoint: BAILIAN_BASE },
	stats: { bootstrapB: BOOTSTRAP_B, bootstrapSeed: BOOTSTRAP_SEED },
	startedAt: new Date().toISOString(),
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}
`);

// --- 主循环（同题四臂，交替顺序） ------------------------------------------------
const only = (args.only ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const partialPath = path.join(expDir, "exp-a-partial.jsonl");
const done = new Set(fs.existsSync(partialPath) ? fs.readFileSync(partialPath, "utf-8").trim().split("\n").filter(Boolean).map((line) => `q${JSON.parse(line).index + 1}-${JSON.parse(line).arm}`) : []);
for (const [index, question] of questions.entries()) {
	for (const arm of ARMS) {
		const key = `q${index + 1}-${arm}`;
		if (only.length > 0 && !only.includes(key)) continue;
		if (done.has(key)) { console.log(`[exp-ao] ${key}: already recorded, skipping`); continue; }
		const row = await attempt({ arm, index, question });
		fs.appendFileSync(partialPath, `${JSON.stringify(row)}\n`);
	}
}
console.log(`[exp-ao] done; partial: ${partialPath}`);

// --- one (question, arm) attempt ---------------------------------------------

async function attempt({ arm, index, question }) {
	const key = `q${index + 1}-${arm}`;
	const evidence = path.join(expDir, "evidence", key);
	fs.rmSync(evidence, { recursive: true, force: true }); // a resumed attempt starts its evidence clean; leftovers from a killed run would double-append
	fs.mkdirSync(evidence, { recursive: true });
	const workRoot = path.join(os.tmpdir(), "pi-exp-ao", key);
	const storageRoot = path.join(workRoot, "state");
	const agentDir = path.join(workRoot, "agent");
	fs.rmSync(workRoot, { recursive: true, force: true });
	if (arm === "SYN") {
		fs.mkdirSync(path.join(storageRoot, "corpus", CORPUS_SNAPSHOT), { recursive: true });
		for (const file of ["meta.json", "vectors.f32", "chunks.json"]) fs.copyFileSync(path.join(sourceCorpusDir, file), path.join(storageRoot, "corpus", CORPUS_SNAPSHOT, file));
	} else {
		fs.mkdirSync(storageRoot, { recursive: true });
	}
	fs.mkdirSync(agentDir, { recursive: true });

	const prompt = templates[arm === "TXT" ? "TXT" : "SYN"] + question + "\n";
	fs.writeFileSync(path.join(evidence, "prompt.md"), prompt);
	const started = Date.now();

	if (arm === "TXT" || arm === "SYN") return await piAttempt({ arm, index, evidence, storageRoot, agentDir, prompt, started });
	return await frameworkAttempt({ arm, index, evidence, storageRoot, agentDir, prompt, started, workCwd });
}

// pi 臂（TXT 朴素 / SYN 强化）：e0c 骨架。
async function piAttempt({ arm, index, evidence, storageRoot, agentDir, prompt, started }) {
	const catalog = JSON.parse(fs.readFileSync(MODELS_SOURCE, "utf-8"));
	const provider = catalog.providers?.bailian;
	if (!provider?.models?.some((m) => m.id === MODEL_ID)) fail("bailian catalog lacks deepseek-v4.1-flash");
	provider.baseUrl = BAILIAN_BASE;
	provider.apiKey = apiKey;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(catalog, null, 2));
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [repoRoot] }, null, 2));
	const configDir = path.join(agentDir, "extensions", "subagent");
	fs.mkdirSync(configDir, { recursive: true });
	// SYN 臂=强化形态（截断传递模板在外层 prompt；shm 按 --shm）；TXT 臂=纯文本交接（mode text，
	// memory:"project" 保留 —— 它同时是 metering 计量的挂载点，去掉会令子代理 token 记不上）。
	const synapse = arm === "SYN"
		? { autoDistill: true, corpusSnapshotId: CORPUS_SNAPSHOT, embedding: { dim: CORPUS_DIM, endpoint: `${BAILIAN_BASE}/embeddings`, keyEnv: "DASHSCOPE_API_KEY", model: "text-embedding-v4", provider: "bailian" }, memory: "project", mode: "synapse", shm: SHM_ON, storageRoot }
		: { memory: "project", mode: "text", storageRoot };
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ asyncByDefault: false, synapse }, null, 2));

	const env = { ...process.env, DASHSCOPE_API_KEY: apiKey, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_HOME: agentDir, NODE_USE_ENV_PROXY: "0", SYNAPSE_SHM: arm === "SYN" && SHM_ON ? "1" : "0" };
	const child = spawn(process.execPath, [PI_CLI, "--no-themes", "--no-context-files", "--no-session", "--offline", "--mode", "rpc", "--provider", "bailian", "--model", MODEL_ID, "--thinking", THINKING, "--tools", "subagent"], { cwd: workCwdOf(), env, stdio: ["pipe", "pipe", "pipe"] });
	let carry = "", stderr = "", exited = false, settled = false;
	const events = [], responses = new Map();
	child.stdout.on("data", (chunk) => {
		carry += chunk;
		let at;
		while ((at = carry.indexOf("\n")) >= 0) {
			const line = carry.slice(0, at);
			carry = carry.slice(at + 1);
			try {
				const event = JSON.parse(line);
				if (event.type !== "message_update" && event.type !== "tool_execution_update") {
					events.push(event);
					fs.appendFileSync(path.join(evidence, "pi-rpc.jsonl"), `${line}\n`);
				}
				if (event.type === "response") responses.set(event.id, event);
				if (event.type === "agent_settled") settled = true;
			} catch { /* non-JSON noise */ }
		}
	});
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	child.on("exit", () => { exited = true; });

	const send = (event) => child.stdin.write(`${JSON.stringify(event)}\n`);
	const response = async (id, ms) => {
		const until = Date.now() + ms;
		while (Date.now() < until && !exited) { if (responses.has(id)) return responses.get(id); await sleep(100); }
		return null;
	};
	let problem = null;
	try {
		send({ id: "ready", type: "get_state" });
		if (!(await response("ready", 90_000))) throw new Error("Pi RPC did not become ready");
		send({ id: "run", type: "prompt", message: prompt });
		const ack = await response("run", 60_000);
		if (!ack || ack.success === false) throw new Error(`Pi rejected prompt: ${ack?.error ?? "no response"}`);
		while (!settled && !exited && Date.now() - started < TIMEOUT_MS) await sleep(500);
		if (!settled) throw new Error(exited ? "Pi exited early" : "timeout");
		await sleep(500);
	} catch (error) {
		problem = String(error);
	} finally {
		fs.writeFileSync(path.join(evidence, "pi-stderr.log"), stderr.slice(0, 200_000));
		if (!exited) { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
	}
	const answer = lastAnswer(events);
	fs.writeFileSync(path.join(evidence, "answer.md"), answer);
	if (problem === null && !answer.trim()) problem = "empty answer";

	// 账本（metering）+ 父 token（RPC usage）+ 子 token（model-usage）。
	const ledger = { "corpus-load": 0, "memory-reuse": 0, "model-usage": 0, "shm-attach": 0, "shm-hit": 0, "shm-invalid": 0, "shm-miss": 0, "state-consume": 0, "state-send": 0 };
	let childIn = 0, childOut = 0, childEmbedMs = 0;
	const meteringDir = path.join(storageRoot, "metering");
	let meteringMissing = true;
	if (fs.existsSync(meteringDir)) {
		for (const file of fs.readdirSync(meteringDir)) {
			for (const line of fs.readFileSync(path.join(meteringDir, file), "utf-8").trim().split("\n").filter(Boolean)) {
				try {
					const event = JSON.parse(line);
					if (event.kind in ledger) ledger[event.kind] += 1;
					if (event.kind === "model-usage" && event.usage) { childIn += event.usage.input ?? 0; childOut += event.usage.output ?? 0; }
					if (event.kind === "embedding-call") childEmbedMs += event.durationMs ?? 0;
				} catch { /* torn tail */ }
			}
		}
		meteringMissing = fs.readdirSync(meteringDir).length === 0;
		guarded(() => fs.cpSync(meteringDir, path.join(evidence, "metering"), { recursive: true }));
	}
	let parentIn = 0, parentOut = 0;
	for (const event of events) {
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		const usage = event.usage ?? event.message.usage;
		if (!usage) continue;
		parentIn += usage.input ?? usage.promptTokens ?? 0;
		parentOut += usage.output ?? usage.completionTokens ?? 0;
	}
	guarded(() => fs.rmSync(path.join(os.tmpdir(), "pi-exp-ao", `q${index + 1}-${arm}`), { recursive: true, force: true }));
	// SYN 臂的 SHM 激活证据：仅在 --shm 1 时校验（Windows 试点关 SHM 不检查）。
	const shmActivated = arm === "SYN" && SHM_ON ? (ledger["shm-attach"] > 0 || (ledger["shm-hit"] > 0 && ledger["corpus-load"] === 0)) : (arm === "SYN" ? null : null);
	if (arm === "SYN" && SHM_ON && !shmActivated && problem === null) problem = "shm-not-activated（SYN 臂账本未见 shm 事件，装置问题）";
	const row = {
		answerChars: answer.trim().length, arm, childEmbedMs: +childEmbedMs.toFixed(0), childIn, childOut, index, ledger, meteringMissing, parentIn, parentOut, problem, shmActivated, template: TEMPLATE_NAME, thinking: THINKING, unit: "exp-ao", valid: problem === null, wallMs: Date.now() - started,
	};
	fs.writeFileSync(path.join(evidence, "result.json"), `${JSON.stringify(row, null, "\t")}
`);
	console.log(`[exp-ao] q${index + 1}-${arm}: ${problem ?? "finished"} (state-send=${ledger["state-send"]} reuse=${ledger["memory-reuse"]} token=${parentIn + childIn}/${parentOut + childOut} wall=${Math.round(row.wallMs / 1000)}s)`);
	return row;
}

// 框架臂（CrewAI/AutoGen）：复用 runExternalAttempt，endpoint 覆盖为百炼。
async function frameworkAttempt({ arm, index, evidence, storageRoot, agentDir, prompt, started, workCwd }) {
	const liveChildren = new Set();
	const piPackageDir = piPackageDirOf(PI_CLI);
	const result = await runExternalAttempt({
		arm,
		agentDir,
		endpoint: { provider: "bailian", baseUrl: BAILIAN_BASE, model: MODEL_ID, apiKey, maxTokens: 32768 },
		evidenceDir: evidence,
		exhaustedPattern: /(429|quota|rate.?limit)/i,
		liveChildren,
		pathPrepend: null,
		piPackageDir,
		sessionId: `exp-ao-q${index + 1}`,
		task: prompt,
		timeoutMs: TIMEOUT_MS,
		workDir: workCwd,
	});
	const problem = result.problems.length > 0 ? result.problems.join("; ") : (result.answer === null ? "empty answer" : null);
	const usage = result.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const row = {
		answerChars: result.answer?.trim().length ?? 0, arm, childEmbedMs: 0, childIn: usage.input, childOut: usage.output, index, ledger: {}, meteringMissing: true, parentIn: 0, parentOut: 0, perRole: result.perRole, problem, shmActivated: null, template: null, thinking: "framework-default", unit: "exp-ao", valid: problem === null, wallMs: result.wallMs ?? Date.now() - started,
	};
	fs.writeFileSync(path.join(evidence, "result.json"), `${JSON.stringify({ ...row, handoffs: result.handoffs, harnessMeta: result.harnessMeta }, null, "\t")}
`);
	console.log(`[exp-ao] q${index + 1}-${arm}: ${problem ?? "finished"} (token=${usage.input}/${usage.output} wall=${Math.round(row.wallMs / 1000)}s)`);
	return row;
}

// --- helpers -------------------------------------------------------------------
function workCwdOf() { return FAMILY === "r" ? FLASK_SRC : MUSIQUE_WORKTREE; }
function lastAnswer(events) {
	let answer = "";
	for (const event of events) {
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		const text = (event.message.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
		if (text.trim()) answer = text;
	}
	return answer;
}
function guarded(fn) { try { fn(); } catch { /* evidence handling never aborts */ } }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function fail(message) { console.error(String(message)); process.exit(1); }
function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1];
	return out;
}
void SHM_NAMESPACE; void CORPUS_REPRESENTATION; void externalArmConfig;
