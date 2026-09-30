// E0a/E0b 判定与报告（规则冻结于 2026-09-30-shm-e0-design.md §3.1/§3.2）：
//  - E0a：配对差 file−shm（正=shm 更快）；95% CI 上界 < 0 才可表述"段路径显著更快"
//  - E0b：功能断言——shm 臂每一轮（全新进程）corpusLoads=0 且 hits 与 file 基线
//    逐字节一致；任一不满足=装置缺陷，报告标 DEFECT 而不是统计
// 用法：node --experimental-strip-types report.mjs --exp-dir <dir>

import * as fs from "node:fs";
import * as path from "node:path";
import { BOOTSTRAP_B, BOOTSTRAP_SEED, E0A_SUBSET_SIZES, bootstrapInterval } from "./matrix.mjs";

const args = parseArgs(process.argv.slice(2));
const expDir = path.resolve(args["exp-dir"] ?? "");
const manifest = JSON.parse(fs.readFileSync(path.join(expDir, "manifest.json"), "utf-8"));

const lines = ["# SHM E0a/E0b 报告", "", `- run：\`${path.basename(expDir)}\``, `- 代码：${manifest.code.sha ?? "n/a"}（dirty ${manifest.code.dirty.length}）`, `- 环境：${manifest.environment.platform} / node ${manifest.environment.node} / koffi ${manifest.environment.koffi}`, `- 统计：bootstrap B=${BOOTSTRAP_B} seed=${BOOTSTRAP_SEED} percentile 95% CI`, ""];

// --- E0a -------------------------------------------------------------------

lines.push("## E0a 微基准（同进程两加载路径配对，判定：diff=file−shm 正=shm 快，CI 下界>0 = 显著更快）", "", "| 负载 | 有效对 | file ms（均值） | shm ms（均值） | 差均值（file−shm） | 95% CI | 判定 |", "|---|---|---|---|---|---|---|");
let e0aDefect = false;
for (const size of E0A_SUBSET_SIZES) {
	const file = path.join(expDir, `e0a-${size}.jsonl`);
	if (!fs.existsSync(file)) {
		lines.push(`| ${size} | 缺失 | - | - | - | - | MISSING |`);
		e0aDefect = true;
		continue;
	}
	const rows = fs.readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
	const valid = rows.filter((row) => row.valid);
	const invalid = rows.length - valid.length;
	if (invalid > 0) e0aDefect = true;
	if (valid.length === 0) {
		lines.push(`| ${size} | 0/${rows.length} | - | - | - | - | ALL-INVALID |`);
		continue;
	}
	const fileMean = mean(valid.map((row) => row.fileMs));
	const shmMean = mean(valid.map((row) => row.shmMs));
	const diffs = valid.map((row) => row.fileMs - row.shmMs);
	const ci = bootstrapInterval(diffs);
	// diff = file − shm（正 = shm 更快，与 matrix/预登记一致）：整区间为正
	// （下界 > 0）= 段路径显著更快；整区间为负 = 显著更慢；跨 0 不可宣称。
	const verdict = ci.lo > 0 ? "shm 显著更快" : ci.hi < 0 ? "shm 显著更慢" : "跨 0，不可宣称显著";
	lines.push(`| ${size} | ${valid.length}/${rows.length} | ${fileMean.toFixed(2)} | ${shmMean.toFixed(2)} | ${ci.mean.toFixed(2)} | [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}] | ${verdict}${invalid > 0 ? `（${invalid} 无效对）` : ""} |`);
}
lines.push("");

// --- E0b -------------------------------------------------------------------

lines.push("## E0b 跨进程链路计量（预登记判定：shm 臂每轮 corpusLoads=0 且 hits 逐字节一致）", "");
const e0bPath = path.join(expDir, "e0b.jsonl");
let e0bVerdict = "n/a";
if (fs.existsSync(e0bPath)) {
	const rows = fs.readFileSync(e0bPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
	const valid = rows.filter((row) => row.valid !== undefined ? row.valid === true : false);
	const allZeroLoads = valid.every((row) => row.corpusLoads === 0);
	const allHitsMatch = valid.every((row) => row.hitsMatch === true);
	const allHits = valid.every((row) => row.shmHits >= 1);
	const defect = rows.length === 0 || valid.length !== rows.length || !allZeroLoads || !allHitsMatch || !allHits;
	e0bVerdict = defect
		? "DEFECT（见下行；按预登记此为装置缺陷，不是统计结论）"
		: `PASS：${valid.length} 轮全新进程全部 0 次语料文件读、hits 逐字节一致、段命中 ${valid.map((row) => row.shmHits).join("/")}`;
	lines.push("", `| 轮 | 语料文件读 | 段命中 | hits 一致 | 有效 |`, "|---|---|---|---|---|");
	for (const row of rows) {
		lines.push(`| ${row.round} | ${row.corpusLoads ?? "-"} | ${row.shmHits ?? "-"} | ${row.hitsMatch ?? "-"} | ${row.valid} |`);
	}
} else {
	e0bVerdict = "MISSING";
}
lines.push("", `**E0b 判定：${e0bVerdict}**`, "");
if (e0aDefect) lines.push("> 注意：E0a 存在无效对或缺失负载，无效单元未按 0 计，上表覆盖数如实标注。", "");

lines.push("## 口径", "", "- 一切数字来自本 run 的 jsonl；`unavailable` 从不按 0 计。", "- E0a 的 attach 延迟不进配对（预登记单列）；跨进程 attach 由 E0b 的 shm-attach 事件覆盖（evidence/ 各轮账本）。", `- 判定规则冻结于 run 之前（spec 2026-09-30-shm-e0-design.md），matrix sha256：${manifest.matrixSha256.slice(0, 16)}…`, "");

const reportPath = path.join(expDir, "report.md");
fs.writeFileSync(reportPath, lines.join("\n") + "\n");
console.log(fs.readFileSync(reportPath, "utf-8"));

function mean(values) {
	return values.reduce((a, c) => a + c, 0) / values.length;
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1];
	return out;
}
