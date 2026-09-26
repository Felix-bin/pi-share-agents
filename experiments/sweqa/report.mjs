#!/usr/bin/env node
// Per-arm summary and paired share-vs-baseline comparisons under the frozen decision rules (spec §5).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, evidenceName, mulberry32 } from "./matrix.mjs";

export const BASELINES = ["nico", "tintinweb"];
export const NON_INFERIORITY = 5;
// [name, value of one attempt, rule]: "fewer" needs the CI upper bound below 0; "quality" needs the lower bound above −δ.
export const METRICS = [
	["children", (a) => a.metrics.dispatch.children, "fewer"],
	["totalTokens", (a) => a.metrics.tokens.total, "fewer"],
	["commBytes", (a) => a.metrics.comm.bytes?.total ?? null, "fewer"],
	["downlinkBytes", (a) => a.metrics.comm.bytes?.downlink ?? null, "report"],
	["uplinkBytes", (a) => a.metrics.comm.bytes?.uplink ?? null, "report"],
	["pullBytes", (a) => a.metrics.comm.bytes?.pull ?? null, "report"],
	["wallMs", (a) => a.metrics.wallMs ?? null, "report"],
	["score", (a) => a.score?.total ?? null, "quality"],
];

export function bootstrap(diffs) {
	const rng = mulberry32(20260921), means = [];
	for (let b = 0; b < 10_000; b++) {
		let s = 0;
		for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rng() * diffs.length)];
		means.push(s / diffs.length);
	}
	means.sort((x, y) => x - y);
	return [means[250], means[9750]];
}

const mean = (xs) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null);
const sum = (xs) => xs.reduce((n, x) => n + x, 0);

// Only questions where both arms are valid and the metric exists are paired; the rest are counted, never zeroed.
export function compare(attempts, baseline) {
	const byKey = new Map(attempts.map((a) => [`${a.id}|${a.arm}`, a]));
	const ids = [...new Set(attempts.map((a) => a.id))];
	const out = {};
	for (const [name, get, rule] of METRICS) {
		const diffs = [];
		let excluded = 0;
		for (const id of ids) {
			const s = byKey.get(`${id}|share`), b = byKey.get(`${id}|${baseline}`);
			const x = s?.metrics.valid ? get(s) : null, y = b?.metrics.valid ? get(b) : null;
			if (typeof x !== "number" || typeof y !== "number") { excluded++; continue; }
			diffs.push(x - y);
		}
		const ci = diffs.length ? bootstrap(diffs) : [null, null];
		const row = { n: diffs.length, excluded, meanDiff: mean(diffs), ci, rule };
		if (rule === "fewer") row.shareFewer = ci[1] !== null && ci[1] < 0;
		if (rule === "quality") row.nonInferior = ci[0] !== null && ci[0] > -NON_INFERIORITY;
		out[name] = row;
	}
	out.qualityQualifier = out.score.nonInferior ? "quality non-inferior" : "quality not shown non-inferior";
	return out;
}

export function summarizeArm(attempts, arm) {
	const all = attempts.filter((a) => a.arm === arm), valid = all.filter((a) => a.metrics.valid);
	const failures = {};
	for (const a of all) for (const p of a.metrics.problems) failures[p] = (failures[p] ?? 0) + 1;
	const pick = (f) => valid.map(f).filter((x) => typeof x === "number");
	const byAgent = {};
	for (const a of valid) for (const [k, v] of Object.entries(a.metrics.dispatch.byAgent)) byAgent[k] = (byAgent[k] ?? 0) + v;
	const tokenAgents = {};
	for (const a of valid) for (const [k, v] of Object.entries(a.metrics.tokens.byAgent)) tokenAgents[k] = (tokenAgents[k] ?? 0) + v.total;
	const unclassified = {};
	for (const a of all) for (const [k, v] of Object.entries(a.metrics.comm.unclassified)) unclassified[k] = (unclassified[k] ?? 0) + v;
	const scored = valid.filter((a) => typeof a.score?.total === "number");
	return {
		attempts: all.length, valid: valid.length, failures,
		dispatch: { meanChildren: mean(pick((a) => a.metrics.dispatch.children)), totalChildren: sum(pick((a) => a.metrics.dispatch.children)), byAgent,
			meanDelegationCalls: mean(pick((a) => a.metrics.dispatch.delegationCalls)), maxDepth: Math.max(0, ...pick((a) => a.metrics.dispatch.maxDepth)) },
		tokens: { meanTotal: mean(pick((a) => a.metrics.tokens.total)), total: sum(pick((a) => a.metrics.tokens.total)),
			parent: sum(pick((a) => a.metrics.tokens.parent.total)), children: sum(pick((a) => a.metrics.tokens.children.total)),
			prompt: sum(pick((a) => a.metrics.tokens.parent.prompt + a.metrics.tokens.children.prompt)),
			output: sum(pick((a) => a.metrics.tokens.parent.output + a.metrics.tokens.children.output)),
			uncachedInput: sum(pick((a) => a.metrics.tokens.parent.input + a.metrics.tokens.children.input)),
			cacheRead: sum(pick((a) => a.metrics.tokens.parent.cacheRead + a.metrics.tokens.children.cacheRead)), byAgent: tokenAgents },
		comm: { meanBytes: mean(pick((a) => a.metrics.comm.bytes?.total)), bytes: Object.fromEntries(["downlink", "uplink", "pull", "total"].map((k) => [k, sum(pick((a) => a.metrics.comm.bytes?.[k]))])),
			tokens: Object.fromEntries(["downlink", "uplink", "pull", "total"].map((k) => [k, sum(pick((a) => a.metrics.comm.tokens?.[k]))])),
			control: sum(pick((a) => a.metrics.comm.control)), partial: valid.filter((a) => a.metrics.comm.partial).length, unclassified },
		audit: { outOfBounds: sum(all.map((a) => a.metrics.audit.outOfBounds)), projectInstructions: sum(all.map((a) => a.metrics.audit.projectInstructions)) },
		meanWallMs: mean(pick((a) => a.metrics.wallMs)),
		score: { mean: mean(scored.map((a) => a.score.total)), scored: scored.length },
	};
}

