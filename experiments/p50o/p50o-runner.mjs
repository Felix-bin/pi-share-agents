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
//   5. 密封沙盒（2026-10-04）：每题将任务语料整份复制到临时目录作为 cwd——早前 pilot 轮发现
//      cwd=语料目录时文件工具可向上逃逸读到题库金标与宿主仓（TXT q5/q-syn q1 曾实质引用），
//      密封后题库与宿主仓物理不在可达树上；框架臂本就以 root 前缀校验密封。
//   6. 消融臂（--arms ABFH,ABNM,ABNC）：三机制消融（压缩传递/共享记忆/语料向量），见 ABLATION。
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
import { summarizeApiJournal } from "./api-accounting.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const args = parseArgs(process.argv.slice(2));

const WSL_REPO = path.resolve(here, "..", ".."); // 本仓（装置随决赛仓提交）
const SOURCE_REPO = path.resolve(args["source-repo"] ?? WSL_REPO);
const CLI = args["pi-cli"] ?? process.env.PI_CLI ?? ""; // pi CLI 路径：--pi-cli 或 PI_CLI 环境变量（装置不绑定宿主路径）
const FLASK_SRC = args.worktree ?? process.env.P50O_WORKTREE ?? `${WSL_REPO}/experiments/data/flask-src`;
const FLASK_QUESTIONS = args["questions-file"] ?? process.env.P50O_QUESTIONS_FILE ?? `${WSL_REPO}/experiments/data/swe-qa/Benchmark/flask.jsonl`;
const MUSIQUE_FAMILY = args["questions-file"] ?? process.env.P50O_QUESTIONS_FILE ?? `${WSL_REPO}/experiments/bench/families/q-musique.json`;
const MUSIQUE_WORKTREE = args.worktree ?? process.env.P50O_WORKTREE ?? `${WSL_REPO}/experiments/data/worktree/musique`;
const CORPUS_SRC_ROOT = args["corpus-root"] ?? path.join(repoRoot, "experiments", "data", "_corpus-cache"); // 语料快照根：--corpus-root 覆盖
const CORPUS_ID = "63a385a420d3bdd080b21981640d964d46b9f1637050a4276ee0510ec8fd56dc";
// 被测/判分 LLM 供应商：commandcode（2026-10-05 起全部实验切换，P50O_API_BASE 可覆盖）。
// 嵌入（语料向量检索）commandcode 无嵌入模型，保留百炼 dashscope（keyEnv 区分）。
const LLM_BASE = process.env.P50O_API_BASE ?? "https://api.commandcode.ai/provider/v1";
const LLM_PROVIDER = "commandcode";
const MODEL = { id: process.env.P50O_MODEL ?? "deepseek/deepseek-v4.1-flash" }; // P50O_MODEL 覆盖（百炼无命名空间前缀）
const EMBEDDING_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const EMBEDDING = { provider: "bailian", endpoint: `${EMBEDDING_BASE}/embeddings`, model: "text-embedding-v4", dim: 1024, keyEnv: "DASHSCOPE_API_KEY" };
const REPO = path.resolve(args["plugin-repo"] ?? WSL_REPO); // pi 插件产品：默认即本仓（装置自包含），--plugin-repo 覆盖
const ROUND_TIMEOUT_MS_DEFAULT = 15 * 60_000;
const SETUP_TIMEOUT_MS = 30_000;

// 消融臂（R 族三机制消融）：模板与机制开关的组合，其余与 SYN 产品形态完全一致。
const ABLATION = {
	ABFH: { template: "ablation-fullhandover", memory: true, corpus: true, label: "no-compress（阶段间全文转贴，截断传递移除）" },
	ABNM: { template: "opt-pipeline", memory: false, corpus: true, label: "no-shared-memory（共享记忆关闭，语料向量保留）" },
	ABNC: { template: "opt-pipeline", memory: true, corpus: false, label: "no-corpus-vectors（语料向量快照关闭，共享记忆保留）" },
};

const expDir = path.resolve(args["exp-dir"] ?? "");
const ARMS = (args.arms ?? "TXT,SYN").split(",").map((x) => x.trim()).filter(Boolean);
const FAMILY = args.family ?? "r";
const TASKS = Number(args.tasks ?? 1);
const TEMPLATE_SYN = args["template-syn"] ?? "opt-pipeline";
const TEMPLATE_TXT = args["template-txt"] ?? "role-pipeline";
const TIMEOUT_MS = Number(args["timeout-ms"] ?? ROUND_TIMEOUT_MS_DEFAULT);
const SEAL = args.seal !== "0"; // 密封沙盒：每题把任务语料复制到临时目录并作为 cwd，切断对题库/宿主仓的文件访问（默认开，--seal 0 关闭）

