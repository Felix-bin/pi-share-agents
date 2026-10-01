// LongMemEval 正式化检索装置（spec: 2026-10-01-synapse-final-experiment-design.md §2 链 3）。
//
// 取代一次性试跑 scripts/lme-trial.mjs。判定口径按官方（arXiv 2410.10813 / GitHub
// xiaowu0162/LongMemEval src/retrieval/eval_utils.py）核实结论冻结于数据产生之前：
//   - 剔除 `_abs` 题（官方：30 abstention instances 无证据位置，不进检索评测）
//   - 每题 recall_all@k = all-hit 二值指示（全部 gold 会话都进 top-k 才记 1）
//     与 recall_any@k = any-hit 二值指示（任一 gold 会话进 top-k 即记 1）
//   - session 粒度，对所有非 _abs 题算术平均（官方打印脚本口径）
//   - gold = answer_session_ids（含 "answer" 子串的会话 id）
//
// 与官方的差异（如实声明）：检索器不是官方 Stella/Contriever/gte，而是 SYNAPSE 共享记忆库
//   （text-embedding-v4 dim1024 语义检索 + keyword/tag 三分量排序）；官方 recall 语义以代码
//   （eval_utils.py）为准，论文表格数字在 LongMemEval M 上、本装置在 _s 上，不直接可比。
//
// 用法（openEuler/WSL，仓库根）：
//   DASHSCOPE_API_KEY 在环境里；
//   node --experimental-strip-types experiments/openeuler/shm/lme.mjs --exp-dir <dir> [--data <json>] [--n 100] [--k 5] [--limit-store false]
//
// 纪律：manifest 存在即拒绝原地重启；流式读数据（264MB 不能整体 JSON.parse）；
//   每实例独立 namespaceId+storeRoot（互不干扰）；零 LLM（只嵌入+检索判定）。
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BOOTSTRAP_B, BOOTSTRAP_SEED, sha256 } from "./matrix.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const args = parseArgs(process.argv.slice(2));
const expDir = path.resolve(args["exp-dir"] ?? "");
const DATA = path.resolve(args.data ?? "/mnt/d/WSL/lme/longmemeval_s_cleaned.json");
const N = Number(args.n ?? 100);
const K = Number(args.k ?? 5);
// 会话体超过该字节则正文截断灌库（控制嵌入成本与单记录体积；0=不截断）。
const MAX_SESSION_BYTES = Number(args["max-session-bytes"] ?? 64 * 1024);

const ENV_CANDIDATES = ["D:/操作系统开源大赛/synapse/.env", path.join(repoRoot, ".env")];

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a.startsWith("--") && i + 1 < argv.length) { out[a.slice(2)] = argv[i + 1]; i += 1; }
	}
	return out;
}

function fail(message) {
	console.error(message);
	process.exit(1);
}

function loadKey() {
	if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
	for (const file of ENV_CANDIDATES) {
		if (!fs.existsSync(file)) continue;
		for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
			const t = line.trim();
			if (t.startsWith("DASHSCOPE_API_KEY=")) return t.slice("DASHSCOPE_API_KEY=".length).trim();
		}
	}
	fail("DASHSCOPE_API_KEY not in env and not in any .env candidate");
}

// --- gates ------------------------------------------------------------------

if (!fs.existsSync(DATA)) fail(`data not found: ${DATA}`);
if (fs.existsSync(path.join(expDir, "manifest.json"))) fail("manifest already exists — an experiment is never restarted in place; use a new --exp-dir");
fs.mkdirSync(expDir, { recursive: true });

const [{ createEmbeddingClient }, { createMemoryService }] = await Promise.all([
	import("../../../src/synapse/embedding.ts"),
	import("../../../src/synapse/memory-service.ts"),
]);

// --- manifest（冻结于数据产生之前） -------------------------------------------

