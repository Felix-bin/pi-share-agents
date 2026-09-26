#!/usr/bin/env node
// SWE-QA LLM-as-judge (spec §4): the benchmark's prompt verbatim, five dimensions 1–20, `--votes`
// independent judgments per answer, the per-dimension median kept. Blind: the judge sees the question,
// the reference answer and the final answer, never the arm. Runs after the measured run; resumable.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, MODEL, evidenceName, loadSample, sha256, shuffledIndices, SEED } from "./matrix.mjs";

export const DIMS = ["correctness", "completeness", "relevance", "clarity", "reasoning"];

export function judgeTemplate(sweqaDir) {
	const file = path.join(sweqaDir, "Benchmark construction", "score", "llm-as-a-judge.py");
	const source = fs.readFileSync(file, "utf8");
	const start = source.indexOf('prompt = f"""'), end = source.indexOf('"""', start + 13);
	if (start < 0 || end < 0) throw new Error(`cannot find the judge prompt in ${file}`);
	return source.slice(start + 13, end);
}

export const judgePrompt = (template, question, reference, candidate) =>
	template.replace("{question}", question).replace("{reference}", reference).replace("{candidate}", candidate).replaceAll("{{", "{").replaceAll("}}", "}");

export function parseScores(text) {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		const value = JSON.parse(match[0]);
		if (!DIMS.every((d) => Number.isInteger(value[d]) && value[d] >= 1 && value[d] <= 20)) return null;
		return Object.fromEntries(DIMS.map((d) => [d, value[d]]));
	} catch { return null; }
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// At most 2 × votes attempts; no parsable vote leaves the score unavailable, never 0.
export async function vote(ask, votes) {
	const got = [];
	let failures = 0;
	while (got.length < votes && failures < votes * 2) {
		const parsed = parseScores(await ask());
		if (parsed) got.push(parsed); else failures++;
	}
	if (!got.length) return { total: null, votes: 0, parseFailures: failures };
	const dims = Object.fromEntries(DIMS.map((d) => [d, median(got.map((v) => v[d]))]));
	return { ...dims, total: DIMS.reduce((n, d) => n + dims[d], 0), votes: got.length, parseFailures: failures };
}

function askPi(piCli, prompt, usage) {
	return new Promise((resolve) => {
		const argv = [piCli, "-p", "--mode", "json", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
			"--no-themes", "--no-context-files", "--offline", "--provider", MODEL.provider, "--model", MODEL.id];
		const child = spawn(process.execPath, argv, { cwd: os.tmpdir(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (chunk) => { out += chunk; });
		const timer = setTimeout(() => child.kill("SIGTERM"), 240_000);
		child.on("close", () => {
			clearTimeout(timer);
			let text = "";
			for (const line of out.split("\n")) {
				let event;
				try { event = JSON.parse(line); } catch { continue; }
				if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
				text = (event.message.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
				for (const key of ["input", "output", "cacheRead", "cacheWrite"]) usage[key] = (usage[key] ?? 0) + (event.message.usage?.[key] ?? 0);
			}
			resolve(text);
		});
		child.stdin.end(prompt);
	});
}

async function main() {
	const argv = process.argv.slice(2);
	const opt = (flag, fallback) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback);
	const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
	const runDir = path.resolve(argv[0] ?? "");
	if (!argv[0] || !fs.existsSync(path.join(runDir, "manifest.json"))) {
		console.error("usage: node score.mjs <run-directory> [--sweqa dir] [--votes 5] [--concurrency 3] [--pi cli.js]"); process.exit(2);
	}
	const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
	if (sha256(manifest.samplePath) !== manifest.sampleSha256) throw new Error("sample changed since the run");
	const sweqa = path.resolve(opt("--sweqa", path.join(repo, "experiments/data/swe-qa")));
	const votes = Number(opt("--votes", "5")), concurrency = Number(opt("--concurrency", "3"));
	const piCli = path.resolve(opt("--pi", manifest.piCli));
	const template = judgeTemplate(sweqa);
	const items = new Map(loadSample(manifest.samplePath, manifest.instances).map((x) => [x.id, x]));
	const outFile = path.join(runDir, "scores.jsonl");
	const done = new Set(fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.id}|${r.arm}`; }) : []);
	const jobs = [];
	for (const id of manifest.instances) for (const arm of ARMS) {
		const evidence = path.join(runDir, "evidence", evidenceName(id), arm);
		const metricsFile = path.join(evidence, "metrics.json");
		if (done.has(`${id}|${arm}`) || !fs.existsSync(metricsFile)) continue;
		jobs.push({ id, arm, evidence, valid: JSON.parse(fs.readFileSync(metricsFile, "utf8")).valid });
	}
	const order = shuffledIndices(jobs.length, SEED).map((i) => jobs[i]);
	fs.writeFileSync(path.join(runDir, "judge.json"), JSON.stringify({ judge: `${MODEL.provider}/${MODEL.id}`, sameModelAsMeasured: true, votes,
		promptSha256: createHash("sha256").update(template).digest("hex"), piCli }, null, 2));
	const worker = async () => {
		while (order.length) {
			const job = order.shift();
			const row = { id: job.id, arm: job.arm };
			if (!job.valid) row.unavailable = "invalid attempt";
			else {
				const item = items.get(job.id), usage = {};
				const answer = fs.readFileSync(path.join(job.evidence, "answer.md"), "utf8");
				const prompt = judgePrompt(template, item.question, item.referenceAnswer, answer);
				Object.assign(row, await vote(() => askPi(piCli, prompt, usage), votes), { judgeUsage: usage });
			}
			fs.appendFileSync(outFile, `${JSON.stringify(row)}\n`);
			console.log(`[score] ${job.id} ${job.arm}: ${row.total ?? row.unavailable ?? "unavailable"}`);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exitCode = 1; });
