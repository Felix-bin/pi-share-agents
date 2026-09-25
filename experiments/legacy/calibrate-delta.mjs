#!/usr/bin/env node
/**
 * Delta parameter calibration (task card P4-2).
 *
 * Scans (grid, threshold) against a recorded pair set and judges each
 * combination by retrieval consistency, not by cosine: a combination is
 * consistent for a pair when the vector recovered from the residual ranks the
 * pinned corpus exactly as the true query vector does. Cosine is only the
 * codec's internal stop condition; what the system promises is that a child
 * retrieves what the parent meant, so that is what gets measured.
 *
 * Two baselines travel with every row. `quantize` is the same grid with no
 * residual loss at all — the ceiling that threshold can never cross — so a row
 * whose ceiling is below 100% is reporting a grid that is too coarse, not a
 * threshold that is too strict. `similarity` bands the pairs by cosine(Y, B),
 * because a residual's payload depends on how close the base is and a single
 * mean would hide which regime the numbers came from.
 *
 * The ranking is `rankCorpusChunks`, the production one. Re-implementing it
 * here would have measured a retrieval the system never runs.
 *
 * Deterministic: same recording in, same report out — no clock, no randomness,
 * and every ordering comes from the input or from a total order on ids.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { cosineInt, dequantize, decodeDelta, encodeDelta, quantize } from "../../src/synapse/delta.ts";
import { loadCorpusVectors, rankCorpusChunks } from "../../src/synapse/state-retrieval.ts";

const FLAGS_WITH_VALUE = new Set(["--consistency-tolerance", "--grids", "--k", "--out", "--pairs", "--similarity-bands", "--storage-root", "--thresholds"]);
const ARGS = process.argv.slice(2);

function usageAndExit(message) {
	console.error(message);
	console.error("usage: node experiments/legacy/calibrate-delta.mjs --pairs <recording.jsonl> --storage-root <dir> --out <report.json>");
	console.error("       [--k 5] [--grids 32,64,96,127,256] [--thresholds 0.90,0.93,0.95,0.97,0.99]");
	process.exit(2);
}

const seenValueFlags = new Set();
for (let index = 0; index < ARGS.length; index += 1) {
	const token = ARGS[index];
	if (token === undefined || !token.startsWith("--")) continue;
	if (FLAGS_WITH_VALUE.has(token)) {
		if (seenValueFlags.has(token)) usageAndExit(`duplicate flag: ${token}`);
		seenValueFlags.add(token);
		index += 1;
		continue;
	}
	usageAndExit(`unknown flag: ${token}`);
}

function takeValue(flag) {
	const index = ARGS.indexOf(flag);
	if (index === -1) return undefined;
	const value = ARGS[index + 1];
	if (value === undefined || value.startsWith("--")) usageAndExit(`missing value for ${flag}`);
	return value;
}

function requireValue(flag) {
	const value = takeValue(flag);
	if (value === undefined) usageAndExit(`${flag} is required`);
	return value;
}

function numberList(flag, fallback) {
	const raw = takeValue(flag);
	if (raw === undefined) return fallback;
	const values = raw.split(",").map((item) => Number(item.trim()));
	if (values.some((value) => !Number.isFinite(value))) usageAndExit(`${flag} must be a comma-separated list of numbers`);
	return values;
}

const pairsPath = requireValue("--pairs");
const storageRoot = requireValue("--storage-root");
const outPath = requireValue("--out");
const k = Number(takeValue("--k") ?? 5);
const grids = numberList("--grids", [32, 64, 96, 127, 256]);
const thresholds = numberList("--thresholds", [0.9, 0.93, 0.95, 0.97, 0.99]);
const bands = numberList("--similarity-bands", [0.5, 0.8, 0.9, 0.95]);
const consistencyTolerance = Number(takeValue("--consistency-tolerance") ?? 0.02);

if (!Number.isInteger(k) || k < 1) usageAndExit(`--k must be a positive integer, got ${k}`);
// A threshold at or below zero stops the encoder at once and a threshold above one
// never stops it: both are outside the codec's contract and would silently produce
// a full-length or empty payload to calibrate against.
if (thresholds.some((value) => !(value > 0 && value <= 1))) usageAndExit(`--thresholds must hold values in (0, 1], got ${JSON.stringify(thresholds)}`);
for (const grid of grids) {
	if (!Number.isInteger(grid) || grid < 1) usageAndExit(`--grids must hold positive integers, got ${grid}`);
	// The wide layout carries a signed 16-bit value, so a residual of 2 * grid must
	// fit or the encoder clamps silently and the row measures a different codec.
	if (grid > 16383) usageAndExit(`--grids value ${grid} exceeds 16383: residuals up to 2 * grid would not fit the int16 value field`);
}

/** The widest residual an int8 component can carry; above it the layout must widen too. */
const INT8_MAX = 127;
const INT16_MAX = 32767;

