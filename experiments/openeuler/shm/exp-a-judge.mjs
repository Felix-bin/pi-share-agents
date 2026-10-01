// EXP-A/AB/B judge：qwen3.8-max × 官方 SWE-QA 五维 prompt × 5 票取中位（学长 vote 口径）。
// 盲评：judge 只见 question / reference / candidate，不见臂名与配置。
// R 组 reference=flask.jsonl.answer；Q 组 reference=q-musique.json 各题 answer。
//
// 用法：node --experimental-strip-types experiments/openeuler/shm/exp-a-judge.mjs \
//   --exp-dir <dir> [--votes 5] [--family r]   # family 与 runner 的 --family 一致
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const SWEQA = path.join(repoRoot, "experiments", "data", "swe-qa");
const FLASK = path.join(repoRoot, "experiments", "data", "swe-qa", "Benchmark", "flask.jsonl");
const MUSIQUE_FAMILY = path.join(repoRoot, "experiments", "bench", "families", "q-musique.json");
const BAILIAN_BASE = "https://llm-3m03faeswsufx2lq.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const JUDGE_MODEL = "qwen3.8-max";
const DIMS = ["correctness", "completeness", "relevance", "clarity", "reasoning"];

const args = parseArgs(process.argv.slice(2));
const expDir = path.resolve(args["exp-dir"] ?? "");
const VOTES = Number(args.votes ?? 5);
const FAMILY = args.family ?? "r";

// partial 文件按存在性适配三种 runner。
const partial = [ "exp-a-partial.jsonl", "exp-ab-partial.jsonl", "exp-b-partial.jsonl" ].map((n) => path.join(expDir, n)).find((f) => fs.existsSync(f));
if (!partial) fail(`no partial jsonl under ${expDir}`);
const rows = fs.readFileSync(partial, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const armField = rows[0]?.arm !== undefined ? "arm" : (rows[0]?.config !== undefined ? "config" : "condition");

// 官方 template 逐字抽取（与 sweqa/score.mjs 的 judgeTemplate 同法）。
const source = fs.readFileSync(path.join(SWEQA, "Benchmark construction", "score", "llm-as-a-judge.py"), "utf8");
const start = source.indexOf('prompt = f"""'), end = source.indexOf('"""', start + 13);
const template = source.slice(start + 13, end);

// reference 池。
const references = FAMILY === "r"
	? fs.readFileSync(FLASK, "utf-8").trim().split("\n").map((l) => JSON.parse(l))
	: (JSON.parse(fs.readFileSync(MUSIQUE_FAMILY, "utf-8")).tasks ?? JSON.parse(fs.readFileSync(MUSIQUE_FAMILY, "utf-8")));

function parseScores(text) {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		const v = JSON.parse(match[0]);
		if (!DIMS.every((d) => Number.isInteger(v[d]) && v[d] >= 1 && v[d] <= 20)) return null;
		return Object.fromEntries(DIMS.map((d) => [d, v[d]]));
	} catch { return null; }
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

let key = process.env.DASHSCOPE_API_KEY;
if (!key) {
	for (const line of fs.readFileSync("/root/.pi/agent/synapse/.env", "utf8").split("\n")) {
		const t = line.trim();
		if (t.startsWith("DASHSCOPE_API_KEY=")) key = t.slice("DASHSCOPE_API_KEY=".length);
	}
}
if (!key) fail("no DASHSCOPE_API_KEY");

async function askOnce(prompt) {
	const resp = await fetch(`${BAILIAN_BASE}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: JUDGE_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 8192 }),
	});
	if (!resp.ok) throw new Error(`judge HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
	const data = await resp.json();
	return { text: data.choices?.[0]?.message?.content ?? "", usage: data.usage };
}

const outPath = path.join(expDir, "judge-results.jsonl");
const judged = new Set(fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).key) : []);
let totalJudgeTokens = 0;
for (const row of rows) {
	if (!row.valid) continue;
	const key = `q${row.index + 1}-${row[armField]}`;
	if (judged.has(key)) { console.log(`[judge] ${key}: already judged, skip`); continue; }
	const answerPath = path.join(expDir, "evidence", key, "answer.md");
	if (!fs.existsSync(answerPath)) continue;
	const ref = references[row.index];
	const reference = FAMILY === "r" ? ref.answer : (ref.answer ?? ref.answer);
	const question = FAMILY === "r" ? ref.question : (ref.task ?? ref.question);
	const candidate = fs.readFileSync(answerPath, "utf-8");
	const prompt = template.replace("{question}", question).replace("{reference}", reference).replace("{candidate}", candidate).replaceAll("{{", "{").replaceAll("}}", "}");
	const got = [];
	let failures = 0;
	while (got.length < VOTES && failures < VOTES * 2) {
		try {
			const { text, usage } = await askOnce(prompt);
			totalJudgeTokens += usage?.total_tokens ?? 0;
			const parsed = parseScores(text);
			if (parsed) got.push(parsed); else failures += 1;
		} catch (error) { failures += 1; console.log(`[judge] ${key} attempt failed: ${String(error).slice(0, 120)}`); }
	}
	if (got.length === 0) {
		fs.appendFileSync(outPath, `${JSON.stringify({ key, parseFailures: failures, total: null, votes: 0 })}\n`);
		console.log(`[judge] ${key}: unavailable (${failures} parse failures) — 不按 0 计`);
		continue;
	}
	const dims = Object.fromEntries(DIMS.map((d) => [d, median(got.map((v) => v[d]))]));
	const record = { ...dims, key, parseFailures: failures, total: DIMS.reduce((n, d) => n + dims[d], 0), votes: got.length };
	fs.appendFileSync(outPath, `${JSON.stringify(record)}\n`);
	console.log(`[judge] ${key}: total=${record.total}/100 (votes=${got.length}, dims=${DIMS.map((d) => dims[d]).join("/")})`);
}
console.log(`[judge] done; judge tokens (total_tokens 口径): ${totalJudgeTokens}; results: ${outPath}`);

function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1]; return out; }
function fail(m) { console.error(String(m)); process.exit(1); }