const apiKey = LLM_BASE.includes("dashscope") ? process.env.DASHSCOPE_API_KEY ?? "" : process.env.COMMANDCODE_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? ""; // 按端点选 key：百炼端点只认 DASHSCOPE key
for (const [what, ok] of [
	["pi cli", fs.existsSync(CLI)],
	["COMMANDCODE_API_KEY", apiKey.length > 0],
	["template(syn)", fs.existsSync(`${SOURCE_REPO}/prompts/${TEMPLATE_SYN}.md`)],
	["template(txt)", fs.existsSync(`${SOURCE_REPO}/prompts/${TEMPLATE_TXT}.md`)],
	...(FAMILY === "r"
		? [["flask src", fs.existsSync(FLASK_SRC)], ["flask questions", fs.existsSync(FLASK_QUESTIONS)]]
		: [["musique family", fs.existsSync(MUSIQUE_FAMILY)], ["musique worktree", fs.existsSync(MUSIQUE_WORKTREE)]]),
	...([...ARMS].filter((a) => (a === "SYN" && args["syn-corpus"] !== "0") || (ABLATION[a]?.corpus)).length > 0 ? [["corpus", fs.existsSync(`${CORPUS_SRC_ROOT}/${CORPUS_ID}/meta.json`)]] : []),
	...(ARMS.some((a) => ABLATION[a]) ? [["ablation template", fs.existsSync(`${WSL_REPO}/prompts/ablation-fullhandover.md`)]] : []),
]) {
	if (!ok) { console.error(`missing ${what}`); process.exit(1); }
}
fs.mkdirSync(path.join(expDir, "evidence"), { recursive: true });

const QSTART = Number(args.start ?? process.env.P50O_START ?? 0); // --start/P50O_START：题目起始偏移（换题校准用）
const externalQuestions = args["questions-file"] ?? process.env.P50O_QUESTIONS_FILE;
let questions = externalQuestions
	? fs.readFileSync(externalQuestions, "utf8").trim().split("\n").slice(QSTART, QSTART + TASKS).map((line) => { const q = JSON.parse(line); return q.question ?? q.task; })
	: FAMILY === "r"
	? fs.readFileSync(FLASK_QUESTIONS, "utf-8").trim().split("\n").slice(QSTART, QSTART + TASKS).map((line) => JSON.parse(line).question)
	: (JSON.parse(fs.readFileSync(MUSIQUE_FAMILY, "utf-8")).tasks ?? []).slice(QSTART, QSTART + TASKS).map((t) => t.task ?? t.question);
// 连续任务流（--flow revisit）：前 5 轮正跑 + 后 5 轮逐字重访（赛题"彼此关联的连续任务"结构；
// storageRoot 跨轮持久，共享记忆真实累积——单发题上无前轮可复用，机制无正贡献舞台）。
const FLOW = (args.flow ?? "") === "revisit";
if (FLOW) questions = [...questions, ...questions];
const CORPUS_SOURCE_DIR = FAMILY === "r" ? FLASK_SRC : MUSIQUE_WORKTREE; // 任务语料（密封沙盒的复制源）

function loadTemplate(name) {
	const raw = fs.readFileSync(`${SOURCE_REPO}/prompts/${name}.md`, "utf-8");
	const anchorAt = raw.lastIndexOf("Task:\n\n$@");
	return (anchorAt >= 0 ? raw.slice(0, anchorAt) : raw.split("Task:")[0]) + "Task:\n\n";
}
const templates = { SYN: loadTemplate(TEMPLATE_SYN), TXT: loadTemplate(TEMPLATE_TXT) };
for (const [arm, ab] of Object.entries(ABLATION)) templates[arm] = loadTemplate(ab.template);

const log = (message) => console.log(`[p50o] ${new Date().toISOString().slice(11, 19)} ${message}`);

