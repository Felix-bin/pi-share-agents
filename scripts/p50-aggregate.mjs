/**
 * P50 aggregation: paired SYN-vs-TXT comparison over the two n30 round logs.
 *
 * Everything here implements the frozen judging rules of
 * docs/experiments/P50-token-ab-preregistration-20260921.md §2/§4 (and the §9
 * addendum): the main metric is the child-session token sum (input+output;
 * cacheRead reported beside, never inside), every difference gets a percentile
 * bootstrap interval (B=10000, seed=20260921), an interval crossing zero is
 * stated as crossing zero, and no round subset is ever reported.
 *
 * Inputs: --syn <expDir> --txt <expDir> [--judge <judge-results.json>] [--out <report.md>]
 * The judge file (produced by p50-judge.mjs afterwards) is optional; without it
 * the success metric is reported as pending rather than omitted silently.
 */
import fs from "node:fs";
import path from "node:path";

const BOOTSTRAP_B = 10_000;
const BOOTSTRAP_SEED = 20260921;

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

const readJsonl = (file) =>
	fs
		.readFileSync(file, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));

/** First VALID attempt per round (the runner stops after the first valid one). */
function validByRound(dir) {
	const byRound = new Map();
	for (const record of readJsonl(path.join(dir, "rounds.jsonl"))) {
		if (record.valid && !byRound.has(record.round)) byRound.set(record.round, record);
	}
	return byRound;
}

/** SYN-only device detail from the valid attempt's evidence metering ledger. */
function synLedgerDetail(expDir, record) {
	const runId = record.runIds[0];
	if (runId === undefined) return null;
	const ledgerFile = path.join(
		expDir,
		"evidence",
		`round-${String(record.round).padStart(2, "0")}`,
		`attempt-${record.attempt}`,
		`${runId}.jsonl`,
	);
	if (!fs.existsSync(ledgerFile)) return null;
	const events = readJsonl(ledgerFile);
	const detail = { payloadBytes: 0, stateEnvelopeBytes: 0, delegateTextBytes: 0, messages: 0, nontextTransfers: 0, ledgerUsage: null };
	for (const event of events) {
		if (event.kind === "state-send" && event.ok) {
			detail.payloadBytes += event.payloadBytes;
			detail.nontextTransfers += 1;
		} else if (event.kind === "message-delivered") {
			detail.messages += 1;
			if (event.textBytes === 0) detail.stateEnvelopeBytes += event.envelopeBytes ?? 0;
			else detail.delegateTextBytes += event.textBytes;
		} else if (event.kind === "model-usage") {
			// Integrity cross-check against the RPC-final usage (§9's uniform source).
			const u = event.usage ?? event;
			detail.ledgerUsage = {
				input: (detail.ledgerUsage?.input ?? 0) + (u.input ?? u.inputTokens ?? 0),
				output: (detail.ledgerUsage?.output ?? 0) + (u.output ?? u.outputTokens ?? 0),
			};
		}
	}
	return detail;
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
	const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
	return { mean, ci95: [pick(0.025), pick(0.975)] };
}

const fmt = (v, digits = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: digits }));
const crossesZero = (iv) => iv !== null && iv.ci95[0] <= 0 && iv.ci95[1] >= 0;

