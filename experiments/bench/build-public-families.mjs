#!/usr/bin/env node
/**
 * Builds the two public-benchmark task families and the worktree they run in.
 *
 *   node experiments/bench/build-public-families.mjs [--data experiments/data]
 *
 * Inputs (downloaded once into --data, never into this repository):
 *   musique_ans_v1.0_dev.jsonl        MuSiQue-Ans dev (HF dgslibisey/MuSiQue)
 *   swe-qa/                           git clone of peng-weihan/SWE-QA-Bench
 *
 * Outputs:
 *   experiments/bench/families/q-musique.json      group Q, 10 MuSiQue questions
 *   experiments/bench/families/r-sweqa-flask.json  group R, 10 SWE-QA Flask questions
 *   <data>/worktree/musique/                           the pooled paragraphs, one file each
 *   <data>/worktree/flask/                             pallets/flask at SWE-QA's pinned commit, .git removed
 *
 * The questions are fixed by id below, not sampled, so a rebuild selects the
 * same tasks. Answers and reference answers live only in the family files,
 * which the runner keeps out of the agents' worktree.
 *
 * Why these ten and in this order:
 *  - Q: every question resolves the same bridge — the city where the Yongle
 *    Emperor greeted the person the edict was addressed to (Nanjing, via the
 *    Sino-Tibetan relations paragraph) — then asks a different attribute of
 *    it. The first question pays for the bridge; a system that keeps what it
 *    learned can reuse it for the other nine. Answers are pairwise distinct and
 *    exact-matchable; vague ones ("thousands", "two") are left out.
 *  - R: ten SWE-QA Flask questions on one subsystem, the tagged JSON serializer
 *    (src/flask/json/tag.py) and the session interface that serializes through
 *    it (src/flask/sessions.py), ordered from the serializer's core to its tags
 *    to the session code that uses it. Question text is SWE-QA's, unedited.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
// Datasets live in experiments/data (git-ignored); --data points elsewhere.
const dataArg = args.includes("--data") ? args[args.indexOf("--data") + 1] : path.join(HERE, "..", "data");
const DATA = path.resolve(dataArg.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
if (!fs.existsSync(DATA)) {
	console.error(`no dataset directory at ${DATA}; see experiments/README.md for the downloads`);
	process.exit(2);
}
const WORKTREE = path.join(DATA, "worktree");
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const MUSIQUE_IDS = [
	"3hop1__857_846_7701",
	"3hop1__857_846_7702",
	"3hop1__857_846_7798",
	"3hop1__857_846_7794",
	"3hop1__857_846_7769",
	"3hop1__857_846_7846",
	"3hop1__857_846_7872",
	"3hop1__857_846_7752",
	"3hop1__857_846_7810",
	"4hop3__857_846_326964_7713",
];
// Indices into SWE-QA Benchmark/flask.jsonl (48 questions).
const SWEQA_FLASK_INDICES = [16, 43, 9, 38, 33, 37, 24, 12, 32, 29];
const FLASK_URL = "https://github.com/pallets/flask";

// ---------------------------------------------------------------------------
// Q: MuSiQue.
// ---------------------------------------------------------------------------
const musiqueFile = path.join(DATA, "musique_ans_v1.0_dev.jsonl");
const allMusique = new Map(fs.readFileSync(musiqueFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line)).map((q) => [q.id, q]));
const chosen = MUSIQUE_IDS.map((id) => {
	const q = allMusique.get(id);
	if (!q) throw new Error(`MuSiQue id not found: ${id}`);
	return q;
});

const musiqueDir = path.join(WORKTREE, "musique");
fs.rmSync(musiqueDir, { force: true, recursive: true });
fs.mkdirSync(musiqueDir, { recursive: true });
const slug = (text) => text.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "untitled";
const pooled = new Map(); // title+text digest → relative path
let fileNo = 0;
const pathOf = (paragraph) => {
	const key = sha256(`${paragraph.title}\u0000${paragraph.paragraph_text}`);
	if (!pooled.has(key)) {
		fileNo += 1;
		const rel = `musique/${String(fileNo).padStart(3, "0")}-${slug(paragraph.title)}.md`;
		fs.writeFileSync(path.join(WORKTREE, rel), `# ${paragraph.title}\n\n${paragraph.paragraph_text}\n`, "utf-8");
		pooled.set(key, rel);
	}
	return pooled.get(key);
};
const qTasks = chosen.map((q, index) => {
	const anchors = q.paragraphs.filter((p) => p.is_supporting).map(pathOf);
	for (const p of q.paragraphs) pathOf(p);
	return {
		index: index + 1,
		title: `MuSiQue ${q.id}`,
		task: `${q.question}\n\nAnswer using only the documents in the musique/ directory of this worktree (one paragraph per file). Put your final answer on the last line as \`ANSWER: <short answer only — the entity, number or phrase itself, no explanation>\`.`,
		dependsOn: index === 0 ? [] : [index],
		anchors,
		source: { benchmark: "MuSiQue-Ans v1.0 dev", id: q.id, hops: Number(q.id[0]) },
		answer: q.answer,
		answerAliases: q.answer_aliases ?? [],
	};
});
const qFamily = {
	group: "Q",
	title: "MuSiQue-Ans 多跳问答链（公开 benchmark）",
	description: "MuSiQue-Ans dev 集中共享同一桥接链（永乐帝接见受诏者之城 → 南京）的 10 道 3/4 跳问题，每题问该城市的不同属性。段落池为 10 道题各自 20 段的并集（含干扰段），每段一个文件，位于工作树 musique/。评分：对末行 ANSWER 做 SQuAD 式归一化后的 EM / F1（答案与别名取最大）。",
	pathConvention: "musique/NNN-<title>.md",
	scoring: "exact-match/F1 against answer and answerAliases (experiments/analysis/score-public.mjs)",
	tasks: qTasks,
};

// ---------------------------------------------------------------------------
// R: SWE-QA Flask.
// ---------------------------------------------------------------------------
const sweqaDir = path.join(DATA, "swe-qa");
const commitLine = fs.readFileSync(path.join(sweqaDir, "repo_commit.txt"), "utf-8").split("\n").find((line) => line.startsWith(FLASK_URL));
if (!commitLine) throw new Error("SWE-QA repo_commit.txt has no flask entry");
const flaskCommit = commitLine.trim().split(/\s+/)[1];
const flaskQuestions = fs.readFileSync(path.join(sweqaDir, "Benchmark", "flask.jsonl"), "utf-8").split(/\n(?=\{)/).filter((chunk) => chunk.trim()).map((chunk) => JSON.parse(chunk));
if (flaskQuestions.length !== 48) throw new Error(`expected 48 SWE-QA flask questions, got ${flaskQuestions.length}`);

const flaskClone = path.join(DATA, "flask-src");
if (!fs.existsSync(path.join(flaskClone, ".git"))) {
	const clone = spawnSync("git", ["clone", "-q", FLASK_URL, flaskClone], { encoding: "utf-8" });
	if (clone.status !== 0) throw new Error(`git clone failed: ${clone.stderr}`);
}
const checkout = spawnSync("git", ["-C", flaskClone, "checkout", "-q", flaskCommit], { encoding: "utf-8" });
if (checkout.status !== 0) throw new Error(`git checkout ${flaskCommit} failed: ${checkout.stderr}`);
const resolvedCommit = spawnSync("git", ["-C", flaskClone, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim();
const flaskDir = path.join(WORKTREE, "flask");
fs.rmSync(flaskDir, { force: true, recursive: true });
fs.cpSync(flaskClone, flaskDir, { recursive: true, filter: (src) => path.basename(src) !== ".git" });

const rTasks = SWEQA_FLASK_INDICES.map((qIndex, index) => {
	const q = flaskQuestions[qIndex];
	const files = [...new Set((q.answer.match(/(?:src|tests|docs|examples)\/[\w/.-]+\.(?:py|rst|toml|cfg|md)/g) ?? []))];
	const anchors = files.map((rel) => `flask/${rel}`).filter((rel) => fs.existsSync(path.join(WORKTREE, rel)));
	return {
		index: index + 1,
		title: `SWE-QA flask #${qIndex}`,
		task: `${q.question}\n\nThe code is the pallets/flask repository at commit ${flaskCommit}, in the flask/ directory of this worktree. Answer from the code, citing the files and functions involved.`,
		dependsOn: index === 0 ? [] : [index],
		anchors,
		source: { benchmark: "SWE-QA (flask.jsonl)", index: qIndex, commit: resolvedCommit },
		referenceAnswer: q.answer,
	};
});
const rFamily = {
	group: "R",
	title: "SWE-QA Flask 仓库级代码问答链（公开 benchmark）",
	description: `SWE-QA（ACL 2026 Findings）Flask 子集中围绕带标签 JSON 序列化器（src/flask/json/tag.py）与会话接口（src/flask/sessions.py）的 10 道题，由序列化器核心到各 tag 再到会话代码排序；题面为 SWE-QA 原文。仓库为 pallets/flask@${resolvedCommit}，位于工作树 flask/（去掉 .git）。评分：SWE-QA 原版 LLM-as-judge 五维（correctness/completeness/relevance/clarity/reasoning，各 1–20，满分 100），对照参考答案。`,
	pathConvention: "flask/<repo path>",
	scoring: "SWE-QA five-dimension LLM judge against referenceAnswer (experiments/analysis/score-public.mjs)",
	tasks: rTasks,
};

for (const [name, family] of [["q-musique.json", qFamily], ["r-sweqa-flask.json", rFamily]]) {
	fs.writeFileSync(path.join(HERE, "families", name), `${JSON.stringify(family, null, 1)}\n`, "utf-8");
}
const manifest = { builtAt: new Date().toISOString(), flaskCommit: resolvedCommit, musiqueFileSha256: sha256(fs.readFileSync(musiqueFile)), musiqueParagraphFiles: pooled.size, musiqueIds: MUSIQUE_IDS, sweqaFlaskIndices: SWEQA_FLASK_INDICES };
fs.writeFileSync(path.join(WORKTREE, ".build-manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
console.log(JSON.stringify(manifest, null, 1));
console.log(`Q anchors: ${qTasks.map((t) => t.anchors.length).join(",")}; R anchors: ${rTasks.map((t) => t.anchors.length).join(",")}`);
