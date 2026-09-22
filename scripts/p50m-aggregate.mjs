#!/usr/bin/env node
/**
 * P50M aggregation: three-arm memory-reuse comparison over the paired round
 * logs (docs/experiments/P50M-memory-reuse-preregistration-20260921.md §4/§5).
 *
 *   node scripts/p50m-aggregate.mjs --root <p50mExpRoot> [--judge <judge-results.json>] [--out <report.md>]
 *
 * Arms: A = cold control (memory wiped each round), B = warm structured
 * (product autoDistill), C = warm plain-text notes.md. Each arm runs the v4
 * family twice (runs 1-30 = pass 1, runs 31-60 = verbatim replay). Paired
 * differences get percentile bootstrap intervals (B=10000, seed=20260921);
 * an interval crossing zero is stated as crossing zero.
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

function validByRound(dir) {
	const byRound = new Map();
	for (const record of readJsonl(path.join(dir, "rounds.jsonl"))) {
		if (record.valid && !byRound.has(record.round)) byRound.set(record.round, record);
	}
	return byRound;
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

function metricsOf(byRound, rounds) {
	const tokens = [];
	const turns = [];
	for (const round of rounds) {
		const record = byRound.get(round);
		if (record === undefined || record.usage === null) continue;
		tokens.push((record.usage.input ?? 0) + (record.usage.output ?? 0));
		turns.push(record.usage.turns ?? 0);
	}
	const mean = (arr) => (arr.length === 0 ? null : arr.reduce((s, v) => s + v, 0) / arr.length);
	return { tokenMean: mean(tokens), turnMean: mean(turns), n: tokens.length, tokens, turns };
}

function pairedDiff(byRoundX, byRoundY, roundsX, metric) {
	// Y − X over matched rounds (positive = X cheaper when metric is token).
	const diffs = [];
	for (const round of roundsX) {
		const x = byRoundX.get(round);
		const y = byRoundY.get(round);
		if (x === undefined || y === undefined || x.usage === null || y.usage === null) continue;
		diffs.push((metric === "token" ? (y.usage.input ?? 0) + (y.usage.output ?? 0) - ((x.usage.input ?? 0) + (x.usage.output ?? 0)) : (y.usage.turns ?? 0) - (x.usage.turns ?? 0)));
	}
	return diffs;
}

function rowOf(label, diffs, unit) {
	const iv = bootstrapInterval(diffs);
	if (iv === null) return `| ${label} | — | — | — |`;
	return `| ${label} | ${fmt(iv.mean)} ${unit} | [${fmt(iv.ci95[0])}, ${fmt(iv.ci95[1])}] | ${crossesZero(iv) ? "跨 0" : "不跨"} |`;
}

function main() {
	const argv = process.argv.slice(2);
	const opt = { root: null, judge: null, out: null };
	for (let i = 0; i < argv.length; i += 2) opt[argv[i].slice(2)] = argv[i + 1];
	if (!opt.root) throw new Error("--root <p50mExpRoot> required");
	const armDir = (arm) => path.join(opt.root, arm);
	const byRound = Object.fromEntries(["a", "b", "c"].map((arm) => [arm, validByRound(armDir(arm))]));
	const pass1 = Array.from({ length: 30 }, (_, i) => i + 1);
	const pass2 = Array.from({ length: 30 }, (_, i) => i + 31);

	const M = {};
	for (const arm of ["a", "b", "c"]) {
		M[`${arm}1`] = metricsOf(byRound[arm], pass1);
		M[`${arm}2`] = metricsOf(byRound[arm], pass2);
	}

	const lines = [];
	lines.push("# P50M 记忆复用三臂聚合报告（A 冷 / B 热-结构化 / C 热-纯文本，v4 族 ×2 遍）");
	lines.push("");
	lines.push(`- 预登记：docs/experiments/P50M-memory-reuse-preregistration-20260921.md（§3 修订版：B 臂=产品 autoDistill outbox）`);
	lines.push(`- 数据：${opt.root}/{a,b,c}（manifest 记录代码 SHA 与本预登记 SHA）`);
	lines.push(`- 覆盖：A ${M.a1.n + M.a2.n} valid、B ${M.b1.n + M.b2.n} valid、C ${M.c1.n + M.c2.n} valid（每臂 60 轮计划）`);
	lines.push("- bootstrap：B=10000，seed=20260921；每差必带区间，跨 0 如实标注");
	lines.push("");
	lines.push("## 主表一：各臂分遍基线（每任务均值）");
	lines.push("");
	lines.push("| 臂 × 遍 | 子会话 token 均值 | turns 均值 | n |");
	lines.push("|---|---|---|---|");
	for (const [arm, label] of [["a", "A 冷"], ["b", "B 热-结构化"], ["c", "C 热-纯文本"]]) {
		for (const [p, pl] of [[1, "第一遍"], [2, "第二遍（重放）"]]) {
			const m = M[`${arm}${p}`];
			lines.push(`| ${label} ${pl} | ${fmt(m.tokenMean, 0)} | ${fmt(m.turnMean)} | ${m.n} |`);
		}
	}

	lines.push("");
	lines.push("## 主表二：配对差（正 = 前者更省）");
	lines.push("");
	lines.push("| 比较 | 差点估计 | 95% 区间 | 跨 0？ |");
	lines.push("|---|---|---|---|");
	lines.push(rowOf("RQ1 B 第二遍 − B 第一遍（token；复用增益）", pairedDiff(byRound.b, byRound.b, pass2, "token").map((d, i) => d), "tok"));
	{
		// pass2 rounds pair with pass1 rounds as (r+31-1) → task r: matched task id.
		const diffs = [];
		for (const r of pass1) {
			const x = byRound.b.get(r);
			const y = byRound.b.get(r + 30);
			if (x?.usage && y?.usage) diffs.push((y.usage.input ?? 0) + (y.usage.output ?? 0) - ((x.usage.input ?? 0) + (x.usage.output ?? 0)));
		}
		lines[rowOf.length - 1] = lines[lines.length - 1];
		lines[lines.length - 1] = rowOf("RQ1 B 第二遍 − B 第一遍（同任务跨遍配对，token）", diffs, "tok");
		const diffsTurns = [];
		for (const r of pass1) {
			const x = byRound.b.get(r);
			const y = byRound.b.get(r + 30);
			if (x?.usage && y?.usage) diffsTurns.push((y.usage.turns ?? 0) - (x.usage.turns ?? 0));
		}
		lines.push(rowOf("RQ1 B 第二遍 − B 第一遍（turns）", diffsTurns, "轮"));
		const diffsC = [];
		for (const r of pass1) {
			const x = byRound.c.get(r);
			const y = byRound.c.get(r + 30);
			if (x?.usage && y?.usage) diffsC.push((y.usage.input ?? 0) + (y.usage.output ?? 0) - ((x.usage.input ?? 0) + (x.usage.output ?? 0)));
		}
		lines.push(rowOf("RQ2b C 第二遍 − C 第一遍（token）", diffsC, "tok"));
		const diffsBC = [];
		for (const r of pass2) {
			const x = byRound.c.get(r);
			const y = byRound.b.get(r);
			if (x?.usage && y?.usage) diffsBC.push((y.usage.input ?? 0) + (y.usage.output ?? 0) - ((x.usage.input ?? 0) + (x.usage.output ?? 0)));
		}
		lines.push(rowOf("RQ2 B − C（第二遍同任务配对，token；正 = 结构化更省）", diffsBC, "tok"));
		const diffsBA2 = [];
		for (const r of pass2) {
			const x = byRound.a.get(r);
			const y = byRound.b.get(r);
			if (x?.usage && y?.usage) diffsBA2.push((y.usage.input ?? 0) + (y.usage.output ?? 0) - ((x.usage.input ?? 0) + (x.usage.output ?? 0)));
		}
		lines.push(rowOf("B − A（第二遍同任务配对，token；正 = 热臂更省）", diffsBA2, "tok"));
		const diffsCA2 = [];
		for (const r of pass2) {
			const x = byRound.a.get(r);
			const y = byRound.c.get(r);
			if (x?.usage && y?.usage) diffsCA2.push((y.usage.input ?? 0) + (y.usage.output ?? 0) - ((x.usage.input ?? 0) + (x.usage.output ?? 0)));
		}
		lines.push(rowOf("C − A（第二遍同任务配对，token）", diffsCA2, "tok"));
		const balBA = [];
		for (const r of pass1) {
			const x = byRound.a.get(r);
			const y = byRound.b.get(r);
			if (x?.usage && y?.usage) balBA.push((y.usage.input ?? 0) + (y.usage.output ?? 0) - ((x.usage.input ?? 0) + (x.usage.output ?? 0)));
		}
		lines.push(rowOf("基线平衡 B − A（第一遍，token；应近 0）", balBA, "tok"));
	}

	lines.push("");
	lines.push("## 复用率与记忆体量（B 臂装置侧证据）");
	const bMemDir = path.join(armDir("b"), "store-B", "memory");
	const bRecords = fs.existsSync(bMemDir) ? fs.readdirSync(bMemDir).filter((name) => name.endsWith(".json")).length : 0;
	const pendingLeft = fs.existsSync(path.join(armDir("b"), "store-B", "distill-pending")) ? fs.readdirSync(path.join(armDir("b"), "store-B", "distill-pending")).length : 0;
	const steerStats = (arm, rounds) => {
		const sizes = [];
		for (const r of rounds) {
			const record = byRound[arm].get(r);
			if (record === undefined) continue;
			sizes.push(record.steer === null || record.steer === undefined ? 0 : record.steer.bytes ?? 0);
		}
		const nonzero = sizes.filter((s) => s > 0).length;
		return { nonzero, mean: sizes.length ? sizes.reduce((s, v) => s + v, 0) / sizes.length : null };
	};
	const b1s = steerStats("b", pass1);
	const b2s = steerStats("b", pass2);
	lines.push(`- B 臂记忆库累积：${bRecords} 条记录（distill-pending 未清残留：${pendingLeft}）`);
	lines.push(`- B handover steer 字节：第一遍均值 ${fmt(b1s.mean, 0)} B（命中 ${b1s.nonzero}/30），第二遍均值 ${fmt(b2s.mean, 0)} B（命中 ${b2s.nonzero}/30）`);
	const cNotes = path.join("D:/操作系统开源大赛/synapse/_state/p45-runs/work", "notes.md");
	if (fs.existsSync(cNotes)) {
		const noteLines = fs.readFileSync(cNotes, "utf-8").split("\n").filter((l) => l.includes("[task")).length;
		lines.push(`- C 臂 notes.md 累积条目：${noteLines} 行`);
	}

	if (opt.judge && fs.existsSync(opt.judge)) {
		const judge = JSON.parse(fs.readFileSync(opt.judge, "utf-8"));
		lines.push("");
		lines.push("## 判分（judge v2 归一化口径）");
		for (const arm of ["A", "B", "C"]) {
			const scores = Object.entries(judge.scores[arm] ?? {});
			if (scores.length === 0) continue;
			const mean = scores.reduce((s, [, v]) => s + v, 0) / scores.length;
			const p1 = scores.filter(([r]) => Number(r) <= 30);
			const p2 = scores.filter(([r]) => Number(r) > 30);
			const m1 = p1.length ? p1.reduce((s, [, v]) => s + v, 0) / p1.length : null;
			const m2 = p2.length ? p2.reduce((s, [, v]) => s + v, 0) / p2.length : null;
			lines.push(`- ${arm}：整体 ${fmt(mean, 3)}（第一遍 ${fmt(m1, 3)} / 第二遍 ${fmt(m2, 3)}，n=${scores.length}）`);
		}
		if (judge.selfCheck) lines.push(`- judge 自检 flip 率：${judge.selfCheck.flipRate}（${judge.selfCheck.totalFlips}/${judge.selfCheck.totalPoints} 要点，${judge.selfCheck.cases} 例双判）`);
	} else {
		lines.push("");
		lines.push("## 判分：待判分（p50-judge.mjs 未运行或结果未给出；本节留位不省略）");
	}

	lines.push("");
	lines.push("## 逐轮曲线数据（token；供累积曲线图）");
	lines.push("");
	lines.push("| 轮 | 遍 | 任务 | A | B | C |");
	lines.push("|---|---|---|---|---|---|");
	for (const round of [...pass1, ...pass2]) {
		const cells = ["a", "b", "c"].map((arm) => {
			const record = byRound[arm].get(round);
			return record?.usage ? fmt((record.usage.input ?? 0) + (record.usage.output ?? 0), 0) : "—";
		});
		lines.push(`| ${round} | ${round <= 30 ? 1 : 2} | ${(round - 1) % 30 + 1} | ${cells[0]} | ${cells[1]} | ${cells[2]} |`);
	}

	const report = lines.join("\n") + "\n";
	if (opt.out) {
		fs.writeFileSync(opt.out, report, "utf-8");
		console.log(`report written: ${opt.out}`);
	} else {
		console.log(report);
	}
}

main();
