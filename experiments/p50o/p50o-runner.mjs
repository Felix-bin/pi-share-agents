// p50o 入仓版（experiments/p50o/）：路径相对本仓、pi CLI 与语料经参数/环境变量传入。
// p50o — P50 轻装置的数据优化版（2026-10-03）。
//
// 沿用 2026-09-21 P50 装置的骨架（一轮一进程、SYN/TXT 双臂同题配对、extensions/subagent
// config、自带 models.json），改动集中在：
//   1. 端点 → 百炼平台 dashscope.aliyuncs.com（平台 key），模型 deepseek-v4.1-flash。
//   2. 四子代理流水线：prompt 通道发模板+题面（SYN=opt-pipeline 截断传递 / TXT=role-pipeline
//      全文传递——纯文本协作的天然形态），一次 subagent 调用内 workflowScript 跑满四角色。
//   3. 计量零账本依赖：subagent tool_execution_end 的 result.usage 即四子代理合计，
//      result.details.workflow.value 即最终答案，runFanoutBudget.used 即角色数。
//   4. 数据集：公开权威基准（R=SWE-QA Flask 前 N 题 / Q=MuSiQue 前 N 题），题面原样。
// 模板与数据文件按绝对路径引用 openeuler-wsl 协作克隆（同 SHA 可溯源），语料快照引用
// _shm_dev 归档（text-embedding-v4/1024，63a385a…）。
//
// 用法：node scripts/p50o-runner.mjs --exp-dir <dir> [--arms TXT,SYN] [--tasks 1]
//         [--family r|q] [--template-syn opt-pipeline] [--timeout-ms 900000]
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const args = parseArgs(process.argv.slice(2));

const WSL_REPO = path.resolve(here, "..", ".."); // 本仓（装置随决赛仓提交）
const CLI = args["pi-cli"] ?? process.env.PI_CLI ?? ""; // pi CLI 路径：--pi-cli 或 PI_CLI 环境变量（装置不绑定宿主路径）
const FLASK_SRC = `${WSL_REPO}/experiments/data/flask-src`;
const FLASK_QUESTIONS = `${WSL_REPO}/experiments/data/swe-qa/Benchmark/flask.jsonl`;
const MUSIQUE_FAMILY = `${WSL_REPO}/experiments/bench/families/q-musique.json`;
const MUSIQUE_WORKTREE = `${WSL_REPO}/experiments/data/worktree/musique`;
const CORPUS_SRC_ROOT = args["corpus-root"] ?? path.join(repoRoot, "experiments", "data", "_corpus-cache"); // 语料快照根：--corpus-root 覆盖
const CORPUS_ID = "63a385a420d3bdd080b21981640d964d46b9f1637050a4276ee0510ec8fd56dc";
const BAILIAN_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MODEL = { id: "deepseek-v4.1-flash" };
const EMBEDDING = { provider: "bailian", endpoint: `${BAILIAN_BASE}/embeddings`, model: "text-embedding-v4", dim: 1024, keyEnv: "DASHSCOPE_API_KEY" };
const REPO = path.resolve(args["plugin-repo"] ?? path.join(repoRoot, "..", "pi-share-agents")); // pi 插件产品：默认兄弟克隆（数据优化口径的工作产品），--plugin-repo 覆盖
const ROUND_TIMEOUT_MS_DEFAULT = 15 * 60_000;
const SETUP_TIMEOUT_MS = 30_000;

const expDir = path.resolve(args["exp-dir"] ?? "");
const ARMS = (args.arms ?? "TXT,SYN").split(",").map((x) => x.trim()).filter(Boolean);
const FAMILY = args.family ?? "r";
const TASKS = Number(args.tasks ?? 1);
const TEMPLATE_SYN = args["template-syn"] ?? "opt-pipeline";
const TEMPLATE_TXT = args["template-txt"] ?? "role-pipeline";
const TIMEOUT_MS = Number(args["timeout-ms"] ?? ROUND_TIMEOUT_MS_DEFAULT);

const apiKey = process.env.DASHSCOPE_API_KEY ?? "";
for (const [what, ok] of [
	["pi cli", fs.existsSync(CLI)],
	["DASHSCOPE_API_KEY", apiKey.length > 0],
	["template(syn)", fs.existsSync(`${WSL_REPO}/prompts/${TEMPLATE_SYN}.md`)],
	["template(txt)", fs.existsSync(`${WSL_REPO}/prompts/${TEMPLATE_TXT}.md`)],
	...(FAMILY === "r"
		? [["flask src", fs.existsSync(FLASK_SRC)], ["flask questions", fs.existsSync(FLASK_QUESTIONS)]]
		: [["musique family", fs.existsSync(MUSIQUE_FAMILY)], ["musique worktree", fs.existsSync(MUSIQUE_WORKTREE)]]),
	...(ARMS.includes("SYN") ? [["corpus", fs.existsSync(`${CORPUS_SRC_ROOT}/${CORPUS_ID}/meta.json`)]] : []),
]) {
	if (!ok) { console.error(`missing ${what}`); process.exit(1); }
}
fs.mkdirSync(path.join(expDir, "evidence"), { recursive: true });

