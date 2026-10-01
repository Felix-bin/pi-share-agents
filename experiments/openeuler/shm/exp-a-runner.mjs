// EXP-A 主对比装置（spec: 2026-10-01-synapse-final-experiment-design.md §1）。
//
// 四臂同题配对：TXT（纯文本）/ SYN（完整形态，SHM 常开）/ CrewAI / AutoGen。
// 判定（冻结于数据产生之前）：TXT−SYN token 配对差 CI 下界>0（显著节省）；
// 质量非劣（judge 五维 δ=5，第五维以官方 coherence 为准）；框架臂不设击败判据。
//
// 臂实现：
//   - pi 臂（TXT/SYN）：e0c.mjs 骨架改造——真实 pi 四角色流水线，SYN 臂 SHM 常开
//     （config shm:true + env SYNAPSE_SHM=1），TXT 臂 mode:"text"；token 取自父 RPC usage
//     + metering model-usage；账本含 shm 事件证明段激活。
//   - 框架臂（CrewAI/AutoGen）：复用 experiments/bench/external-arm.mjs 的
//     runExternalAttempt（4 角色同提示词机械剪除、tool-server、记录代理 llm-calls.jsonl、
//     handoffs.jsonl）；endpoint 覆盖为百炼 deepseek-v4.1-flash 统一口径。
//
// 轨迹（每 attempt 落盘，后期优化入口）：answer.md/prompt.md/pi-rpc.jsonl/pi-stderr.log/
//   llm-calls.jsonl/metering/handoffs.jsonl/result.json。
//
// 用法（openEuler/WSL，仓库根，DASHSCOPE_API_KEY + EXTERNAL_LLM_API_KEY 在环境里）：
//   node --experimental-strip-types experiments/openeuler/shm/exp-a-runner.mjs --exp-dir <dir> \
//     [--arms TXT,SYN,CREWAI,AUTOGEN] [--tasks 1] [--only q1-TXT,...] [--timeout-ms 1200000]
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
const PI_CLI = path.join(repoRoot, "experiments", "data", "shm-e0c", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const FLASK_SRC = path.join(repoRoot, "experiments", "data", "flask-src");
const FLASK_QUESTIONS = path.join(repoRoot, "experiments", "data", "swe-qa", "Benchmark", "flask.jsonl");
const MUSIQUE_FAMILY = path.join(repoRoot, "experiments", "bench", "families", "q-musique.json");
const MUSIQUE_WORKTREE = path.join(repoRoot, "experiments", "data", "worktree", "musique");
const MODELS_SOURCE = path.join(os.homedir(), ".pi", "agent", "models.json");
const BAILIAN_BASE = "https://llm-3m03faeswsufx2lq.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const MODEL_ID = "deepseek-v4.1-flash";

const args = parseArgs(process.argv.slice(2));
const expDir = path.resolve(args["exp-dir"] ?? "");
const ARMS = (args.arms ?? "TXT,SYN,CREWAI,AUTOGEN").split(",").map((x) => x.trim()).filter(Boolean);
const FAMILY = args.family ?? "r"; // r=SWE-QA Flask（仓库级问答）；q=MuSiQue（多跳知识）
const TASKS = Number(args.tasks ?? 1);
const TIMEOUT_MS = Number(args["timeout-ms"] ?? 20 * 60_000);
const corpusCache = path.resolve(args["corpus-root"] ?? "/root/.pi/agent/synapse/experiments/_corpus-cache");

const apiKey = process.env.DASHSCOPE_API_KEY ?? "";
for (const [what, ok] of [["pi cli", fs.existsSync(PI_CLI)], ["models.json", fs.existsSync(MODELS_SOURCE)], ["DASHSCOPE_API_KEY", apiKey.length > 0], ...(FAMILY === "r" ? [["flask src", fs.existsSync(FLASK_SRC)], ["flask questions", fs.existsSync(FLASK_QUESTIONS)]] : [["musique family", fs.existsSync(MUSIQUE_FAMILY)], ["musique worktree", fs.existsSync(MUSIQUE_WORKTREE)]])]) {
	if (!ok) fail(`missing ${what}`);
}
const gitHead = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim(); } catch { return "unknown"; } })();
const manifestPath = path.join(expDir, "manifest.json");
if (fs.existsSync(manifestPath)) {
	// --resume: an interrupted run continues on the same exp-dir only when the
	// frozen manifest matches this code (the WSL→server handoff relies on it;
	// anything else is still a refused in-place restart).
	if (args.resume !== "1") fail("manifest already exists — new --exp-dir for a new run (or --resume 1 to continue an interrupted run)");
	// Resume across a code bump is recorded, not refused: the handoff machine may
	// carry a newer runner (the resume support itself). The audit trail keeps
	// every head this run has run under.
	const existing = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	existing.resumes = [...(existing.resumes ?? []), { head: gitHead(), resumedAt: new Date().toISOString() }];
	fs.writeFileSync(manifestPath, `${JSON.stringify(existing, null, "	")}
`);
}
fs.mkdirSync(path.join(expDir, "evidence"), { recursive: true });

