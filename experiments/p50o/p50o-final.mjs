// p50o 总聚合：合并 pi 臂分片与框架臂记录，输出四臂对照 + 三个硬指标（vs TXT / vs CrewAI / vs AutoGen）。
// 用法：node scripts/p50o-final.mjs --dirs <expDir1,expDir2,...> [--judge-dir <dir>]
import * as fs from "node:fs";
import * as path from "node:path";

const args = parseArgs(process.argv.slice(2));
const dirs = (args.dirs ?? "").split(",").map((x) => x.trim()).filter(Boolean);
if (dirs.length === 0) { console.error("--dirs <expDir,...> required"); process.exit(1); }
const rows = [];
for (const dir of dirs) {
	for (const name of ["p50o-partial.jsonl", "CREWAI-partial.jsonl", "AUTOGEN-partial.jsonl"]) {
		const p = path.join(dir, name);
		if (!fs.existsSync(p)) continue;
		for (const line of fs.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean)) {
			try { rows.push(JSON.parse(line)); } catch { /* torn */ }
		}
	}
}
const cell = new Map();
for (const r of rows) {
	if (!r.valid) continue;
	const arm = r.arm ?? "";
	if (!["TXT", "SYN", "CREWAI", "AUTOGEN"].includes(arm)) continue;
	cell.set(`${r.index}-${arm}`, (r.totalIn ?? r.input ?? 0) + (r.totalOut ?? r.output ?? 0));
}
const qs = [...new Set([...cell.keys()].map((k) => Number(k.split("-")[0])))].sort((a, b) => a - b);
const arms = ["TXT", "SYN", "CREWAI", "AUTOGEN"];
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const col = (arm) => qs.map((q) => cell.get(`${q}-${arm}`) ?? null);

console.log("q | TXT | SYN | CrewAI | AutoGen | SYN/TXT | SYN/CrewAI | SYN/AutoGen");
for (const q of qs) {
	const t = cell.get(`${q}-TXT`), s = cell.get(`${q}-SYN`), c = cell.get(`${q}-CREWAI`), a = cell.get(`${q}-AUTOGEN`);
	const pct = (x, y) => (x && y ? `${((1 - y / x) * 100).toFixed(1)}%` : "—");
	console.log(`q${q + 1} | ${t ? t.toLocaleString() : "—"} | ${s ? s.toLocaleString() : "—"} | ${c ? c.toLocaleString() : "—"} | ${a ? a.toLocaleString() : "—"} | ${pct(t, s)} | ${pct(c, s)} | ${pct(a, s)}`);
}
const means = Object.fromEntries(arms.map((arm) => [arm, mean(col(arm).filter((x) => x !== null))]));
console.log(`\nmean: TXT=${Math.round(means.TXT).toLocaleString()} SYN=${Math.round(means.SYN).toLocaleString()} CrewAI=${Math.round(means.CREWAI).toLocaleString()} AutoGen=${Math.round(means.AUTOGEN).toLocaleString()}`);
const savingVs = (x, y) => (x && y ? `省 ${((1 - y / x) * 100).toFixed(1)}%` : "数据不足");
console.log(`\n== 硬指标 ==`);
console.log(`SYN vs TXT    : ${savingVs(means.TXT, means.SYN)}（目标 70%）`);
console.log(`SYN vs CrewAI : ${savingVs(means.CREWAI, means.SYN)}（目标 40%）`);
console.log(`SYN vs AutoGen: ${savingVs(means.AUTOGEN, means.SYN)}（目标 40%）`);

if (args["judge-dir"]) {
	const jp = path.join(args["judge-dir"], "judge-results.jsonl");
	if (fs.existsSync(jp)) {
		const js = fs.readFileSync(jp, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const byKey = new Map(js.map((j) => [j.key, j]));
		console.log(`\n== judge（同通道 5 票中位） ==`);
		for (const arm of arms) {
			const scores = qs.map((q) => byKey.get(`q${q + 1}-${arm}`)?.total).filter((x) => typeof x === "number");
			if (scores.length) console.log(`${arm}: mean=${(mean(scores)).toFixed(1)} (n=${scores.length})`);
		}
	}
}
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1]; return out; }
