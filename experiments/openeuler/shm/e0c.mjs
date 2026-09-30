// E0c 端到端冒烟（spec §3.3）：真实 pi 四角色流水线 × SWE-QA Flask 题 × 段开/关交替。
//
// 验证目标（冻结）：功能判定——两臂全部产出有效答案与完整账本；token 并列记录
// （预期两臂同分布，不设显著性判据）；段开臂的账本必须出现 shm 事件（父装配
// publish + 子会话消费命中），这证明产品装配在真实 LLM 会话里真的走了共享段。
//
// 与 sweqa 装置的差异（如实记录，防口径混淆）：
//  - 不用记录代理：token 取自父 RPC 事件的 usage（父）+ metering model-usage（子），
//    与 E1 的父子口径同构；不做逐角色归因（E0c 是冒烟不是判定实验）
//  - 状态面激活：synapse 配置钉 corpusSnapshotId=63a385a4 + bailian 嵌入（E1 同款）
//  - 每尝试独立 storageRoot（含语料副本）——段在任务进程组内共享（父 publish、
//    四个角色子进程 attach 消费）；跨任务驻留已由 E0b 判定，不在此重复
//
// 用法（openEuler，仓库根，DASHSCOPE_API_KEY 在环境里）：
//   node --experimental-strip-types experiments/openeuler/shm/e0c.mjs --exp-dir <dir>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CORPUS_DIM, CORPUS_REPRESENTATION, CORPUS_SNAPSHOT, SHM_NAMESPACE } from "./matrix.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const PI_CLI = path.join(repoRoot, "experiments", "data", "shm-e0c", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const FLASK_SRC = path.join(repoRoot, "experiments", "data", "flask-src");
const FLASK_QUESTIONS = path.join(repoRoot, "experiments", "data", "swe-qa", "Benchmark", "flask.jsonl");
const MODELS_SOURCE = path.join(os.homedir(), ".pi", "agent", "models.json");
const BAILIAN_BASE = "https://llm-3m03faeswsufx2lq.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const MODEL_ID = "deepseek-v4.1-flash";
const TASKS = Number(parseArgs(process.argv.slice(2))["tasks"] ?? 3);
const TIMEOUT_MS = 15 * 60_000;

const args = parseArgs(process.argv.slice(2));
const expDir = path.resolve(args["exp-dir"] ?? "");
const corpusCache = path.resolve(args["corpus-root"] ?? "/root/.pi/agent/synapse/experiments/_corpus-cache");

const apiKey = process.env.DASHSCOPE_API_KEY ?? "";
for (const [what, ok] of [["pi cli", fs.existsSync(PI_CLI)], ["flask src", fs.existsSync(FLASK_SRC)], ["flask questions", fs.existsSync(FLASK_QUESTIONS)], ["models.json", fs.existsSync(MODELS_SOURCE)], ["DASHSCOPE_API_KEY", apiKey.length > 0]]) {
	if (!ok) fail(`missing ${what}`);
}
if (fs.existsSync(path.join(expDir, "e0c.jsonl"))) fail("e0c.jsonl already exists — new --exp-dir for a new run");
fs.mkdirSync(path.join(expDir, "evidence"), { recursive: true });

const sourceCorpusDir = path.join(corpusCache, "corpus", CORPUS_SNAPSHOT);
const questions = fs.readFileSync(FLASK_QUESTIONS, "utf-8").trim().split("\n").slice(0, TASKS).map((line) => JSON.parse(line));
const template = fs.readFileSync(path.join(repoRoot, "prompts", "role-pipeline.md"), "utf-8").split("Task:")[0] + "Task:\n\n";

const results = [];
// Alternating arm order across questions, so no question always sees one arm first.
for (const [index, question] of questions.entries()) {
	for (const arm of index % 2 === 0 ? ["shm", "file"] : ["file", "shm"]) {
		results.push(await attempt({ arm, index, question }));
	}
}
fs.writeFileSync(path.join(expDir, "e0c.jsonl"), results.map((row) => JSON.stringify(row)).join("\n") + "\n");
writeReport(results);

// --- one (question, arm) attempt ---------------------------------------------

