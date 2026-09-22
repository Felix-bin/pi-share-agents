#!/usr/bin/env node
/**
 * P50 answer-quality judge (preregistration §3): grades every valid round's
 * final answer against the frozen keypoints (docs/experiments/p50-grading-keypoints.json).
 *
 *   node --experimental-strip-types scripts/p50-judge.mjs --syn <expDir> --txt <expDir> --out <judge-results.json>
 *
 * Frozen method (§3): one LLM call per (arm, round) — the task text, that
 * task's keypoints, and the answer (the runner's evidence/answer.md, which is
 * the child session's final assistant message). The judge scores each keypoint
 * 0/1; the round score is hits/points. Judge calls run offline AFTER the
 * measured runs, never interleaved with them. Temperature 0, same API channel
 * as the measured system. A seeded 10-case sample is written alongside for the
 * human consistency check (§3 step 3); disagreement >10% switches grading to
 * fully manual on a reduced sample.
 *
 * The API key is read from synapse/.env into the environment, never printed.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = "D:/操作系统开源大赛/synapse/.env";
const KEYPOINTS_FILE = path.join(REPO, "docs", "experiments", "p50-grading-keypoints.json");
const API_BASE = "https://llmapi.paratera.com/v1";
const JUDGE_MODEL = "DeepSeek-V4-Flash";
const SAMPLE_SEED = 20260921;
const SAMPLE_N = 10;

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const readJsonl = (file) =>
	fs
		.readFileSync(file, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));

function loadKey() {
	for (const line of fs.readFileSync(ENV_FILE, "utf-8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.startsWith("PARATERA_API_KEY=")) return trimmed.slice("PARATERA_API_KEY=".length).trim();
	}
	throw new Error("PARATERA_API_KEY not present in synapse/.env");
}

const PROMPT = {
	system:
		"You are a strict grading engine for a code-reading quiz. You receive a task, the grading keypoints, and a candidate answer. For EACH keypoint decide whether the answer states the fact or an exact equivalent (unit conversions and verbatim constant expressions count; a wrong number on a probed constant fails that keypoint). Judge only against the keypoints; extra content neither helps nor hurts. Reply with STRICT JSON only: {\"hits\": [0 or 1, ...]} with exactly one entry per keypoint, in order. No prose, no code fence.",
	user: (task, keypoints, answer) =>
		`TASK:\n${task}\n\nKEYPOINTS (score each, in order):\n${keypoints.map((k, i) => `${i + 1}. ${k}`).join("\n")}\n\nCANDIDATE ANSWER:\n${answer}\n\nReply with strict JSON: {"hits": [...]} with ${keypoints.length} entries.`,
};
const promptSha256 = createHash("sha256").update(PROMPT.system + "\n---\n" + PROMPT.user("<task>", ["<k>"], "<answer>"), "utf-8").digest("hex");

/**
 * Answer-side normalization (O4): strips formatting shape so the judge sees
 * words, not markdown. Both arms run through the identical rule — a structured
 * answer and a long narrative that state the same fact score the same way, and
 * neither gains an impression advantage from headers, fences, or bullet
 * decoration. Deliberately conservative: only markers are removed, never any
 * word or number a keypoint might score.
 */
