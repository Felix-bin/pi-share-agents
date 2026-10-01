// Phase 3 总聚合：全部 run 一键出 M8 汇总表 + 配对判定 + judge 合并。
//
// 输入（均已完成或部分完成的 run 目录）：
//   exp-a-r / exp-a-q（四臂主对比）· exp-ab-r（消融）· exp-b-r / exp-b-q（链）· lme-100（检索）
// 输出：<out>/final-report.md + m8-per-attempt.jsonl（每 attempt 一行 M8 全量账）
//
// 用法：node --experimental-strip-types experiments/openeuler/shm/final-aggregate.mjs \
//   --exp-root /root/.pi/agent/synapse/experiments --out <dir>
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BOOTSTRAP_B, BOOTSTRAP_SEED, bootstrapInterval, crossesZero } from "./matrix.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args["exp-root"] ?? "/root/.pi/agent/synapse/experiments");
const OUT = path.resolve(args.out ?? path.join(ROOT, "final-aggregate"));
fs.mkdirSync(OUT, { recursive: true });

const RUNS = [
	{ key: "exp-a-r", kind: "exp-a", label: "EXP-A R 组（SWE-QA Flask 10 题 × 4 臂）", group: "R" },
	{ key: "exp-a-q", kind: "exp-a", label: "EXP-A Q 组（MuSiQue 6 题 × 4 臂）", group: "Q" },
	{ key: "exp-ab-r", kind: "exp-ab", label: "EXP-AB 消融（R 组 6 题 × 4 配置）", group: "AB" },
	{ key: "exp-b-r", kind: "exp-b", label: "EXP-B 链 1（Flask 5 题连续 vs 冷启动）", group: "B-r" },
	{ key: "exp-b-q", kind: "exp-b", label: "EXP-B 链 2（MuSiQue 4 连问 vs 冷启动）", group: "B-q" },
];

const lines = ["# 决赛实验总聚合报告", "", `生成：${new Date().toISOString()}`, ""];
const m8Rows = [];

for (const run of RUNS) {
	const dir = path.join(ROOT, `${run.key}-20261002`);
	if (!fs.existsSync(dir)) { lines.push(`## ${run.label}`, "", "> run 目录不存在，跳过", ""); continue; }
	const partial = ["exp-a-partial.jsonl", "exp-ab-partial.jsonl", "exp-b-partial.jsonl"].map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));
	if (!partial) { lines.push(`## ${run.label}`, "", "> 无 partial，跳过", ""); continue; }
	const rows = fs.readFileSync(partial, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const armField = rows[0]?.arm !== undefined ? "arm" : (rows[0]?.config !== undefined ? "config" : "condition");
	const valid = rows.filter((r) => r.valid);

	lines.push(`## ${run.label}`, "");
	lines.push(`- attempts：${rows.length}（valid ${valid.length}，invalid ${rows.length - valid.length}——不按 0 计）`);

	// 臂级汇总表（token/墙钟/SHM 证据/记忆证据）
	const byArm = new Map();
	for (const r of valid) {
		const a = r[armField];
		const slot = byArm.get(a) ?? { n: 0, tokIn: 0, tokOut: 0, wallMs: 0, shmHit: 0, corpusLoad: 0, stateSend: 0, memReuse: 0, answerChars: 0 };
		slot.n += 1;
		slot.tokIn += (r.parentIn ?? 0) + (r.childIn ?? 0);
		slot.tokOut += (r.parentOut ?? 0) + (r.childOut ?? 0);
		slot.wallMs += r.wallMs ?? 0;
		slot.shmHit += r.ledger?.["shm-hit"] ?? 0;
		slot.corpusLoad += r.ledger?.["corpus-load"] ?? 0;
		slot.stateSend += r.ledger?.["state-send"] ?? 0;
		slot.memReuse += r.ledger?.["memory-reuse"] ?? 0;
		slot.answerChars += r.answerChars ?? 0;
		byArm.set(a, slot);
	}
	lines.push("", "| 臂/配置 | n | token in（均） | token out（均） | 墙钟 s（均） | shm-hit | corpus-load | state-send | mem-reuse |", "|---|---|---|---|---|---|---|---|---|");
	for (const [arm, s] of byArm) {
		lines.push(`| ${arm} | ${s.n} | ${Math.round(s.tokIn / s.n)} | ${Math.round(s.tokOut / s.n)} | ${Math.round(s.wallMs / s.n / 1000)} | ${s.shmHit} | ${s.corpusLoad} | ${s.stateSend} | ${s.memReuse} |`);
	}

	// M8 逐 attempt 行（供 m8-per-attempt.jsonl）
	for (const r of rows) {
		m8Rows.push({
			arm: r[armField], answerChars: r.answerChars ?? 0, group: run.group,
			index: r.index, invalid: !r.valid,
			memReuse: r.ledger?.["memory-reuse"] ?? 0, problem: r.problem ?? null,
			shmHit: r.ledger?.["shm-hit"] ?? 0, stateSend: r.ledger?.["state-send"] ?? 0,
			tokIn: (r.parentIn ?? 0) + (r.childIn ?? 0), tokOut: (r.parentOut ?? 0) + (r.childOut ?? 0),
			valid: r.valid, wallMs: r.wallMs ?? 0,
		});
	}
	lines.push("");
}