async function attempt({ arm, index, question }) {
	const key = `q${index + 1}-${arm}`;
	const evidence = path.join(expDir, "evidence", key);
	fs.mkdirSync(evidence, { recursive: true });
	const workRoot = path.join(os.tmpdir(), "pi-shm-e0c", key);
	const storageRoot = path.join(workRoot, "state");
	const agentDir = path.join(workRoot, "agent");
	fs.rmSync(workRoot, { recursive: true, force: true });
	fs.mkdirSync(path.join(storageRoot, "corpus", CORPUS_SNAPSHOT), { recursive: true });
	for (const file of ["meta.json", "vectors.f32", "chunks.json"]) fs.copyFileSync(path.join(sourceCorpusDir, file), path.join(storageRoot, "corpus", CORPUS_SNAPSHOT, file));
	fs.mkdirSync(agentDir, { recursive: true });

	// models.json: the home bailian catalog, pinned to this attempt's key file (deleted with the attempt).
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
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
		asyncByDefault: false,
		synapse: {
			autoDistill: true,
			corpusSnapshotId: CORPUS_SNAPSHOT,
			embedding: { dim: CORPUS_DIM, endpoint: `${BAILIAN_BASE}/embeddings`, keyEnv: "DASHSCOPE_API_KEY", model: "text-embedding-v4", provider: "bailian" },
			memory: "project",
			mode: "synapse",
			shm: arm === "shm",
			storageRoot,
		},
	}, null, 2));

	const prompt = template + question.question + "\n";
	fs.writeFileSync(path.join(evidence, "prompt.md"), prompt);
	const env = {
		...process.env,
		DASHSCOPE_API_KEY: apiKey,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_HOME: agentDir,
		NODE_USE_ENV_PROXY: "0",
	};
	const child = spawn(process.execPath, [PI_CLI, "--no-themes", "--no-context-files", "--no-session", "--offline", "--mode", "rpc",
		"--provider", "bailian", "--model", MODEL_ID, "--thinking", "high", "--tools", "subagent"], { cwd: FLASK_SRC, env, stdio: ["pipe", "pipe", "pipe"] });
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
		while (Date.now() < until && !exited) {
			if (responses.has(id)) return responses.get(id);
			await sleep(100);
		}
		return null;
	};
	const started = Date.now();
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

	// Ledger counts: every metering jsonl this attempt wrote (parent + each child).
	const ledger = { "corpus-load": 0, "memory-reuse": 0, "model-usage": 0, "shm-attach": 0, "shm-hit": 0, "shm-invalid": 0, "shm-miss": 0, "state-consume": 0 };
	const meteringDir = path.join(storageRoot, "metering");
	if (fs.existsSync(meteringDir)) {
		for (const file of fs.readdirSync(meteringDir)) {
			for (const line of fs.readFileSync(path.join(meteringDir, file), "utf-8").trim().split("\n").filter(Boolean)) {
				try { const kind = JSON.parse(line).kind; if (kind in ledger) ledger[kind] += 1; } catch { /* torn tail line */ }
			}
		}
		guarded(() => fs.cpSync(meteringDir, path.join(evidence, "metering"), { recursive: true }));
	}
	// Parent tokens from the RPC stream (children bill through model-usage rows).
	let parentIn = 0, parentOut = 0;
	for (const event of events) {
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		const usage = event.usage ?? event.message.usage;
		if (!usage) continue;
		parentIn += usage.input ?? usage.promptTokens ?? 0;
		parentOut += usage.output ?? usage.completionTokens ?? 0;
	}
	guarded(() => fs.rmSync(workRoot, { recursive: true, force: true }));
	const row = {
		answerChars: answer.trim().length, arm, index, ledger, parentIn, parentOut, problem, unit: "e0c", valid: problem === null, wallMs: Date.now() - started,
	};
	console.log(`[e0c] ${key}: ${problem ?? "finished"} (shm-hit=${ledger["shm-hit"]} corpus-load=${ledger["corpus-load"]} wall=${Math.round(row.wallMs / 1000)}s)`);
	return row;
}

// --- report -------------------------------------------------------------------

function writeReport(rows) {
	const lines = ["## E0c 端到端冒烟（功能判定：两臂出答案+账本齐全；段开臂必须出现 shm 事件）", "",
		"| 题 | 臂 | 有效 | 答案字符 | shm-attach/hit/miss/invalid | corpus-load | state-consume | 父 token in/out | 墙钟 s |", "|---|---|---|---|---|---|---|---|---|"];
	for (const row of rows) {
		const l = row.ledger;
		lines.push(`| q${row.index + 1} | ${row.arm} | ${row.valid} | ${row.answerChars} | ${l["shm-attach"]}/${l["shm-hit"]}/${l["shm-miss"]}/${l["shm-invalid"]} | ${l["corpus-load"]} | ${l["state-consume"]} | ${row.parentIn}/${row.parentOut} | ${Math.round(row.wallMs / 1000)} |`);
	}
	lines.push("", "> token 为并列记录（预登记：预期两臂同分布，不设判据）；shm 臂的 corpus-load>0 时段只覆盖了部分消费（子会话按契约逐个装配），数字如实列出。", "");
	fs.writeFileSync(path.join(expDir, "e0c-report.md"), lines.join("\n") + "\n");
	console.log(lines.join("\n"));
}

// --- helpers ------------------------------------------------------------------

function lastAnswer(events) {
	let answer = "";
	for (const event of events) {
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		const text = (event.message.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
		if (text.trim()) answer = text;
	}
	return answer;
}

function guarded(fn) {
	try { fn(); } catch { /* evidence handling never aborts the run */ }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function fail(message) { console.error(String(message)); process.exit(1); }

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1];
	return out;
}

void SHM_NAMESPACE;
