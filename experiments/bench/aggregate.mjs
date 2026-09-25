#!/usr/bin/env node
/**
 * SYNAPSE benchmark aggregation (plan A2).
 *
 *   node experiments/bench/aggregate.mjs <expDir>
 *
 * Reads <expDir>/manifest.json and rounds.jsonl, keeps the LAST valid attempt
 * per arm × group × round, and writes <expDir>/summary.json and report.md.
 *
 * Honesty rules:
 *  - A quantity nobody reported stays "unavailable" (or "N/A" where the
 *    product itself says so, e.g. a hit rate over zero queries). It is never
 *    replaced by 0, and every mean says how many rounds it covers.
 *  - Paired differences are TXT − SYN over the (group, round) pairs where BOTH
 *    arms have a valid round and a numeric value; a positive difference means
 *    SYN spent less. Each carries a percentile bootstrap 95% interval
 *    (B = 10000, seed 20260921 — the p50-aggregate.mjs implementation).
 *
 * Parent tokens are the parent's own assistant messages (record.parentUsage,
 * or the same sum re-read from the round's pi-rpc.log for records written
 * before the field existed). get_session_stats is never used for them: it
 * already includes the in-process children, which made every earlier total
 * count the children twice.
 *
 * Tokens: child tokens come from the metering ledger (model-usage, role child);
 * SYN0 (SYNAPSE off, no ledger by design) takes them from the children's own
 * artifacts meta files, which the runner records per round as childArtifacts
 * and which equal the ledger rows wherever both exist. Parent tokens come from
 * the ledger when it has them, else from the RPC session stats of the parent
 * process (source recorded per round). A round whose child usage is unavailable
 * has unavailable total tokens.
 *
 * "N/A" (not applicable) differs from "unavailable" (not reported): SYN0 has no
 * envelope, state or memory at all, so those metrics are N/A for it.
 */
import fs from "node:fs";
import path from "node:path";

const BOOTSTRAP_B = 10_000;
const BOOTSTRAP_SEED = 20260921;
const UNAVAILABLE = "unavailable";
const NOT_APPLICABLE = "N/A";
// Arms with SYNAPSE entirely off (memory off → no child contract): no envelope,
// state, memory or ledger exists, so those metrics are not applicable.
const NO_SYNAPSE_ARMS = new Set(["SYN0"]);
const SYNAPSE_ONLY_METRICS = ["crossAgentReuses", "distilled", "envelopeBytes", "handoffBytes", "hitRate", "hits", "messages", "queries", "reuses", "stateBytes", "stateSent"];

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function bootstrapInterval(diffs) {
	if (diffs.length === 0) return null;
	const rng = mulberry32(BOOTSTRAP_SEED);
	const means = [];
	for (let b = 0; b < BOOTSTRAP_B; b += 1) {
		let sum = 0;
		for (let i = 0; i < diffs.length; i += 1) sum += diffs[Math.floor(rng() * diffs.length)];
		means.push(sum / diffs.length);
	}
	means.sort((a, b) => a - b);
	const pick = (q) => means[Math.min(means.length - 1, Math.floor(q * means.length))];
	return [pick(0.025), pick(0.975)];
}

const readJsonl = (file) =>
	fs.existsSync(file)
		? fs
				.readFileSync(file, "utf-8")
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line))
		: [];

