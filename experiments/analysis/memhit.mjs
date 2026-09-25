#!/usr/bin/env node
/**
 * memhit: offline scoring of shared-memory reuse in a synapse-bench run,
 * against gold that was fixed before the run (no LLM).
 *
 *   node experiments/analysis/memhit.mjs <benchExpDir> [--out <dir>]
 *
 * Inputs (read-only): the bench manifest, rounds.jsonl (runIds per round), and
 * each arm's store (memory/*.json records, metering/<runId>.jsonl).
 *
 * Every memory record is placed at its ORIGIN round (provenance.runId ∈ that
 * round's runIds). Every memory-reuse event (a record handed to a child) is
 * placed at its CONSUMER round (the ledger file's runId). Each reuse is then
 * classified:
 *   intra-round   origin = consumer round (roles sharing inside one pipeline)
 *   dep           origin round ∈ the consumer task's dependsOn (the gold link)
 *   chain         origin is an earlier round of the same group, not in dependsOn
 *   cross-group   origin is in the other group
 * and, independently, as anchor-relevant when the record's source.path is one
 * of the consumer task's anchors or its dependsOn tasks' anchors.
 *
 * Per round: queries, queries with ≥1 authorised valid hit (retrieval-hit
 * rate), distinct records reused by class, dep-recall (share of the dependsOn
 * rounds' records that were reused at least once), anchor precision.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const args = process.argv.slice(2);
const opt = (flag, fallback) => {
	const at = args.indexOf(flag);
	return at === -1 ? fallback : args[at + 1];
};
const benchDir = path.resolve(args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--"))) ?? "");
const bench = JSON.parse(fs.readFileSync(path.join(benchDir, "manifest.json"), "utf-8"));
const OUT_ROOT = path.resolve(opt("--out", path.join(os.homedir(), ".pi", "agent", "synapse", "experiments")));
const ID = `memhit-${bench.experimentId}`;
const outDir = path.join(OUT_ROOT, ID);
fs.mkdirSync(outDir, { recursive: true });
const writeJson = (f, v) => fs.writeFileSync(f, `${JSON.stringify(v, null, "\t")}\n`);
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Experiments recorded before the move to experiments/ name their families under scripts/synapse-bench/.
const familyPath = (file) => path.join(REPO, fs.existsSync(path.join(REPO, file)) ? file : file.replace(/^scripts\/synapse-bench\//, "experiments/bench/"));
const families = Object.fromEntries(bench.groups.map((g) => [g.group, JSON.parse(fs.readFileSync(familyPath(g.file), "utf-8"))]));
const taskOf = (group, round) => families[group].tasks.find((t) => t.index === round);
const groupOrder = bench.groups.map((g) => g.group);

const rounds = readJsonl(path.join(benchDir, "rounds.jsonl"));
// Last valid attempt per arm × group × round; every attempt's runIds still map
// (an invalid attempt's writes are real store contents the next round can see).
const roundOfRun = new Map();
for (const r of rounds) for (const id of r.runIds ?? []) roundOfRun.set(`${r.arm}|${id}`, { attempt: r.attempt, group: r.group, round: r.round, valid: r.valid });
const validRounds = new Map();
for (const r of rounds) if (r.valid) validRounds.set(`${r.arm}|${r.group}|${r.round}`, r);

const arms = [...new Set(rounds.map((r) => r.arm))].sort();
const perArm = {};
const series = {};
for (const arm of arms) {
	const cfg = bench.arms.find((a) => a.arm === arm)?.config?.synapse ?? {};
	const store = cfg.storageRoot && fs.existsSync(cfg.storageRoot) ? cfg.storageRoot : path.join(benchDir, `store-${arm}`);
	const records = new Map();
	// SYNCOLD moves each round's memory to _cold-archive/<label>/memory before the next attempt.
	const archiveRoot = path.join(store, "_cold-archive");
	const memDirs = [path.join(store, "memory"), ...(fs.existsSync(archiveRoot) ? fs.readdirSync(archiveRoot).sort().map((label) => path.join(archiveRoot, label, "memory")) : [])];
	for (const memDir of memDirs) if (fs.existsSync(memDir)) for (const f of fs.readdirSync(memDir)) if (f.endsWith(".json")) {
		const rec = JSON.parse(fs.readFileSync(path.join(memDir, f), "utf-8"));
		const origin = roundOfRun.get(`${arm}|${rec.provenance?.runId}`) ?? null;
		records.set(rec.memoryId, { agent: rec.provenance?.agent ?? null, embedded: Boolean(rec.embedding), kind: rec.kind, origin, sourcePath: rec.source?.path ?? null, topic: rec.taskTopic });
	}
	const recordsByOrigin = new Map();
	for (const [id, rec] of records) if (rec.origin) {
		const k = `${rec.origin.group}|${rec.origin.round}`;
		if (!recordsByOrigin.has(k)) recordsByOrigin.set(k, []);
		recordsByOrigin.get(k).push(id);
	}
	const rows = [];
	for (const group of groupOrder) for (let round = 1; round <= (bench.rounds ?? 10); round += 1) {
		const r = validRounds.get(`${arm}|${group}|${round}`);
		if (!r) {
			rows.push({ group, round, valid: false });
			continue;
		}
		const task = taskOf(group, round);
		const deps = task.dependsOn ?? [];
		const relevantAnchors = new Set([...task.anchors, ...deps.flatMap((d) => taskOf(group, d).anchors)]);
		let queries = 0;
		let queriesWithHit = 0;
		const reused = new Map();
		for (const runId of r.runIds ?? []) for (const e of readJsonl(path.join(store, "metering", `${runId}.jsonl`))) {
			if (e.kind === "memory-query") {
				queries += 1;
				if ((e.authorisedValidHits ?? 0) > 0) queriesWithHit += 1;
			} else if (e.kind === "memory-reuse" && typeof e.memoryId === "string") reused.set(e.memoryId, (reused.get(e.memoryId) ?? 0) + 1);
		}
		const cls = { chain: 0, "cross-group": 0, dep: 0, "intra-round": 0, unknown: 0 };
		let anchorRelevant = 0;
		for (const id of reused.keys()) {
			const rec = records.get(id);
			if (!rec?.origin) {
				cls.unknown += 1;
				continue;
			}
			const o = rec.origin;
			if (o.group !== group) cls["cross-group"] += 1;
			else if (o.round === round) cls["intra-round"] += 1;
			else if (deps.includes(o.round)) cls.dep += 1;
			else cls.chain += 1;
			if (rec.sourcePath && relevantAnchors.has(rec.sourcePath)) anchorRelevant += 1;
		}
		const depPool = deps.flatMap((d) => recordsByOrigin.get(`${group}|${d}`) ?? []);
		const crossRound = cls.dep + cls.chain + cls["cross-group"];
		rows.push({
			anchorPrecision: reused.size ? anchorRelevant / reused.size : null,
			classes: cls,
			crossRoundReused: crossRound,
			depPool: depPool.length,
			depRecall: depPool.length ? depPool.filter((id) => reused.has(id)).length / depPool.length : null,
			group,
			queries,
			queriesWithHit,
			retrievalHitRate: queries ? queriesWithHit / queries : null,
			reusedDistinct: reused.size,
			round,
			valid: true,
			written: (recordsByOrigin.get(`${group}|${round}`) ?? []).length,
		});
	}
	const valid = rows.filter((x) => x.valid);
	const later = valid.filter((x) => x.round > 1);
	perArm[arm] = {
		crossGroupShare: (() => {
			const g2 = valid.filter((x) => x.group !== groupOrder[0]);
			const tot = g2.reduce((a, x) => a + x.crossRoundReused, 0);
			return tot ? g2.reduce((a, x) => a + x.classes["cross-group"], 0) / tot : null;
		})(),
		depRecallMean: mean(later.map((x) => x.depRecall).filter((x) => x !== null)),
		anchorPrecisionMean: mean(valid.map((x) => x.anchorPrecision).filter((x) => x !== null)),
		records: records.size,
		recordsEmbedded: [...records.values()].filter((x) => x.embedded).length,
		retrievalHitRate: (() => {
			const q = valid.reduce((a, x) => a + x.queries, 0);
			return q ? valid.reduce((a, x) => a + x.queriesWithHit, 0) / q : null;
		})(),
		roundsWithCrossRoundReuse: later.length ? later.filter((x) => x.crossRoundReused > 0).length / later.length : null,
		validRounds: valid.length,
	};
	series[arm] = {};
	for (const group of groupOrder) series[arm][group] = rows.filter((x) => x.group === group).map((x) => (x.valid ? { anchorPrecision: x.anchorPrecision, crossRoundReused: x.crossRoundReused, depRecall: x.depRecall, retrievalHitRate: x.retrievalHitRate, reusedDistinct: x.reusedDistinct, round: x.round, written: x.written } : { round: x.round, valid: false }));
	fs.writeFileSync(path.join(outDir, `rounds-${arm}.jsonl`), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
}

writeJson(path.join(outDir, "manifest.json"), { benchDir, benchExperimentId: bench.experimentId, createdAt: new Date().toISOString(), experimentId: ID, kind: "memhit", llm: "none", model: bench.model ?? null });
writeJson(path.join(outDir, "summary.json"), { arms, groups: groupOrder, perArm, series });
const f = (x) => (x === null || x === undefined ? "n/a" : typeof x === "number" ? x.toFixed(3) : String(x));
const lines = [`# memhit — ${bench.experimentId}`, "", "| arm | valid rounds | records (embedded) | retrieval hit rate | rounds≥2 with cross-round reuse | dep recall | anchor precision | cross-group share (G2) |", "|---|---|---|---|---|---|---|---|"];
for (const a of arms) {
	const p = perArm[a];
	lines.push(`| ${a} | ${p.validRounds} | ${p.records} (${p.recordsEmbedded}) | ${f(p.retrievalHitRate)} | ${f(p.roundsWithCrossRoundReuse)} | ${f(p.depRecallMean)} | ${f(p.anchorPrecisionMean)} | ${f(p.crossGroupShare)} |`);
}
fs.writeFileSync(path.join(outDir, "report.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
