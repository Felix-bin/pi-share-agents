// p50o 聚合：配对差 + bootstrap 区间 + judge 合并（轻量，读 p50o-partial.jsonl）。
// 用法：node scripts/p50o-aggregate.mjs --exp-dir <dir> [--judge]   # --judge 时合并 judge-results.jsonl
import * as fs from "node:fs";
import * as path from "node:path";

const args = parseArgs(process.argv.slice(2));
const expDir = path.resolve(args["exp-dir"] ?? "");
const partialPath = path.join(expDir, "p50o-partial.jsonl");
if (!fs.existsSync(partialPath)) { console.error("no p50o-partial.jsonl"); process.exit(1); }
const rows = fs.readFileSync(partialPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const B = 10000, SEED = 20260921;

// (题, 臂) → 每题总 token（in+out；cacheRead 单列不计入合计，与说明书口径一致）
const cell = new Map();
for (const r of rows) {
	if (!r.valid) continue;
	cell.set(`${r.index}-${r.arm}`, r.totalIn + r.totalOut + (args.cache === "in" ? r.cacheRead : 0));
}
const pairs = [];
for (const [key, v] of cell) {
	const m = /^(\d+)-TXT$/.exec(key);
	if (!m) continue;
	const syn = cell.get(`${m[1]}-SYN`);
	if (syn !== undefined) pairs.push({ q: Number(m[1]) + 1, txt: v, syn });
}
if (pairs.length === 0) { console.error("no valid TXT/SYN pairs"); process.exit(1); }

const diffs = pairs.map((p) => p.txt - p.syn);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const saving = diffs.map((d, i) => d / pairs[i].txt);
let rng = SEED;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const boots = [];
for (let b = 0; b < B; b++) {
	const sample = [];
	for (let i = 0; i < diffs.length; i++) sample.push(diffs[Math.floor(rand() * diffs.length)]);
	boots.push(mean(sample));
}
boots.sort((a, b) => a - b);
const lo = boots[Math.floor(0.025 * B)], hi = boots[Math.floor(0.975 * B)];

console.log(`pairs=${pairs.length} (valid only)`);
for (const p of pairs) console.log(`  q${p.q}: TXT=${p.txt.toLocaleString()} SYN=${p.syn.toLocaleString()} diff=+${(p.txt - p.syn).toLocaleString()} (${((1 - p.syn / p.txt) * 100).toFixed(1)}% saved)`);
console.log(`mean TXT=${Math.round(mean(pairs.map((p) => p.txt))).toLocaleString()}  SYN=${Math.round(mean(pairs.map((p) => p.syn))).toLocaleString()}`);
console.log(`paired diff mean=+${Math.round(mean(diffs)).toLocaleString()}  [${Math.round(lo).toLocaleString()}, ${Math.round(hi).toLocaleString()}]  cross0=${lo <= 0 && hi >= 0}`);
console.log(`mean saving=${(mean(saving) * 100).toFixed(1)}%`);

if (args.judge === "in") {
	const judgePath = path.join(expDir, "judge-results.jsonl");
	if (fs.existsSync(judgePath)) {
		const js = fs.readFileSync(judgePath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const byKey = new Map(js.map((j) => [j.key, j]));
		const arms = ["TXT", "SYN"];
		for (const arm of arms) {
			const scores = pairs.map((p) => byKey.get(`q${p.q}-${arm}`)?.total).filter((x) => typeof x === "number");
			if (scores.length) console.log(`judge ${arm}: mean=${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)} (n=${scores.length})`);
		}
	} else console.log("(no judge-results.jsonl yet)");
}
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1]; return out; }
