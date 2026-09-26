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
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { startLlmProxy } from "../bench/llm-proxy.mjs";
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

function askPi(piCli, agentDir, prompt) {
	return new Promise((resolve) => {
		const argv = [piCli, "-p", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
			"--no-themes", "--no-context-files", "--offline", "--provider", MODEL.provider, "--model", MODEL.id];
		const env = { PATH: process.env.PATH, HOME: process.env.HOME, PI_CODING_AGENT_DIR: agentDir, NODE_USE_ENV_PROXY: "0" };
		const child = spawn(process.execPath, argv, { cwd: os.tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (chunk) => { out += chunk; });
		const timer = setTimeout(() => child.kill("SIGTERM"), 240_000);
		child.on("close", () => { clearTimeout(timer); resolve(out); });
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
	const apiKey = process.env.COMMANDCODE_API_KEY?.trim();
	if (!apiKey) throw new Error("COMMANDCODE_API_KEY is not set");
	if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) setGlobalDispatcher(new EnvHttpProxyAgent());
	const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
	if (sha256(manifest.samplePath) !== manifest.sampleSha256) throw new Error("sample changed since the run");
	const sweqa = path.resolve(opt("--sweqa", path.join(repo, "experiments/data/swe-qa")));
	const votes = Number(opt("--votes", "5")), concurrency = Number(opt("--concurrency", "3"));
	const piCli = path.resolve(opt("--pi", manifest.piCli));
	const template = judgeTemplate(sweqa);
	const items = new Map(loadSample(manifest.samplePath, manifest.instances).map((x) => [x.id, x]));
	// The judge is the measured model behind its own recorder; Pi gets a dummy key and a fresh agent directory.
	const proxy = await startLlmProxy({ upstreamBaseUrl: MODEL.baseUrl, apiKey, roles: ["judge"], logFile: path.join(runDir, "judge-calls.jsonl") });
	const agentDir = path.join(runDir, "judge-agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const armCatalog = JSON.parse(fs.readFileSync(path.join(manifest.arms.share.dir, "models.json"), "utf8"));
	const provider = armCatalog.providers[MODEL.provider];
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [MODEL.provider]: {
		...provider, baseUrl: proxy.baseUrlFor("judge"), apiKey: "judge-proxy-key" } } }, null, 2));
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
	const worker = async () => {
		while (order.length) {
			const job = order.shift();
			const row = { id: job.id, arm: job.arm };
			if (!job.valid) row.unavailable = "invalid attempt";
			else {
				const item = items.get(job.id);
				const answer = fs.readFileSync(path.join(job.evidence, "answer.md"), "utf8");
				const prompt = judgePrompt(template, item.question, item.referenceAnswer, answer);
				Object.assign(row, await vote(() => askPi(piCli, agentDir, prompt), votes));
			}
			fs.appendFileSync(outFile, `${JSON.stringify(row)}\n`);
			console.log(`[score] ${job.id} ${job.arm}: ${row.total ?? row.unavailable ?? "unavailable"}`);
		}
	};
	try {
		await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
	} finally {
		const calls = proxy.calls().filter((c) => c.path === "/chat/completions");
		const usage = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map((k) => [k, calls.reduce((n, c) => n + (c.usage?.[k] ?? 0), 0)]));
		fs.writeFileSync(path.join(runDir, "judge.json"), JSON.stringify({ judge: `${MODEL.provider}/${MODEL.id}`, sameModelAsMeasured: true, votes,
			promptSha256: createHash("sha256").update(template).digest("hex"), piCli, calls: calls.length, usage }, null, 2));
		await proxy.close();
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exitCode = 1; });
