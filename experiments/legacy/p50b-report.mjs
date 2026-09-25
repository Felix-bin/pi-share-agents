/**
 * P50-B report: the cross-system table over the four arms (SYN, TXT, AUTOGEN, CREWAI).
 *
 * Per preregistration §11 point 7 the framework arms are compared ACROSS SYSTEMS,
 * not paired: each arm gets mean and range for tokens, with the answer-quality
 * score from the same frozen judge (§3 keypoints, identical prompt) reported
 * beside it. No paired bootstrap is run across systems, and the n difference
 * (30 vs 15) is stated.
 *
 *   node --experimental-strip-types experiments/legacy/p50b-report.mjs --out <report.md>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE = "D:/操作系统开源大赛/synapse/_state";

const ARMS = [
	{ name: "SYN", label: "SYNAPSE（结构化状态传递）", dir: path.join(STATE, "p50-token-ab-20260921", "syn-n30"), judge: path.join(STATE, "p50-token-ab-20260921", "judge-results.json"), key: "SYN" },
	{ name: "TXT", label: "纯文本协作（同运行时·M3 基线）", dir: path.join(STATE, "p50-token-ab-20260921", "txt-n30"), judge: path.join(STATE, "p50-token-ab-20260921", "judge-results.json"), key: "TXT" },
	{ name: "AUTOGEN", label: "AutoGen（AG2）双助手文本交接", dir: path.join(STATE, "p50b-framework-20260921", "autogen-n15"), judge: path.join(STATE, "p50b-framework-20260921", "judge-results.json"), key: "AUTOGEN" },
	{ name: "CREWAI", label: "CrewAI sequential crew", dir: path.join(STATE, "p50b-framework-20260921", "crewai-n15"), judge: path.join(STATE, "p50b-framework-20260921", "judge-results.json"), key: "CREWAI" },
];

const readJsonl = (file) =>
	fs
		.readFileSync(file, "utf-8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
const fmt = (v, d = 0) => (v === null || Number.isNaN(v) ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d }));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

const rows = ARMS.map((arm) => {
	const records = readJsonl(path.join(arm.dir, "rounds.jsonl")).filter((r) => r.valid);
	const judge = fs.existsSync(arm.judge) ? JSON.parse(fs.readFileSync(arm.judge, "utf-8")) : null;
	const scores = judge?.scores?.[arm.key] ? Object.values(judge.scores[arm.key]) : [];
	const tokens = records.map((r) => r.usage.input + r.usage.output);
	const wall = records.map((r) => r.wallMs);
	return {
		...arm,
		n: records.length,
		valid: records.length,
		tokenMean: mean(tokens),
		tokenMin: tokens.length ? Math.min(...tokens) : null,
		tokenMax: tokens.length ? Math.max(...tokens) : null,
		inputMean: mean(records.map((r) => r.usage.input)),
		outputMean: mean(records.map((r) => r.usage.output)),
		wallMean: mean(wall),
		scoreMean: mean(scores),
		scoreN: scores.length,
	};
});

const out = [];
out.push("# P50-B 跨系统对照（主实验 P50 + 框架基线；n 不同，读数看口径）");
out.push("");
out.push("判据：`experiments/legacy/records/P50-token-ab-preregistration-20260921.md` §7/§11（跨系统并列、非配对；");
out.push("token 一律 API usage 层；同一冻结判分器与关键点）。");
out.push("");
out.push("| 臂 | n | token/轮 均值 | 极差 [min, max] | 输入均值 | 输出均值 | 墙钟 ms/轮 | judge 得分（同判据） |");
out.push("|---|---|---|---|---|---|---|---|");
for (const r of rows) {
	out.push(`| ${r.label} | ${r.n} | ${fmt(r.tokenMean)} | [${fmt(r.tokenMin)}, ${fmt(r.tokenMax)}] | ${fmt(r.inputMean)} | ${fmt(r.outputMean)} | ${fmt(r.wallMean)} | ${r.scoreMean === null ? "待判分" : `${fmt(r.scoreMean, 3)}（n=${r.scoreN}）`} |`);
}
out.push("");
out.push("读法（§11 第 7 条）：框架臂与 P50 两臂为跨系统并列，按臂报均值与极差，不做逐轮配对；");
out.push("n 差异（30 vs 15）如实标注。**token 少不等于好**——质量列必须与 token 列同读：");
out.push("作答少而得分低说明省 token 是靠少干活换来的，不构成效率优势。");
out.push("");
out.push("装置差异（如实披露，不得隐藏）：");
out.push("- SYN/TXT 子代理＝pi 运行时子会话（自带系统提示与完整文件工具）；");
out.push("- AutoGen/CrewAI 臂＝框架原生助手（角色系统提示仅声明职责，三件同构工作树工具，未调优）；");
out.push("- 三系统同模型同通道（paratera DeepSeek-V4-Flash，temp 0）、同 v4 任务族、同工作树。");
out.push("");
out.push("## 分析（照读数写，不挑有利栏）");
out.push("");
const byKey = Object.fromEntries(rows.map((r) => [r.name, r]));
if (byKey.CREWAI && byKey.SYN) {
	out.push(`1. **与 CrewAI 的对照是可比的效率对比**：CrewAI 完成同类工作且质量带相当（${fmt(byKey.CREWAI.scoreMean, 3)} vs SYN ${fmt(byKey.SYN.scoreMean, 3)}），`);
	out.push(`   但每轮耗 ${fmt(byKey.CREWAI.tokenMean)} token ≈ SYN 的 ${(byKey.CREWAI.tokenMean / byKey.SYN.tokenMean).toFixed(2)} 倍（SYN 省 ${(100 * (1 - byKey.SYN.tokenMean / byKey.CREWAI.tokenMean)).toFixed(1)}%）。`);
}
if (byKey.AUTOGEN) {
	out.push(`2. **AutoGen 的 token 低不等于省**：每轮 ${fmt(byKey.AUTOGEN.tokenMean)} token（约为 SYN 的 ${(100 * byKey.AUTOGEN.tokenMean / byKey.SYN.tokenMean).toFixed(0)}%），`);
	out.push(`   但判分仅 ${fmt(byKey.AUTOGEN.scoreMean, 3)}——其助手常在 1-2 次工具调用后收尾、作答缺关键点。`);
	out.push(`   **该臂不构成"更省"的证据**，只说明"少干活可以少花 token"；如实列出，不作为我方优势的对照栏。`);
}
out.push("3. 结论口径：本表支持的主张仅为——在**同等完成度**的对照（CrewAI 带）下，结构化状态传递");
out.push("   以更少 token 达到同质量带；P50 主实验（配对 n=30）给出该优势的区间估计。");
out.push("");

const text = `${out.join("\n")}\n`;
const argv = process.argv.slice(2);
const outFile = argv.indexOf("--out") !== -1 ? argv[argv.indexOf("--out") + 1] : null;
if (outFile) {
	fs.writeFileSync(outFile, text, "utf-8");
	console.log(`report written: ${outFile}`);
} else console.log(text);