/** 臂间差异在机制开关：TXT=text 基线；SYN=synapse+memory+corpus 全开；消融臂按 ABLATION 逐项关闭。 */
function synapseConfigFor(arm, storageRoot) {
	const ab = ABLATION[arm];
	const synFamily = arm === "SYN" || ab !== undefined;
	const config = { mode: synFamily ? "synapse" : "text", storageRoot: storageRoot.replaceAll("\\", "/") };
	if (synFamily) {
		if (arm === "SYN" || ab.memory) {
			config.memory = arm === "SYN" ? (args["syn-memory"] ?? "project") : "project";
		} else {
			// 显式关闭（2026-10-06 修复）：此前省略 memory 字段，被插件 resolveSynapseConfig 在
			// synapse 模式下默认解析为 "project"——ABNM 臂实际与 SYN 同配置（普查 P0）。
			config.memory = "off";
		}
		if ((arm === "SYN" && args["syn-corpus"] !== "0") || ab?.corpus) {
			config.corpusSnapshotId = CORPUS_ID;
			config.embedding = { ...EMBEDDING };
		}
	}
	return config;
}

function writeAgentConfig(agentDir, arm, storageRoot, armKey) {
	const models = {
		providers: {
			commandcode: {
				name: "CommandCode (provider gateway)",
				baseUrl: process.env.P50O_PROXY_BASE ? `${process.env.P50O_PROXY_BASE}/run/${armKey}` : LLM_BASE,
				api: "openai-completions",
				apiKey: "$COMMANDCODE_API_KEY",
				compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
				models: [{ id: MODEL.id, name: `${MODEL.id} (Bailian platform)`, reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 32768, cost: { input: 0.15, output: 1.5, cacheRead: 0.0375, cacheWrite: 0.15 } }],
			},
		},
	};
	fs.mkdirSync(agentDir, { recursive: true });
	if (arm === "SYN" && args["efficient-agents"] === "1") {
		const efficientRoot = path.join(SOURCE_REPO, "experiments", "p50o", "agents-efficient");
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		for (const role of ["planner", "retriever", "executor", "summarizer"]) {
			const definition = fs.readFileSync(path.join(efficientRoot, role + ".md"), "utf8").replace("../../../src/synapse/evidence-extension.ts", path.join(SOURCE_REPO, "src", "synapse", "evidence-extension.ts").replaceAll("\\", "/"));
			fs.writeFileSync(path.join(agentDir, "agents", role + ".md"), definition, "utf8");
		}
	}
	fs.writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify(models, null, "\t")}\n`, "utf-8");
    // Plain-text baseline receives inline stage outputs; do not require absent artifact files.
    const localAgents = path.join(agentDir, "agents");
    fs.mkdirSync(localAgents, { recursive: true });
    const guard = path.join(SOURCE_REPO, "src", "synapse", "task-world-extension.ts").replaceAll("\\", "/");
    for (const role of ["planner", "retriever", "executor", "summarizer"]) {
        const destination = path.join(localAgents, role + ".md");
        const source = arm === "TXT" ? path.join(SOURCE_REPO, "agents", role + ".md") : destination;
        if (!fs.existsSync(source)) continue;
        let definition = fs.readFileSync(source, "utf8");
        if (arm === "TXT") {
            definition = definition.replace(/^defaultReads:.*\r?\n/gm, "");
            definition += "\nFor this evaluation, all previous stage outputs arrive inline in the task. Artifact files are disabled: use the supplied plan and evidence directly; do not read absent plan.md/evidence.md or write artifact files.\n";
        }
        // All arms solve closed, read-only QA tasks with no external supervisor.
        // Source editing and interactive escalation are outside this protocol.
        definition = definition.replace(/^tools:\s*(.*)$/m, (_, tools) => `tools: ${tools.split(",").map(tool => tool.trim()).filter(tool => !["write", "edit", "contact_supervisor"].includes(tool)).join(", ")}`);
        definition += "\nThis is a closed QA evaluation with no interactive supervisor. Preserve source files; report any unresolved issue in your returned evidence instead of requesting a supervisor or doing bookkeeping calls.\n";
        if (/^subagentOnlyExtensions:/m.test(definition)) definition = definition.replace(/^subagentOnlyExtensions:(.*)$/m, (_, paths) => `subagentOnlyExtensions:${paths}, ${guard}`);
        else definition = definition.replace(/^completionGuard: false/m, `completionGuard: false\nsubagentOnlyExtensions: ${guard}`);
        fs.writeFileSync(destination, definition, "utf8");
    }
	const dir = path.join(agentDir, "extensions", "subagent");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify({ synapse: synapseConfigFor(arm, storageRoot) }, null, "\t")}\n`, "utf-8");
}