const questions = FAMILY === "r"
	? fs.readFileSync(FLASK_QUESTIONS, "utf-8").trim().split("\n").slice(0, TASKS).map((line) => JSON.parse(line).question)
	: (JSON.parse(fs.readFileSync(MUSIQUE_FAMILY, "utf-8")).tasks ?? []).slice(0, TASKS).map((t) => t.task ?? t.question);
const workDir = FAMILY === "r" ? FLASK_SRC : MUSIQUE_WORKTREE;

function loadTemplate(name) {
	const raw = fs.readFileSync(`${WSL_REPO}/prompts/${name}.md`, "utf-8");
	const anchorAt = raw.lastIndexOf("Task:\n\n$@");
	return (anchorAt >= 0 ? raw.slice(0, anchorAt) : raw.split("Task:")[0]) + "Task:\n\n";
}
const templates = { SYN: loadTemplate(TEMPLATE_SYN), TXT: loadTemplate(TEMPLATE_TXT) };

const log = (message) => console.log(`[p50o] ${new Date().toISOString().slice(11, 19)} ${message}`);

/** 与 p50 同款：唯一臂间差异在 mode（TXT=text 且 memory 关闭=M3 基线；SYN=synapse+memory+corpus）。 */
function synapseConfigFor(arm, storageRoot) {
	const config = { mode: arm === "TXT" ? "text" : "synapse", storageRoot: storageRoot.replaceAll("\\", "/") };
	if (arm === "SYN") {
		config.memory = "project";
		config.corpusSnapshotId = CORPUS_ID;
		config.embedding = { ...EMBEDDING };
	}
	return config;
}

function writeAgentConfig(agentDir, arm, storageRoot) {
	const models = {
		providers: {
			bailian: {
				name: "Aliyun Bailian (platform key)",
				baseUrl: BAILIAN_BASE,
				api: "openai-completions",
				apiKey: "$DASHSCOPE_API_KEY",
				compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
				models: [{ id: MODEL.id, name: `${MODEL.id} (Bailian platform)`, reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 32768, cost: { input: 0.15, output: 1.5, cacheRead: 0.0375, cacheWrite: 0.15 } }],
			},
		},
	};
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify(models, null, "\t")}\n`, "utf-8");
	const dir = path.join(agentDir, "extensions", "subagent");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify({ synapse: synapseConfigFor(arm, storageRoot) }, null, "\t")}\n`, "utf-8");
}

/** One pi RPC process, one prompt — p50 mechanics; completion = subagent tool_execution_end. */
function runPiRound({ agentDir, tempRoot, prompt, roundLog, armKey }) {
	fs.rmSync(tempRoot, { force: true, recursive: true });
	fs.mkdirSync(tempRoot, { recursive: true });
	const events = [];
	let carry = "", stderr = "";
	const child = spawn(process.execPath, [CLI, "-e", path.join(REPO, "index.ts"), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--mode", "rpc", "--provider", "bailian", "--model", MODEL.id], { cwd: workDir, env: { ...process.env, DASHSCOPE_API_KEY: apiKey, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENTS_TEMP_ROOT: tempRoot }, stdio: ["pipe", "pipe", "pipe"] });
	const append = (prefix, chunk) => {
		carry += String(chunk);
		let at;
		while ((at = carry.indexOf("\n")) !== -1) {
			const line = carry.slice(0, at);
			carry = carry.slice(at + 1);
			if (line.trim().length === 0) continue;
			if (prefix) { stderr += line + "\n"; continue; }
			try {
				const event = JSON.parse(line);
				if (event.type !== "message_update" && event.type !== "tool_execution_update") events.push(event);
				fs.appendFileSync(roundLog, `${line}\n`, "utf-8");
			} catch { /* non-JSON noise */ }
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
						if (parsed?.id === id && parsed.type === "response") { clearTimeout(timer); child.stdout.off("data", onData); resolve(true); return; }
					} catch { /* not ours */ }
				}
			};
			child.stdout.on("data", onData);
		});
	const startedAt = Date.now();
	return (async () => {
		const out = { ok: false, problem: null };
		try {
			await sleep(3_000);
			child.stdin.write(`${JSON.stringify({ id: "setup", message: "/synapse-setup", type: "prompt" })}\n`);
			await awaitResponse("setup", SETUP_TIMEOUT_MS);
			child.stdin.write(`${JSON.stringify({ id: "run", message: prompt, type: "prompt" })}\n`);
			const deadline = Date.now() + TIMEOUT_MS;
			while (Date.now() < deadline) {
				if (events.some((e) => e.type === "tool_execution_end" && e.toolName === "subagent")) { out.ok = true; break; }
				if (events.some((e) => e.type === "agent_settled")) { await sleep(2_000); out.ok = events.some((e) => e.type === "tool_execution_end" && e.toolName === "subagent"); break; }
				await sleep(1_500);
			}
			if (!out.ok) out.problem = "timeout-or-no-subagent-result";
			await sleep(1_000);
		} catch (error) {
			out.problem = String(error);
		} finally {
			fs.appendFileSync(roundLog, `ERR ${stderr.slice(0, 100_000)}\n`, "utf-8");
			child.kill();
		}
		out.wallMs = Date.now() - startedAt;
		out.subagentEnd = events.find((e) => e.type === "tool_execution_end" && e.toolName === "subagent") ?? null;
		out.events = events;
		return out;
	})();
}

