#!/usr/bin/env node
/**
 * Scores the public-benchmark groups of a synapse-bench run by each benchmark's own rule.
 *
 *   node experiments/analysis/score-public.mjs <benchExpDir> \
 *     [--sweqa experiments/data/swe-qa] [--judge-model z-ai/glm-5.3-flashx] \
 *     [--provider commandcode] [--votes 5] [--concurrency 3]
 *
 *  Q (MuSiQue): the answer's last `ANSWER:` line, SQuAD-normalized, against the
 *    gold answer and its aliases — EM and token F1, the maximum over golds (the
 *    MuSiQue/HotpotQA convention). Cover-EM — a gold contained in the whole
 *    normalized answer — is reported beside it, since agentic QA papers use it.
 *    A missing ANSWER line scores 0 and is counted.
 *  R (SWE-QA): SWE-QA's own LLM-as-judge prompt, read verbatim from the cloned
 *    benchmark (`Benchmark construction/score/llm-as-a-judge.py`), five
 *    dimensions 1–20, total 100; `--votes` independent judgments per answer,
 *    the per-dimension median kept (the benchmark takes five and votes).
 *
 * Paired differences B − A over (group, round) with the aggregate's bootstrap
 * (B = 10000, seed 20260921); non-inferiority of B against A is the lower CI
 * bound above −δ, δ = 0.05 of the scale (0.05 F1, 5 points of 100).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const args = process.argv.slice(2);
const opt = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const benchDir = path.resolve(args[0] ?? "");
if (!fs.existsSync(path.join(benchDir, "manifest.json"))) {
	console.error("usage: score-public.mjs <benchExpDir> [--sweqa <dir>] [--judge-model m] [--provider p] [--votes 5]");
	process.exit(2);
}
const home = (p) => p.replace(/^~(?=\/)/, os.homedir());
const SWEQA = path.resolve(home(opt("--sweqa", path.join(REPO, "experiments", "data", "swe-qa"))));
const JUDGE_MODEL = opt("--judge-model", "z-ai/glm-5.3-flashx");
const VOTES = Number(opt("--votes", "5"));
const CONCURRENCY = Number(opt("--concurrency", "3"));
const bench = JSON.parse(fs.readFileSync(path.join(benchDir, "manifest.json"), "utf-8"));
const PROVIDER = opt("--provider", bench.resumes?.at(-1)?.provider ?? bench.provider ?? null);
const PI_CLI = bench.pi?.cli ?? path.resolve(REPO, "..", "pi-web/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const log = (m) => console.log(`[score ${new Date().toISOString().slice(11, 19)}] ${m}`);

// Experiments recorded before the move to experiments/ name their families under scripts/synapse-bench/.
const familyPath = (file) => path.join(REPO, fs.existsSync(path.join(REPO, file)) ? file : file.replace(/^scripts\/synapse-bench\//, "experiments/bench/"));
const families = {};
for (const g of bench.groups) {
	const file = familyPath(g.file);
	if (sha256(fs.readFileSync(file)) !== g.familySha256) throw new Error(`${g.file} changed since the run`);
	families[g.group] = JSON.parse(fs.readFileSync(file, "utf-8"));
}
const rounds = fs.readFileSync(path.join(benchDir, "rounds.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const latest = new Map();
for (const r of rounds) if (r.valid) latest.set(`${r.arm}|${r.group}|${r.round}`, r);
const answerOf = (r) => {
	const file = path.join(benchDir, "evidence", r.arm, r.group, `round-${String(r.round).padStart(2, "0")}`, `attempt-${r.attempt}`, "answer.md");
	return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
};

// ---------------------------------------------------------------------------
// Q: SQuAD-style normalization, EM / F1 / Cover-EM.
// ---------------------------------------------------------------------------
function normalize(text) {
	return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\b(a|an|the)\b/g, " ").replace(/\s+/g, " ").trim();
}
function f1(prediction, gold) {
	const p = normalize(prediction).split(" ").filter(Boolean);
	const g = normalize(gold).split(" ").filter(Boolean);
	if (p.length === 0 || g.length === 0) return p.length === g.length ? 1 : 0;
	const counts = new Map();
	for (const token of g) counts.set(token, (counts.get(token) ?? 0) + 1);
	let common = 0;
	for (const token of p) if ((counts.get(token) ?? 0) > 0) { common += 1; counts.set(token, counts.get(token) - 1); }
	if (common === 0) return 0;
	const precision = common / p.length;
	const recall = common / g.length;
	return (2 * precision * recall) / (precision + recall);
}
function scoreQ(task, answer) {
	const golds = [task.answer, ...(task.answerAliases ?? [])];
	const lines = answer.split(/\r?\n/).map((line) => line.replace(/[*`_]/g, "").trim()).filter(Boolean);
	const answerLine = [...lines].reverse().find((line) => /^answer\s*[:：]/i.test(line));
	const predicted = answerLine ? answerLine.replace(/^answer\s*[:：]\s*/i, "") : null;
	const whole = ` ${normalize(answer)} `;
	return {
		answerLine: predicted !== null,
		coverEm: golds.some((gold) => normalize(gold).length > 0 && whole.includes(` ${normalize(gold)} `)) ? 1 : 0,
		em: predicted === null ? 0 : golds.some((gold) => normalize(gold) === normalize(predicted)) ? 1 : 0,
		f1: predicted === null ? 0 : Math.max(...golds.map((gold) => f1(predicted, gold))),
		predicted,
	};
}