/** One pi RPC process, one prompt — p50 mechanics; completion = subagent tool_execution_end. */
function runPiRound({ agentDir, tempRoot, prompt, roundLog, armKey, cwd }) {
	fs.rmSync(tempRoot, { force: true, recursive: true });
	fs.mkdirSync(tempRoot, { recursive: true });
	const events = [];
	let carry = "", stderr = "";
	const optimized = armKey.endsWith("-SYN");
	const deterministic = args.dispatch === "deterministic";
	const resultFile = path.join(path.dirname(roundLog), "native-workflow-result.json");
	const extension = deterministic ? path.join(REPO, "experiments", "p50o", "eval-extension.ts") : path.join(REPO, "index.ts");
	const child = spawn(process.execPath, [CLI, "-e", extension, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--mode", "rpc", "--provider", LLM_PROVIDER, "--model", MODEL.id], { cwd, env: { ...process.env, COMMANDCODE_API_KEY: apiKey, DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY ?? "", PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENTS_TEMP_ROOT: tempRoot, SYNAPSE_STAGE_REDEMPTION: optimized ? (args["stage-redemption"] ?? "full") : "full", SYNAPSE_STAGE_INLINE_BYTES: optimized ? (args["stage-inline-bytes"] ?? "1536") : "1536", SYNAPSE_CONTEXT_LEDGER: optimized ? (args["context-ledger"] ?? "0") : "0", SYNAPSE_EVIDENCE_EXTENSION: optimized && args["efficient-agents"] === "1" ? "1" : "0", SYNAPSE_EVIDENCE_STORE: path.join(agentDir, "synapse-observations"), SYNAPSE_EVIDENCE_PREFETCH: optimized ? (args["prefetch"] ?? "0") : "0", P50O_EVAL_RESULT: resultFile }, stdio: ["pipe", "pipe", "pipe"] });
	const append = (prefix, chunk) => {
		if (prefix) { const safe = String(chunk).replaceAll(apiKey, "[REDACTED]"); stderr += safe; fs.appendFileSync(roundLog, `ERR ${safe}`, "utf8"); return; }
		carry += String(chunk);
		let at;
		while ((at = carry.indexOf("\n")) !== -1) {
			const line = carry.slice(0, at);
			carry = carry.slice(at + 1);
			if (line.trim().length === 0) continue;
			try {
				const event = JSON.parse(line);
				if (event.type !== "message_update" && event.type !== "tool_execution_update") events.push(event);
				if (event.type !== "message_update" && event.type !== "tool_execution_update") fs.appendFileSync(roundLog, `${line}\n`, "utf-8");
			} catch { /* non-JSON noise */ }
		}
	};
	child.stdout.on("data", (chunk) => append("", chunk));
	child.stderr.on("data", (chunk) => append("ERR ", chunk));
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const awaitResponse = async (id, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (events.some(e => e.type === "response" && e.id === id)) return true;
            if (child.exitCode !== null || child.signalCode !== null) return false;
            await sleep(100);
        }
        return false;
    };
	const startedAt = Date.now();
	return (async () => {
		const out = { ok: false, problem: null };
		try {
			await sleep(3_000);
			child.stdin.write(`${JSON.stringify({ id: "setup", message: "/synapse-setup", type: "prompt" })}\n`);
			if (!await awaitResponse("setup", SETUP_TIMEOUT_MS)) throw new Error(`setup-failed-or-timeout: exit=${child.exitCode}`);
			const workflowScript = /```js\r?\n([\s\S]*?)```/.exec(prompt)?.[1];
			const originalTask = prompt.slice(prompt.lastIndexOf("Task:\n\n") + "Task:\n\n".length).trim();
			if (deterministic && !workflowScript) throw new Error("no frozen workflow script");
			const message = deterministic ? "/synapse-eval " + JSON.stringify({ workflowScript, args: { task: originalTask } }) : prompt;
			child.stdin.write(`${JSON.stringify({ id: "run", message, type: "prompt" })}\n`);
			const deadline = Date.now() + TIMEOUT_MS;
			while (Date.now() < deadline) {
                if (child.exitCode !== null || child.signalCode !== null) { out.problem = `pi-process-exited:${child.exitCode ?? child.signalCode}`; break; }
				if (deterministic && fs.existsSync(resultFile)) {
					const record = JSON.parse(fs.readFileSync(resultFile, "utf8"));
					if (record.result) events.push({ type: "tool_execution_end", toolName: "subagent", result: record.result, source: "deterministic-native-tool-dispatch" });
					else out.problem = record.error ?? "native-dispatch-failed";
					out.ok = Boolean(record.result);
					break;
				}
				if (!deterministic && events.some((e) => e.type === "tool_execution_end" && e.toolName === "subagent")) { out.ok = true; break; }
				if (!deterministic && events.some((e) => e.type === "agent_settled")) { await sleep(2_000); out.ok = events.some((e) => e.type === "tool_execution_end" && e.toolName === "subagent"); break; }
				await sleep(1_500);
			}
			if (!out.ok && !out.problem) out.problem = "timeout-or-no-subagent-result";
			await sleep(1_000);
		} catch (error) {
			out.problem = String(error);
		} finally {
			fs.appendFileSync(roundLog, `ERR process-end; stderrChars=${stderr.length}\n`, "utf-8");
			child.kill();
		}
		out.wallMs = Date.now() - startedAt;
		out.subagentEnd = events.find((e) => e.source === "deterministic-native-tool-dispatch") ?? (deterministic ? null : events.find((e) => e.type === "tool_execution_end" && e.toolName === "subagent")) ?? null;
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
		// 流式模式：storageRoot/agentDir 按臂持久（共享记忆跨轮真实累积）；单发模式按题隔离。
		const workRoot = FLOW
			? path.join(os.tmpdir(), "pi-p50o", createHash("sha256").update(expDir).digest("hex").slice(0, 8), `flow-${arm}`)
			: path.join(os.tmpdir(), "pi-p50o", createHash("sha256").update(expDir).digest("hex").slice(0, 8), key);
		const agentDir = path.join(workRoot, "agent");
		const storageRoot = path.join(workRoot, "state");
		if (FLOW) { if (index === 0) fs.rmSync(workRoot, { recursive: true, force: true }); }
		else fs.rmSync(workRoot, { recursive: true, force: true });
		if (arm === "SYN" || ABLATION[arm]?.corpus) {
			fs.mkdirSync(path.join(storageRoot, "corpus", CORPUS_ID), { recursive: true });
			for (const file of ["meta.json", "vectors.f32", "chunks.json"]) {
				const dst = path.join(storageRoot, "corpus", CORPUS_ID, file);
				if (!fs.existsSync(dst)) fs.copyFileSync(`${CORPUS_SRC_ROOT}/${CORPUS_ID}/${file}`, dst);
			}
		} else fs.mkdirSync(storageRoot, { recursive: true });
		writeAgentConfig(agentDir, arm, storageRoot, key);
		// 密封沙盒：任务语料整份复制到临时目录，cwd 指向副本——题库（含金标）与宿主仓不在可达树上。
		// Windows 坑：cpSync 递归复制含 junction 的 .venv 会令 node 原生崩溃（静默 exit 127），
		// 故过滤 .venv 后以 junction 回接（executor 的 pytest 可用，行为与密封前轮一致）。
		// 流式模式下沙盒仍按轮独立（语料只读、每轮干净副本），记忆驻留在 storageRoot 不受影响。
		const sealDir = FLOW ? path.join(workRoot, "seals", key) : path.join(workRoot, "seal");
		if (SEAL) {
			fs.rmSync(sealDir, { recursive: true, force: true });
			// MuSiQue task text names musique/ explicitly; preserve that visible layout.
			const destination = FAMILY === "q" ? path.join(sealDir, "musique") : sealDir;
			fs.mkdirSync(sealDir, { recursive: true });
			fs.cpSync(CORPUS_SOURCE_DIR, destination, { recursive: true, filter: (s) => !s.split(/[\\/]/).includes(".venv") });
			const venvLink = path.join(sealDir, ".venv"), venvSrc = path.join(CORPUS_SOURCE_DIR, ".venv");
			if (fs.existsSync(venvSrc)) {
				fs.rmSync(venvLink, { recursive: true, force: true });
				fs.symlinkSync(venvSrc, venvLink, "junction");
			}
			log(`${key}: sealed sandbox ready (${sealDir})`);
		}
		const cwd = SEAL ? sealDir : CORPUS_SOURCE_DIR;

		const prompt = templates[arm] + question + "\n";
		fs.writeFileSync(path.join(evidence, "prompt.md"), prompt, "utf-8");
		const outcome = await runPiRound({ agentDir, tempRoot: path.join(workRoot, "tmp", key), prompt, roundLog: path.join(evidence, "rpc.jsonl"), armKey: key, cwd });

		const result = outcome.subagentEnd?.result ?? {};
		const usage = result.usage ?? null;
		const answer = result.details?.workflow?.value ?? null;
		const roles = result.details?.runFanoutBudget?.used ?? null;
		const stages = Array.isArray(result.details?.results) ? result.details.results.map((r) => r.agent) : [];
		let parentIn = 0, parentOut = 0, parentCacheRead = 0, parentCacheWrite = 0;
		for (const e of outcome.events) {
			if (e.type !== "message_end" || e.message?.role !== "assistant") continue;
			const u = e.usage ?? e.message?.usage;
			if (!u) continue;
			parentIn += u.input ?? u.promptTokens ?? 0;
			parentOut += u.output ?? u.completionTokens ?? 0;
			parentCacheRead += u.cacheRead ?? 0;
			parentCacheWrite += u.cacheWrite ?? 0;
		}
		let problem = outcome.problem;
		if (problem === null && args.dispatch === "deterministic" && (parentIn + parentOut + parentCacheRead + parentCacheWrite) > 0) problem = "unexpected-parent-llm-turn";
		if (problem === null && (usage === null || answer === null)) problem = "no-usage-or-answer";
		const minimumRoles = arm === "SYN" ? Math.max(3, Number(args["syn-min-roles"] ?? 3)) : 4;
		if (problem === null && roles !== null && roles < minimumRoles) problem = `roles=${roles}<${minimumRoles}`;
		if (problem === null && arm === "TXT" && roles !== 4) problem = `TXT-roles=${roles},expected=4`;
		const completedStages = new Set((result.details?.results ?? []).filter((r) => r.exitCode === 0 && String(r.finalOutput ?? "").trim().length > 0).map((r) => r.agent));
		const requiredStages = arm === "TXT" ? ["planner", "retriever", "executor", "summarizer"] : ["planner", "retriever", "summarizer"];
		const completedNorm = new Set([...completedStages].map((s) => String(s).replace(/^naive-/, ""))); // naive-pipeline 阶段名带 naive- 前缀，与标准名等价（2026-10-07 修复）
		if (problem === null && requiredStages.some((r) => !completedNorm.has(r))) problem = `missing-completed-roles:${requiredStages.filter((r) => !completedNorm.has(r)).join(",")}`;
		if (answer !== null) fs.writeFileSync(path.join(evidence, "answer.md"), answer, "utf-8");
		const row = {
			parentCacheRead, parentCacheWrite,
			totalTokensLogical: (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0) + parentIn + parentOut + parentCacheRead + parentCacheWrite,
			arm, answerChars: answer === null ? 0 : answer.trim().length, cacheRead: usage?.cacheRead ?? 0, childIn: usage?.input ?? 0, childOut: usage?.output ?? 0, index, parentIn, parentOut, problem, question, roles, stages, sealed: SEAL, template: arm === "TXT" ? TEMPLATE_TXT : (ABLATION[arm]?.template ?? TEMPLATE_SYN), totalIn: (usage?.input ?? 0) + parentIn, totalOut: (usage?.output ?? 0) + parentOut, unit: "p50o", valid: problem === null, wallMs: outcome.wallMs,
		};
		if (process.env.P50O_PROXY_BASE) {
			const readJournal = (name) => { const file = path.join(evidence, name); return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : []; };
			const accounting = summarizeApiJournal(readJournal("api.jsonl"), readJournal("api-starts.jsonl"));
			row.runtimeTokensLogical = row.totalTokensLogical;
			row.totalTokensLogical = accounting.knownTokens;
			row.accounting = accounting;
			if (!accounting.complete) { row.valid = false; row.problem = row.problem ?? "incomplete-api-accounting"; }
			else if (problem === null && row.runtimeTokensLogical !== accounting.knownTokens) { row.valid = false; row.problem = "api-runtime-usage-mismatch"; }
		}
		fs.appendFileSync(partialPath, `${JSON.stringify(row)}\n`, "utf-8");
		fs.writeFileSync(path.join(evidence, "result.json"), `${JSON.stringify(row, null, "\t")}\n`, "utf-8");
		log(`${key}: ${row.problem ?? "finished"} (roles=${roles ?? "?"} stages=[${stages.join(",")}] token=${row.totalIn}/${row.totalOut} cacheRead=${row.cacheRead} wall=${Math.round(row.wallMs / 1000)}s)`);
	}
}
log(`done; partial: ${partialPath}`);

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1];
	return out;
}
void createHash;