// --- main loop -----------------------------------------------------------------
const partialPath = path.join(expDir, "p50o-partial.jsonl");
const only = (args.only ?? "").split(",").map((x) => x.trim()).filter(Boolean);
for (const [index, question] of questions.entries()) {
	for (const arm of ARMS) {
		const key = `q${index + 1}-${arm}`;
		if (only.length > 0 && !only.includes(key)) continue;
		const evidence = path.join(expDir, "evidence", key);
		fs.rmSync(evidence, { recursive: true, force: true });
		fs.mkdirSync(evidence, { recursive: true });
		const workRoot = path.join(os.tmpdir(), "pi-p50o", createHash("sha256").update(expDir).digest("hex").slice(0, 8), key);
		const agentDir = path.join(workRoot, "agent");
		const storageRoot = path.join(workRoot, "state");
		fs.rmSync(workRoot, { recursive: true, force: true });
		if (arm === "SYN") {
			fs.mkdirSync(path.join(storageRoot, "corpus", CORPUS_ID), { recursive: true });
			for (const file of ["meta.json", "vectors.f32", "chunks.json"]) fs.copyFileSync(`${CORPUS_SRC_ROOT}/${CORPUS_ID}/${file}`, path.join(storageRoot, "corpus", CORPUS_ID, file));
		} else fs.mkdirSync(storageRoot, { recursive: true });
		writeAgentConfig(agentDir, arm, storageRoot);

		const prompt = templates[arm] + question + "\n";
		fs.writeFileSync(path.join(evidence, "prompt.md"), prompt, "utf-8");
		const outcome = await runPiRound({ agentDir, tempRoot: path.join(workRoot, "tmp"), prompt, roundLog: path.join(evidence, "rpc.jsonl"), armKey: key });

		const result = outcome.subagentEnd?.result ?? {};
		const usage = result.usage ?? null;
		const answer = result.details?.workflow?.value ?? null;
		const roles = result.details?.runFanoutBudget?.used ?? null;
		const stages = Array.isArray(result.details?.results) ? result.details.results.map((r) => r.agent) : [];
		let parentIn = 0, parentOut = 0;
		for (const e of outcome.events) {
			if (e.type !== "message_end" || e.message?.role !== "assistant") continue;
			const u = e.usage ?? e.message?.usage;
			if (!u) continue;
			parentIn += u.input ?? u.promptTokens ?? 0;
			parentOut += u.output ?? u.completionTokens ?? 0;
		}
		let problem = outcome.problem;
		if (problem === null && (usage === null || answer === null)) problem = "no-usage-or-answer";
		if (problem === null && roles !== null && roles < 4) problem = `roles=${roles}<4`;
		if (answer !== null) fs.writeFileSync(path.join(evidence, "answer.md"), answer, "utf-8");
		const row = {
			arm, answerChars: answer === null ? 0 : answer.trim().length, cacheRead: usage?.cacheRead ?? 0, childIn: usage?.input ?? 0, childOut: usage?.output ?? 0, index, parentIn, parentOut, problem, question, roles, stages, template: arm === "SYN" ? TEMPLATE_SYN : TEMPLATE_TXT, totalIn: (usage?.input ?? 0) + parentIn, totalOut: (usage?.output ?? 0) + parentOut, unit: "p50o", valid: problem === null, wallMs: outcome.wallMs,
		};
		fs.appendFileSync(partialPath, `${JSON.stringify(row)}\n`, "utf-8");
		fs.writeFileSync(path.join(evidence, "result.json"), `${JSON.stringify(row, null, "\t")}\n`, "utf-8");
		log(`${key}: ${problem ?? "finished"} (roles=${roles ?? "?"} stages=[${stages.join(",")}] token=${row.totalIn}/${row.totalOut} cacheRead=${row.cacheRead} wall=${Math.round(row.wallMs / 1000)}s)`);
	}
}
log(`done; partial: ${partialPath}`);

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1];
	return out;
}
void createHash;
