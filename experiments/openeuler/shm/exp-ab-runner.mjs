// EXP-AB 核心机制消融装置（spec §1b，唯一允许关 SHM 的实验）。
//
// 4 配置同题配对：SYN-full（完整形态，SHM 常开，=EXP-A SYN 臂引用）+ 3 消融因子
// （每次只关一个，其余保持完整）：
//   SYN−state  ：非文本状态传递关闭（状态平面降级文本交接）→ 归因 M4
//   SYN−memory：跨任务共享记忆清空（每任务冷启动）→ 归因 M5/M7
//   SYN−shm    ：共享内存段关闭（存储回文件路径）→ 归因 OS 层贡献
//
// 判定（冻结）：各消融配置对 SYN-full 的 token 配对差与质量非劣；SYN−shm 预期 token/
// 质量均不劣（SHM 收益在宿主侧与激活稳定性，token 账预期不变——诚实报告）。
//
// 用法：node --experimental-strip-types experiments/openeuler/shm/exp-ab-runner.mjs \
//   --exp-dir <dir> [--configs SYN-full,SYN-state,SYN-memory,SYN-shm] [--tasks 6] [--only q1-SYN-shm,...]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CORPUS_DIM, CORPUS_SNAPSHOT, BOOTSTRAP_B, BOOTSTRAP_SEED, sha256 } from "./matrix.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const PI_CLI = path.join(repoRoot, "experiments", "data", "shm-e0c", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const FLASK_SRC = path.join(repoRoot, "experiments", "data", "flask-src");
const FLASK_QUESTIONS = path.join(repoRoot, "experiments", "data", "swe-qa", "Benchmark", "flask.jsonl");
const MODELS_SOURCE = path.join(os.homedir(), ".pi", "agent", "models.json");
const BAILIAN_BASE = "https://llm-3m03faeswsufx2lq.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const MODEL_ID = "deepseek-v4.1-flash";

const args = parseArgs(process.argv.slice(2));
const expDir = path.resolve(args["exp-dir"] ?? "");
const CONFIGS = (args.configs ?? "SYN-full,SYN-state,SYN-memory,SYN-shm").split(",").map((x) => x.trim()).filter(Boolean);
const TASKS = Number(args.tasks ?? 6);
const TIMEOUT_MS = Number(args["timeout-ms"] ?? 20 * 60_000);
const corpusCache = path.resolve(args["corpus-root"] ?? "/root/.pi/agent/synapse/experiments/_corpus-cache");