// ---------------------------------------------------------------------------
// R: SWE-QA judge prompt, verbatim.
// ---------------------------------------------------------------------------
const judgeSource = path.join(SWEQA, "Benchmark construction", "score", "llm-as-a-judge.py");
let judgeTemplate = null;
if (families.R) {
	const source = fs.readFileSync(judgeSource, "utf-8");
	const start = source.indexOf('prompt = f"""');
	const end = source.indexOf('"""', start + 13);
	if (start < 0 || end < 0) throw new Error(`cannot find the judge prompt in ${judgeSource}`);
	judgeTemplate = source.slice(start + 13, end);
}
const DIMS = ["correctness", "completeness", "relevance", "clarity", "reasoning"];
const judgePrompt = (question, reference, candidate) =>
	judgeTemplate.replace("{question}", question).replace("{reference}", reference).replace("{candidate}", candidate).replaceAll("{{", "{").replaceAll("}}", "}");

function runPi(prompt) {
	return new Promise((resolve) => {
		const argv = [PI_CLI, "-p", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline", "--model", JUDGE_MODEL];
		if (PROVIDER) argv.push("--provider", PROVIDER);
		const child = spawn(process.execPath, argv, { cwd: os.tmpdir(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (c) => (out += c));
		const timer = setTimeout(() => child.kill("SIGTERM"), 240_000);
		child.on("close", () => {
			clearTimeout(timer);
			resolve(out);
		});
		child.stdin.end(prompt);
	});
}
function parseScores(text) {
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try {
		const value = JSON.parse(m[0]);
		if (!DIMS.every((d) => Number.isInteger(value[d]) && value[d] >= 1 && value[d] <= 20)) return null;
		return Object.fromEntries(DIMS.map((d) => [d, value[d]]));
	} catch {
		return null;
	}
}
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
async function scoreR(task, answer) {
	const prompt = judgePrompt(task.task.split("\n\n")[0], task.referenceAnswer, answer);
	const votes = [];
	let failures = 0;
	while (votes.length < VOTES && failures < VOTES * 2) {
		const parsed = parseScores(await runPi(prompt));
		if (parsed) votes.push(parsed);
		else failures += 1;
	}
	if (votes.length === 0) return { total: null, votes: 0 };
	const dims = Object.fromEntries(DIMS.map((d) => [d, median(votes.map((v) => v[d]))]));
	return { ...dims, parseFailures: failures, total: DIMS.reduce((s, d) => s + dims[d], 0), votes: votes.length };
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------
const jobs = [...latest.values()].filter((r) => families[r.group]?.group === "Q" || families[r.group]?.group === "R");
const rows = [];
const queue = [...jobs];
async function worker() {
	while (queue.length > 0) {
		const r = queue.shift();
		const task = families[r.group].tasks[r.round - 1];
		const answer = answerOf(r);
		const row = { arm: r.arm, attempt: r.attempt, group: r.group, round: r.round };
		if (answer === null) Object.assign(row, { unavailable: "no answer.md" });
		else if (r.group === "Q") Object.assign(row, scoreQ(task, answer));
		else Object.assign(row, await scoreR(task, answer));
		rows.push(row);
		log(`${r.arm} ${r.group} r${r.round}: ${r.group === "Q" ? `EM ${row.em} F1 ${row.f1?.toFixed(2)} cover ${row.coverEm}` : `total ${row.total} (${row.votes} votes)`}`);
	}
}
await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
rows.sort((a, b) => a.group.localeCompare(b.group) || a.round - b.round || a.arm.localeCompare(b.arm));

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
function bootstrap(diffs) {
	const rng = mulberry32(20260921);
	const means = [];
	for (let b = 0; b < 10_000; b += 1) {
		let s = 0;
		for (let i = 0; i < diffs.length; i += 1) s += diffs[Math.floor(rng() * diffs.length)];
		means.push(s / diffs.length);
	}
	means.sort((x, y) => x - y);
	return [means[250], means[9750]];
}
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const METRICS = { Q: [["f1", 0.05], ["em", 0.05], ["coverEm", 0.05]], R: [["total", 5]] };
const arms = bench.arms.map((a) => a.arm);
const PAIRS = [["SYN0", "SYN"], ["TXT", "SYN"], ["SYNCOLD", "SYN"], ["SYN0", "TXT"]];
const summary = { byArm: {}, comparisons: {}, experimentId: bench.experimentId, judge: families.R ? { model: JUDGE_MODEL, promptSha256: sha256(judgeTemplate), source: judgeSource, votes: VOTES } : null };
for (const group of Object.keys(families)) {
	const kind = families[group].group;
	for (const [metric, delta] of METRICS[kind] ?? []) {
		for (const arm of arms) {
			const values = rows.filter((r) => r.group === group && r.arm === arm && typeof r[metric] === "number").map((r) => r[metric]);
			((summary.byArm[group] ??= {})[arm] ??= {})[metric] = { mean: mean(values), n: values.length };
		}
		for (const [a, b] of PAIRS) {
			if (!arms.includes(a) || !arms.includes(b)) continue;
			const diffs = [];
			for (let round = 1; round <= bench.rounds; round += 1) {
				const ra = rows.find((r) => r.group === group && r.arm === a && r.round === round);
				const rb = rows.find((r) => r.group === group && r.arm === b && r.round === round);
				if (typeof ra?.[metric] === "number" && typeof rb?.[metric] === "number") diffs.push(rb[metric] - ra[metric]);
			}
			if (diffs.length === 0) continue;
			const ci = bootstrap(diffs);
			((summary.comparisons[group] ??= {})[`${a}-${b}`] ??= {})[metric] = { ci, delta, diff: mean(diffs), nonInferior: ci[0] > -delta, pairs: diffs.length };
		}
	}
	summary.byArm[group].missingAnswerLine = kind === "Q" ? Object.fromEntries(arms.map((arm) => [arm, rows.filter((r) => r.group === group && r.arm === arm && r.answerLine === false).length])) : undefined;
}
const outDir = path.join(path.dirname(benchDir), `score-${bench.experimentId}`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "rows.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
fs.writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, "\t")}\n`);
const lines = [`# 公开 benchmark 评分 — ${bench.experimentId}`, ""];
for (const [group, byArm] of Object.entries(summary.byArm)) {
	lines.push(`## ${group}（${families[group].title}）`, "", `| arm | ${Object.keys(byArm[arms[0]] ?? {}).join(" | ")} |`, `|---|${Object.keys(byArm[arms[0]] ?? {}).map(() => "---").join("|")}|`);
	for (const arm of arms) if (byArm[arm]) lines.push(`| ${arm} | ${Object.values(byArm[arm]).map((v) => (v.mean === null ? "n/a" : `${v.mean.toFixed(3)} (n=${v.n})`)).join(" | ")} |`);
	for (const [pair, metrics] of Object.entries(summary.comparisons[group] ?? {})) for (const [metric, c] of Object.entries(metrics)) lines.push(`- ${pair} ${metric}: B−A ${c.diff.toFixed(3)} [${c.ci.map((x) => x.toFixed(3)).join(", ")}] n=${c.pairs}; non-inferior (δ=${c.delta}): ${c.nonInferior ? "yes" : "no"}`);
	lines.push("");
}
fs.writeFileSync(path.join(outDir, "report.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
