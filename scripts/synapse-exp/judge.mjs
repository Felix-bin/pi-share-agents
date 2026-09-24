#!/usr/bin/env node
/**
 * Answer-quality judge for synapse-bench experiment directories.
 *
 *   node scripts/synapse-exp/judge.mjs <benchExpDir> [--judge-model deepseek/deepseek-v4.1-flash] [--provider <p>]
 *        [--self-check] [--out <dir>] [--pi-cli <cli.js>] [--concurrency 2]
 *
 * One LLM call per (arm, group, round): the task text, that task's keypoints
 * (from the family file whose sha256 the bench manifest recorded), and the
 * round's final answer (evidence/<arm>/<group>/round-NN/attempt-K/answer.md,
 * last valid attempt). The judge scores each keypoint 0/1; round score =
 * hits / keypoints. Calls go through `pi -p` with tools, extensions, skills and
 * context files off, so pi's own configured provider and key are used and no
 * key passes through this script.
 *
 * Runs AFTER the measured run, never interleaved with it. The judge model is,
 * by default, from a different family than the measured model to avoid a
 * self-preference bias; --self-check re-judges every round a second time and
 * reports the flip rate (per keypoint) as the judge's own consistency.
 *
 * A round without an answer, or whose judge reply cannot be parsed after two
 * retries, is recorded as unavailable — never as 0.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const args = process.argv.slice(2);
const opt = (flag, fallback) => {
	const at = args.indexOf(flag);
	return at === -1 ? fallback : args[at + 1];
};
const benchDir = path.resolve(args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--"))) ?? "");
if (!fs.existsSync(path.join(benchDir, "manifest.json"))) throw new Error(`not a synapse-bench experiment dir: ${benchDir}`);
const JUDGE_MODEL = opt("--judge-model", "deepseek/deepseek-v4.1-flash");
const SELF_CHECK = args.includes("--self-check");
const CONCURRENCY = Number(opt("--concurrency", "2"));
const bench = JSON.parse(fs.readFileSync(path.join(benchDir, "manifest.json"), "utf-8"));
const PROVIDER = opt("--provider", bench.provider ?? null);
const PI_CLI = path.resolve(opt("--pi-cli", bench.pi?.cli ?? path.resolve(REPO, "..", "pi-web/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")));
const OUT_ROOT = path.resolve(opt("--out", path.join(os.homedir(), ".pi", "agent", "synapse", "experiments")));
const ID = `judge-${bench.experimentId}`;
const outDir = path.join(OUT_ROOT, ID);
fs.mkdirSync(outDir, { recursive: true });
const writeJson = (f, v) => fs.writeFileSync(f, `${JSON.stringify(v, null, "\t")}\n`);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const log = (m) => console.log(`[judge ${new Date().toISOString().slice(11, 19)}] ${m}`);

// Families, verified against what the bench recorded.
const families = {};
for (const g of bench.groups) {
	const file = path.join(REPO, g.file);
	const digest = sha256(fs.readFileSync(file));
	if (g.familySha256 && digest !== g.familySha256) throw new Error(`${g.file} changed since the run (sha ${digest.slice(0, 12)} ≠ recorded ${g.familySha256.slice(0, 12)})`);
	families[g.group] = JSON.parse(fs.readFileSync(file, "utf-8"));
}

// Last valid attempt per arm × group × round.
const rounds = fs.readFileSync(path.join(benchDir, "rounds.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const latest = new Map();
for (const r of rounds) if (r.valid) latest.set(`${r.arm}|${r.group}|${r.round}`, r);
const jobs = [...latest.values()].sort((a, b) => a.group.localeCompare(b.group) || a.round - b.round || a.arm.localeCompare(b.arm));

const SYSTEM =
	"You are a strict grading engine for a code-reading quiz. You receive a task, the grading keypoints, and a candidate answer. For EACH keypoint decide whether the answer states the fact or an exact equivalent (unit conversions and verbatim constant expressions count; a wrong number on a probed constant fails that keypoint). Judge only against the keypoints; extra content neither helps nor hurts. Reply with STRICT JSON only: {\"hits\": [0 or 1, ...]} with exactly one entry per keypoint, in order. No prose, no code fence.";

function runPi(prompt) {
	return new Promise((resolve) => {
		const argv = [PI_CLI, "-p", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline", "--model", JUDGE_MODEL, "--system-prompt", SYSTEM];
		if (PROVIDER) argv.push("--provider", PROVIDER);
		const child = spawn(process.execPath, argv, { cwd: os.tmpdir(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (err += c));
		const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, err, out });
		});
		child.stdin.end(prompt);
	});
}

function parseHits(text, n) {
	const m = text.match(/\{[\s\S]*"hits"[\s\S]*\}/);
	if (!m) return null;
	try {
		const hits = JSON.parse(m[0]).hits;
		if (!Array.isArray(hits) || hits.length !== n || hits.some((h) => h !== 0 && h !== 1)) return null;
		return hits;
	} catch {
		return null;
	}
}

async function judgeOnce(task, answer) {
	const prompt = [`TASK:\n${task.task}`, `KEYPOINTS (${task.keypoints.length}):\n${task.keypoints.map((k, i) => `${i + 1}. ${k}`).join("\n")}`, `CANDIDATE ANSWER:\n${answer}`].join("\n\n");
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const t = Date.now();
		const r = await runPi(prompt);
		const hits = parseHits(r.out, task.keypoints.length);
		if (hits) return { attempts: attempt, hits, ms: Date.now() - t };
		log(`  parse failed (attempt ${attempt}, exit ${r.code}): ${(r.out || r.err).slice(0, 160).replace(/\n/g, " ")}`);
	}
	return null;
}

const results = [];
const queue = [...jobs];
async function worker() {
	while (queue.length > 0) {
		const r = queue.shift();
		const task = families[r.group].tasks.find((t) => t.index === (r.taskIndex ?? r.round));
		const answerFile = path.join(benchDir, "evidence", r.arm, r.group, `round-${String(r.round).padStart(2, "0")}`, `attempt-${r.attempt}`, "answer.md");
		const row = { arm: r.arm, attempt: r.attempt, group: r.group, keypoints: task.keypoints.length, round: r.round };
		if (!fs.existsSync(answerFile)) {
			results.push({ ...row, score: null, reason: "no answer.md" });
			continue;
		}
		const answer = fs.readFileSync(answerFile, "utf-8");
		row.answerSha256 = sha256(answer);
		const first = await judgeOnce(task, answer);
		if (!first) {
			results.push({ ...row, score: null, reason: "judge reply unparseable" });
			continue;
		}
		row.hits = first.hits;
		row.score = first.hits.reduce((a, b) => a + b, 0) / first.hits.length;
		row.judgeMs = first.ms;
		if (SELF_CHECK) {
			const second = await judgeOnce(task, answer);
			row.hits2 = second?.hits ?? null;
			row.flips = second ? second.hits.filter((h, i) => h !== first.hits[i]).length : null;
		}
		log(`${r.arm} ${r.group} r${r.round}: ${row.hits.join("")} → ${row.score.toFixed(2)}${SELF_CHECK ? ` (flips ${row.flips})` : ""}`);
		results.push(row);
	}
}
await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
results.sort((a, b) => a.group.localeCompare(b.group) || a.round - b.round || a.arm.localeCompare(b.arm));
fs.writeFileSync(path.join(outDir, "judge-results.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");

// Paired comparison over (group, round) pairs where both arms scored.
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
const arms = [...new Set(results.map((r) => r.arm))].sort();
const groups = [...new Set(results.map((r) => r.group))].sort();
const scoreOf = new Map(results.filter((r) => r.score !== null).map((r) => [`${r.arm}|${r.group}|${r.round}`, r.score]));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const comparison = {};
if (arms.includes("TXT") && arms.includes("SYN")) {
	const pairs = [];
	for (const g of groups) for (let k = 1; k <= 10; k += 1) {
		const t = scoreOf.get(`TXT|${g}|${k}`);
		const s = scoreOf.get(`SYN|${g}|${k}`);
		if (t !== undefined && s !== undefined) pairs.push([t, s]);
	}
	if (pairs.length > 0) {
		const rnd = mulberry32(20260921);
		const B = 10000;
		const diffs = [];
		for (let b = 0; b < B; b += 1) {
			let sum = 0;
			for (let i = 0; i < pairs.length; i += 1) {
				const [t, s] = pairs[Math.floor(rnd() * pairs.length)];
				sum += s - t;
			}
			diffs.push(sum / pairs.length);
		}
		diffs.sort((a, b) => a - b);
		const txt = mean(pairs.map((p) => p[0]));
		const syn = mean(pairs.map((p) => p[1]));
		comparison.score = { ci: [diffs[Math.floor(0.025 * B)], diffs[Math.floor(0.975 * B)]], diff: syn - txt, n: pairs.length, pct: txt ? (syn - txt) / txt : null, syn, txt };
	}
}
const series = {};
for (const a of arms) {
	series[a] = {};
	for (const g of groups) series[a][g] = results.filter((r) => r.arm === a && r.group === g).map((r) => ({ round: r.round, score: r.score }));
}
const byArm = Object.fromEntries(arms.map((a) => [a, { meanScore: mean(results.filter((r) => r.arm === a && r.score !== null).map((r) => r.score)), n: results.filter((r) => r.arm === a && r.score !== null).length, unavailable: results.filter((r) => r.arm === a && r.score === null).length }]));
let flipRate = null;
if (SELF_CHECK) {
	const checked = results.filter((r) => typeof r.flips === "number");
	const kp = checked.reduce((a, r) => a + r.keypoints, 0);
	flipRate = kp ? checked.reduce((a, r) => a + r.flips, 0) / kp : null;
}
writeJson(path.join(outDir, "manifest.json"), { benchExperimentId: bench.experimentId, benchDir, createdAt: new Date().toISOString(), experimentId: ID, judgeModel: JUDGE_MODEL, kind: "judge", measuredModel: bench.model, model: JUDGE_MODEL, provider: PROVIDER, selfCheck: SELF_CHECK, systemPromptSha256: sha256(SYSTEM) });
writeJson(path.join(outDir, "summary.json"), { arms, byArm, comparison, flipRate, groups, series });
const lines = [`# judge — ${bench.experimentId}`, "", `judge ${JUDGE_MODEL} (measured model ${bench.model}); ${results.length} rounds${SELF_CHECK ? `; self-check flip rate ${flipRate === null ? "n/a" : (100 * flipRate).toFixed(1) + "%"}` : ""}`, "", "| arm | n | mean score | unavailable |", "|---|---|---|---|"];
for (const a of arms) lines.push(`| ${a} | ${byArm[a].n} | ${byArm[a].meanScore?.toFixed(3) ?? "n/a"} | ${byArm[a].unavailable} |`);
if (comparison.score) lines.push("", `SYN − TXT = ${comparison.score.diff.toFixed(3)} [${comparison.score.ci.map((x) => x.toFixed(3)).join(", ")}] over ${comparison.score.n} paired rounds`);
fs.writeFileSync(path.join(outDir, "report.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