function vectorFromBase64(text, label) {
	const bytes = Buffer.from(text, "base64");
	if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
		throw new Error(`${label} holds ${bytes.byteLength} bytes, not a whole number of float32 values`);
	}
	return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * The candidate int16 layout: same algorithm as `encodeDelta`, widened so a
 * grid above 127 can be scanned at all. It stays in this script until the
 * calibration says whether any run needs it — shipping a second layout in
 * delta.ts before the scan would fix a format the numbers have not chosen.
 */
function encodeWide(target, base, grid, threshold) {
	const residual = new Int32Array(target.length);
	for (let index = 0; index < target.length; index += 1) residual[index] = target[index] - base[index];
	const order = Array.from(residual.keys()).sort((left, right) => Math.abs(residual[right]) - Math.abs(residual[left]));
	const reconstruction = Int32Array.from(base);
	const parts = [];
	let nnz = 0;
	for (const index of order) {
		const delta = residual[index];
		if (delta === 0) break;
		if (cosineInt(reconstruction, target) >= threshold) break;
		const value = Math.max(-INT16_MAX, Math.min(INT16_MAX, delta));
		reconstruction[index] = base[index] + value;
		parts.push(index & 0xff, (index >> 8) & 0xff, value & 0xff, (value >> 8) & 0xff);
		nnz += 1;
	}
	return { nnz, payload: Uint8Array.from(parts) };
}

function decodeWide(payload, base) {
	if (payload.byteLength % 4 !== 0) throw new Error(`wide payload holds ${payload.byteLength} bytes, not a multiple of 4`);
	const reconstruction = Int32Array.from(base);
	for (let offset = 0; offset < payload.byteLength; offset += 4) {
		const index = payload[offset] | (payload[offset + 1] << 8);
		if (index >= base.length) throw new Error(`wide payload names index ${index} beyond base dim ${base.length}`);
		const low = payload[offset + 2];
		const high = payload[offset + 3];
		const value = (high << 8) | low;
		reconstruction[index] = base[index] + (value >= 0x8000 ? value - 0x10000 : value);
	}
	return reconstruction;
}

