// EXP-B 关联任务链装置（spec §2，M7 + 记忆复用 20 分）。
//
// 两条件配对：连续（同 storageRoot 跨任务保留记忆+SHM 驻留）vs 独立冷启动（每任务全新）。
// 链 1（R-链）：Flask 前 N 题连续 vs 同 N 题独立；链 2（Q-链）：MuSiQue 同主题连问。
// 判定（冻结）：链上 vs 冷启动 token 配对差 CI；记忆命中率并列报；重访题检索次数下降
//   佐证"减少重复计算"。SHM 落点：连续条件时段也跨任务驻留（同 storageRoot）。
//
// 用法：node --experimental-strip-types experiments/openeuler/shm/exp-b-chain.mjs \
//   --exp-dir <dir> [--tasks 5] [--chain r|q] [--timeout-ms 1200000]
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
const MUSIQUE_FAMILY = path.join(repoRoot, "experiments", "bench", "families", "q-musique.json");
const MUSIQUE_WORKTREE = path.join(repoRoot, "experiments", "data", "worktree", "musique");
const MODELS_SOURCE = path.join(os.homedir(), ".pi", "agent", "models.json");
const BAILIAN_BASE = "https://llm-3m03faeswsufx2lq.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const MODEL_ID = "deepseek-v4.1-flash";

const args = parseArgs(process.argv.slice(2));
const expDir = path.resolve(args["exp-dir"] ?? "");
const TASKS = Number(args.tasks ?? 5);
const CHAIN = args.chain ?? "r";
const TIMEOUT_MS = Number(args["timeout-ms"] ?? 20 * 60_000);
const corpusCache = path.resolve(args["corpus-root"] ?? "/root/.pi/agent/synapse/experiments/_corpus-cache");

