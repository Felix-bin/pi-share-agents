#!/usr/bin/env node
/**
 * P4-5 aggregator: reads an experiment directory the runner produced and emits
 * the four pre-registered tables, the M8 three-account layered table, and the
 * paired statistics §13 requires (point estimate per the wide threshold, paired
 * interval beside every difference with its crossing-zero status stated).
 *
 *   node --experimental-strip-types scripts/p45-aggregate.mjs <expDir>
 *
 * Nothing trusts the runner's summary: round validity, the steer evidence and
 * every byte are re-derived here from evidence/ (metering ledger, child
 * transcript, state envelope). rounds.jsonl is used only to locate attempts and
 * to audit what the runner believed; a disagreement between the two verdicts is
 * reported, not silently resolved.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = (name) => `file:///${REPO.replaceAll("\\", "/")}/src/synapse/${name}`;

const BOOTSTRAP_B = 10_000;
const BOOTSTRAP_SEED = 20260920;
const STEER_PREFIX = "The delegating agent handed over a retrieval state";

/** Deterministic PRNG so the interval is reproducible from the same evidence. */
function mulberry32(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function percentile(sorted, q) {
	const position = (sorted.length - 1) * q;
	const low = Math.floor(position);
	const high = Math.ceil(position);
	return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function bootstrapInterval(diffs) {
	if (diffs.length === 0) return null;
	const random = mulberry32(BOOTSTRAP_SEED);
	const means = [];
	for (let draw = 0; draw < BOOTSTRAP_B; draw += 1) {
		let sum = 0;
		for (let index = 0; index < diffs.length; index += 1) sum += diffs[Math.floor(random() * diffs.length)];
		means.push(sum / diffs.length);
	}
	means.sort((a, b) => a - b);
	return { mean: diffs.reduce((a, b) => a + b, 0) / diffs.length, ci95: [percentile(means, 0.025), percentile(means, 0.975)] };
}

function crossesZero(interval) {
	return interval === null ? null : interval.ci95[0] <= 0 && interval.ci95[1] >= 0;
}

function logGamma(x) {
	const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
	let y = x;
	let tmp = x + 5.5;
	tmp -= (x + 0.5) * Math.log(tmp);
	let ser = 1.000000000190015;
	for (let j = 0; j < 6; j += 1) ser += cof[j] / ++y;
	return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function binomialPmf(k, n, p) {
	if (p <= 0) return k === 0 ? 1 : 0;
	if (p >= 1) return k === n ? 1 : 0;
	return Math.exp(logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

function cdfBinomial(k, n, p) {
	let sum = 0;
	for (let i = 0; i <= k; i += 1) sum += binomialPmf(i, n, p);
	return sum;
}

/**
 * Clopper-Pearson endpoints. Both solve by bisection on the binomial CDF,
 * which is strictly decreasing in p for 0 < k < n:
 *   lower p_L solves cdf(k-1; n, p_L) = 1 - α/2   (0.975 at α = 0.05)
 *   upper p_U solves cdf(k;   n, p_U) = α/2       (0.025 at α = 0.05)
 */
function invertUpper(successes, n, alpha) {
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 200; i += 1) {
		const mid = (lo + hi) / 2;
		if (cdfBinomial(successes, n, mid) > alpha / 2) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

function invertLower(successes, n, alpha) {
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 200; i += 1) {
		const mid = (lo + hi) / 2;
		if (cdfBinomial(successes - 1, n, mid) > 1 - alpha / 2) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/** Clopper-Pearson exact two-sided 95% interval for a binomial proportion. */
function exactBinomial(successes, n) {
	const lower = successes === 0 ? 0 : invertLower(successes, n, 0.05);
	const upper = successes === n ? 1 : invertUpper(successes, n, 0.05);
	return { point: successes / n, ci95: [lower, upper] };
}

/** State-plane metrics re-derived from the raw events. */
function metricsOf(events) {
	const state = {
		payloadBytes: 0,
		resendBytes: 0,
		stateEnvelopeBytes: 0,
		delegateTextBytes: 0,
		delegateEnvelopeBytes: 0,
		baseSelectionBytes: 0,
		baseRebuildBytes: 0,
		payloadReadBytes: 0,
		rankingReadBytes: 0,
		embeddingRequests: 0,
		embeddingFailed: 0,
		restoreCount: 0,
		deltaPayloadBytes: 0,
		encoding: null,
		fallbackReason: null,
	};
	for (const event of events) {
		switch (event.kind) {
			case "state-send":
				// Bytes count on every attempt, failed sends included — the frozen ②
				// (aggregateMetering) counts a send that reached the wire even when the
				// publish failed, and this re-derivation must not disagree with it
				// (K3 P2-1, 2026-09-20: the two implementations of ② diverged on !ok).
				state.payloadBytes += event.payloadBytes;
				if (event.restore === undefined) {
					if (state.encoding === null) {
						state.encoding = event.encoding ?? "float32-vector";
						state.fallbackReason = event.fallbackReason ?? null;
					}
				} else state.resendBytes += event.payloadBytes;
				if (event.encoding === "delta") state.deltaPayloadBytes += event.payloadBytes;
				break;
			case "message-delivered":
				if (event.textBytes === 0) state.stateEnvelopeBytes += event.envelopeBytes;
				else {
					state.delegateTextBytes += event.textBytes;
					state.delegateEnvelopeBytes += event.envelopeBytes;
				}
				break;
			case "object-io":
				if (event.direction !== "read") break;
				if (event.purpose === "base-selection") state.baseSelectionBytes += event.bytes;
				else if (event.purpose === "base-rebuild") state.baseRebuildBytes += event.bytes;
				else if (event.purpose === "payload-read") state.payloadReadBytes += event.bytes;
				else if (event.purpose === "ranking") state.rankingReadBytes += event.bytes;
				break;
			case "embedding-call":
				state.embeddingRequests += event.requests;
				if (!event.ok) state.embeddingFailed += 1;
				break;
			case "state-restore":
				state.restoreCount += 1;
				break;
		}
	}
	state.table1 = state.payloadBytes + state.stateEnvelopeBytes;
	state.table2StatePlane = state.table1 + state.baseSelectionBytes + state.baseRebuildBytes;
	return state;
}

/**
 * The same validity the runner applied, re-derived here from the evidence so a
 * bug in the runner cannot decide what enters the tables. §2 condition 4 is
 * literal: prepare and ok-send counts must be equal.
 */
function revalidate(events, arm) {
	const problems = [];
	const prepares = events.filter((event) => event.kind === "state-prepare" && event.ok);
	const okSends = events.filter((event) => event.kind === "state-send" && event.ok);
	const consumes = events.filter((event) => event.kind === "state-consume" && event.ok);
	const errors = events.filter((event) => event.kind === "error");
	const ended = events.some((event) => event.kind === "task-span" && event.phase === "end");
	if (prepares.length !== okSends.length) problems.push(`prepare/send misaligned (${prepares.length}/${okSends.length})`);
	if (okSends.length === 0) problems.push("state-send ok=0");
	if (consumes.length === 0) problems.push("state-consume ok=0");
	if (errors.length > 0) problems.push(`errors=${errors.length}`);
	if (!ended) problems.push("no task-span end");
	const send = okSends[0];
	if (send !== undefined) {
		if (arm === "S2" && send.encoding !== "float32-vector") problems.push(`S2 encoding=${send.encoding}`);
		if (arm === "R1" && send.encoding !== "delta" && send.fallbackReason === undefined) problems.push("R1 neither delta nor fallbackReason");
	}
	return { problems, valid: problems.length === 0 };
}

/** The steer message, re-extracted from the archived child transcript. */
function steerFromTranscript(transcriptPath, runId) {
	if (!fs.existsSync(transcriptPath)) return null;
	const raw = fs.readFileSync(transcriptPath, "utf-8");
	if (!raw.includes(STEER_PREFIX) || !raw.includes(runId)) return null;
	for (const line of raw.split("\n")) {
		if (!line.includes(STEER_PREFIX)) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed.runId !== runId) continue;
			const text = parsed.message?.content?.[0]?.text ?? parsed.text;
			if (typeof text === "string" && text.startsWith(STEER_PREFIX)) return text;
		} catch {
			// The transcript holds non-JSON lines too; only records parse.
		}
	}
	return null;
}

const expDir = path.resolve(process.argv[2]);
const manifest = JSON.parse(fs.readFileSync(path.join(expDir, "manifest.json"), "utf-8"));
const rounds = fs
	.readFileSync(path.join(expDir, "rounds.jsonl"), "utf-8")
	.split("\n")
	.filter((line) => line.trim().length > 0)
	.map((line) => JSON.parse(line));

const { aggregateMetering } = await import(SRC("metering.ts"));

// Every attempt is re-validated from its evidence; the runner's own verdict is
// kept only to report disagreements.
const audit = { attempts: 0, invalidByEvidence: 0, verdictDisagreements: 0, perArm: { S2: { valid: 0, attempts: 0 }, R1: { valid: 0, attempts: 0 } }, invalidReasons: {} };
const chosen = new Map();
for (const record of rounds) {
	audit.attempts += 1;
	audit.perArm[record.arm].attempts += 1;
	const evidenceDir = path.join(expDir, "evidence", record.arm, `round-${String(record.round).padStart(2, "0")}`, `attempt-${record.attempt}`);
	let problems = [];
	let metrics = null;
	if (record.runIds.length === 0) {
		problems.push(...record.problems.length > 0 ? record.problems : ["no ledger claimed"]);
	} else {
		const meteringFile = path.join(evidenceDir, `${record.runIds[0]}.jsonl`);
		if (!fs.existsSync(meteringFile)) problems.push("metering evidence missing");
		else {
			const events = fs.readFileSync(meteringFile, "utf-8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
			const validation = revalidate(events, record.arm);
			problems.push(...validation.problems);
			metrics = metricsOf(events);
			// §15 登记三（2026-09-21，先于 v3 数据冻结）：探针事件随轮次入表，供
			// durationMs 分布使用——"探针是否该留在 2500 ms 预算关键路径上"（K3 P1-2）
			// 的运行期证据。分布只纳入通过证据复核的轮次。
			metrics.probeEvents = events
				.filter((event) => event.kind === "capability-probe")
				.map((event) => ({ durationMs: event.durationMs ?? null, ok: event.ok, wired: event.wired ?? null }));
			const steerText = steerFromTranscript(path.join(evidenceDir, "child-transcript.jsonl"), record.runIds[0]);
			if (steerText === null) problems.push("steer not found in archived transcript");
			else {
				metrics.steerBytes = Buffer.byteLength(steerText, "utf-8");
				metrics.top5 = steerText.split("\n").filter((line) => line.startsWith("- "));
			}
			metrics.frozen2 = aggregateMetering(events).fullAccount.bytes;
		}
	}
	const valid = metrics !== null && problems.length === 0;
	if (!valid) {
		audit.invalidByEvidence += 1;
		for (const problem of problems) audit.invalidReasons[problem.split(" (")[0]] = (audit.invalidReasons[problem.split(" (")[0]] ?? 0) + 1;
	}
	if (valid !== record.valid) audit.verdictDisagreements += 1;
	if (valid && metrics !== null) {
		const key = `${record.arm}/${record.round}`;
		if (!chosen.has(key)) {
			chosen.set(key, { round: record.round, arm: record.arm, attempt: record.attempt, metrics });
			audit.perArm[record.arm].valid += 1;
		}
	}
}

const perRound = { S2: new Map(), R1: new Map() };
for (const [key, entry] of chosen) perRound[entry.arm].set(entry.round, entry.metrics);

// Paired rounds — both arms valid — are the only rows that enter the tables.
const pairRounds = [...new Set(rounds.map((record) => record.round))]
	.filter((round) => perRound.S2.has(round) && perRound.R1.has(round))
	.sort((a, b) => a - b);
const mean = (arm, field) => (pairRounds.length === 0 ? null : pairRounds.reduce((total, round) => total + perRound[arm].get(round)[field], 0) / pairRounds.length);
const sum = (arm, field) => pairRounds.reduce((total, round) => total + perRound[arm].get(round)[field], 0);

const pairedDiff = (field) => pairRounds.map((round) => perRound.R1.get(round)[field] - perRound.S2.get(round)[field]);
const diffs = {
	payloadBytes: pairedDiff("payloadBytes"),
	table1: pairedDiff("table1"),
	table2StatePlane: pairedDiff("table2StatePlane"),
	frozen2: pairedDiff("frozen2"),
	delegateEnvelopeBytes: pairedDiff("delegateEnvelopeBytes"),
};
const intervals = {
	payload: bootstrapInterval(diffs.payloadBytes),
	table1: bootstrapInterval(diffs.table1),
	table2StatePlane: bootstrapInterval(diffs.table2StatePlane),
	frozen2: bootstrapInterval(diffs.frozen2),
	delegateEnvelope: bootstrapInterval(diffs.delegateEnvelopeBytes),
};

// ③ ordered top-5 agreement, with top-1 and set overlap as diagnostics. The
// pre-registered criterion (§3, "沿用 P4-2") is over CHUNK IDENTITIES: the two
// chunkId lists ordered and element-wise equal — never over the steer lines
// verbatim, which carry per-arm cosine scores that differ whenever the arms'
// vectors differ at all. The K3 review (2026-09-20, preregistration §14) caught
// the original implementation comparing full lines, under which no legitimate
// round can ever agree. Lines that do not parse as "- <chunk> (cosine …)" are
// counted rather than silently treated as identical chunks.
const chunkIdOf = (line) => {
	const match = line.match(/^- (.+) \(cosine /);
	return match === null ? line : match[1];
};
const agreement = { ordered: 0, top1: 0, jaccardSum: 0, compared: 0, unparsedLines: 0, nearAgree: 0 };
const chunkPattern = /^- (.+) \(cosine /;
for (const round of pairRounds) {
	const s2 = perRound.S2.get(round);
	const r1 = perRound.R1.get(round);
	if (!Array.isArray(s2.top5) || !Array.isArray(r1.top5) || s2.top5.length === 0 || r1.top5.length === 0) continue;
	for (const line of [...s2.top5, ...r1.top5]) if (!chunkPattern.test(line)) agreement.unparsedLines += 1;
	agreement.compared += 1;
	const s2Chunks = s2.top5.map(chunkIdOf);
	const r1Chunks = r1.top5.map(chunkIdOf);
	if (s2Chunks.join("|") === r1Chunks.join("|")) agreement.ordered += 1;
	if (s2Chunks[0] === r1Chunks[0]) agreement.top1 += 1;
	// §15 登记二（2026-09-21，先于 v3 数据冻结）：诊断列"容许 1 位错位"——两列表等长
	// 且 (a) Hamming 距离 ≤1 或 (b) 仅相差一次相邻交换，即记近似一致。它不参与判定，
	// 只区分"量化造成相邻名次微调"与"排序被打乱"。
	if (s2Chunks.length === r1Chunks.length) {
		let mismatches = 0;
		for (let i = 0; i < s2Chunks.length; i++) if (s2Chunks[i] !== r1Chunks[i]) mismatches += 1;
		let swapMatch = false;
		for (let i = 0; i + 1 < r1Chunks.length && !swapMatch; i++) {
			const swapped = [...r1Chunks];
			[swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
			if (swapped.join("|") === s2Chunks.join("|")) swapMatch = true;
		}
		if (mismatches <= 1 || swapMatch) agreement.nearAgree += 1;
	}
	const setA = new Set(s2Chunks);
	const setB = new Set(r1Chunks);
	let intersection = 0;
	for (const item of setA) if (setB.has(item)) intersection += 1;
	agreement.jaccardSum += intersection / new Set([...setA, ...setB]).size;
}
const stats3 = agreement.compared === 0 ? null : exactBinomial(agreement.ordered, agreement.compared);

// The frozen ② and the state-plane ② differ by exactly the delegate-plane
// envelope when the arms' delegate envelopes match (same task, fixed-length
// ids). Verified here rather than asserted in prose; a mismatch is reported.
const delegateEnvelopeGap = intervals.delegateEnvelope === null ? null : intervals.delegateEnvelope.mean;
const frozenGapCheck = pairRounds.length === 0 ? null : pairRounds.every((round) => {
	const s2 = perRound.S2.get(round);
	const r1 = perRound.R1.get(round);
	const expected = (r1.frozen2 - r1.table2StatePlane) - (s2.frozen2 - s2.table2StatePlane);
	return Math.abs(expected - (r1.delegateEnvelopeBytes - s2.delegateEnvelopeBytes)) < 1;
});

// Query plaintext share of the state envelope, from the envelope evidence.
function queryShare(arm) {
	let queryBytes = 0;
	let envelopeBytes = 0;
	let envelopesMissing = 0;
	for (const round of pairRounds) {
		const metrics = perRound[arm].get(round);
		envelopeBytes += metrics.stateEnvelopeBytes;
		const attemptDir = path.join(expDir, "evidence", arm, `round-${String(round).padStart(2, "0")}`, `attempt-${[...chosen.entries()].find(([, entry]) => entry.arm === arm && entry.round === round)?.attempt ?? 1}`);		const stateEnvelopes = fs.existsSync(path.join(attemptDir, "envelopes")) ? fs.readdirSync(path.join(attemptDir, "envelopes")).filter((name) => name.endsWith(".state.json")) : [];
		if (stateEnvelopes.length === 0) {
			envelopesMissing += 1;
			continue;
		}
		const wire = JSON.parse(fs.readFileSync(path.join(attemptDir, "envelopes", stateEnvelopes[0]), "utf-8"));
		try {
			const query = JSON.parse(wire.inputParamsJson).query;
			if (typeof query === "string") queryBytes += Buffer.byteLength(query, "utf-8");
		} catch {
			envelopesMissing += 1;
		}
	}
	return { queryBytes, envelopeBytes, share: envelopeBytes === 0 ? null : queryBytes / envelopeBytes, envelopesMissing };
}

// Trigger rate over the paired denominator, so a reader can multiply it against
// the tables without hitting a population mismatch.
const trigger = { delta: 0, fallback: {}, total: 0 };
for (const round of pairRounds) {
	const metrics = perRound.R1.get(round);
	if (metrics.encoding === null) continue;
	trigger.total += 1;
	if (metrics.encoding === "delta") trigger.delta += 1;
	else trigger.fallback[metrics.fallbackReason ?? "unknown"] = (trigger.fallback[metrics.fallbackReason ?? "unknown"] ?? 0) + 1;
}

// §15 登记三：探针耗时分布（仅纳入通过证据复核的入表轮次，两臂合计）。
const probeDurations = [];
let probeCount = 0;
let probeWiredTrue = 0;
let probeOkTrue = 0;
let probeArmRoundsWith = 0;
for (const round of pairRounds) {
	for (const arm of ["S2", "R1"]) {
		const probes = perRound[arm].get(round).probeEvents ?? [];
		if (probes.length > 0) probeArmRoundsWith += 1;
		for (const probe of probes) {
			probeCount += 1;
			if (probe.wired === true) probeWiredTrue += 1;
			if (probe.ok === true) probeOkTrue += 1;
			if (typeof probe.durationMs === "number") probeDurations.push(probe.durationMs);
		}
	}
}
probeDurations.sort((a, b) => a - b);
const probeDistribution = probeDurations.length === 0 ? null : {
	count: probeDurations.length,
	min: probeDurations[0],
	p50: percentile(probeDurations, 0.5),
	p90: percentile(probeDurations, 0.9),
	max: probeDurations[probeDurations.length - 1],
};

const fmt = (value) => (value === null || value === undefined ? "—" : Math.round(value).toLocaleString("en-US"));
const pct = (value) => (value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`);
const cross = (interval) => (interval === null ? "" : crossesZero(interval) ? "（**区间跨 0**）" : "（区间不跨 0）");

const pointEstimate = diffs.table2StatePlane.length === 0 ? null : diffs.table2StatePlane.reduce((a, b) => a + b, 0) / diffs.table2StatePlane.length;

/**
 * §4 is conjunctive and §13 froze ② on the point estimate: 净赚 needs BOTH ②
 * point ≤ 0 AND ③ without measurable degradation. ③'s P4-2-style McNemar is
 * degenerate here — the S2 ranking IS the reference (the exact query vector),
 * so there is no second rating to cross-tabulate; the honest operationalisation
 * of "not significantly worse" is zero ordered-top-5 disagreements, which any
 * imperfect agreement falsifies. The p0=1 binomial test is therefore NOT used
 * as a judgment input; it was degenerate (p→0 for any k<n) and is dropped.
 */
const agreementPerfect = agreement.compared > 0 && agreement.ordered === agreement.compared;
let verdict;
if (pairRounds.length === 0) {
	verdict = "不可判定（无有效配对轮）";
} else if (pointEstimate > 0) {
	verdict = "净亏（②点估计 > 0；§4 第 2 条：生产路径默认关闭 delta，以完整向量直传为参赛主实现，负结果与成立条件全文披露）";
} else if (agreementPerfect) {
	verdict = "净赚（宽档：②点估计 ≤ 0 且 ③ 无可测退化）";
} else {
	verdict = `不可判定→保守处置（②点估计 ≤ 0，但 ③ 有序 top-5 存在 ${agreement.compared - agreement.ordered}/${agreement.compared} 轮不一致；§4 第 1 条的合取不满足，按第 3 条处理：生产默认关闭 delta，分辨率与区间一并披露）`;
}
const crossesHeadline = crossesZero(intervals.table2StatePlane);
const missingPairs = manifest.roundsPlanned.length - pairRounds.length;

const shareS2 = queryShare("S2");
const shareR1 = queryShare("R1");

const report = [];
report.push(`# P4-5 两臂计量报告（${manifest.experimentId}）`);
report.push("");
report.push(`> 判定口径：预登记 §3/§4 + §13（宽档，点估计）；一切差值并列配对区间与跨 0 状态；区间跨 0 时不得写"统计显著"。`);
report.push(`> 配对轮数：${pairRounds.length}（计划 ${manifest.roundsPlanned.length}${missingPairs > 0 ? `，缺 ${missingPairs}` : ""}；S2 有效 ${audit.perArm.S2.valid} / R1 有效 ${audit.perArm.R1.valid}；尝试共 ${audit.attempts} 次，证据复核无效 ${audit.invalidByEvidence} 次，runner/聚合器判定分歧 ${audit.verdictDisagreements} 次）。`);
report.push(`> 代码 ${manifest.code.sha ?? "?"}${manifest.code.dirty.length > 0 ? "（含未提交改动）" : ""}；runner/aggregate 脚本指纹 ${manifest.scripts["p45-runner.mjs"].slice(0, 8)}…/${manifest.scripts["p45-aggregate.mjs"].slice(0, 8)}…；模型 ${manifest.model}；嵌入 ${manifest.embedding.representationId}；语料 ${manifest.corpusSnapshotId.slice(0, 8)}…。`);
report.push("");
report.push(`## 判定（§4 + §13，合取结构）`);
report.push("");
report.push(`- ②全账（状态面口径，R1−S2 配对均值）：**${fmt(pointEstimate)} B/轮**；95% 配对区间 [${fmt(intervals.table2StatePlane?.ci95[0])}, ${fmt(intervals.table2StatePlane?.ci95[1])}]${cross(intervals.table2StatePlane)}。`);
report.push(`- ②全账（冻结口径 aggregateMetering.fullAccount）：配对均值 ${fmt(intervals.frozen2?.mean)} B/轮；95% 区间 [${fmt(intervals.frozen2?.ci95[0])}, ${fmt(intervals.frozen2?.ci95[1])}]${cross(intervals.frozen2)}。两口径差＝委派面信封（R1−S2 均值 ${fmt(delegateEnvelopeGap)} B/轮），${frozenGapCheck === true ? "已逐轮核实一致" : "**未能逐轮核实，见审计**"}。`);
report.push(`- ③有序 top-5 一致：**${agreement.ordered}/${agreement.compared} = ${pct(agreement.compared === 0 ? null : agreement.ordered / agreement.compared)}**（Clopper-Pearson 95% 区间 [${pct(stats3?.ci95[0])}, ${pct(stats3?.ci95[1])}]；S2 即精确向量参照，故 P4-2 式 McNemar 在此退化，判据按"零不一致"执行，p0=1 二项检验已弃用——见代码注释）；top-1 = ${pct(agreement.compared === 0 ? null : agreement.top1 / agreement.compared)}；集合 Jaccard 均值 = ${agreement.compared === 0 ? "—" : (agreement.jaccardSum / agreement.compared).toFixed(3)}；容许 1 位错位（§15 诊断列，不参与判定）= ${agreement.nearAgree}/${agreement.compared}${agreement.unparsedLines > 0 ? `；**${agreement.unparsedLines} 行 top-5 未按预期格式解析**` : ""}。`);
report.push(`- ④回退次数：S2 = ${sum("S2", "restoreCount")}，R1 = ${sum("R1", "restoreCount")}。`);
report.push(`- **结论：${verdict}**。`);
report.push("");
report.push(`## 表① 线上传输字节（状态面，发送侧单计）`);
report.push("");
report.push(`| 指标 | S2 均值 B/轮 | R1 均值 B/轮 | R1−S2 均值 | 95% 配对区间 | 跨 0 |`);
report.push(`|---|---|---|---|---|---|`);
report.push(`| 载荷（state-send.payloadBytes，含重传跳） | ${fmt(mean("S2", "payloadBytes"))} | ${fmt(mean("R1", "payloadBytes"))} | ${fmt(intervals.payload?.mean)} | [${fmt(intervals.payload?.ci95[0])}, ${fmt(intervals.payload?.ci95[1])}] | ${crossesZero(intervals.payload) ? "跨 0" : "不跨"} |`);
report.push(`| 载荷 + 状态信封控制字节 | ${fmt(mean("S2", "table1"))} | ${fmt(mean("R1", "table1"))} | ${fmt(intervals.table1?.mean)} | [${fmt(intervals.table1?.ci95[0])}, ${fmt(intervals.table1?.ci95[1])}] | ${crossesZero(intervals.table1) ? "跨 0" : "不跨"} |`);
report.push(`| 其中 delta 载荷（R1） | — | ${fmt(mean("R1", "deltaPayloadBytes"))} | — | — | — |`);
report.push("");
report.push(`## 表② 全账总字节`);
report.push("");
report.push(`| 行 | S2 均值 B/轮 | R1 均值 B/轮 |`);
report.push(`|---|---|---|`);
report.push(`| 冷基（实测；默认 vectorCache=false） | ${fmt(mean("S2", "table2StatePlane"))} | ${fmt(mean("R1", "table2StatePlane"))} |`);
report.push(`| 热基（推导＝冷基−基读取，非实测） | ${fmt(pairRounds.length === 0 ? null : mean("S2", "table2StatePlane") - mean("S2", "baseSelectionBytes") - mean("S2", "baseRebuildBytes"))} | ${fmt(pairRounds.length === 0 ? null : mean("R1", "table2StatePlane") - mean("R1", "baseSelectionBytes") - mean("R1", "baseRebuildBytes"))} |`);
report.push(`| 冻结口径（aggregateMetering.fullAccount，含委派面信封） | ${fmt(mean("S2", "frozen2"))} | ${fmt(mean("R1", "frozen2"))} |`);
report.push("");
report.push(`分量（B/轮均值）：base-selection 读取 S2=${fmt(mean("S2", "baseSelectionBytes"))} R1=${fmt(mean("R1", "baseSelectionBytes"))}；base-rebuild 读取 S2=${fmt(mean("S2", "baseRebuildBytes"))} R1=${fmt(mean("R1", "baseRebuildBytes"))}；重传跳 S2=${fmt(mean("S2", "resendBytes"))} R1=${fmt(mean("R1", "resendBytes"))}。`);
report.push(`并列不入②（预登记 §10 修订）：payload-read S2=${fmt(mean("S2", "payloadReadBytes"))} R1=${fmt(mean("R1", "payloadReadBytes"))}；ranking 读取 S2=${fmt(mean("S2", "rankingReadBytes"))} R1=${fmt(mean("R1", "rankingReadBytes"))}。`);
report.push(`嵌入调用（按调用与 token 计，不折算字节）：S2=${fmt(mean("S2", "embeddingRequests"))} 次/轮，R1=${fmt(mean("R1", "embeddingRequests"))} 次/轮（R1 的选基嵌入与载荷嵌入同文本，命中进程内 L1 缓存，故与 S2 同次；重试轮 L2 热——见 manifest 措辞）。`);
report.push("");
report.push(`## 表③ 检索一致性（主判据：有序 top-5）`);
report.push("");
report.push(`| 口径 | 值 |`);
report.push(`|---|---|`);
report.push(`| 有序 top-5 完全一致 | ${agreement.ordered}/${agreement.compared}（${pct(agreement.compared === 0 ? null : agreement.ordered / agreement.compared)}，Clopper-Pearson 95% 区间 [${pct(stats3?.ci95[0])}, ${pct(stats3?.ci95[1])}]） |`);
report.push(`| top-1 一致（诊断） | ${pct(agreement.compared === 0 ? null : agreement.top1 / agreement.compared)} |`);
report.push(`| 集合 Jaccard（诊断） | ${agreement.compared === 0 ? "—" : (agreement.jaccardSum / agreement.compared).toFixed(3)} |`);
report.push(`| 容许 1 位错位（§15 登记二·诊断，**不参与判定**） | ${agreement.nearAgree}/${agreement.compared}（${pct(agreement.compared === 0 ? null : agreement.nearAgree / agreement.compared)}）——等长且 Hamming ≤1 或仅差一次相邻交换 |`);
report.push("");
report.push(`## 表④ 回退次数（state-restore 事件）`);
report.push("");
report.push(`| 臂 | 总数 | 均值/轮 |`);
report.push(`|---|---|---|`);
report.push(`| S2 | ${sum("S2", "restoreCount")} | ${fmt(mean("S2", "restoreCount"))} |`);
report.push(`| R1 | ${sum("R1", "restoreCount")} | ${fmt(mean("R1", "restoreCount"))} |`);
report.push("");
report.push(`## 探针耗时分布（§15 登记三·报告层，不改判据）`);
report.push("");
report.push(`| 项 | 值 |`);
report.push(`|---|---|`);
report.push(`| 事件数（入表轮次两臂合计） | ${probeCount}（含事件的臂·轮数 ${probeArmRoundsWith}） |`);
report.push(`| wired=true / ok=true | ${probeWiredTrue} / ${probeOkTrue} |`);
report.push(`| durationMs min / p50 / p90 / max | ${fmt(probeDistribution?.min)} / ${fmt(probeDistribution?.p50)} / ${fmt(probeDistribution?.p90)} / ${fmt(probeDistribution?.max)} |`);
report.push("");
report.push(`读法（装置构造事实）：本装置每轮一独立进程，探针缓存为进程级（TTL 300 s），每进程只委派一次——入表轮次的探针按构造**全部是真跑**（≈5.07 MB 语料同步加载），不存在 TTL 命中；TTL 命中只会在常驻进程多轮装置（批次 C，v4 条件另冻）中出现。该分布是"探针是否留在 2500 ms 状态预算关键路径上"（K3 P1-2）的运行期证据；**是否移出预算属机制变更，须用户裁决，本报告只出数**。`);
report.push("");
report.push(`## M8 三本账分层表（均值 B/轮；三账互不相加）`);
report.push("");
report.push(`| 账 | S2 | R1 | 说明 |`);
report.push(`|---|---|---|---|`);
report.push(`| (a) 任务面文本（delegate textBytes） | ${fmt(mean("S2", "delegateTextBytes"))} | ${fmt(mean("R1", "delegateTextBytes"))} | 委派面 message-delivered.textBytes |`);
report.push(`| (b) 状态面非文本＝载荷＋控制字节 | ${fmt(mean("S2", "table1"))} | ${fmt(mean("R1", "table1"))} | 其中 query 明文占信封字节 S2=${pct(shareS2.share)} R1=${pct(shareR1.share)}（单列${shareS2.envelopesMissing + shareR1.envelopesMissing > 0 ? `；缺信封 ${shareS2.envelopesMissing + shareR1.envelopesMissing} 份` : ""}） |`);
report.push(`| (c) 命中渲染文本（steer 注入） | ${fmt(mean("S2", "steerBytes"))} | ${fmt(mean("R1", "steerBytes"))} | 从子会话转录测得；**无计量事件**（§3 已声明缺口），绝不计入 (b) |`);
report.push("");
report.push(`## 触发率与审计`);
report.push("");
report.push(`- R1 残差触发（分母＝配对轮）：${trigger.delta}/${trigger.total}${Object.keys(trigger.fallback).length > 0 ? `；回落分布 ${JSON.stringify(trigger.fallback)}` : ""}。`);
report.push(`- 尝试审计：S2 ${audit.perArm.S2.attempts} 次尝试/${audit.perArm.S2.valid} 有效，R1 ${audit.perArm.R1.attempts}/${audit.perArm.R1.valid}；重试保留规则＝首个通过证据复核的尝试（选择偏置已披露：重试臂的保留样本条件分布不同）。无效原因分布：${JSON.stringify(audit.invalidReasons)}。`);
report.push(`- 嵌入缓存状态：${manifest.embeddingCacheState}。`);
report.push(`- 统计方法：${manifest.statsPlan}。`);
report.push(`- 种子库指纹：seed-manifest sha256 ${manifest.seedIdentity.seedManifestSha256.slice(0, 8)}…、记忆文件摘要 ${manifest.seedIdentity.seedMemorySha256.slice(0, 8)}…。`);
report.push("");

fs.writeFileSync(path.join(expDir, "report.md"), `${report.join("\n")}\n`, "utf-8");
fs.writeFileSync(
	path.join(expDir, "tables.json"),
	`${JSON.stringify(
		{
			experimentId: manifest.experimentId,
			pairRounds,
			audit,
			trigger,
			agreement,
			stats3,
			probeDistribution: { ...probeDistribution, count: probeCount, armRoundsWithEvents: probeArmRoundsWith, wiredTrue: probeWiredTrue, okTrue: probeOkTrue },
			diffs,
			intervals,
			crossesZero: { table2StatePlane: crossesHeadline, payload: crossesZero(intervals.payload), table1: crossesZero(intervals.table1), frozen2: crossesZero(intervals.frozen2) },
			perRound: { S2: [...perRound.S2.entries()], R1: [...perRound.R1.entries()] },
			queryShare: { S2: shareS2, R1: shareR1 },
			frozenGapCheck,
			verdict,
			pointEstimate,
		},
		null,
		"\t",
	)}\n`,
	"utf-8",
);
console.log(report.join("\n"));
console.log(`\n[p45] report written: ${path.join(expDir, "report.md")}`);