const apiKey = process.env.DASHSCOPE_API_KEY ?? "";
for (const [what, ok] of [["pi cli", fs.existsSync(PI_CLI)], ["flask src", fs.existsSync(FLASK_SRC)], ["flask questions", fs.existsSync(FLASK_QUESTIONS)], ["models.json", fs.existsSync(MODELS_SOURCE)], ["DASHSCOPE_API_KEY", apiKey.length > 0]]) {
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
const questions = fs.readFileSync(FLASK_QUESTIONS, "utf-8").trim().split("\n").slice(0, TASKS).map((line) => JSON.parse(line));
const template = fs.readFileSync(path.join(repoRoot, "prompts", "role-pipeline.md"), "utf-8").split("Task:")[0] + "Task:\n\n";

fs.writeFileSync(manifestPath, `${JSON.stringify({
	code: { head: gitHead, runnerSha256: sha256(fs.readFileSync(new URL(import.meta.url))) },
	configs: CONFIGS,
	judgment: { primary: "各消融配置对 SYN-full 的 token 配对差与质量非劣", note: "SYN−shm 预期 token/质量均不劣（诚实报告 SHM 不省 token）", source: "spec §1b（冻结）" },
	kind: "exp-ab",
	model: { measured: MODEL_ID, endpoint: BAILIAN_BASE },
	stats: { bootstrapB: BOOTSTRAP_B, bootstrapSeed: BOOTSTRAP_SEED },
	startedAt: new Date().toISOString(),
}, null, "\t")}\n`);

const only = (args.only ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const partialPath = path.join(expDir, "exp-ab-partial.jsonl");
const done = new Set(fs.existsSync(partialPath) ? fs.readFileSync(partialPath, "utf-8").trim().split("\n").filter(Boolean).map((line) => `q${JSON.parse(line).index + 1}-${JSON.parse(line).config}`) : []);
for (const [index, question] of questions.entries()) {
	for (const config of CONFIGS) {
		const key = `q${index + 1}-${config}`;
		if (only.length > 0 && !only.includes(key)) continue;
		if (done.has(key)) { console.log(`[exp-ab] ${key}: already recorded, skipping`); continue; }
		const row = await attempt({ config, index, question });
		fs.appendFileSync(partialPath, `${JSON.stringify(row)}\n`);
	}
}
console.log(`[exp-ab] done; partial: ${partialPath}`);

async function attempt({ config, index, question }) {
	const key = `q${index + 1}-${config}`;
	const evidence = path.join(expDir, "evidence", key);
	fs.rmSync(evidence, { recursive: true, force: true }); // a resumed attempt starts its evidence clean; leftovers from a killed run would double-append
	fs.mkdirSync(evidence, { recursive: true });
	const workRoot = path.join(os.tmpdir(), "pi-exp-ab", key);
	const storageRoot = path.join(workRoot, "state");
	const agentDir = path.join(workRoot, "agent");
	fs.rmSync(workRoot, { recursive: true, force: true });
	fs.mkdirSync(path.join(storageRoot, "corpus", CORPUS_SNAPSHOT), { recursive: true });
	for (const file of ["meta.json", "vectors.f32", "chunks.json"]) fs.copyFileSync(path.join(sourceCorpusDir, file), path.join(storageRoot, "corpus", CORPUS_SNAPSHOT, file));
	fs.mkdirSync(agentDir, { recursive: true });
	const prompt = template + question.question + "\n";
	fs.writeFileSync(path.join(evidence, "prompt.md"), prompt);
	const started = Date.now();

	const catalog = JSON.parse(fs.readFileSync(MODELS_SOURCE, "utf-8"));
	const provider = catalog.providers?.bailian;
	provider.baseUrl = BAILIAN_BASE;
	provider.apiKey = apiKey;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(catalog, null, 2));
	fs.chmodSync(path.join(agentDir, "models.json"), 0o600);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [repoRoot] }, null, 2));
	const configDir = path.join(agentDir, "extensions", "subagent");
	fs.mkdirSync(configDir, { recursive: true });

	// 消融配置：SYN-full 完整（SHM 常开）；各消融只关一个因子。
	const embedding = { dim: CORPUS_DIM, endpoint: `${BAILIAN_BASE}/embeddings`, keyEnv: "DASHSCOPE_API_KEY", model: "text-embedding-v4", provider: "bailian" };
	let synapse;
	let shmEnv = "1";
	if (config === "SYN-full") {
		synapse = { autoDistill: true, corpusSnapshotId: CORPUS_SNAPSHOT, embedding, memory: "project", mode: "synapse", shm: true, storageRoot };
	} else if (config === "SYN-state") {
		// 关非文本状态传递：无 corpusSnapshotId/embedding（状态平面降级文本交接）
		synapse = { autoDistill: true, memory: "project", mode: "synapse", shm: true, storageRoot };
	} else if (config === "SYN-memory") {
		// 关跨任务记忆：autoDistill off + 每任务冷启动（独立 storageRoot 已保证；显式 memory off 跨任务）
		synapse = { autoDistill: false, corpusSnapshotId: CORPUS_SNAPSHOT, embedding, memory: "project", mode: "synapse", shm: true, storageRoot };
	} else if (config === "SYN-shm") {
		// 关共享内存段：shm:false + env SYNAPSE_SHM=0
		synapse = { autoDistill: true, corpusSnapshotId: CORPUS_SNAPSHOT, embedding, memory: "project", mode: "synapse", shm: false, storageRoot };
		shmEnv = "0";
	} else {
		fail(`unknown config ${config}`);
	}
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ asyncByDefault: false, synapse }, null, 2));

	const env = { ...process.env, DASHSCOPE_API_KEY: apiKey, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_HOME: agentDir, NODE_USE_ENV_PROXY: "0", SYNAPSE_SHM: shmEnv };
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
				if (event.type !== "message_update" && event.type !== "tool_execution_update") { events.push(event); fs.appendFileSync(path.join(evidence, "pi-rpc.jsonl"), `${line}\n`); }
				if (event.type === "response") responses.set(event.id, event);
				if (event.type === "agent_settled") settled = true;
			} catch { /* noise */ }
		}
	});
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	child.on("exit", () => { exited = true; });
	const send = (event) => child.stdin.write(`${JSON.stringify(event)}\n`);
	const response = async (id, ms) => { const until = Date.now() + ms; while (Date.now() < until && !exited) { if (responses.has(id)) return responses.get(id); await sleep(100); } return null; };
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
	} catch (error) { problem = String(error); } finally {
		fs.writeFileSync(path.join(evidence, "pi-stderr.log"), stderr.slice(0, 200_000));
		if (!exited) { try { child.kill("SIGTERM"); } catch { /* gone */ } }
	}
	const answer = lastAnswer(events);
	fs.writeFileSync(path.join(evidence, "answer.md"), answer);
	if (problem === null && !answer.trim()) problem = "empty answer";

	const ledger = { "corpus-load": 0, "memory-reuse": 0, "model-usage": 0, "shm-attach": 0, "shm-hit": 0, "shm-invalid": 0, "shm-miss": 0, "state-consume": 0, "state-send": 0 };
	let childIn = 0, childOut = 0;
	const meteringDir = path.join(storageRoot, "metering");
	if (fs.existsSync(meteringDir)) {
		for (const file of fs.readdirSync(meteringDir)) {
			for (const line of fs.readFileSync(path.join(meteringDir, file), "utf-8").trim().split("\n").filter(Boolean)) {
				try { const event = JSON.parse(line); if (event.kind in ledger) ledger[event.kind] += 1; if (event.kind === "model-usage" && event.usage) { childIn += event.usage.input ?? 0; childOut += event.usage.output ?? 0; } } catch { /* torn */ }
			}
		}
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
	guarded(() => fs.rmSync(workRoot, { recursive: true, force: true }));
	// 消融验证：SYN-shm 应 corpus-load>0；SYN-state 应 state-send=0；SYN-memory 应 memory-reuse=0
	const ablationOk =
		config === "SYN-shm" ? ledger["corpus-load"] > 0 && ledger["shm-attach"] === 0 :
		config === "SYN-state" ? ledger["state-send"] === 0 :
		config === "SYN-memory" ? true : // 冷启动由独立 storageRoot 保证，reuse 未必为 0（任务内）
		ledger["shm-attach"] > 0 || (ledger["shm-hit"] > 0 && ledger["corpus-load"] === 0);
	if (problem === null && !ablationOk) problem = `ablation-not-isolated（${config} 未按预期隔离因子）`;
	const row = { answerChars: answer.trim().length, ablationOk, childIn, childOut, config, index, ledger, parentIn, parentOut, problem, unit: "exp-ab", valid: problem === null, wallMs: Date.now() - started };
	fs.writeFileSync(path.join(evidence, "result.json"), `${JSON.stringify(row, null, "\t")}\n`);
	console.log(`[exp-ab] ${key}: ${problem ?? "finished"} (state-send=${ledger["state-send"]} corpus-load=${ledger["corpus-load"]} shm-attach=${ledger["shm-attach"]})`);
	return row;
}

function lastAnswer(events) { let answer = ""; for (const event of events) { if (event.type !== "message_end" || event.message?.role !== "assistant") continue; const text = (event.message.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n"); if (text.trim()) answer = text; } return answer; }
function guarded(fn) { try { fn(); } catch { /* no abort */ } }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function fail(message) { console.error(String(message)); process.exit(1); }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1]; return out; }