const apiKey = process.env.DASHSCOPE_API_KEY ?? "";
for (const [what, ok] of [["pi cli", fs.existsSync(PI_CLI)], ["models.json", fs.existsSync(MODELS_SOURCE)], ["DASHSCOPE_API_KEY", apiKey.length > 0]]) {
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
// 链 1=R（Flask），链 2=Q（MuSiQue 题族，任务在 worktree/musique）。
let questions, workCwd, template;
if (CHAIN === "r") {
	questions = fs.readFileSync(FLASK_QUESTIONS, "utf-8").trim().split("\n").slice(0, TASKS).map((line) => JSON.parse(line).question);
	workCwd = FLASK_SRC;
	template = fs.readFileSync(path.join(repoRoot, "prompts", "role-pipeline.md"), "utf-8").split("Task:")[0] + "Task:\n\n";
} else {
	const family = JSON.parse(fs.readFileSync(MUSIQUE_FAMILY, "utf-8"));
	questions = (family.tasks ?? family).slice(0, TASKS).map((t) => t.task ?? t.question);
	workCwd = MUSIQUE_WORKTREE;
	template = fs.readFileSync(path.join(repoRoot, "prompts", "role-pipeline.md"), "utf-8").split("Task:")[0] + "Task:\n\n";
}

fs.writeFileSync(manifestPath, `${JSON.stringify({
	chain: CHAIN,
	code: { head: gitHead, runnerSha256: sha256(fs.readFileSync(new URL(import.meta.url))) },
	judgment: { primary: "链上 vs 冷启动 token 配对差 CI；命中率并列报", source: "spec §2（冻结）" },
	kind: "exp-b-chain",
	model: { measured: MODEL_ID, endpoint: BAILIAN_BASE },
	stats: { bootstrapB: BOOTSTRAP_B, bootstrapSeed: BOOTSTRAP_SEED },
	startedAt: new Date().toISOString(),
}, null, "\t")}\n`);

// 两条件：chain（同 storageRoot）vs cold（每任务独立）。同题两条件交替。
const results = [];
for (const condition of ["chain", "cold"]) {
	// 连续条件共用一个 storageRoot（跨任务记忆+SHM 驻留）；冷启动每任务新建。
	const chainStorageRoot = path.join(os.tmpdir(), "pi-exp-b", `${CHAIN}-chain-state`);
	if (condition === "chain") {
		fs.rmSync(chainStorageRoot, { recursive: true, force: true });
		fs.mkdirSync(path.join(chainStorageRoot, "corpus", CORPUS_SNAPSHOT), { recursive: true });
		for (const file of ["meta.json", "vectors.f32", "chunks.json"]) fs.copyFileSync(path.join(sourceCorpusDir, file), path.join(chainStorageRoot, "corpus", CORPUS_SNAPSHOT, file));
	}
	for (const [index, question] of questions.entries()) {
		const storageRoot = condition === "chain" ? chainStorageRoot : path.join(os.tmpdir(), "pi-exp-b", `${CHAIN}-cold-${index}-state`);
		if (condition === "cold") {
			fs.rmSync(storageRoot, { recursive: true, force: true });
			fs.mkdirSync(path.join(storageRoot, "corpus", CORPUS_SNAPSHOT), { recursive: true });
			for (const file of ["meta.json", "vectors.f32", "chunks.json"]) fs.copyFileSync(path.join(sourceCorpusDir, file), path.join(storageRoot, "corpus", CORPUS_SNAPSHOT, file));
		}
		const row = await attempt({ condition, index, question, storageRoot });
		results.push(row);
		fs.appendFileSync(path.join(expDir, "exp-b-partial.jsonl"), `${JSON.stringify(row)}\n`);
	}
}
console.log(`[exp-b] done; ${results.length} attempts`);

async function attempt({ condition, index, question, storageRoot }) {
	const key = `${CHAIN}-${condition}-t${index + 1}`;
	const evidence = path.join(expDir, "evidence", key);
	fs.rmSync(evidence, { recursive: true, force: true }); // a resumed attempt starts its evidence clean; leftovers from a killed run would double-append
	fs.mkdirSync(evidence, { recursive: true });
	const agentDir = path.join(os.tmpdir(), "pi-exp-b", `${key}-agent`);
	fs.rmSync(agentDir, { recursive: true, force: true });
	fs.mkdirSync(agentDir, { recursive: true });
	const prompt = template + question + "\n";
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
	// 完整形态 + SHM 常开（两条件唯一差异=storageRoot 是否跨任务保留）。
	const synapse = { autoDistill: true, corpusSnapshotId: CORPUS_SNAPSHOT, embedding: { dim: CORPUS_DIM, endpoint: `${BAILIAN_BASE}/embeddings`, keyEnv: "DASHSCOPE_API_KEY", model: "text-embedding-v4", provider: "bailian" }, memory: "project", mode: "synapse", shm: true, storageRoot };
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ asyncByDefault: false, synapse }, null, 2));

	const env = { ...process.env, DASHSCOPE_API_KEY: apiKey, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_HOME: agentDir, NODE_USE_ENV_PROXY: "0", SYNAPSE_SHM: "1" };
	const child = spawn(process.execPath, [PI_CLI, "--no-themes", "--no-context-files", "--no-session", "--offline", "--mode", "rpc", "--provider", "bailian", "--model", MODEL_ID, "--thinking", "high", "--tools", "subagent"], { cwd: workCwd, env, stdio: ["pipe", "pipe", "pipe"] });
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

	const ledger = { "corpus-load": 0, "memory-query": 0, "memory-reuse": 0, "model-usage": 0, "shm-attach": 0, "shm-hit": 0, "state-consume": 0, "state-send": 0 };
	let childIn = 0, childOut = 0;
	const meteringDir = path.join(storageRoot, "metering");
	if (fs.existsSync(meteringDir)) {
		for (const file of fs.readdirSync(meteringDir)) {
			for (const line of fs.readFileSync(path.join(meteringDir, file), "utf-8").trim().split("\n").filter(Boolean)) {
				try { const event = JSON.parse(line); if (event.kind in ledger) ledger[event.kind] += 1; if (event.kind === "model-usage" && event.usage) { childIn += event.usage.input ?? 0; childOut += event.usage.output ?? 0; } } catch { /* torn */ }
			}
		}
		// 连续条件的账本跨任务累积，每任务拷贝快照（不删源）
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
	// 跨任务记忆复用证据：连续条件第 2 任务起 memory-reuse 应 >0（复用前序任务记忆）。
	const row = { answerChars: answer.trim().length, chain: CHAIN, childIn, childOut, condition, index, ledger, parentIn, parentOut, problem, unit: "exp-b", valid: problem === null, wallMs: Date.now() - started };
	fs.writeFileSync(path.join(evidence, "result.json"), `${JSON.stringify(row, null, "\t")}\n`);
	console.log(`[exp-b] ${key}: ${problem ?? "finished"} (memory-reuse=${ledger["memory-reuse"]} corpus-load=${ledger["corpus-load"]} token=${parentIn + childIn}/${parentOut + childOut})`);
	return row;
}

function lastAnswer(events) { let answer = ""; for (const event of events) { if (event.type !== "message_end" || event.message?.role !== "assistant") continue; const text = (event.message.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n"); if (text.trim()) answer = text; } return answer; }
function guarded(fn) { try { fn(); } catch { /* no abort */ } }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function fail(message) { console.error(String(message)); process.exit(1); }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1]; return out; }