// --- 配对判定（exp-a-report 的逻辑内联，全部组） ---------------------------------
function pairJudgment(rows, armField, aName, bName, metric) {
	const byIndex = new Map(rows.filter((r) => r[armField] === bName).map((r) => [r.index, r]));
	const diffs = [];
	for (const a of rows.filter((r) => r[armField] === aName && r.valid)) {
		const b = byIndex.get(a.index);
		if (!b || !b.valid) continue;
		const val = (r) => metric === "token" ? (r.parentIn ?? 0) + (r.childIn ?? 0) + (r.parentOut ?? 0) + (r.childOut ?? 0) : (r.wallMs ?? 0);
		diffs.push(val(a) - val(b));
	}
	if (diffs.length === 0) return null;
	const ci = bootstrapInterval(diffs);
	return { n: diffs.length, mean: diffs.reduce((s, d) => s + d, 0) / diffs.length, lo: ci.lo, hi: ci.hi, crosses: crossesZero(ci) };
}

lines.push("## 配对判定（tokenTotal 口径；diff=A−B，正=B 更省）", "");
const PAIRS = [
	{ group: "R", pairs: [["TXT", "SYN"], ["SYN", "CREWAI"], ["SYN", "AUTOGEN"]] },
	{ group: "Q", pairs: [["TXT", "SYN"], ["SYN", "CREWAI"], ["SYN", "AUTOGEN"]] },
	{ group: "AB", pairs: [["SYN-full", "SYN-state"], ["SYN-full", "SYN-memory"], ["SYN-full", "SYN-shm"]] },
	{ group: "B-r", pairs: [["chain", "cold"]] },
	{ group: "B-q", pairs: [["chain", "cold"]] },
];
lines.push("| 组 | 配对 | n | diff 均值 | 95% CI | 跨 0 | 判定 |", "|---|---|---|---|---|---|---|");
for (const { group, pairs } of PAIRS) {
	const run = RUNS.find((r) => r.group === group);
	const dir = path.join(ROOT, `${run.key}-20261002`);
	const partial = ["exp-a-partial.jsonl", "exp-ab-partial.jsonl", "exp-b-partial.jsonl"].map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));
	if (!partial) continue;
	const rows = fs.readFileSync(partial, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const armField = rows[0]?.arm !== undefined ? "arm" : (rows[0]?.config !== undefined ? "config" : "condition");
	for (const [a, b] of pairs) {
		const j = pairJudgment(rows, armField, a, b, "token");
		if (!j) { lines.push(`| ${group} | ${a}−${b} | 0 | — | — | — | 无有效配对 |`); continue; }
		const verdict = j.crosses ? "不可宣称显著" : j.mean > 0 ? b + " 显著更省" : b + " 显著更多";
		lines.push(`| ${group} | ${a}−${b} | ${j.n} | ${Math.round(j.mean)} | [${Math.round(j.lo)}, ${Math.round(j.hi)}] | ${j.crosses ? "是" : "否"} | ${verdict} |`);
	}
}
lines.push("", `> bootstrap B=${BOOTSTRAP_B} seed=${BOOTSTRAP_SEED}；n<10 标注「已实现待扩样」。`, "");

// --- judge 合并 -------------------------------------------------------------------
lines.push("## judge（qwen3.8-max × 官方五维 × 5 票中位）", "");
lines.push("| 组 | 臂/配置 | n | total（均） | correctness | completeness | relevance | clarity | reasoning |", "|---|---|---|---|---|---|---|---|---|");
for (const run of RUNS) {
	const jf = path.join(ROOT, `${run.key}-20261002`, "judge-results.jsonl");
	if (!fs.existsSync(jf)) continue;
	const js = fs.readFileSync(jf, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((j) => j.total !== null);
	const byArm = new Map();
	for (const j of js) {
		const arm = j.key.split("-").slice(1).join("-");
		const s = byArm.get(arm) ?? { n: 0, total: 0, c: 0, comp: 0, rel: 0, cl: 0, r: 0 };
		s.n += 1; s.total += j.total; s.c += j.correctness; s.comp += j.completeness; s.rel += j.relevance; s.cl += j.clarity; s.r += j.reasoning;
		byArm.set(arm, s);
	}
	for (const [arm, s] of byArm) {
		lines.push(`| ${run.group} | ${arm} | ${s.n} | ${(s.total / s.n).toFixed(1)} | ${(s.c / s.n).toFixed(1)} | ${(s.comp / s.n).toFixed(1)} | ${(s.rel / s.n).toFixed(1)} | ${(s.cl / s.n).toFixed(1)} | ${(s.r / s.n).toFixed(1)} |`);
	}
}
lines.push("");

// --- LME --------------------------------------------------------------------------
const lmeSummary = path.join(ROOT, "lme-100-20261002", "summary.json");
if (fs.existsSync(lmeSummary)) {
	const s = JSON.parse(fs.readFileSync(lmeSummary, "utf-8"));
	lines.push("## LongMemEval（EXP-B 链 3，n=100，官方 recall_all 口径）", "");
	lines.push(`- **recall_all@5 = ${s.meanRecallAllAtK}**；recall_any@5 = ${s.meanRecallAnyAtK}；semantic ok ${s.nSemanticOk}/${s.n}；剔除 _abs ${s.skippedAbs} 题`, "");
}

fs.writeFileSync(path.join(OUT, "final-report.md"), lines.join("\n") + "\n");
fs.writeFileSync(path.join(OUT, "m8-per-attempt.jsonl"), m8Rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(lines.join("\n"));
console.log(`\nwritten: ${OUT}/final-report.md, m8-per-attempt.jsonl`);

function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1]; return out; }
