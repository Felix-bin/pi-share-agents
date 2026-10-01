// EXP-C：M8 口径聚合脚本（spec: 2026-10-01-synapse-final-experiment-design.md §3）。
//
// 从每 attempt 的 v7 账本（metering/*.jsonl）+ pi-rpc.jsonl + llm-calls.jsonl + handoffs.jsonl
// 聚合出赛题 M8 六统计项，外加工具使用频率表（后期优化入口）。
//
// M8 六统计项（竞赛赛题.md L47 原文）：
//   ① Agent 间消息次数 ② 文本通信 token/字符开销 ③ 非文本状态传递次数及数据规模
//   ④ 单任务总耗时 ⑤ 共享记忆命中率 ⑥ 整体性能提升（臂间配对差，报告层算）
//
// 用法（仓库根）：
//   node --experimental-strip-types experiments/openeuler/shm/m8-aggregate.mjs --evidence <attempt-evidence-dir> [--out <json>]
//   # attempt-evidence-dir = 含 metering/ pi-rpc.jsonl llm-calls.jsonl handoffs.jsonl 的目录
//
// 纪律：unavailable ≠ 0（撕裂尾行跳过记 tornLines；metering 缺失记 meteringMissing）；零 API。
import * as fs from "node:fs";
import * as path from "node:path";

const args = parseArgs(process.argv.slice(2));
const evidenceDir = path.resolve(args.evidence ?? "");
const outPath = args.out ? path.resolve(args.out) : null;

if (!fs.existsSync(evidenceDir)) fail(`evidence dir not found: ${evidenceDir}`);

// --- 读 metering（容错：撕裂尾行跳过） ------------------------------------------

function readMeteringDir(dir) {
	const events = [];
	let tornLines = 0;
	if (!fs.existsSync(dir)) return { events, tornLines, missing: true };
	for (const file of fs.readdirSync(dir)) {
		if (!file.endsWith(".jsonl")) continue;
		for (const line of fs.readFileSync(path.join(dir, file), "utf-8").split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try { events.push(JSON.parse(t)); } catch { tornLines += 1; }
		}
	}
	return { events, tornLines, missing: events.length === 0 };
}