function main() {
	const argv = process.argv.slice(2);
	const opt = { out: null, judge: null };
	for (let i = 0; i < argv.length; i += 2) opt[argv[i].slice(2)] = argv[i + 1];
	for (const key of ["syn", "txt"]) if (!opt[key]) throw new Error(`--${key} <expDir> required`);

	const syn = validByRound(opt.syn);
	const txt = validByRound(opt.txt);
	const rounds = [...syn.keys()].filter((r) => txt.has(r)).sort((a, b) => a - b);
	const synOnly = [...syn.keys()].filter((r) => !txt.has(r));
	const txtOnly = [...txt.keys()].filter((r) => !syn.has(r));

	const rows = rounds.map((round) => {
		const s = syn.get(round);
		const t = txt.get(round);
		const detail = synLedgerDetail(opt.syn, s);
		return {
			round,
			synInput: s.usage.input,
			synOutput: s.usage.output,
			synCacheRead: s.usage.cacheRead ?? 0,
			synTurns: s.usage.turns ?? null,
			txtInput: t.usage.input,
			txtOutput: t.usage.output,
			txtCacheRead: t.usage.cacheRead ?? 0,
			txtTurns: t.usage.turns ?? null,
			synWallMs: s.wallMs,
			txtWallMs: t.wallMs,
			synAnswerBytes: s.answerBytes,
			txtAnswerBytes: t.answerBytes,
			steerBytes: s.steer?.bytes ?? null,
			synDetail: detail,
		};
	});

	const diffs = {
		totalTokens: rows.map((r) => r.txtInput + r.txtOutput - (r.synInput + r.synOutput)),
		inputTokens: rows.map((r) => r.txtInput - r.synInput),
		outputTokens: rows.map((r) => r.txtOutput - r.synOutput),
		wallMs: rows.map((r) => r.txtWallMs - r.synWallMs),
		turns: rows.filter((r) => r.synTurns !== null && r.txtTurns !== null).map((r) => r.txtTurns - r.synTurns),
		answerBytes: rows.filter((r) => r.synAnswerBytes !== null && r.txtAnswerBytes !== null).map((r) => r.txtAnswerBytes - r.synAnswerBytes),
	};
	const intervals = Object.fromEntries(Object.entries(diffs).map(([k, v]) => [k, bootstrapInterval(v)]));

	const meanOf = (sel) => {
		const v = rows.map(sel).filter((x) => x !== null && x !== undefined);
		return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
	};
	const ledgerCrossCheck = rows.filter((r) => r.synDetail?.ledgerUsage).map((r) => ({
		round: r.round,
		final: r.synInput + r.synOutput,
		ledger: r.synDetail.ledgerUsage.input + r.synDetail.ledgerUsage.output,
	}));
	const ledgerMismatch = ledgerCrossCheck.filter((x) => x.final !== x.ledger);

	const judge = opt.judge && fs.existsSync(opt.judge) ? JSON.parse(fs.readFileSync(opt.judge, "utf-8")) : null;
	let judgeSection = "⑥ 任务成功率：**待判分**（p50-judge.mjs 未运行或结果未给出；本节留位不省略）。";
	if (judge) {
		const synScores = rounds.map((r) => judge.scores?.SYN?.[r]).filter((v) => v !== undefined);
		const txtScores = rounds.map((r) => judge.scores?.TXT?.[r]).filter((v) => v !== undefined);
		const paired = rounds.filter((r) => judge.scores?.SYN?.[r] !== undefined && judge.scores?.TXT?.[r] !== undefined);
		const scoreDiffs = paired.map((r) => judge.scores.TXT[r] - judge.scores.SYN[r]);
		const iv = bootstrapInterval(scoreDiffs);
		judgeSection = [
			`⑥ 任务成功率（LLM judge，逐点 0/1 后按题取均值；${judge.model ?? "judge model"}）`,
			`- SYN 平均得分：${fmt(synScores.length ? synScores.reduce((s, x) => s + x, 0) / synScores.length : null, 3)}（n=${synScores.length}）`,
			`- TXT 平均得分：${fmt(txtScores.length ? txtScores.reduce((s, x) => s + x, 0) / txtScores.length : null, 3)}（n=${txtScores.length}）`,
			`- 配对差（TXT−SYN）点估计 ${fmt(iv?.mean, 3)}，95% 区间 [${fmt(iv?.ci95[0], 3)}, ${fmt(iv?.ci95[1], 3)}]（${crossesZero(iv) ? "跨 0" : "不跨 0"}）`,
			`- judge 一致性抽查：${judge.consistency ?? "未记录"}`,
		].join("\n");
	}

	const report = [];
	report.push(`# P50 通信效率 A/B 聚合报告（SYN vs TXT，配对 n=${rows.length}/30）`);
	report.push("");
	report.push(`- 装置与判据：docs/experiments/P50-token-ab-preregistration-20260921.md（含 §9/§10 附录）`);
	report.push(`- 数据：${opt.syn} 与 ${opt.txt}（各自 manifest.json 记录 familySha256 与配置）`);
	report.push(`- 覆盖：SYN valid ${syn.size}/30，TXT valid ${txt.size}/30，配对 ${rows.length}/30` +
		(synOnly.length ? `；仅 SYN 有效轮 ${JSON.stringify(synOnly)}` : "") +
		(txtOnly.length ? `；仅 TXT 有效轮 ${JSON.stringify(txtOnly)}` : ""));
	report.push(`- bootstrap：B=${BOOTSTRAP_B}，seed=${BOOTSTRAP_SEED}，配对差 = TXT − SYN（正 = SYN 更省）`);
	report.push("");
	report.push(`## 主表（每差必带区间；跨 0 如实标注）`);
	report.push("");
	report.push(`| 指标 | SYN 均值 | TXT 均值 | 配对差点估计 | 95% 区间 | 跨 0？ |`);
	report.push(`|---|---|---|---|---|---|`);
	const row = (label, synMean, txtMean, iv, digits = 1) =>
		report.push(`| ${label} | ${fmt(synMean, digits)} | ${fmt(txtMean, digits)} | ${fmt(iv?.mean, digits)} | [${fmt(iv?.ci95[0], digits)}, ${fmt(iv?.ci95[1], digits)}] | ${crossesZero(iv) ? "跨 0" : "不跨"} |`);
	row("① 子会话总 token（input+output）", meanOf((r) => r.synInput + r.synOutput), meanOf((r) => r.txtInput + r.txtOutput), intervals.totalTokens, 0);
	row("①a 输入 token", meanOf((r) => r.synInput), meanOf((r) => r.txtInput), intervals.inputTokens, 0);
	row("①b 输出 token", meanOf((r) => r.synOutput), meanOf((r) => r.txtOutput), intervals.outputTokens, 0);
	row("⑤ 墙钟耗时（ms）", meanOf((r) => r.synWallMs), meanOf((r) => r.txtWallMs), intervals.wallMs, 0);
	row("工具轮次 turns", meanOf((r) => r.synTurns), meanOf((r) => r.txtTurns), intervals.turns, 1);
	row("作答字节 answerBytes", meanOf((r) => r.synAnswerBytes), meanOf((r) => r.txtAnswerBytes), intervals.answerBytes, 0);
	report.push("");
	report.push(`并列披露（不入合计，预登记 §2）：SYN cacheRead 均值 ${fmt(meanOf((r) => r.synCacheRead), 0)}，TXT cacheRead 均值 ${fmt(meanOf((r) => r.txtCacheRead), 0)}。`);
	report.push("");
	report.push(`## 机制面（SYN 独有；TXT 无此机制，如实标注）`);
	report.push("");
	report.push(`- ③ 文本通信：两臂委派任务文本逐字节相同（装置性质）；SYN 另有 steer 注入，均值 ${fmt(meanOf((r) => r.steerBytes), 0)} B/轮。`);
	report.push(`- ④ 非文本状态传递：SYN payload（state-send.payloadBytes）均值 ${fmt(meanOf((r) => r.synDetail?.payloadBytes ?? null), 0)} B/轮，次数均值 ${fmt(meanOf((r) => r.synDetail?.nontextTransfers ?? null), 2)}；信封控制字节均值 ${fmt(meanOf((r) => r.synDetail?.stateEnvelopeBytes ?? null), 0)} B/轮。`);
	report.push(`- ② 消息次数：SYN 账本 message-delivered 均值 ${fmt(meanOf((r) => r.synDetail?.messages ?? null), 1)}；TXT 装置面无状态账本，逻辑委派 1 次/轮（口径差异如实说明）。`);
	report.push(`- 完整性互查（SYN 账本 model-usage vs RPC 最终 usage）：${ledgerMismatch.length === 0 ? `${ledgerCrossCheck.length}/${ledgerCrossCheck.length} 轮一致` : `不一致轮 ${JSON.stringify(ledgerMismatch)}`}。`);
	report.push("");
	report.push(`## ⑥ 成功率`);
	report.push("");
	report.push(judgeSection);
	report.push("");
	report.push(`## 逐轮明细`);
	report.push("");
	report.push(`| 轮 | SYN tok | TXT tok | Δ tok | SYN ms | TXT ms | SYN turns | TXT turns | steer B |`);
	report.push(`|---|---|---|---|---|---|---|---|---|`);
	for (const r of rows) {
		report.push(`| ${r.round} | ${fmt(r.synInput + r.synOutput, 0)} | ${fmt(r.txtInput + r.txtOutput, 0)} | ${fmt(r.txtInput + r.txtOutput - (r.synInput + r.synOutput), 0)} | ${fmt(r.synWallMs, 0)} | ${fmt(r.txtWallMs, 0)} | ${fmt(r.synTurns, 0)} | ${fmt(r.txtTurns, 0)} | ${fmt(r.steerBytes, 0)} |`);
	}
	report.push("");

	const text = `${report.join("\n")}\n`;
	if (opt.out) {
		fs.writeFileSync(opt.out, text, "utf-8");
		console.log(`report written: ${opt.out}`);
	} else {
		console.log(text);
	}
	const sidecar = { generatedAt: new Date().toISOString(), paired: rows.length, synValid: syn.size, txtValid: txt.size, intervals, rows: rows.map((r) => ({ ...r, synDetail: undefined })) };
	fs.writeFileSync(path.join(opt.out ? path.dirname(opt.out) : process.cwd(), "p50-aggregate-rows.json"), `${JSON.stringify(sidecar, null, "\t")}\n`, "utf-8");
}

main();