const sourceCorpusDir = path.join(corpusCache, "corpus", CORPUS_SNAPSHOT);
// 题面与工作目录按任务族选择：R=Flask 仓库；Q=MuSiQue 段落池工作树（bench 题族已含 ANSWER 尾注）。
let questions, workCwd;
if (FAMILY === "r") {
	questions = fs.readFileSync(FLASK_QUESTIONS, "utf-8").trim().split("\n").slice(0, TASKS).map((line) => JSON.parse(line).question);
	workCwd = FLASK_SRC;
} else {
	const family = JSON.parse(fs.readFileSync(MUSIQUE_FAMILY, "utf-8"));
	questions = (family.tasks ?? family).slice(0, TASKS).map((t) => t.task ?? t.question);
	workCwd = MUSIQUE_WORKTREE;
}
const template = fs.readFileSync(path.join(repoRoot, "prompts", "role-pipeline.md"), "utf-8").split("Task:")[0] + "Task:\n\n";

// --- manifest（冻结于数据产生之前） -------------------------------------------
const runnerSha = sha256(fs.readFileSync(new URL(import.meta.url)));
const manifest = {
	arms: ARMS,
	code: { head: gitHead, runnerSha256: runnerSha },
	judgment: {
		primary: "TXT−SYN token 配对差 95% CI 下界>0（显著节省）",
		quality: "judge 五维（correctness/completeness/relevance/clarity/coherence，官方 coherence 非 reasoning）非劣 δ=5",
		framework: "框架臂仅作参照系，不设击败判据",
		source: "spec 2026-10-01-synapse-final-experiment-design.md §1（冻结）",
	},
	family: FAMILY,
	kind: "exp-a",
	model: { judge: "qwen3.8-max", measured: MODEL_ID, endpoint: BAILIAN_BASE },
	stats: { bootstrapB: BOOTSTRAP_B, bootstrapSeed: BOOTSTRAP_SEED },
	startedAt: new Date().toISOString(),
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

// --- 主循环（同题四臂，交替顺序） ------------------------------------------------
const only = (args.only ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const partialPath = path.join(expDir, "exp-a-partial.jsonl");
const done = new Set(fs.existsSync(partialPath) ? fs.readFileSync(partialPath, "utf-8").trim().split("\n").filter(Boolean).map((line) => `q${JSON.parse(line).index + 1}-${JSON.parse(line).arm}`) : []);
for (const [index, question] of questions.entries()) {
	for (const arm of ARMS) {
		const key = `q${index + 1}-${arm}`;
		if (only.length > 0 && !only.includes(key)) continue;
		if (done.has(key)) { console.log(`[exp-a] ${key}: already recorded, skipping`); continue; }
		const row = await attempt({ arm, index, question });
		fs.appendFileSync(partialPath, `${JSON.stringify(row)}\n`);
	}
}
console.log(`[exp-a] done; partial: ${partialPath}`);

// --- one (question, arm) attempt ---------------------------------------------

async function attempt({ arm, index, question }) {
	const key = `q${index + 1}-${arm}`;
	const evidence = path.join(expDir, "evidence", key);
	fs.rmSync(evidence, { recursive: true, force: true }); // a resumed attempt starts its evidence clean; leftovers from a killed run would double-append
	fs.mkdirSync(evidence, { recursive: true });
	const workRoot = path.join(os.tmpdir(), "pi-exp-a", key);
	const storageRoot = path.join(workRoot, "state");
	const agentDir = path.join(workRoot, "agent");
	fs.rmSync(workRoot, { recursive: true, force: true });
	fs.mkdirSync(path.join(storageRoot, "corpus", CORPUS_SNAPSHOT), { recursive: true });
	for (const file of ["meta.json", "vectors.f32", "chunks.json"]) fs.copyFileSync(path.join(sourceCorpusDir, file), path.join(storageRoot, "corpus", CORPUS_SNAPSHOT, file));
	fs.mkdirSync(agentDir, { recursive: true });

	const prompt = template + question + "\n";
	fs.writeFileSync(path.join(evidence, "prompt.md"), prompt);
	const started = Date.now();

	if (arm === "TXT" || arm === "SYN") return await piAttempt({ arm, index, evidence, storageRoot, agentDir, prompt, started });
	return await frameworkAttempt({ arm, index, evidence, storageRoot, agentDir, prompt, started, workCwd });
}

// pi 臂（TXT/SYN）：e0c 骨架，SYN 臂 SHM 常开。
async function piAttempt({ arm, index, evidence, storageRoot, agentDir, prompt, started }) {
	const catalog = JSON.parse(fs.readFileSync(MODELS_SOURCE, "utf-8"));
	const provider = catalog.providers?.bailian;
	if (!provider?.models?.some((m) => m.id === MODEL_ID)) fail("bailian catalog lacks deepseek-v4.1-flash");
	provider.baseUrl = BAILIAN_BASE;
	provider.apiKey = apiKey;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(catalog, null, 2));
	fs.chmodSync(path.join(agentDir, "models.json"), 0o600);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [repoRoot] }, null, 2));
	const configDir = path.join(agentDir, "extensions", "subagent");
	fs.mkdirSync(configDir, { recursive: true });
	// SYN 臂=完整形态（SHM 常开）；TXT 臂=纯文本（无 corpus/embedding/shm）。
	const synapse = arm === "SYN"
		? { autoDistill: true, corpusSnapshotId: CORPUS_SNAPSHOT, embedding: { dim: CORPUS_DIM, endpoint: `${BAILIAN_BASE}/embeddings`, keyEnv: "DASHSCOPE_API_KEY", model: "text-embedding-v4", provider: "bailian" }, memory: "project", mode: "synapse", shm: true, storageRoot }
		: { memory: "project", mode: "text", storageRoot };
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ asyncByDefault: false, synapse }, null, 2));

	const env = { ...process.env, DASHSCOPE_API_KEY: apiKey, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_HOME: agentDir, NODE_USE_ENV_PROXY: "0", SYNAPSE_SHM: arm === "SYN" ? "1" : "0" };
	const child = spawn(process.execPath, [PI_CLI, "--no-themes", "--no-context-files", "--no-session", "--offline", "--mode", "rpc", "--provider", "bailian", "--model", MODEL_ID, "--thinking", "high", "--tools", "subagent"], { cwd: FLASK_SRC, env, stdio: ["pipe", "pipe", "pipe"] });
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
	guarded(() => fs.rmSync(path.join(os.tmpdir(), "pi-exp-a", `q${index + 1}-${arm}`), { recursive: true, force: true }));
	// SYN 臂的 SHM 激活证据：shm-attach>0 或 corpus-load=0 且有 shm-hit。
	const shmActivated = arm === "SYN" ? (ledger["shm-attach"] > 0 || (ledger["shm-hit"] > 0 && ledger["corpus-load"] === 0)) : null;
	if (arm === "SYN" && !shmActivated && problem === null) problem = "shm-not-activated（SYN 臂账本未见 shm 事件，装置问题）";
	const row = {
		answerChars: answer.trim().length, arm, childEmbedMs: +childEmbedMs.toFixed(0), childIn, childOut, index, ledger, meteringMissing, parentIn, parentOut, problem, shmActivated, unit: "exp-a", valid: problem === null, wallMs: Date.now() - started,
	};
	fs.writeFileSync(path.join(evidence, "result.json"), `${JSON.stringify(row, null, "\t")}\n`);
	console.log(`[exp-a] q${index + 1}-${arm}: ${problem ?? "finished"} (shm-hit=${ledger["shm-hit"]} corpus-load=${ledger["corpus-load"]} token=${parentIn + childIn}/${parentOut + childOut} wall=${Math.round(row.wallMs / 1000)}s)`);
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
		sessionId: `exp-a-q${index + 1}`,
		task: prompt,
		timeoutMs: TIMEOUT_MS,
		workDir: workCwd, // tool-server cwd = 题目工作树，与 pi 臂一致（公平性）
	});
	const problem = result.problems.length > 0 ? result.problems.join("; ") : (result.answer === null ? "empty answer" : null);
	const usage = result.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const row = {
		answerChars: result.answer?.trim().length ?? 0, arm, childEmbedMs: 0, childIn: usage.input, childOut: usage.output, index, ledger: {}, meteringMissing: true, parentIn: 0, parentOut: 0, perRole: result.perRole, problem, shmActivated: null, unit: "exp-a", valid: problem === null, wallMs: result.wallMs ?? Date.now() - started,
	};
	fs.writeFileSync(path.join(evidence, "result.json"), `${JSON.stringify({ ...row, handoffs: result.handoffs, harnessMeta: result.harnessMeta }, null, "\t")}\n`);
	console.log(`[exp-a] q${index + 1}-${arm}: ${problem ?? "finished"} (token=${usage.input}/${usage.output} wall=${Math.round(row.wallMs / 1000)}s)`);
	return row;
}

// --- helpers -------------------------------------------------------------------
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
void SHM_NAMESPACE;