const fmt = (x, d = 0) => (x === null || x === undefined ? "n/a" : typeof x === "number" ? x.toFixed(d) : String(x));

function markdown(report) {
	const lines = [`# SWE-QA three-arm report — ${report.runId}`, "",
		`Byte/token ratio ${fmt(report.ratio?.median, 3)} (IQR ${fmt(report.ratio?.q1, 3)}–${fmt(report.ratio?.q3, 3)}, ${report.ratio?.pairs ?? 0} pairs). Judge: ${report.judge ?? "not run"} (same model as measured: relative comparison only).`, "",
		"| arm | valid | mean children | mean tokens | mean comm bytes | comm tokens (down/up/pull) | mean score | failures |", "|---|---|---|---|---|---|---|---|"];
	for (const arm of ARMS) {
		const s = report.arms[arm];
		lines.push(`| ${arm} | ${s.valid}/${s.attempts} | ${fmt(s.dispatch.meanChildren, 2)} | ${fmt(s.tokens.meanTotal)} | ${fmt(s.comm.meanBytes)} | ${s.comm.tokens.downlink}/${s.comm.tokens.uplink}/${s.comm.tokens.pull} | ${fmt(s.score.mean, 1)} (${s.score.scored}) | ${Object.entries(s.failures).map(([k, v]) => `${k} ×${v}`).join("; ") || "—"} |`);
	}
	for (const [pair, rows] of Object.entries(report.pairs)) {
		lines.push("", `## ${pair} (${rows.qualityQualifier})`, "", "| metric | n | excluded | mean diff (share − baseline) | 95% CI | verdict |", "|---|---|---|---|---|---|");
		for (const [name] of METRICS) {
			const r = rows[name];
			const verdict = r.rule === "fewer" ? (r.shareFewer ? "share fewer" : "not shown fewer") : r.rule === "quality" ? (r.nonInferior ? "non-inferior" : "not shown non-inferior") : "—";
			lines.push(`| ${name} | ${r.n} | ${r.excluded} | ${fmt(r.meanDiff, 1)} | [${fmt(r.ci[0], 1)}, ${fmt(r.ci[1], 1)}] | ${verdict} |`);
		}
	}
	return lines.join("\n") + "\n";
}

function main(runDir) {
	const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
	const scores = new Map();
	const scoreFile = path.join(runDir, "scores.jsonl");
	if (fs.existsSync(scoreFile)) for (const line of fs.readFileSync(scoreFile, "utf8").split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		scores.set(`${row.id}|${row.arm}`, row);
	}
	const attempts = [];
	for (const id of manifest.instances) for (const arm of ARMS) {
		const file = path.join(runDir, "evidence", evidenceName(id), arm, "metrics.json");
		if (!fs.existsSync(file)) continue;
		attempts.push({ id, arm, metrics: JSON.parse(fs.readFileSync(file, "utf8")), score: scores.get(`${id}|${arm}`) ?? null });
	}
	const run = fs.existsSync(path.join(runDir, "metrics.json")) ? JSON.parse(fs.readFileSync(path.join(runDir, "metrics.json"), "utf8")) : {};
	const judge = fs.existsSync(path.join(runDir, "judge.json")) ? JSON.parse(fs.readFileSync(path.join(runDir, "judge.json"), "utf8")).judge : null;
	const report = { runId: manifest.id, questions: manifest.instances.length, ratio: run.ratio ?? null, judge,
		arms: Object.fromEntries(ARMS.map((arm) => [arm, summarizeArm(attempts, arm)])),
		pairs: Object.fromEntries(BASELINES.map((b) => [`share-vs-${b}`, compare(attempts, b)])) };
	fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
	fs.writeFileSync(path.join(runDir, "report.md"), markdown(report));
	console.log(markdown(report));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (!process.argv[2]) { console.error("usage: node report.mjs <run-directory>"); process.exit(2); }
	main(path.resolve(process.argv[2]));
}