function readJsonl(file) {
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// --- M8 聚合 ---------------------------------------------------------------------

function aggregate(evidenceDir) {
	const { events, tornLines, missing } = readMeteringDir(path.join(evidenceDir, "metering"));
	const rpc = readJsonl(path.join(evidenceDir, "pi-rpc.jsonl"));
	const llmCalls = readJsonl(path.join(evidenceDir, "llm-calls.jsonl"));
	const handoffs = readJsonl(path.join(evidenceDir, "handoffs.jsonl"));

	const count = (kind) => events.filter((e) => e.kind === kind).length;
	const sum = (kind, field) => events.filter((e) => e.kind === kind).reduce((s, e) => s + (e[field] ?? 0), 0);

	// ① 消息次数
	const messageDelivered = count("message-delivered");
	const messageReceived = count("message-received");
	const messageFailed = count("message-failed");

	// ② token / 字符开销
	let tokenIn = 0, tokenOut = 0, tokenCacheRead = 0, tokenCacheWrite = 0;
	for (const e of events) {
		if (e.kind !== "model-usage" || !e.usage) continue;
		tokenIn += e.usage.input ?? 0;
		tokenOut += e.usage.output ?? 0;
		tokenCacheRead += e.usage.cacheRead ?? 0;
		tokenCacheWrite += e.usage.cacheWrite ?? 0;
	}
	const charHandoff = sum("message-delivered", "textBytes");
	const charEnvelope = sum("message-delivered", "envelopeBytes");
	const charStageResult = sum("stage-result", "renderedBytes");

	// ③ 非文本状态传递次数 + 数据规模（按 encoding 拆 delta/float32）
	const statePrepare = events.filter((e) => e.kind === "state-prepare" && e.ok).length;
	const stateSend = events.filter((e) => e.kind === "state-send" && e.ok).length;
	const stateReceive = events.filter((e) => e.kind === "state-receive" && e.ok).length;
	const stateConsume = events.filter((e) => e.kind === "state-consume" && e.ok).length;
	const stateBytesByEncoding = {};
	for (const e of events) {
		if (e.kind !== "state-send" || !e.ok) continue;
		const enc = e.encoding ?? "float32-vector";
		stateBytesByEncoding[enc] = (stateBytesByEncoding[enc] ?? 0) + (e.payloadBytes ?? 0);
	}
	const statePayloadBytes = sum("state-send", "payloadBytes");

	// ④ 耗时（task-span 起止配对 + 各阶段 durationMs + 总时长）
	const taskSpans = {};
	for (const e of events) {
		if (e.kind !== "task-span") continue;
		const id = e.taskId;
		if (!taskSpans[id]) taskSpans[id] = { agent: e.agent ?? null };
		if (e.phase === "start") taskSpans[id].startMs = e.monotonicMs;
		if (e.phase === "end") taskSpans[id].endMs = e.monotonicMs;
	}
	const taskDurations = Object.entries(taskSpans)
		.filter(([, s]) => s.startMs !== undefined && s.endMs !== undefined)
		.map(([taskId, s]) => ({ taskId, agent: s.agent, durationMs: s.endMs - s.startMs }));
	const embeddingMs = sum("embedding-call", "durationMs");
	const corpusLoadMs = sum("corpus-load", "durationMs");
	const shmAttachMicros = sum("shm-attach", "attachMicros");
	// 总时长：父 writer（pid 最小/首个 process-identity）的 monotonicMs 极差
	const monoEvents = events.filter((e) => typeof e.monotonicMs === "number");
	const totalMs = monoEvents.length >= 2 ? Math.max(...monoEvents.map((e) => e.monotonicMs)) - Math.min(...monoEvents.map((e) => e.monotonicMs)) : null;

	// ⑤ 记忆命中率（query 里 authorisedValidHits>0 的比例 + 跨 agent reuse 数）
	const memoryQueries = events.filter((e) => e.kind === "memory-query");
	const memoryHits = memoryQueries.filter((e) => (e.authorisedValidHits ?? 0) > 0).length;
	const memoryReuses = events.filter((e) => e.kind === "memory-reuse" && e.sourceAgent && e.agent && e.sourceAgent !== e.agent).length;
	const memoryHitRate = memoryQueries.length === 0 ? null : memoryHits / memoryQueries.length;

	// SHM 证据
	const shmAttach = count("shm-attach");
	const shmHit = count("shm-hit");
	const shmMiss = count("shm-miss");
	const shmInvalid = count("shm-invalid");
	const corpusLoad = count("corpus-load");
	const corpusLoadBytes = sum("corpus-load", "bytesRead");

	// --- 工具使用频率表（pi-rpc tool_execution + llm-calls tool_calls + handoffs） ---
	const toolFreq = {};
	const toolStart = {};
	for (const e of rpc) {
		if (e.type === "tool_execution_start") {
			toolStart[e.toolCallId] = Date.now(); // pi-rpc 无时间戳，用接收顺序近似（精确耗时见下）
			const t = e.toolName ?? "unknown";
			if (!toolFreq[t]) toolFreq[t] = { calls: 0, argBytes: 0, resultBytes: 0, source: "pi-rpc" };
			toolFreq[t].calls += 1;
			toolFreq[t].argBytes += JSON.stringify(e.args ?? {}).length;
		}
		if (e.type === "tool_execution_end") {
			const t = e.toolName ?? "unknown";
			if (toolFreq[t]) toolFreq[t].resultBytes += JSON.stringify(e.result ?? "").length;
		}
	}
	// llm-calls 的 tool_calls（LLM 层，含子会话归因 role）
	for (const c of llmCalls) {
		for (const tc of c.response?.tool_calls ?? []) {
			const t = tc.function?.name ?? tc.name ?? "unknown";
			if (!toolFreq[t]) toolFreq[t] = { calls: 0, argBytes: 0, resultBytes: 0, source: "llm-calls" };
			toolFreq[t].calls += 1;
			toolFreq[t].argBytes += (tc.function?.arguments ?? "").length;
		}
	}
	// handoffs（框架臂交接次数与字节）
	const handoffCount = handoffs.length;
	const handoffBytes = handoffs.reduce((s, h) => s + (h.bytes ?? 0), 0);

	return {
		evidenceDir,
		m8: {
			"1-消息次数": { delivered: messageDelivered, received: messageReceived, failed: messageFailed },
			"2-token字符开销": {
				tokenIn, tokenOut, tokenCacheRead, tokenCacheWrite, tokenTotal: tokenIn + tokenOut,
				charHandoffBytes: charHandoff, charEnvelopeBytes: charEnvelope, charStageResultBytes: charStageResult,
			},
			"3-非文本状态传递": {
				prepare: statePrepare, send: stateSend, receive: stateReceive, consume: stateConsume,
				payloadBytesTotal: statePayloadBytes, payloadBytesByEncoding: stateBytesByEncoding,
			},
			"4-耗时": {
				totalMs,
				taskDurations,
				embeddingMs: +embeddingMs.toFixed(1),
				corpusLoadMs: +corpusLoadMs.toFixed(3),
				shmAttachMicros: +shmAttachMicros.toFixed(1),
			},
			"5-记忆命中率": { queries: memoryQueries.length, hits: memoryHits, hitRate: memoryHitRate, crossAgentReuses: memoryReuses },
			"6-整体提升": "臂间配对差，报告层计算（EXP-A/B 报告）",
		},
		shm: { attach: shmAttach, hit: shmHit, miss: shmMiss, invalid: shmInvalid, corpusLoad, corpusLoadBytes },
		toolFrequency: toolFreq,
		handoffs: { count: handoffCount, bytes: handoffBytes },
		dataQuality: { meteringMissing: missing, tornLines, rpcEvents: rpc.length, llmCalls: llmCalls.length },
	};
}

const result = aggregate(evidenceDir);
const text = JSON.stringify(result, null, "\t");
if (outPath) { fs.writeFileSync(outPath, `${text}\n`); console.log(`written: ${outPath}`); }
else console.log(text);

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1];
	return out;
}
function fail(message) { console.error(String(message)); process.exit(1); }