function average(values) {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted, fraction) {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

/** Same chunks, order set aside: the weaker reading of a matching top-k. */
function sameSet(left, right) {
	if (left.length !== right.length) return false;
	const remaining = new Map();
	for (const chunkId of right) remaining.set(chunkId, (remaining.get(chunkId) ?? 0) + 1);
	for (const chunkId of left) {
		const count = remaining.get(chunkId) ?? 0;
		if (count === 0) return false;
		remaining.set(chunkId, count - 1);
	}
	return true;
}

/**
 * One bit per pair, packed little-endian and base64'd into the report. Two
 * combinations a percentage point apart on 239 pairs are not distinguishable by
 * their totals alone, so the rows carry the raw outcomes and any claim about
 * which points really differ can be recomputed from the shipped report instead
 * of being taken on trust.
 */
function packOutcomes(flags) {
	const bytes = new Uint8Array(Math.ceil(flags.length / 8));
	flags.forEach((flag, index) => {
		if (flag) bytes[index >> 3] |= 1 << (index & 7);
	});
	return Buffer.from(bytes).toString("base64");
}

function unpackOutcome(bytes, index) {
	return (bytes[index >> 3] & (1 << (index & 7))) !== 0;
}

const lines = fs.readFileSync(pairsPath, "utf-8").split("\n").filter((line) => line.trim().length > 0);
const headerLine = lines.find((line) => line.includes('"kind":"header"'));
if (headerLine === undefined) throw new Error(`${pairsPath} has no header line; it is not a recording from record-delta-pairs.mjs`);
// SAFETY: the header is written by record-delta-pairs.mjs from a literal object; a missing field is caught by the checks below.
const header = JSON.parse(headerLine);
for (const field of ["corpusSnapshotId", "dim", "representationId"]) {
	if (header[field] === undefined) throw new Error(`recording header has no ${field}`);
}

const rounds = [];
const seenRoundIds = new Set();
for (const line of lines) {
	if (line === headerLine) continue;
	// SAFETY: round lines come from record-delta-pairs.mjs, which writes them from a literal object.
	const parsed = JSON.parse(line);
	if (parsed.roundId === undefined) throw new Error(`${pairsPath} holds a line without a roundId`);
	// A round id keys the reference ranking, so a repeat would silently overwrite
	// one answer with another. Two recordings can legitimately share ids — the
	// follow-up and progression registers both open a chunk with `-a` — and a
	// concatenated file would then measure pairs against the wrong reference.
	if (seenRoundIds.has(parsed.roundId)) throw new Error(`${pairsPath} repeats round id ${parsed.roundId}; recordings of different registers must be calibrated separately`);
	seenRoundIds.add(parsed.roundId);
	// The header is a claim about the file; each row is checked against it rather
	// than trusted, so a mixed file cannot pass as a homogeneous one.
	for (const field of ["corpusSnapshotId", "representationId"]) {
		if (parsed[field] !== header[field]) {
			throw new Error(`round ${parsed.roundId} declares ${field} ${JSON.stringify(parsed[field])}, the header says ${JSON.stringify(header[field])}`);
		}
	}
	rounds.push(parsed);
}
const pairs = rounds.filter((round) => round.baseVector !== null && round.baseVector !== undefined);
if (pairs.length === 0) throw new Error(`${pairsPath} holds no round with a base vector; there is nothing to encode against`);

const corpus = loadCorpusVectors(storageRoot, header.corpusSnapshotId, header.dim, header.representationId);
if (corpus.chunkIds.length === 0) throw new Error(`corpus ${header.corpusSnapshotId} holds no chunks`);

/** Every pair, with both vectors decoded once. */
const prepared = pairs.map((round) => {
	const y = vectorFromBase64(round.queryVector, `round ${round.roundId} queryVector`);
	const b = vectorFromBase64(round.baseVector, `round ${round.roundId} baseVector`);
	if (y.length !== header.dim || b.length !== header.dim) {
		throw new Error(`round ${round.roundId} holds vectors of ${y.length}/${b.length} floats, the header declares dim ${header.dim}`);
	}
	let dot = 0;
	let yNorm = 0;
	let bNorm = 0;
	for (let index = 0; index < y.length; index += 1) {
		dot += y[index] * b[index];
		yNorm += y[index] * y[index];
		bNorm += b[index] * b[index];
	}
	const similarity = dot / (Math.sqrt(yNorm) * Math.sqrt(bNorm));
	return { b, roundId: round.roundId, similarity, y };
});

const referenceHits = new Map();
const rankMargins = [];
for (const pair of prepared) {
	const ranked = rankCorpusChunks(corpus, pair.y, k + 1);
	referenceHits.set(pair.roundId, ranked.slice(0, k).map((hit) => hit.chunkId));
	// The gap between the last kept rank and the first dropped one. A corpus of
	// near-duplicate chunks separates them by far less than any lossy codec
	// perturbs the query, which is why an exact ordered top-k is a much harder
	// bar here than in a corpus of distinct documents.
	const kept = ranked[k - 1];
	const dropped = ranked[k];
	if (kept !== undefined && dropped !== undefined) rankMargins.push(kept.cosine - dropped.cosine);
}
const sortedMargins = [...rankMargins].sort((left, right) => left - right);

const rows = [];
for (const threshold of thresholds) {
	for (const grid of grids) {
		const wide = grid > INT8_MAX;
		if (wide && grid > INT16_MAX) throw new Error(`grid ${grid} exceeds the widest component this scan can carry (${INT16_MAX})`);
		const quantizedY = prepared.map((pair) => quantize(pair.y, grid));
		const quantizedB = prepared.map((pair) => quantize(pair.b, grid));
		const payloadBytes = [];
		const nnzValues = [];
		const outcomes = [];
		let consistent = 0;
		let setConsistent = 0;
		let top1Consistent = 0;
		let quantizeOnlyConsistent = 0;
		for (let index = 0; index < prepared.length; index += 1) {
			const target = quantizedY[index];
			const base = quantizedB[index];
			const encoding = wide ? encodeWide(target, base, grid, threshold) : encodeDelta(target, base, { grid, threshold });
			const decoded = wide ? decodeWide(encoding.payload, base) : decodeDelta(encoding.payload, base);
			payloadBytes.push(encoding.payload.byteLength);
			nnzValues.push(encoding.nnz);
			const recovered = rankCorpusChunks(corpus, dequantize(decoded, grid), k).map((hit) => hit.chunkId);
			const ceiling = rankCorpusChunks(corpus, dequantize(target, grid), k).map((hit) => hit.chunkId);
			const reference = referenceHits.get(prepared[index].roundId);
			const exact = recovered.every((chunkId, position) => chunkId === reference[position]);
			outcomes.push(exact);
			if (exact) consistent += 1;
			// Order is the strict reading of "same top-k"; the set is reported next to
			// it so a reader can see whether a miss is a swap or a genuinely different
			// result rather than having to guess which one the number meant.
			if (sameSet(recovered, reference)) setConsistent += 1;
			// Top-1 is the value the pipeline is actually judged on downstream — a
			// handoff that lands a different first hit has changed the child's answer
			// even when the rest of the list survived.
			if (recovered[0] === reference[0]) top1Consistent += 1;
			if (ceiling.every((chunkId, position) => chunkId === reference[position])) quantizeOnlyConsistent += 1;
		}
		const sortedBytes = [...payloadBytes].sort((left, right) => left - right);
		const bandRows = [];
		for (let index = 0; index <= bands.length; index += 1) {
			const low = index === 0 ? -1 : bands[index - 1];
			const high = index === bands.length ? 2 : bands[index];
			const members = prepared.map((pair, position) => ({ pair, position })).filter(({ pair }) => pair.similarity >= low && pair.similarity < high);
			if (members.length === 0) continue;
			const perBand = members.map(({ position }) => position);
			bandRows.push({
				band: `[${low < 0 ? "-1" : low.toFixed(2)}, ${high > 1 ? "1" : high.toFixed(2)})`,
				meanPayloadBytes: Math.round(average(perBand.map((position) => payloadBytes[position])) * 100) / 100,
				pairs: members.length,
			});
		}
		rows.push({
			/**
			 * Per similarity band: how many pairs fell in it and what the mean payload
			 * cost there. Payload cost tracks base similarity, so a single overall mean
			 * would hide which regime the bytes came from.
			 */
			bands: bandRows,
			bytesPerComponent: wide ? 4 : 3,
			consistency: consistent / prepared.length,
			grid,
			layout: wide ? "int16" : "int8",
			maxPayloadBytes: sortedBytes[sortedBytes.length - 1] ?? 0,
			meanNnz: Math.round(average(nnzValues) * 100) / 100,
			meanPayloadBytes: Math.round(average(payloadBytes) * 100) / 100,
			outcomes: packOutcomes(outcomes),
			p95PayloadBytes: percentile(sortedBytes, 0.95),
			quantizeOnlyConsistency: quantizeOnlyConsistent / prepared.length,
			setConsistency: setConsistent / prepared.length,
			threshold,
			top1Consistency: top1Consistent / prepared.length,
		});
	}
}

const perfect = rows.filter((row) => row.consistency === 1);
const bestConsistency = Math.max(...rows.map((row) => row.consistency));
const selectionPool = perfect.length > 0 ? perfect : rows.filter((row) => row.consistency === bestConsistency);
selectionPool.sort((left, right) => (left.meanPayloadBytes !== right.meanPayloadBytes ? left.meanPayloadBytes - right.meanPayloadBytes : left.grid !== right.grid ? left.grid - right.grid : left.threshold - right.threshold));
const selected = selectionPool[0];

/**
 * The card's rule takes the highest consistency tier and the cheapest point in
 * it. On a 239-pair sample that tier is decided by a couple of pairs, so the
 * report also names the cheapest point within `--consistency-tolerance` of the
 * best and the exact pairs the two disagree on: a reader can then see whether
 * the extra bytes buy a real difference or a rounding artifact of the sample.
 */
function discordance(left, right) {
	const leftBytes = Buffer.from(left.outcomes, "base64");
	const rightBytes = Buffer.from(right.outcomes, "base64");
	let onlyLeft = 0;
	let onlyRight = 0;
	for (let index = 0; index < prepared.length; index += 1) {
		const inLeft = unpackOutcome(leftBytes, index);
		const inRight = unpackOutcome(rightBytes, index);
		if (inLeft && !inRight) onlyLeft += 1;
		if (inRight && !inLeft) onlyRight += 1;
	}
	return { onlyLeft, onlyRight };
}

const tolerancePool = rows.filter((row) => bestConsistency - row.consistency <= consistencyTolerance);
tolerancePool.sort((left, right) => (left.meanPayloadBytes !== right.meanPayloadBytes ? left.meanPayloadBytes - right.meanPayloadBytes : left.grid !== right.grid ? left.grid - right.grid : left.threshold - right.threshold));
const cheapestWithinTolerance = tolerancePool[0];
const gap = discordance(selected, cheapestWithinTolerance);

const report = {
	// The calibration set is reserved and must never appear in the formal G1 run:
	// these rounds exist so the parameters could be frozen without touching the
	// rounds the evaluation reports on.
	isolation: {
		declared: "reserved rounds; excluded from every formal G1/G2 statistic",
		roundIdCount: rounds.length,
		roundIdPrefix: "RESERVED-G1-",
		roundIdsSha256: createHash("sha256").update(rounds.map((round) => round.roundId).join("\n"), "utf-8").digest("hex"),
	},
	corpus: {
		chunkCount: corpus.chunkIds.length,
		corpusSnapshotId: header.corpusSnapshotId,
		dim: header.dim,
		overlapLines: header.overlapLines,
		representationId: header.representationId,
		sourceCommit: header.sourceCommit,
		windowLines: header.windowLines,
	},
	pairs: {
		coldStarts: rounds.length - pairs.length,
		count: pairs.length,
		rounds: rounds.length,
		similarity: {
			max: Math.max(...prepared.map((pair) => pair.similarity)),
			mean: average(prepared.map((pair) => pair.similarity)),
			min: Math.min(...prepared.map((pair) => pair.similarity)),
			under0_8: prepared.filter((pair) => pair.similarity < 0.8).length,
		},
		/** Cosine gap between the last kept and first dropped reference rank; small means the ordering is fragile to any perturbation. */
		rankMargin: {
			max: sortedMargins[sortedMargins.length - 1] ?? 0,
			mean: average(sortedMargins),
			median: percentile(sortedMargins, 0.5),
			p10: percentile(sortedMargins, 0.1),
		},
	},
	recording: {
		mode: header.mode ?? "unknown",
		path: path.basename(pairsPath),
		sha256: createHash("sha256").update(fs.readFileSync(pairsPath)).digest("hex"),
	},
	retrieval: { k },
	scan: rows,
	selection: {
		bytesPerPayloadComparison: "meanPayloadBytes",
		perfectCombinations: perfect.length,
		reason:
			perfect.length > 0
				? "the cheapest combination among those whose recovered top-k matched the true top-k on every pair"
				: `no combination reached full retrieval consistency; the highest observed was ${bestConsistency}, so the cheapest combination at that level is named and the benefit claim must be downgraded`,
		selected: { bytesPerComponent: selected.bytesPerComponent, grid: selected.grid, layout: selected.layout, threshold: selected.threshold },
		selectedMeanPayloadBytes: selected.meanPayloadBytes,
		selectedConsistency: selected.consistency,
		/**
		 * The cheapest point within the stated tolerance of the best consistency,
		 * and the exact pairs where it disagrees with the literal pick.
		 */
		withinTolerance: {
			consistencyTolerance,
			selected: { bytesPerComponent: cheapestWithinTolerance.bytesPerComponent, grid: cheapestWithinTolerance.grid, layout: cheapestWithinTolerance.layout, threshold: cheapestWithinTolerance.threshold },
			selectedConsistency: cheapestWithinTolerance.consistency,
			selectedMeanPayloadBytes: cheapestWithinTolerance.meanPayloadBytes,
			consistencyDifference: bestConsistency - cheapestWithinTolerance.consistency,
			pairsOnlyLiteralPickPasses: gap.onlyLeft,
			pairsOnlyWithinTolerancePickPasses: gap.onlyRight,
		},
	},
};

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

console.log(`pairs=${pairs.length} coldStarts=${rounds.length - pairs.length} mode=${header.mode ?? "unknown"} corpusChunks=${corpus.chunkIds.length} k=${k}`);
console.log("grid  layout threshold  ordered  top1   set  quantizeOnly  meanBytes  p95Bytes  meanNnz");
for (const row of rows) {
	console.log(
		`${String(row.grid).padStart(4)}  ${row.layout.padEnd(6)} ${row.threshold.toFixed(2).padStart(9)} ` +
			`${(row.consistency * 100).toFixed(1).padStart(7)}% ${(row.top1Consistency * 100).toFixed(1).padStart(5)}% ${(row.setConsistency * 100).toFixed(1).padStart(5)}% ` +
			`${(row.quantizeOnlyConsistency * 100).toFixed(1).padStart(11)}% ${String(row.meanPayloadBytes).padStart(10)} ${String(row.p95PayloadBytes).padStart(9)} ${String(row.meanNnz).padStart(8)}`,
	);
}
console.log(`selected: grid=${selected.grid} ${selected.layout} threshold=${selected.threshold} meanPayloadBytes=${selected.meanPayloadBytes} consistency=${selected.consistency}`);
console.log(`report written to ${outPath}`);
if (perfect.length === 0) console.log("WARNING: no combination reached 100% retrieval consistency; the benefit claim must be downgraded and the report must say so");
