// E1s 小规模对照臂判定（spec §3.4 冻结；n<10 一切结论标"已实现待扩样"）。
//
// 输入：e0c.mjs --unit e1s 产出的 e0c-partial.jsonl（每行一个 attempt）。
// 配对单位 = 题（同题两臂各一次，同模型同题面）；diff = file − shm（正 = shm 更省/更快）。
// 判定：
//  1. 主指标（功能断言）：shm 臂 corpus-load 计数配对差 CI 下界 > 0（段确实接管了子会话语料加载）
//  2. 墙钟配对差 CI（如实报方向，n 小不外推）
//  3. token 并列：不设判据（预登记预期不变），两臂总量与差值并列展示
// 装置边界（如实注明）：每尝试独立 storageRoot，"跨任务语料文件字节=0"的跨任务形态由 E0b 判定；
// 本判定是任务进程组内（父+四角色子）的接管证明。
//
// 用法：node --experimental-strip-types e1s-report.mjs --exp-dir <dir>

import * as fs from "node:fs";
import * as path from "node:path";
import { BOOTSTRAP_B, BOOTSTRAP_SEED, bootstrapInterval } from "./matrix.mjs";

const args = parseArgs(process.argv.slice(2));
const expDir = path.resolve(args["exp-dir"] ?? "");
const partial = path.join(expDir, "e0c-partial.jsonl");
if (!fs.existsSync(partial)) fail(`no e0c-partial.jsonl under ${expDir}`);
const rows = fs.readFileSync(partial, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

const pairs = [];
for (const file of rows.filter((row) => row.arm === "file" && row.valid)) {
	const shm = rows.find((row) => row.arm === "shm" && row.index === file.index && row.valid);
	if (shm) pairs.push({ file, shm });
}
const invalid = rows.filter((row) => !row.valid);

const lines = ["# E1s 小规模对照臂（SYN 段开/关 × SWE-QA Flask，配对差 file−shm，正 = shm 更省/更快）", "",
	`- 配对：${pairs.length}（有效 file 臂 ${rows.filter((r) => r.arm === "file" && r.valid).length} / shm 臂 ${rows.filter((r) => r.arm === "shm" && r.valid).length}；无效 ${invalid.length} 不按 0 计：${invalid.map((r) => `q${r.index + 1}-${r.arm}(${r.problem})`).join("、") || "无"}）`,
	`- 统计：bootstrap B=${BOOTSTRAP_B} seed=${BOOTSTRAP_SEED} percentile 95% CI；n=${pairs.length} < 10，一切结论标注「已实现待扩样」`, "",
	"| 指标 | 配对差均值 | 95% CI | 判定 |", "|---|---|---|---|"];

const addMetric = (label, diffOf) => {
	const diffs = pairs.map(diffOf).filter((value) => Number.isFinite(value));
	if (diffs.length === 0) { lines.push(`| ${label} | 无配对 | - | - |`); return; }
	const ci = bootstrapInterval(diffs);
	const verdict = ci.lo > 0 ? "shm 显著更省/快" : ci.hi < 0 ? "shm 显著更费/慢" : "跨 0，不可宣称";
	lines.push(`| ${label} | ${ci.mean.toFixed(1)} | [${ci.lo.toFixed(1)}, ${ci.hi.toFixed(1)}] | ${verdict}（覆盖 ${diffs.length}/${pairs.length}） |`);
};

addMetric("corpus-load 次数（主指标）", (p) => p.file.ledger["corpus-load"] - p.shm.ledger["corpus-load"]);
addMetric("总墙钟 ms", (p) => p.file.wallMs - p.shm.wallMs);
addMetric("子会话语料加载字节行数替代指标见上行；嵌入耗时 ms", (p) => (p.file.childEmbedMs || 0) - (p.shm.childEmbedMs || 0));

lines.push("", "## token（并列展示，不设判据；预登记预期两臂同分布）", "",
	"| 臂 | 父 in/out | 子 in/out | 合计 in+out |", "|---|---|---|---|");
for (const arm of ["file", "shm"]) {
	const armRows = rows.filter((row) => row.arm === arm && row.valid);
	if (armRows.length === 0) continue;
	const pIn = armRows.reduce((a, r) => a + (r.parentIn ?? 0), 0), pOut = armRows.reduce((a, r) => a + (r.parentOut ?? 0), 0);
	const cIn = armRows.reduce((a, r) => a + (r.childIn ?? 0), 0), cOut = armRows.reduce((a, r) => a + (r.childOut ?? 0), 0);
	lines.push(`| ${arm} | ${pIn}/${pOut} | ${cIn}/${cOut} | ${pIn + pOut + cIn + cOut} |`);
}
lines.push("", "## 账本事件计数（两臂并列）", "", "| 臂 | shm-attach | shm-hit | shm-miss | shm-invalid | corpus-load | state-consume |", "|---|---|---|---|---|---|---|");
for (const arm of ["file", "shm"]) {
	const armRows = rows.filter((row) => row.arm === arm && row.valid);
	if (armRows.length === 0) continue;
	const sum = (kind) => armRows.reduce((a, r) => a + (r.ledger[kind] ?? 0), 0);
	lines.push(`| ${arm} | ${sum("shm-attach")} | ${sum("shm-hit")} | ${sum("shm-miss")} | ${sum("shm-invalid")} | ${sum("corpus-load")} | ${sum("state-consume")} |`);
}
lines.push("", "> 边界（冻结）：本装置每尝试独立 storageRoot，段在任务进程组（父+四角色子）内共享；跨任务驻留由 E0b 判定。", "> state-consume 的逐次延迟未入账本，墙钟为替代指标，如实注明。", "");

fs.writeFileSync(path.join(expDir, "e1s-report.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));

function fail(message) { console.error(String(message)); process.exit(1); }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1]; return out; }
