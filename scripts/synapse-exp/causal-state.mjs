#!/usr/bin/env node
/**
 * causal-state: does the non-text state the SYNAPSE retrieve path sends carry
 * task-specific information, and what does sending it cost?
 *
 *   node --experimental-strip-types scripts/synapse-exp/causal-state.mjs [--out <dir>] [--id <id>] [--seeds 20]
 *
 * No LLM is called. The only network calls are embeddings, through the same
 * client and stored key the product uses (/synapse-setup → SiliconFlow bge-m3);
 * the key is resolved in-process and never printed.
 *
 * Corpus: this repository at HEAD (git archive), src/ docs/ scripts/ prompts/
 * agents/ skills/ and top-level markdown, built with the product's corpus
 * builder at window 40 / overlap 8 (see WINDOW below). Excluded before anything is embedded:
 * test/ (kept out for size), docs/experiments/*.json, and the synapse-bench
 * families (they hold the answer keypoints; at HEAD they are untracked anyway).
 *
 * Queries: the 20 tasks of the synapse-bench G1/G2 families (task text only);
 * gold = the task's `anchors` files. A secondary set uses every keypoint text
 * as a query against its task's anchors.
 *
 * Conditions (what the receiver ranks the corpus with):
 *   correct        v(q) as sent on the wire (float32, 4096 B)
 *   int8           v(q) through the delta grid (127) and back — lossy transfer
 *   delta-prev     v(q) sent as a residual against the previous task's vector
 *                  in the same chain (the shared-context case); rounds ≥ 2 only
 *   mismatch-cross v of the same-index task from the other group
 *   mismatch-near  v of the neighbouring task in the same chain
 *   random         seeded Gaussian vectors (mean over --seeds draws)
 *   zero           the all-zero vector (the product must refuse it)
 *   bm25-text      no state at all: BM25 over chunk text from the query text
 *
 * Metrics per query: file hit@1 / hit@5, anchor coverage@5, MRR@10 of the
 * first anchor chunk; bytes each path puts on the wire; embed and rank time.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);
const { buildCorpus } = await imp("src/synapse/corpus.ts");
const { createEmbeddingClient } = await imp("src/synapse/embedding.ts");
const { resolveEmbeddingKey } = await imp("src/synapse/credentials.ts");
const { loadCorpusVectors, rankCorpusChunks } = await imp("src/synapse/state-retrieval.ts");
const { quantize, dequantize, encodeDelta, decodeDelta } = await imp("src/synapse/delta.ts");
const { SYNAPSE_DELTA_PARAMS } = await imp("src/synapse/delta-params.ts");

const args = process.argv.slice(2);
const opt = (flag, fallback) => {
	const at = args.indexOf(flag);
	return at === -1 ? fallback : args[at + 1];
};
const SEEDS = Number(opt("--seeds", "20"));
// 40/8 (the P45 corpus shape): at the product default 200/40 the largest
// chunks of this repository reach ~45 KB, past bge-m3's 8K-token input limit.
const WINDOW = Number(opt("--window", "40"));
const OVERLAP = Number(opt("--overlap", "8"));
const agentDir = path.join(os.homedir(), ".pi", "agent");
const OUT_ROOT = path.resolve(opt("--out", path.join(agentDir, "synapse", "experiments")));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const ID = opt("--id", `causal-state-${stamp}`);
const expDir = path.join(OUT_ROOT, ID);
fs.mkdirSync(expDir, { recursive: true });
const log = (m) => console.log(`[causal ${new Date().toISOString().slice(11, 19)}] ${m}`);
const writeJson = (f, v) => fs.writeFileSync(f, `${JSON.stringify(v, null, "\t")}\n`);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ---------------------------------------------------------------------------
// Tasks.
// ---------------------------------------------------------------------------
const FAMILIES = { G1: "g1-openeuler.json", G2: "g2-codebase.json" };
const families = {};
for (const [group, file] of Object.entries(FAMILIES)) {
	const full = path.join(REPO, "scripts", "synapse-bench", "families", file);
	families[group] = { sha256: sha256(fs.readFileSync(full)), tasks: JSON.parse(fs.readFileSync(full, "utf-8")).tasks };
}

// ---------------------------------------------------------------------------
// Corpus source: HEAD, filtered.
// ---------------------------------------------------------------------------
const headSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf-8" }).stdout.trim();
const sourceDir = path.join(expDir, "corpus-source");
fs.rmSync(sourceDir, { force: true, recursive: true });
fs.mkdirSync(sourceDir, { recursive: true });
const INCLUDE = ["src", "docs", "scripts", "prompts", "agents", "skills", "README.md", "VISION.md", "AGENTS.md", "CHANGELOG.md"];
const tar = spawnSync("sh", ["-c", `git archive ${headSha} ${INCLUDE.join(" ")} | tar -x -C ${JSON.stringify(sourceDir)}`], { cwd: REPO, encoding: "utf-8" });
if (tar.status !== 0) throw new Error(`git archive failed: ${tar.stderr}`);
const excluded = [];
const walk = (dir) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		const rel = path.relative(sourceDir, full).split(path.sep).join("/");
		if (entry.isDirectory()) {
			if (rel === "scripts/synapse-bench") {
				fs.rmSync(full, { recursive: true });
				excluded.push(`${rel}/`);
			} else walk(full);
		} else if (/^docs\/experiments\/.*\.json$/.test(rel)) {
			fs.rmSync(full);
			excluded.push(rel);
		}
	}
};
walk(sourceDir);
const ALLOWLIST = [".ts", ".md", ".mjs", ".sh", ".bt", ".json", ".yaml", ".py", ".txt"];

// Every anchor must be in the corpus, or hit@k is unreachable by construction.
const allAnchors = new Set(Object.values(families).flatMap((f) => f.tasks.flatMap((t) => t.anchors)));
const missingAnchors = [...allAnchors].filter((a) => !fs.existsSync(path.join(sourceDir, a)));
if (missingAnchors.length > 0) throw new Error(`anchors missing from corpus at ${headSha}: ${missingAnchors.join(", ")}`);

// ---------------------------------------------------------------------------
// Embedder: the product's client, the product's stored key.
// ---------------------------------------------------------------------------
const resolved = resolveEmbeddingKey({ agentDir, env: process.env });
if (resolved.key === null) throw new Error("no embedding key: run /synapse-setup in pi (or set SILICONFLOW_API_KEY)");
const EMBEDDING = { dim: 1024, endpoint: "https://api.siliconflow.cn/v1/embeddings", keyEnv: "SILICONFLOW_API_KEY", model: "BAAI/bge-m3", provider: "siliconflow" };
const storageRoot = path.join(expDir, "store");
const embedder = createEmbeddingClient(EMBEDDING, { key: resolved.key, storageRoot: path.join(storageRoot, "embedding-store") });
log(`embedding key source=${resolved.source}; representation=${embedder.representationId}`);

log(`building corpus (product builder, window ${WINDOW}/overlap ${OVERLAP})…`);
const t0 = Date.now();
const built = await buildCorpus({ allowlist: ALLOWLIST, corpusRoot: sourceDir, embedder, overlapLines: OVERLAP, sourceCommit: headSha, storageRoot, windowLines: WINDOW });
const corpusBuildMs = Date.now() - t0;
const corpusSnapshotId = built.corpusSnapshotId;
const corpus = loadCorpusVectors(storageRoot, corpusSnapshotId, EMBEDDING.dim, embedder.representationId);
const chunksPath = path.join(storageRoot, "corpus", corpusSnapshotId, "chunks.json");
const chunkTexts = new Map(JSON.parse(fs.readFileSync(chunksPath, "utf-8")).map((c) => [c.chunkId, c.text]));
log(`corpus ${corpusSnapshotId.slice(0, 12)}…: ${corpus.chunkIds.length} chunks, built in ${corpusBuildMs} ms`);

// ---------------------------------------------------------------------------
// BM25 text baseline over the same chunks.
// ---------------------------------------------------------------------------
const TOKEN = /[a-z0-9_]+|[㐀-䶿一-鿿]/g;
const toks = (s) => s.toLowerCase().match(TOKEN) ?? [];
const docs = corpus.chunkIds.map((id) => {
	const tf = new Map();
	const list = toks(chunkTexts.get(id) ?? "");
	for (const t of list) tf.set(t, (tf.get(t) ?? 0) + 1);
	return { len: list.length, tf };
});
const avgdl = docs.reduce((s, d) => s + d.len, 0) / docs.length;
const df = new Map();
for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
function bm25Rank(query, k) {
	const q = [...new Set(toks(query))];
	const N = docs.length;
	const scored = docs.map((d, i) => {
		let s = 0;
		for (const t of q) {
			const f = d.tf.get(t);
			if (!f) continue;
			const n = df.get(t);
			const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
			s += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.len) / avgdl));
		}
		return { i, s };
	});
	scored.sort((a, b) => b.s - a.s || (corpus.chunkIds[a.i] < corpus.chunkIds[b.i] ? -1 : 1));
	return scored.slice(0, k).map(({ i }) => ({ chunkId: corpus.chunkIds[i], path: corpus.chunkMeta[i].path }));
}

// ---------------------------------------------------------------------------
// Scoring.
// ---------------------------------------------------------------------------
function score(hits, anchors) {
	const set = new Set(anchors);
	const top5 = hits.slice(0, 5);
	const firstAnchor = hits.slice(0, 10).findIndex((h) => set.has(h.path));
	return {
		coverage5: new Set(top5.filter((h) => set.has(h.path)).map((h) => h.path)).size / set.size,
		hit1: set.has(hits[0]?.path) ? 1 : 0,
		hit5: top5.some((h) => set.has(h.path)) ? 1 : 0,
		mrr10: firstAnchor === -1 ? 0 : 1 / (firstAnchor + 1),
	};
}
const rankVec = (v) => rankCorpusChunks(corpus, v, 10);
function mulberry32(seed) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function gaussianVector(seed) {
	const rnd = mulberry32(seed);
	const v = new Float32Array(EMBEDDING.dim);
	for (let i = 0; i < v.length; i += 1) v[i] = Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
	return v;
}
const utf8 = (s) => Buffer.byteLength(s, "utf-8");

// ---------------------------------------------------------------------------
// Embed queries (timed: first call is a real request, the second a cache hit).
// ---------------------------------------------------------------------------
const tasks = [];
for (const group of ["G1", "G2"]) for (const t of families[group].tasks) tasks.push({ group, index: t.index, anchors: t.anchors, text: t.task, keypoints: t.keypoints });
for (const t of tasks) {
	const first = await embedder.embedQuery(t.text);
	const again = await embedder.embedQuery(t.text);
	t.vector = first.vector;
	t.embedMs = first.cached ? null : first.latencyMs;
	t.embedCachedMs = again.cached ? again.latencyMs : null;
	t.embedTokens = first.promptTokens;
}
const byKey = new Map(tasks.map((t) => [`${t.group}:${t.index}`, t]));
const other = (g) => (g === "G1" ? "G2" : "G1");

// ---------------------------------------------------------------------------
// Primary set.
// ---------------------------------------------------------------------------
const rows = [];
for (const t of tasks) {
	const rankStart = performance.now();
	const correctHits = rankVec(t.vector);
	const rankMs = performance.now() - rankStart;
	const q = quantize(t.vector, SYNAPSE_DELTA_PARAMS.grid);
	const conditions = {};
	conditions.correct = { ...score(correctHits, t.anchors), wireBytes: t.vector.byteLength };
	conditions.int8 = { ...score(rankVec(dequantize(q, SYNAPSE_DELTA_PARAMS.grid)), t.anchors), wireBytes: null, note: "grid round-trip; no product encoding sends a bare int8 vector" };
	const prev = byKey.get(`${t.group}:${t.index - 1}`);
	if (prev) {
		const base = quantize(prev.vector, SYNAPSE_DELTA_PARAMS.grid);
		const enc = encodeDelta(q, base, SYNAPSE_DELTA_PARAMS);
		const rebuilt = dequantize(decodeDelta(enc.payload, base), SYNAPSE_DELTA_PARAMS.grid);
		conditions["delta-prev"] = { ...score(rankVec(rebuilt), t.anchors), wireBytes: enc.payload.byteLength, nnz: enc.nnz };
	} else conditions["delta-prev"] = null;
	conditions["mismatch-cross"] = { ...score(rankVec(byKey.get(`${other(t.group)}:${t.index}`).vector), t.anchors), wireBytes: t.vector.byteLength };
	const near = byKey.get(`${t.group}:${t.index === 1 ? 2 : t.index - 1}`);
	const nearOverlap = near.anchors.filter((a) => t.anchors.includes(a)).length;
	conditions["mismatch-near"] = { ...score(rankVec(near.vector), t.anchors), wireBytes: t.vector.byteLength, anchorOverlap: nearOverlap };
	const rs = [];
	for (let s = 0; s < SEEDS; s += 1) rs.push(score(rankVec(gaussianVector(1000 * t.index + s + (t.group === "G2" ? 500 : 0))), t.anchors));
	conditions.random = Object.fromEntries(["hit1", "hit5", "coverage5", "mrr10"].map((k) => [k, rs.reduce((a, r) => a + r[k], 0) / rs.length]));
	conditions.random.wireBytes = t.vector.byteLength;
	let zeroOutcome;
	try {
		rankVec(new Float32Array(EMBEDDING.dim));
		zeroOutcome = "accepted";
	} catch (error) {
		zeroOutcome = `refused: ${String(error.message).split(";")[0]}`;
	}
	conditions.zero = { refused: zeroOutcome.startsWith("refused"), outcome: zeroOutcome };
	const bm = bm25Rank(t.text, 10);
	conditions["bm25-text"] = { ...score(bm, t.anchors), wireBytes: utf8(t.text) };
	const top5TextBytes = correctHits.slice(0, 5).reduce((a, h) => a + utf8(chunkTexts.get(h.chunkId) ?? ""), 0);
	rows.push({
		anchors: t.anchors,
		conditions,
		cost: { embedCachedMs: t.embedCachedMs, embedMs: t.embedMs, embedTokens: t.embedTokens, queryTextBytes: utf8(t.text), rankMs, top5ChunkTextBytes: top5TextBytes, vectorBytes: t.vector.byteLength },
		group: t.group,
		index: t.index,
		top5: correctHits.slice(0, 5).map((h) => ({ cosine: Number(h.cosine.toFixed(4)), path: h.path, startLine: h.startLine })),
	});
}
fs.writeFileSync(path.join(expDir, "results.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

// ---------------------------------------------------------------------------
// Secondary set: keypoints as queries.
// ---------------------------------------------------------------------------
const kpRows = [];
const kpTexts = tasks.flatMap((t) => t.keypoints.map((k, i) => ({ t, k, i })));
const kpVecs = await embedder.embedBatch(kpTexts.map((x) => x.k));
kpTexts.forEach(({ t, k, i }, n) => {
	const crossPool = tasks.filter((u) => u.group !== t.group);
	const mis = crossPool[n % crossPool.length];
	kpRows.push({
		bm25: score(bm25Rank(k, 10), t.anchors),
		correct: score(rankVec(kpVecs[n].vector), t.anchors),
		group: t.group,
		index: t.index,
		keypoint: i,
		mismatch: score(rankVec(mis.vector), t.anchors),
	});
});
fs.writeFileSync(path.join(expDir, "keypoint-results.jsonl"), kpRows.map((r) => JSON.stringify(r)).join("\n") + "\n");

// ---------------------------------------------------------------------------
// Statistics.
// ---------------------------------------------------------------------------
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
function bootstrapDiff(a, b, B = 10000, seed = 7) {
	const rnd = mulberry32(seed);
	const n = a.length;
	const diffs = [];
	for (let r = 0; r < B; r += 1) {
		let s = 0;
		for (let i = 0; i < n; i += 1) {
			const j = Math.floor(rnd() * n);
			s += a[j] - b[j];
		}
		diffs.push(s / n);
	}
	diffs.sort((x, y) => x - y);
	return [diffs[Math.floor(0.025 * B)], diffs[Math.floor(0.975 * B)]];
}
function mcnemarExact(a, b) {
	let n01 = 0;
	let n10 = 0;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] === 1 && b[i] === 0) n10 += 1;
		if (a[i] === 0 && b[i] === 1) n01 += 1;
	}
	const n = n01 + n10;
	if (n === 0) return { n01, n10, p: 1 };
	const k = Math.min(n01, n10);
	let tail = 0;
	let c = 1;
	for (let i = 0; i <= n; i += 1) {
		if (i > 0) c = (c * (n - i + 1)) / i;
		if (i <= k) tail += c;
	}
	return { n01, n10, p: Math.min(1, (2 * tail) / 2 ** n) };
}
const CONDS = ["correct", "int8", "delta-prev", "mismatch-cross", "mismatch-near", "random", "bm25-text"];
const METRICS = ["hit1", "hit5", "coverage5", "mrr10"];
const table = {};
for (const c of CONDS) {
	const present = rows.filter((r) => r.conditions[c] != null);
	table[c] = { n: present.length };
	for (const m of METRICS) table[c][m] = mean(present.map((r) => r.conditions[c][m]));
	const wb = present.map((r) => r.conditions[c].wireBytes).filter((x) => typeof x === "number");
	table[c].wireBytesMean = wb.length ? mean(wb) : null;
}
const contrasts = {};
for (const c of CONDS.filter((x) => x !== "correct")) {
	const present = rows.filter((r) => r.conditions[c] != null);
	contrasts[c] = {};
	for (const m of METRICS) {
		const a = present.map((r) => r.conditions.correct[m]);
		const b = present.map((r) => r.conditions[c][m]);
		contrasts[c][m] = { ci95: bootstrapDiff(a, b), diff: mean(a) - mean(b) };
	}
	if (c !== "random") contrasts[c].hit5McNemar = mcnemarExact(present.map((r) => r.conditions.correct.hit5), present.map((r) => r.conditions[c].hit5));
}
const kpTable = Object.fromEntries(["correct", "mismatch", "bm25"].map((c) => [c, Object.fromEntries(METRICS.map((m) => [m, mean(kpRows.map((r) => r[c][m]))]))]));
kpTable.n = kpRows.length;
kpTable.hit5McNemarCorrectVsMismatch = mcnemarExact(kpRows.map((r) => r.correct.hit5), kpRows.map((r) => r.mismatch.hit5));
kpTable.hit5McNemarCorrectVsBm25 = mcnemarExact(kpRows.map((r) => r.correct.hit5), kpRows.map((r) => r.bm25.hit5));

const cost = {
	embedCachedMsMean: mean(rows.map((r) => r.cost.embedCachedMs).filter((x) => x !== null)),
	embedMsMean: mean(rows.map((r) => r.cost.embedMs).filter((x) => x !== null)),
	queryTextBytesMean: mean(rows.map((r) => r.cost.queryTextBytes)),
	rankMsMean: mean(rows.map((r) => r.cost.rankMs)),
	top5ChunkTextBytesMean: mean(rows.map((r) => r.cost.top5ChunkTextBytes)),
	vectorBytes: EMBEDDING.dim * 4,
	deltaPrevBytesMean: table["delta-prev"].wireBytesMean,
};

const manifest = {
	corpus: { allowlist: ALLOWLIST, overlapLines: OVERLAP, windowLines: WINDOW, buildMs: corpusBuildMs, chunks: corpus.chunkIds.length, corpusSnapshotId, excluded, include: INCLUDE, sourceCommit: headSha },
	createdAt: new Date().toISOString(),
	embedding: { ...EMBEDDING, keySource: resolved.source, representationId: embedder.representationId },
	experimentId: ID,
	families: Object.fromEntries(Object.entries(families).map(([g, f]) => [g, { sha256: f.sha256, tasks: f.tasks.length }])),
	kind: "causal-state",
	llm: "none",
	model: null,
	randomSeeds: SEEDS,
	zeroVector: rows[0].conditions.zero,
};
writeJson(path.join(expDir, "manifest.json"), manifest);
writeJson(path.join(expDir, "summary.json"), {
	arms: CONDS,
	comparison: Object.fromEntries(
		CONDS.filter((c) => c !== "correct").map((c) => [
			`hit5:correct-vs-${c}`,
			{ ci: contrasts[c].hit5.ci95, diff: contrasts[c].hit5.diff, pct: table[c].hit5 ? (table.correct.hit5 - table[c].hit5) / table[c].hit5 : null, syn: table.correct.hit5, txt: table[c].hit5 },
		]),
	),
	contrasts,
	cost,
	groups: ["G1", "G2"],
	keypointSet: kpTable,
	table,
});

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
const f = (x, d = 3) => (x === null || x === undefined ? "n/a" : typeof x === "number" ? x.toFixed(d) : String(x));
const lines = [];
lines.push(`# causal-state — ${ID}`, "");
lines.push(`corpus ${corpusSnapshotId.slice(0, 16)}… @ ${headSha.slice(0, 10)}, ${corpus.chunkIds.length} chunks; embedding ${EMBEDDING.model}/${EMBEDDING.dim}; queries n=${rows.length} (G1/G2 tasks); random = mean of ${SEEDS} seeds.`, "");
lines.push("| condition | n | hit@1 | hit@5 | coverage@5 | MRR@10 | wire bytes |", "|---|---|---|---|---|---|---|");
for (const c of CONDS) lines.push(`| ${c} | ${table[c].n} | ${f(table[c].hit1)} | ${f(table[c].hit5)} | ${f(table[c].coverage5)} | ${f(table[c].mrr10)} | ${f(table[c].wireBytesMean, 0)} |`);
lines.push("", `zero vector: ${manifest.zeroVector.outcome}`, "");
lines.push("## correct minus control (paired bootstrap 95% CI, B=10000; McNemar exact on hit@5)", "");
lines.push("| control | Δhit@5 [CI] | ΔMRR@10 [CI] | McNemar p |", "|---|---|---|---|");
for (const c of CONDS.filter((x) => x !== "correct")) {
	const k = contrasts[c];
	lines.push(`| ${c} | ${f(k.hit5.diff)} [${f(k.hit5.ci95[0])}, ${f(k.hit5.ci95[1])}] | ${f(k.mrr10.diff)} [${f(k.mrr10.ci95[0])}, ${f(k.mrr10.ci95[1])}] | ${k.hit5McNemar ? f(k.hit5McNemar.p, 4) : "—"} |`);
}
lines.push("", `## keypoints as queries (n=${kpTable.n})`, "");
lines.push("| condition | hit@1 | hit@5 | MRR@10 |", "|---|---|---|---|");
for (const c of ["correct", "mismatch", "bm25"]) lines.push(`| ${c} | ${f(kpTable[c].hit1)} | ${f(kpTable[c].hit5)} | ${f(kpTable[c].mrr10)} |`);
lines.push("", `McNemar hit@5 correct vs mismatch p=${f(kpTable.hit5McNemarCorrectVsMismatch.p, 4)}; correct vs bm25 p=${f(kpTable.hit5McNemarCorrectVsBm25.p, 4)}`, "");
lines.push("## cost", "");
lines.push(`vector on the wire ${cost.vectorBytes} B; delta vs previous task ${f(cost.deltaPrevBytesMean, 0)} B; query text ${f(cost.queryTextBytesMean, 0)} B; top-5 chunk text (what a text handoff of the evidence would carry) ${f(cost.top5ChunkTextBytesMean, 0)} B.`);
lines.push(`embed (uncached) ${f(cost.embedMsMean, 1)} ms — the call a state receiver skips; cached ${f(cost.embedCachedMsMean, 2)} ms; cosine rank over the corpus ${f(cost.rankMsMean, 2)} ms.`);
fs.writeFileSync(path.join(expDir, "report.md"), `${lines.join("\n")}\n`);
fs.rmSync(sourceDir, { force: true, recursive: true });
log(`done → ${expDir}`);
console.log(lines.join("\n"));