function normalizeAnswer(raw) {
	return raw
		.replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[^\n]*\n?/gm, "").replace(/```/g, ""))
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s?|\*\s+|-\s+|\+\s+|\d+[.)]\s+)/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/`([^`]+)`/g, "$1"))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
const normalizeSha256 = createHash("sha256").update(normalizeAnswer.toString(), "utf-8").digest("hex");

async function judgeOnce(key, task, keypoints, answer) {
	const resp = await fetch(`${API_BASE}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: JSON.stringify({
			model: JUDGE_MODEL,
			messages: [
				{ role: "system", content: PROMPT.system },
				{ role: "user", content: PROMPT.user(task, keypoints, answer) },
			],
			temperature: 0,
			// The provider's DeepSeek-V4-Flash spends the budget on reasoning_content
			// first (observed: 2048 reasoning tokens, empty content at max_tokens=256,
			// finish_reason "length"). The budget must cover the model's reasoning AND
			// the JSON, so it is set well above the observed reasoning length.
			max_tokens: 8192,
		}),
	});
	if (!resp.ok) throw new Error(`judge API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
	const data = await resp.json();
	const choice = data.choices?.[0];
	const text = choice?.message?.content ?? "";
	if (text.trim().length === 0) {
		throw new Error(`empty judge content (finish_reason=${choice?.finish_reason}, reasoning=${(choice?.message?.reasoning_content ?? "").length} chars)`);
	}
	const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
	const parsed = JSON.parse(cleaned);
	if (!Array.isArray(parsed.hits) || parsed.hits.length !== keypoints.length || !parsed.hits.every((h) => h === 0 || h === 1)) {
		throw new Error(`judge returned malformed hits: ${text.slice(0, 200)}`);
	}
	return { hits: parsed.hits, usage: data.usage ?? null };
}

async function main() {
	const argv = process.argv.slice(2);
	const opt = { out: null, pairs: null };
	for (let i = 0; i < argv.length; i += 2) opt[argv[i].slice(2)] = argv[i + 1];
	// Two ways to name the arms: the P50 pair (--syn/--txt) or an explicit list
	// (--arms "AUTOGEN=<dir>,CREWAI=<dir>") for the §11 framework baselines.
	// Both go through the identical frozen prompt and scoring.
	const arms = opt.arms
		? opt.arms.split(",").map((entry) => {
				const at = entry.indexOf("=");
				if (at <= 0) throw new Error(`bad --arms entry: ${entry}`);
				return [entry.slice(0, at).trim(), entry.slice(at + 1).trim()];
			})
		: [["SYN", opt.syn], ["TXT", opt.txt]];
	if (!opt.out || arms.some(([, dir]) => !dir)) throw new Error("--out <file> and (--arms L=D,... or --syn <dir> --txt <dir>) required");

	const key = loadKey();
	const keypointsDoc = JSON.parse(fs.readFileSync(KEYPOINTS_FILE, "utf-8"));
	const keypointsByTask = new Map(keypointsDoc.tasks.map((t) => [t.task, t.keypoints]));
	const { TASKS } = await import(`file:///${REPO.replaceAll("\\", "/")}/scripts/p50-family.mjs`);

	const wanted = opt.pairs
		? new Set(opt.pairs.split("-").length === 2 ? Array.from({ length: Number(opt.pairs.split("-")[1]) - Number(opt.pairs.split("-")[0]) + 1 }, (_, i) => Number(opt.pairs.split("-")[0]) + i) : opt.pairs.split(",").map(Number))
		: null;

	const results = { model: `${"paratera"}/${JUDGE_MODEL}`, promptSha256, normalize: { version: "v1-answer-normalization", normalizeSha256 }, keypointsSha256: createHash("sha256").update(fs.readFileSync(KEYPOINTS_FILE)).digest("hex"), generatedAt: new Date().toISOString(), scores: Object.fromEntries(arms.map(([name]) => [name, {}])), detail: {}, failures: [] };

	for (const [armName, dir] of arms) {
		const seen = new Map();
		for (const record of readJsonl(path.join(dir, "rounds.jsonl"))) {
			if (record.valid && !seen.has(record.round)) seen.set(record.round, record);
		}
		for (const [round, record] of [...seen.entries()].sort((a, b) => a[0] - b[0])) {
			if (wanted !== null && !wanted.has(round)) continue;
			// Two layouts exist: the P50 runner writes evidence/round-XX/attempt-N/answer.md,
			// the framework harnesses write evidence/round-XX/answer.md (no attempts).
			const roundDir = path.join(dir, "evidence", `round-${String(round).padStart(2, "0")}`);
			const candidates = [path.join(roundDir, `attempt-${record.attempt}`, "answer.md"), path.join(roundDir, "answer.md")];
			const answerFile = candidates.find((candidate) => fs.existsSync(candidate));
			if (answerFile === undefined) {
				results.failures.push({ arm: armName, round, error: "answer.md missing" });
				continue;
			}
			const answer = fs.readFileSync(answerFile, "utf-8");
			const normalized = normalizeAnswer(answer);
			const taskIndex = ((round - 1) % 30) + 1; // P50M replays rounds 31-60 over tasks 1-30
			const keypoints = keypointsByTask.get(taskIndex);
			if (keypoints === undefined) throw new Error(`no keypoints for task ${round}`);
			let outcome = null;
			let secondOutcome = null;
			let lastError = null;
			for (let attempt = 1; attempt <= 2 && outcome === null; attempt += 1) {
				try {
					outcome = await judgeOnce(key, TASKS[taskIndex - 1], keypoints, normalized);
				} catch (error) {
					lastError = error;
				}
			}
			// Self-check (--self-check): an independent second grading of the same
			// normalized input. Temperature 0 still leaves provider-side
			// nondeterminism; the flip count bounds how much of any reported gap
			// could be judge noise rather than answer quality.
			if (opt["self-check"] && outcome !== null) {
				try {
					secondOutcome = await judgeOnce(key, TASKS[taskIndex - 1], keypoints, normalized);
				} catch {
					secondOutcome = null;
				}
			}
			if (outcome === null) {
				results.failures.push({ arm: armName, round, error: String(lastError?.message ?? lastError) });
				console.log(`[judge] ${armName} round ${round}: FAILED (${lastError?.message})`);
				continue;
			}
			const score = outcome.hits.reduce((s, h) => s + h, 0) / outcome.hits.length;
			results.scores[armName][round] = Math.round(score * 1000) / 1000;
			results.detail[`${armName}-${round}`] = {
				hits: outcome.hits,
				points: outcome.hits.length,
				usage: outcome.usage,
				answerBytes: Buffer.byteLength(answer, "utf-8"),
				normalizedBytes: Buffer.byteLength(normalized, "utf-8"),
				...(secondOutcome !== null
					? { secondHits: secondOutcome.hits, flips: outcome.hits.reduce((n, h, i) => n + (h !== secondOutcome.hits[i] ? 1 : 0), 0) }
					: {}),
			};
			console.log(`[judge] ${armName} round ${round}: ${outcome.hits.reduce((s, h) => s + h, 0)}/${outcome.hits.length} = ${results.scores[armName][round]}`);
		}
	}

	// Seeded 10-case sample for the human consistency check (§3 step 3): full
	// inputs and judge output, so a human can re-grade independently.
	const rng = mulberry32(SAMPLE_SEED);
	const allCases = Object.keys(results.detail);
	const sample = [];
	const pool = [...allCases];
	for (let i = 0; i < Math.min(SAMPLE_N, pool.length); i += 1) {
		const at = Math.floor(rng() * pool.length);
		const caseKey = pool.splice(at, 1)[0];
		const [arm, round] = caseKey.split("-");
		const armDir = arms.find(([name]) => name === arm)[1];
		const record = readJsonl(path.join(armDir, "rounds.jsonl")).find((r) => r.valid && r.round === Number(round));
		const roundDir = path.join(armDir, "evidence", `round-${String(Number(round)).padStart(2, "0")}`);
		const answerFile = [path.join(roundDir, `attempt-${record.attempt}`, "answer.md"), path.join(roundDir, "answer.md")].find((candidate) => fs.existsSync(candidate));
		sample.push({
			arm,
			round: Number(round),
			task: TASKS[(Number(round) - 1) % 30],
			keypoints: keypointsByTask.get(((Number(round) - 1) % 30) + 1),
			answer: fs.readFileSync(answerFile, "utf-8"),
			normalizedAnswer: normalizeAnswer(fs.readFileSync(answerFile, "utf-8")),
			judge: results.detail[`${arm}-${round}`],
		});
	}
	results.consistency = `待人工复核：抽样 ${sample.length} 份已写入 ${opt.out.replace(/\.json$/, "")}-human-sample.json；分歧率 >10% 时改全人工并缩样（§3）`;
	// Self-check rollup: flips across every doubly-graded case. A flip rate
	// above zero bounds the judge-noise floor any arm gap must be read against.
	const selfChecked = Object.values(results.detail).filter((d) => d.flips !== undefined);
	if (selfChecked.length > 0) {
		const totalFlips = selfChecked.reduce((s, d) => s + d.flips, 0);
		const totalPoints = selfChecked.reduce((s, d) => s + d.points, 0);
		results.selfCheck = { cases: selfChecked.length, totalFlips, totalPoints, flipRate: Math.round((totalFlips / totalPoints) * 10000) / 10000 };
	}
	results.humanSampleFile = `${opt.out.replace(/\.json$/, "")}-human-sample.json`;

	fs.writeFileSync(opt.out, `${JSON.stringify(results, null, "\t")}\n`, "utf-8");
	fs.writeFileSync(results.humanSampleFile, `${JSON.stringify(sample, null, "\t")}\n`, "utf-8");
	console.log(`[judge] written: ${opt.out} (+ human sample ${results.humanSampleFile}); failures: ${results.failures.length}`);
}

await main();
