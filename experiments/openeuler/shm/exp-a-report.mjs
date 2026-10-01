// EXP-A/AB/B 配对 bootstrap 判定报告器。
//
// 读 partial.jsonl（exp-a-runner / exp-ab-runner / exp-b-chain 的输出），按同题两臂（或两条件）
// 配对算差值分布，bootstrap percentile 95% CI（B=10000 seed=20260921，与全部装置同源）。
// 判定语义：diff = A − B；CI 下界>0 = A 显著更多（token 口径=B 显著更省）；跨 0 = 不可宣称。
//
// 用法：node --experimental-strip-types experiments/openeuler/shm/exp-a-report.mjs \
//   --exp-dir <dir> [--pairs TXT-SYN,SYN-SYN-shm] [--metric tokenIn]
import * as fs from "node:fs";
import * as path from "node:path";
import { BOOTSTRAP_B, BOOTSTRAP_SEED, bootstrapInterval, crossesZero, mulberry32 } from "./matrix.mjs";

const args = parseArgs(process.argv.slice(2));
const expDir = path.resolve(args["exp-dir"] ?? "");
const pairs = (args.pairs ?? "TXT-SYN").split(",").map((x) => x.trim()).filter(Boolean);
const partial = path.join(expDir, "exp-a-partial.jsonl");
const abPartial = path.join(expDir, "exp-ab-partial.jsonl");
const bPartial = path.join(expDir, "exp-b-partial.jsonl");
const file = [partial, abPartial, bPartial].find((f) => fs.existsSync(f));
if (!file) fail(`no partial jsonl under ${expDir} (looked for exp-a/exp-ab/exp-b-partial.jsonl)`);
const rows = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const armField = rows[0]?.arm !== undefined ? "arm" : (rows[0]?.config !== undefined ? "config" : "condition");
const metric = args.metric ?? "tokenTotal";

// --- 配对与 bootstrap -----------------------------------------------------------

function metricOf(row, metric) {
	if (metric === "tokenIn") return (row.parentIn ?? 0) + (row.childIn ?? 0);
	if (metric === "tokenOut") return (row.parentOut ?? 0) + (row.childOut ?? 0);
	if (metric === "tokenTotal") return (row.parentIn ?? 0) + (row.childIn ?? 0) + (row.parentOut ?? 0) + (row.childOut ?? 0);
	if (metric === "wallMs") return row.wallMs ?? 0;
	if (metric === "answerChars") return row.answerChars ?? 0;
	if (metric === "corpusLoad") return row.ledger?.["corpus-load"] ?? 0;
	if (metric === "memoryReuse") return row.ledger?.["memory-reuse"] ?? 0;
	fail(`unknown metric ${metric}`);
}

for (const pair of pairs) {
	const [aName, bName] = pair.split("-");
	// EXP-AB 的配置名带连字符（SYN-state），配对解析按最长匹配处理。
	let A = rows.filter((r) => r[armField] === aName);
	let B = rows.filter((r) => r[armField] === bName);
	if (bName === undefined) {
		// 单臂分布模式（如 TXT-SYN 里 SYN-shm 的写法冲突时用 pairs SYN-full,SYN-shm 显式）
		fail(`pair "${pair}" needs exactly one "-"; for ablation names with hyphens pass both sides explicitly`);
	}
	const byIndex = (list) => new Map(list.map((r) => [r.index, r]));
	const bMap = byIndex(B);
	const diffs = [];
	let excluded = 0;
	for (const a of A) {
		const b = bMap.get(a.index);
		if (!b || !a.valid || !b.valid) { excluded += 1; continue; }
		diffs.push(metricOf(a, metric) - metricOf(b, metric));
	}
	if (diffs.length === 0) { console.log(`## ${pair}: no valid pairs`); continue; }
	const ci = bootstrapInterval(diffs);
	const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
	console.log(`## ${pair}（n=${diffs.length}${excluded ? `, excluded=${excluded}` : ""}）`);
	console.log(`- diff 均值 = ${+mean.toFixed(1)}`);
	console.log(`- 95% CI = [${ci.lo.toFixed(1)}, ${ci.hi.toFixed(1)}]`);
	console.log(`- 跨 0：${crossesZero(ci) ? "是（不可宣称显著）" : "否（显著）"}`);
}
console.log(`\n> 统计：bootstrap B=${BOOTSTRAP_B} seed=${BOOTSTRAP_SEED} percentile 95%；n<10 标注「已实现待扩样」。`);
console.log(`> 数据源：${file}`);

function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1]; return out; }
function fail(m) { console.error(String(m)); process.exit(1); }