const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const nums = (values) => values.filter(isNum);
const allNotApplicable = (values) => values.length > 0 && values.every((v) => v === NOT_APPLICABLE);
const sum = (values) => (allNotApplicable(values) ? NOT_APPLICABLE : nums(values).length === 0 ? UNAVAILABLE : nums(values).reduce((s, v) => s + v, 0));
const mean = (values) => (allNotApplicable(values) ? NOT_APPLICABLE : nums(values).length === 0 ? UNAVAILABLE : nums(values).reduce((s, v) => s + v, 0) / nums(values).length);
function median(values) {
	const sorted = nums(values).sort((a, b) => a - b);
	if (sorted.length === 0) return UNAVAILABLE;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** input + output of a UsageTotals-shaped object, or unavailable. */
function tokensOf(usage) {
	if (usage === null || usage === undefined) return UNAVAILABLE;
	return isNum(usage.input) && isNum(usage.output) ? usage.input + usage.output : UNAVAILABLE;
}

/** The parent's own usage summed from a round's RPC log: assistant message_end events only. */
function parentUsageFromLog(logFile) {
	if (!fs.existsSync(logFile)) return null;
	const usage = { calls: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };
	for (const line of fs.readFileSync(logFile, "utf-8").split("\n")) {
		if (!line.includes('"message_end"')) continue;
		const at = line.indexOf("{");
		let event;
		try {
			event = JSON.parse(line.slice(at));
		} catch {
			continue;
		}
		if (event.type !== "message_end" || event.message?.role !== "assistant" || !event.message.usage) continue;
		usage.calls += 1;
		for (const key of ["cacheRead", "cacheWrite", "input", "output"]) usage[key] += event.message.usage[key] ?? 0;
	}
	return usage;
}

let EXP_DIR = null;

/** Per-round metrics from one valid rounds.jsonl record. Missing stays unavailable. */
function roundMetrics(record) {
	const t = record.totals;
	const get = (fn) => {
		if (t === null || t === undefined) return UNAVAILABLE;
		const value = fn(t);
		return value === undefined || value === null ? UNAVAILABLE : value;
	};
	const ledgerChild = get((x) => tokensOf(x.model?.child));
	const artifactChild = tokensOf(record.childArtifacts?.usage);
	const childTokens = isNum(ledgerChild) ? ledgerChild : NO_SYNAPSE_ARMS.has(record.arm) ? artifactChild : UNAVAILABLE;
	const childSource = isNum(ledgerChild) ? "ledger" : isNum(childTokens) ? "artifacts-meta" : UNAVAILABLE;
	const ledgerParent = get((x) => tokensOf(x.model?.parent));
	const logFile = EXP_DIR === null ? null : path.join(EXP_DIR, "evidence", record.arm, record.group, `round-${String(record.round).padStart(2, "0")}`, `attempt-${record.attempt}`, "pi-rpc.log");
	const ownParent = record.parentUsage ? tokensOf(record.parentUsage) : logFile === null ? UNAVAILABLE : tokensOf(parentUsageFromLog(logFile));
	const parentTokens = isNum(ledgerParent) ? ledgerParent : ownParent;
	const parentSource = isNum(ledgerParent) ? "ledger" : isNum(ownParent) ? (record.parentUsage ? "rpc-message-end" : "rpc-message-end (re-read from pi-rpc.log)") : UNAVAILABLE;
	const tokens = isNum(childTokens) && isNum(parentTokens) ? childTokens + parentTokens : UNAVAILABLE;
	const queries = get((x) => x.memory?.queries);
	const hitRate = get((x) => x.memory?.hitRate);
	const hits = isNum(queries) && isNum(hitRate) ? Math.round(hitRate * queries) : isNum(queries) && queries === 0 ? 0 : UNAVAILABLE;
	const metrics = {
		answerBytes: isNum(record.answerBytes) ? record.answerBytes : UNAVAILABLE,
		childSource,
		childTokens,
		crossAgentReuses: get((x) => x.memory?.crossAgentReuses),
		distilled: get((x) => x.memory?.distilled),
		envelopeBytes: get((x) => x.control?.envelopeBytes),
		handoffBytes: get((x) => x.text?.handoffBytes),
		hitRate,
		hits,
		messages: get((x) => x.messages?.delivered),
		parentSource,
		parentTokens,
		queries,
		reuses: get((x) => x.memory?.reuses),
		roles: record.roles?.seen?.length ?? UNAVAILABLE,
		runs: record.runIds?.length ?? 0,
		stateBytes: get((x) => x.state?.sentBytes),
		stateSent: get((x) => x.state?.sent),
		tokens,
		wallMs: isNum(record.wallMs) ? record.wallMs : UNAVAILABLE,
	};
	if (NO_SYNAPSE_ARMS.has(record.arm)) for (const key of SYNAPSE_ONLY_METRICS) metrics[key] = NOT_APPLICABLE;
	return metrics;
}

function cellMetrics(rows) {
	const col = (key) => rows.map((row) => row.metrics[key]);
	const queries = sum(col("queries"));
	const hits = sum(col("hits"));
	const tokenCoverage = nums(col("tokens")).length;
	return {
		rounds: rows.length,
		messages: { total: sum(col("messages")), meanPerRound: mean(col("messages")) },
		handoffBytes: { total: sum(col("handoffBytes")), meanPerRound: mean(col("handoffBytes")) },
		envelopeBytes: { total: sum(col("envelopeBytes")), meanPerRound: mean(col("envelopeBytes")) },
		tokens: {
			total: sum(col("tokens")),
			meanPerRound: mean(col("tokens")),
			child: { total: sum(col("childTokens")), coverage: nums(col("childTokens")).length, sources: [...new Set(col("childSource"))] },
			parent: { total: sum(col("parentTokens")), coverage: nums(col("parentTokens")).length, sources: [...new Set(col("parentSource"))] },
			coverage: tokenCoverage,
		},
		stateSent: { total: sum(col("stateSent")), meanPerRound: mean(col("stateSent")) },
		stateBytes: { total: sum(col("stateBytes")), meanPerRound: mean(col("stateBytes")) },
		wallMs: { mean: mean(col("wallMs")), median: median(col("wallMs")) },
		memory: {
			queries,
			hits,
			reuses: sum(col("reuses")),
			crossAgentReuses: sum(col("crossAgentReuses")),
			distilled: sum(col("distilled")),
			hitRate: queries === NOT_APPLICABLE ? NOT_APPLICABLE : isNum(queries) && isNum(hits) ? (queries === 0 ? "N/A" : hits / queries) : UNAVAILABLE,
		},
		answerBytes: { mean: mean(col("answerBytes")) },
		rolesMetered: { mean: mean(col("roles")), fourRoleRounds: col("roles").filter((n) => n === 4).length },
	};
}

function seriesOf(rows) {
	let cumQueries = 0;
	let cumHits = 0;
	let cumulativeKnown = true;
	return rows.map(({ round, metrics: m }) => {
		if (isNum(m.queries) && isNum(m.hits)) {
			cumQueries += m.queries;
			cumHits += m.hits;
		} else cumulativeKnown = false;
		return {
			round,
			tokens: m.tokens,
			wallMs: m.wallMs,
			handoffBytes: m.handoffBytes,
			envelopeBytes: m.envelopeBytes,
			stateSent: m.stateSent,
			stateBytes: m.stateBytes,
			hitRate: m.hitRate,
			cumulativeHitRate: m.queries === NOT_APPLICABLE ? NOT_APPLICABLE : !cumulativeKnown ? UNAVAILABLE : cumQueries === 0 ? "N/A" : cumHits / cumQueries,
			reuses: m.reuses,
		};
	});
}

const COMPARED = [
	["tokens", "总 token（父+子 input+output）"],
	["childTokens", "子会话 token"],
	["messages", "消息投递次数"],
	["handoffBytes", "文本交接字节 text.handoffBytes"],
	["envelopeBytes", "信封控制字节 control.envelopeBytes"],
	["stateSent", "状态传递次数 state.sent"],
	["stateBytes", "状态字节 state.sentBytes"],
	["wallMs", "单轮墙钟耗时（ms）"],
	["queries", "记忆查询次数"],
	["reuses", "记忆复用次数"],
	["crossAgentReuses", "跨 Agent 复用次数"],
	["answerBytes", "最终答案字节"],
];

/**
 * Paired comparison of arm A (baseline) against arm B over the (group, round)
 * pairs where both are valid and numeric. Keys are the lowercased arm names
 * (TXT-SYN → {txt, syn, …}). diff = A − B (positive = B spent less) with its
 * bootstrap interval; pct = (B − A) / A as a fraction (negative = B spent less), the shape the pi-web console reads.
 */
function compare(byKey, groups, rounds, metric, armA = "TXT", armB = "SYN") {
	const a = [];
	const b = [];
	const diffs = [];
	for (const group of groups) {
		for (let round = 1; round <= rounds; round += 1) {
			const ra = byKey.get(`${armA}/${group}/${round}`);
			const rb = byKey.get(`${armB}/${group}/${round}`);
			if (ra === undefined || rb === undefined) continue;
			const va = ra.metrics[metric];
			const vb = rb.metrics[metric];
			if (!isNum(va) || !isNum(vb)) continue;
			a.push(va);
			b.push(vb);
			diffs.push(va - vb);
		}
	}
	const ka = armA.toLowerCase();
	const kb = armB.toLowerCase();
	if (diffs.length === 0) return { [ka]: UNAVAILABLE, [kb]: UNAVAILABLE, diff: UNAVAILABLE, pct: UNAVAILABLE, ci: UNAVAILABLE, pairs: 0 };
	const meanA = mean(a);
	const meanB = mean(b);
	return {
		[ka]: meanA,
		[kb]: meanB,
		diff: mean(diffs),
		pct: meanA === 0 ? "N/A" : (meanB - meanA) / meanA,
		ci: bootstrapInterval(diffs),
		pairs: diffs.length,
	};
}

// A = baseline, B = treatment. Meanings follow the S5 §2.3 revision (2026-09-25).
const PAIRS = [
	["TXT", "SYN"],
	["SYNCOLD", "SYN"],
	["SYN0", "SYN"],
	["SYN0", "TXT"],
];
const PAIR_TITLES = {
	"TXT-SYN": "协议效果（text 模式 vs synapse 模式，记忆均开启）",
	"SYNCOLD-SYN": "跨轮记忆效果（同一协议与状态面，SYNCOLD 每轮清空记忆）",
	"SYN0-SYN": "SYNAPSE 整体效果（无 SYNAPSE 基线 vs 完整系统）",
	"SYN0-TXT": "text 模式 + 文本记忆效果（无 SYNAPSE 基线 vs TXT）",
};

// ---------------------------------------------------------------------------
// Report formatting.
// ---------------------------------------------------------------------------

function fmt(value, digits = 0) {
	if (value === UNAVAILABLE) return "不可用";
	if (value === "N/A") return "N/A";
	if (!isNum(value)) return "不可用";
	return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
const pctFmt = (value) => (isNum(value) ? `${(value * 100).toFixed(1)}%` : fmt(value));
const ciFmt = (ci, digits = 0) => (Array.isArray(ci) ? `[${fmt(ci[0], digits)}, ${fmt(ci[1], digits)}]` : "不可用");
const crosses = (ci) => (Array.isArray(ci) ? (ci[0] <= 0 && ci[1] >= 0 ? "跨 0" : "不跨 0") : "—");

function buildReport(summary, manifest) {
	const lines = [];
	const { arms, groups } = summary;
	lines.push(`# SYNAPSE 连续关联任务评测报告（${summary.experimentId}）`);
	lines.push("");
	lines.push(`- 生成时间：${summary.generatedAt}`);
	lines.push(`- 模型：${manifest.provider}/${manifest.model}；pi：${manifest.pi?.version ?? "不可用"}；Node：${manifest.node}`);
	lines.push(`- 代码：${manifest.code?.sha ?? "不可用"}${Array.isArray(manifest.code?.dirty) && manifest.code.dirty.length > 0 ? `（工作区有 ${manifest.code.dirty.length} 处未提交改动）` : ""}`);
	lines.push(`- 任务组：${(manifest.groups ?? []).map((g) => `${g.group} ${g.title}（sha256 ${String(g.familySha256).slice(0, 12)}…）`).join("；")}`);
	lines.push(`- 每组轮数：${manifest.rounds}；每轮最多尝试 ${manifest.attempts} 次；语义检索：${manifest.semantic === UNAVAILABLE ? "不可用（未配置 embedding key，SYN 仅关键词+标签检索）" : `${manifest.semantic}（${manifest.embedding?.representationId ?? "来源不明"}；TXT 为 text 模式，SYN0 为 SYNAPSE 全关）`}`);
	const corpus = manifest.corpus;
	lines.push(`- 语料库（状态面）：${corpus && typeof corpus === "object" ? `${String(corpus.corpusSnapshotId).slice(0, 12)}…，${corpus.chunks} chunks，窗口 ${corpus.window}/${corpus.overlap}，仅 SYN/SYNCOLD 配置` : corpus ?? "未配置（旧装置：SYN 不发状态）"}`);
	lines.push(`- 各臂配置：${(manifest.arms ?? []).map((a) => `${a.arm} = ${JSON.stringify({ ...a.config.synapse, storageRoot: undefined })}`).join("；")}`);
	if (manifest.armSemantics) lines.push(`- 各臂含义：${Object.entries(manifest.armSemantics).filter(([arm]) => arms.includes(arm)).map(([arm, text]) => `${arm}：${text}`).join("；")}`);
	lines.push(`- 执行顺序：每组内逐轮、各臂交替（${arms.map((arm) => `${arm} r1`).join(" → ")} → …）；store 跨轮、跨任务组保留（SYNCOLD 每次尝试前清空记忆）`);
	lines.push(`- 配对差 = A − B（正值 = B 更省）；节省 % = (A − B) / A；bootstrap B=${BOOTSTRAP_B}，seed=${BOOTSTRAP_SEED}；"不可用"表示没有上报，从不按 0 计`);
	lines.push("");
	lines.push("## 有效性");
	lines.push("");
	lines.push("| 组 | 任务组 | 计划轮数 | 有效轮数 | 尝试总数 | 四角色齐全轮数 |");
	lines.push("|---|---|---|---|---|---|");
	for (const arm of arms) {
		for (const group of groups) {
			const v = summary.validity.cells[arm]?.[group];
			lines.push(`| ${arm} | ${group} | ${v?.planned ?? 0} | ${v?.valid ?? 0} | ${v?.attempts ?? 0} | ${summary.cells[arm]?.[group]?.rolesMetered?.fourRoleRounds ?? 0} |`);
		}
	}
	if (summary.validity.invalid.length > 0) {
		lines.push("");
		lines.push("无效尝试（全部保留在 evidence/ 下）：");
		for (const item of summary.validity.invalid.slice(0, 40)) lines.push(`- ${item.arm} ${item.group} r${item.round} 第 ${item.attempt} 次：${item.problems.join("；")}`);
	}
	lines.push("");
	const pairTitles = PAIR_TITLES;
	for (const [pairKey, entry] of Object.entries(summary.comparisons ?? {})) {
		const [armA, armB] = pairKey.split("-");
		const ka = armA.toLowerCase();
		const kb = armB.toLowerCase();
		lines.push(`## 配对比较 ${armA} vs ${armB}：${pairTitles[pairKey] ?? ""}（全部任务组合并）`);
		lines.push("");
		lines.push(`| 指标 | ${armA} 均值/轮 | ${armB} 均值/轮 | 配对差 ${armA}−${armB} | ${armB} 相对 ${armA} 节省 % | 差的 95% 区间 | 跨 0？ | 配对数 |`);
		lines.push("|---|---|---|---|---|---|---|---|");
		for (const [metric, label] of COMPARED) {
			const c = entry[metric];
			if (!c) continue;
			lines.push(`| ${label} | ${fmt(c[ka], 1)} | ${fmt(c[kb], 1)} | ${fmt(c.diff, 1)} | ${isNum(c.pct) ? `${(-c.pct * 100).toFixed(1)}%` : fmt(c.pct)} | ${ciFmt(c.ci, 1)} | ${crosses(c.ci)} | ${c.pairs} |`);
		}
		lines.push("");
	}
	lines.push("## 分组明细");
	lines.push("");
	lines.push("| 组 | 任务组 | 轮数 | 消息数 | 交接字节 | 信封字节 | token（覆盖轮数） | 子会话 token | 状态次数/字节 | 耗时均值/中位（s） | 记忆查询/命中率 | 复用/跨 Agent |");
	lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
	const cellRow = (arm, group, c) =>
		`| ${arm} | ${group} | ${c.rounds} | ${fmt(c.messages.total)} | ${fmt(c.handoffBytes.total)} | ${fmt(c.envelopeBytes.total)} | ${fmt(c.tokens.total)}（${c.tokens.coverage}/${c.rounds}） | ${fmt(c.tokens.child.total)} | ${fmt(c.stateSent.total)} / ${fmt(c.stateBytes.total)} | ${isNum(c.wallMs.mean) ? (c.wallMs.mean / 1000).toFixed(1) : "不可用"} / ${isNum(c.wallMs.median) ? (c.wallMs.median / 1000).toFixed(1) : "不可用"} | ${fmt(c.memory.queries)} / ${pctFmt(c.memory.hitRate)} | ${fmt(c.memory.reuses)} / ${fmt(c.memory.crossAgentReuses)} |`;
	for (const group of groups) for (const arm of arms) if (summary.cells[arm]?.[group]) lines.push(cellRow(arm, group, summary.cells[arm][group]));
	for (const arm of arms) if (summary.overall[arm]) lines.push(cellRow(arm, "合计", summary.overall[arm]));
	lines.push("");
	lines.push("## 逐轮序列");
	for (const group of groups) {
		lines.push("");
		lines.push(`### ${group}`);
		lines.push("");
		lines.push("| 轮 | 组 | token | 耗时（s） | 交接字节 | 信封字节 | 状态次数/字节 | 命中率 | 累计命中率 | 复用 |");
		lines.push("|---|---|---|---|---|---|---|---|---|---|");
		const maxRound = summary.rounds;
		for (let round = 1; round <= maxRound; round += 1) {
			for (const arm of arms) {
				const p = summary.series[arm]?.[group]?.find((point) => point.round === round);
				if (!p) {
					lines.push(`| ${round} | ${arm} | 无有效轮 | | | | | | | |`);
					continue;
				}
				lines.push(`| ${round} | ${arm} | ${fmt(p.tokens)} | ${isNum(p.wallMs) ? (p.wallMs / 1000).toFixed(1) : "不可用"} | ${fmt(p.handoffBytes)} | ${fmt(p.envelopeBytes)} | ${fmt(p.stateSent)} / ${fmt(p.stateBytes)} | ${pctFmt(p.hitRate)} | ${pctFmt(p.cumulativeHitRate)} | ${fmt(p.reuses)} |`);
			}
		}
	}
	lines.push("");
	lines.push("## 口径说明");
	lines.push("");
	lines.push("- 消息数、交接字节、信封字节、状态次数/字节、记忆查询/复用均来自 `aggregateMetering`（src/synapse/metering.ts）对该轮全部 metering 运行的汇总。");
	lines.push("- 父会话 token 只算父会话自己的 assistant 消息（RPC `message_end` usage）；`get_session_stats` 已含进程内子会话，不再使用（此前的总 token 因此重复计入子会话）。");
	lines.push("- 子会话 token 来自账本 `model-usage`（role child）；SYN0 无账本（SYNAPSE 全关），取各子 Agent 的 `artifacts/*_meta.json` usage（与账本同源：两者并存的轮次逐位一致），来源记录在 summary.json（tokens.child.sources / tokens.parent.sources）。");
	lines.push("- \"N/A\" 表示该臂不存在这项机制（SYN0 没有信封、状态与记忆），\"不可用\" 表示应有而未上报；两者都从不按 0 计。");
	lines.push("- 命中率 = 有授权有效命中的查询数 / 查询数；查询数为 0 时为 N/A（不是 0%）。累计命中率按轮累加查询与命中后相除。");
	lines.push("- 区间跨 0 的差异不能表述为显著节省；配对数少于总轮数时，缺失轮的原因见“有效性”。");
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function main() {
	const expDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
	if (!expDir || !fs.existsSync(path.join(expDir, "manifest.json"))) {
		console.error("usage: aggregate.mjs <expDir>   (the directory holding manifest.json and rounds.jsonl)");
		process.exit(2);
	}
	EXP_DIR = expDir;
	const manifest = JSON.parse(fs.readFileSync(path.join(expDir, "manifest.json"), "utf-8"));
	const records = readJsonl(path.join(expDir, "rounds.jsonl"));
	const arms = (manifest.arms ?? []).map((a) => a.arm);
	const groups = (manifest.groups ?? []).map((g) => g.group);
	const rounds = manifest.rounds ?? 10;

	// Last valid attempt per arm/group/round (records are appended in run order).
	const byKey = new Map();
	const attempts = new Map();
	const invalid = [];
	for (const record of records) {
		const key = `${record.arm}/${record.group}/${record.round}`;
		attempts.set(key, (attempts.get(key) ?? 0) + 1);
		if (record.valid) byKey.set(key, { ...record, metrics: roundMetrics(record) });
		else invalid.push({ arm: record.arm, group: record.group, round: record.round, attempt: record.attempt, problems: record.problems ?? [] });
	}

	const cells = {};
	const overall = {};
	const series = {};
	const validity = { cells: {}, invalid, attemptsTotal: records.length, validTotal: byKey.size, plannedTotal: arms.length * groups.length * rounds };
	for (const arm of arms) {
		cells[arm] = {};
		series[arm] = {};
		validity.cells[arm] = {};
		const armRows = [];
		for (const group of groups) {
			const rows = [];
			let attemptCount = 0;
			for (let round = 1; round <= rounds; round += 1) {
				attemptCount += attempts.get(`${arm}/${group}/${round}`) ?? 0;
				const entry = byKey.get(`${arm}/${group}/${round}`);
				if (entry) rows.push({ round, metrics: entry.metrics });
			}
			const ran = records.some((r) => r.arm === arm && r.group === group);
			validity.cells[arm][group] = { planned: rounds, valid: rows.length, attempts: attemptCount, started: ran };
			cells[arm][group] = cellMetrics(rows);
			series[arm][group] = seriesOf(rows);
			armRows.push(...rows);
		}
		overall[arm] = cellMetrics(armRows);
	}
	const comparisons = {};
	for (const [armA, armB] of PAIRS) {
		if (!arms.includes(armA) || !arms.includes(armB)) continue;
		const entry = {};
		for (const [metric] of COMPARED) entry[metric] = compare(byKey, groups, rounds, metric, armA, armB);
		comparisons[`${armA}-${armB}`] = entry;
	}
	const comparison = comparisons["TXT-SYN"] ?? {};

	const summary = {
		experimentId: manifest.experimentId ?? path.basename(expDir),
		generatedAt: new Date().toISOString(),
		arms,
		groups,
		rounds,
		cells,
		overall,
		series,
		comparison,
		comparisons,
		validity,
		semantic: manifest.semantic ?? UNAVAILABLE,
		bootstrap: { B: BOOTSTRAP_B, seed: BOOTSTRAP_SEED, difference: "for pair A-B: diff = A − B (positive = B spent less), ci is the interval of diff; pct = (B − A) / A as a fraction (negative = B spent less)" },
	};
	fs.writeFileSync(path.join(expDir, "summary.json"), `${JSON.stringify(summary, null, "\t")}\n`, "utf-8");
	fs.writeFileSync(path.join(expDir, "report.md"), buildReport(summary, manifest), "utf-8");
	console.log(`summary: ${path.join(expDir, "summary.json")}`);
	console.log(`report:  ${path.join(expDir, "report.md")}`);
	console.log(`valid rounds ${byKey.size}/${validity.plannedTotal} (attempts ${records.length})`);
}

main();