const dataSha = sha256(fs.readFileSync(DATA));
const selfSha = sha256(fs.readFileSync(new URL(import.meta.url)));
const gitHead = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim(); } catch { return "unknown"; } })();
const manifest = {
	code: { head: gitHead, runnerSha256: selfSha },
	data: { path: DATA, sha256: dataSha, note: "xiaowu0162/longmemeval-cleaned (_s with distractors); HF 直连未核对，sha256 冻结本文件" },
	device: {
		retriever: "synapse-memory-service.searchSemantic (text-embedding-v4/1024 semantic + keyword/tag 三分量)",
		embedding: { provider: "bailian", model: "text-embedding-v4", dim: 1024 },
		maxSessionBytes: MAX_SESSION_BYTES,
		perInstanceIsolation: "独立 namespaceId(question_id sha256 前16) + 独立 storeRoot",
	},
	judgment: {
		granularity: "session",
		skipAbs: true,
		recallAllK: "all-hit 二值（全部 gold 会话进 top-k 记 1），k=" + K,
		recallAnyK: "any-hit 二值（任一 gold 会话进 top-k 记 1），k=" + K,
		aggregate: "对非 _abs 题算术平均",
		gold: "answer_session_ids",
		source: "arXiv 2410.10813 + github.com/xiaowu0162/LongMemEval src/retrieval/eval_utils.py（2026-10-01 核实）",
		differences: "检索器非官方 Stella/Contriever/gte；官方数字在 LongMemEval M 上不直接可比",
	},
	kind: "lme-retrieval",
	n: N,
	k: K,
	startedAt: new Date().toISOString(),
	stats: { bootstrapB: BOOTSTRAP_B, bootstrapSeed: BOOTSTRAP_SEED },
};
fs.writeFileSync(path.join(expDir, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

// --- 数据流式读取（JSON 数组，逐实例） ----------------------------------------

// _s_cleaned.json 是 pretty-printed 的 JSON 数组（264MB，不能整体 parse）。状态机按花括号
// 深度切出顶层对象；字符串内的大括号不计；数组顶层 `[`/`]` 与实例间逗号在未 started 时丢弃。
async function* iterateInstances(filePath) {
	const rl = readline.createInterface({ input: fs.createReadStream(filePath, "utf-8"), crlfDelay: Infinity });
	let depth = 0, buf = "", inString = false, escape = false, started = false, arrayDepth = 0;
	for await (const line of rl) {
		for (const ch of line) {
			if (escape) { escape = false; if (started) buf += ch; continue; }
			if (ch === "\\") { escape = true; if (started) buf += ch; continue; }
			if (ch === '"') { inString = !inString; if (started) buf += ch; continue; }
			if (inString) { if (started) buf += ch; continue; }
			if (ch === "[") { arrayDepth += 1; if (started) buf += ch; continue; }
			if (ch === "]") { arrayDepth -= 1; if (started) buf += ch; continue; }
			if (ch === "{") { depth += 1; started = true; buf += ch; continue; }
			if (ch === "}") {
				depth -= 1; buf += ch;
				if (depth === 0 && started) { yield JSON.parse(buf); buf = ""; started = false; }
				continue;
			}
			if (started) buf += ch;
		}
		if (started && buf.length > 0) buf += "\n";
	}
}

// --- 主流程 -------------------------------------------------------------------

const embedder = createEmbeddingClient(
	{ provider: "bailian", endpoint: "https://llm-3m03faeswsufx2lq.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings", model: "text-embedding-v4", dim: 1024, keyEnv: "DASHSCOPE_API_KEY" },
	{ key: loadKey() },
);

const workRoot = path.join(expDir, "work");
fs.mkdirSync(workRoot, { recursive: true });
const resultsPath = path.join(expDir, "results.jsonl");
const resultsOut = fs.createWriteStream(resultsPath, { flags: "a" });

let seen = 0;
let processed = 0;
let totalEmbeddingCalls = 0;
let totalEmbeddingMs = 0;

for await (const inst of iterateInstances(DATA)) {
	seen += 1;
	// 官方：剔除 _abs 题（无证据位置，不进检索评测）。
	if (String(inst.question_id ?? "").includes("_abs")) { console.log(`[lme] skip _abs ${inst.question_id}`); continue; }
	if (processed >= N) break;
	processed += 1;

	const questionId = String(inst.question_id);
	const namespaceId = createHash("sha256").update(`lme-${questionId}`).digest("hex").slice(0, 16);
	const storeRoot = path.join(workRoot, `store-${questionId}`);
	const worktreeRoot = path.join(workRoot, `wt-${questionId}`);
	fs.rmSync(storeRoot, { recursive: true, force: true });
	fs.mkdirSync(storeRoot, { recursive: true });
	fs.mkdirSync(worktreeRoot, { recursive: true });

	const meteringDir = path.join(storeRoot, "metering");
	fs.mkdirSync(meteringDir, { recursive: true });
	const meteringLogPath = path.join(meteringDir, `${namespaceId}.jsonl`);
	const { createMeteringLog } = await import("../../../src/synapse/metering.ts");
	const metering = {
		identity: { agent: "lme", attempt: 1, mode: "synapse", nodeId: "lme-node", runId: `lme-${namespaceId.slice(0, 8)}`, sessionId: `lme-${questionId}`, snapshotId: null },
		log: createMeteringLog(meteringLogPath),
	};

	const service = createMemoryService({
		embedder,
		metering,
		provenance: { agent: "lme", attempt: 1, runId: metering.identity.runId, sessionId: metering.identity.sessionId },
		scope: { agent: "lme", namespaceId, pathPrefixes: [""], write: true },
		storeRoot,
		worktreeRoot,
	});

	// 灌库：一个会话一条记录；tags 带会话 id；正文超阈值截断。
	const sessions = inst.haystack_sessions ?? [];
	const sessionIds = inst.haystack_session_ids ?? [];
	let stored = 0;
	for (let i = 0; i < sessions.length; i += 1) {
		const messages = sessions[i] ?? [];
		let content = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
		if (content.trim().length === 0) continue;
		if (MAX_SESSION_BYTES > 0 && Buffer.byteLength(content, "utf-8") > MAX_SESSION_BYTES) {
			content = content.slice(0, MAX_SESSION_BYTES);
		}
		const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
		await service.remember({
			content,
			kind: "evidence",
			operationId: `lme-${questionId}-s${i}`,
			summary: firstUser.slice(0, 200),
			tags: [sessionIds[i] ?? `s${i}`],
			topic: questionId,
		});
		stored += 1;
	}

	// 检索：searchSemantic（语义 cosine + keyword/tag 三分量）。
	const embedT0 = process.hrtime.bigint();
	const found = await service.searchSemantic({ query: inst.question, k: K });
	totalEmbeddingMs += Number(process.hrtime.bigint() - embedT0) / 1e6;

	const hitTags = (found.results ?? []).flatMap((r) => r.tags ?? []);
	const gold = inst.answer_session_ids ?? [];
	const hitGold = gold.filter((id) => hitTags.includes(id));
	// 官方二值口径：all-hit / any-hit（非部分折算）。
	const recallAll = gold.length === 0 ? null : (hitGold.length === gold.length ? 1 : 0);
	const recallAny = gold.length === 0 ? null : (hitGold.length > 0 ? 1 : 0);

	const row = {
		goldHit: hitGold.length,
		goldSessions: gold.length,
		hits: (found.results ?? []).map((r) => ({ components: r.components, cosine: r.components?.semantic?.cosine ?? null, score: r.score, summary: (r.summary ?? "").slice(0, 80), tags: r.tags })),
		question_id: questionId,
		question_type: inst.question_type,
		recallAll,
		recallAny,
		semantic: found.semantic,
		sessions: sessions.length,
		stored,
		valid: found.semantic === "ok",
		problem: found.semantic === "ok" ? null : "semantic-unavailable（语义检索降级，结果按 keyword/tag 口径，不计入官方语义口径结论）",
	};
	resultsOut.write(`${JSON.stringify(row)}\n`);
	console.log(`[lme] ${processed}/${N} ${questionId}: sessions=${sessions.length} gold=${gold.length} hit=${hitGold.length} recall_all=${recallAll} recall_any=${recallAny} semantic=${found.semantic}`);
}
resultsOut.end();

// 嵌入调用账本统计。
let embedCalls = 0;
try {
	const { readMeteringLog } = await import("../../../src/synapse/metering.ts");
	// 各实例独立 metering 文件；汇总（可选，代价高时省略——results.jsonl 已有逐题证据）。
	void readMeteringLog;
} catch { /* metering 汇总失败不阻塞主结论 */ }

// 聚合：对非 _abs 题算术平均（官方口径）。
const allRows = fs.existsSync(resultsPath) ? fs.readFileSync(resultsPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const valid = allRows.filter((r) => r.recallAll !== null);
const semanticOk = allRows.filter((r) => r.semantic === "ok");
const mean = (arr, key) => (arr.length === 0 ? null : arr.reduce((s, r) => s + r[key], 0) / arr.length);
const summary = {
	embeddingCalls: embedCalls,
	meanRecallAllAtK: mean(valid, "recallAll"),
	meanRecallAnyAtK: mean(valid, "recallAny"),
	meanRecallAllAtK_semanticOnly: mean(semanticOk, "recallAll"),
	meanRecallAnyAtK_semanticOnly: mean(semanticOk, "recallAny"),
	n: valid.length,
	nSemanticOk: semanticOk.length,
	processed,
	seen,
	skippedAbs: seen - processed,
	totalEmbeddingMs: +totalEmbeddingMs.toFixed(1),
};
fs.writeFileSync(path.join(expDir, "summary.json"), `${JSON.stringify(summary, null, "\t")}\n`);
console.log(`\n[lme] mean recall_all@${K} = ${summary.meanRecallAllAtK} (n=${valid.length}, semantic-ok=${semanticOk.length})`);
console.log(`[lme] mean recall_any@${K} = ${summary.meanRecallAnyAtK}`);
console.log(`[lme] written: ${path.join(expDir, "summary.json")}`);
