// SHM E0a/E0b 驱动（spec: 2026-09-30-shm-e0-design.md，判定规则已冻结）。
//
// 纪律（继承 sweqa/bench 两代装置）：
//  - manifest 存在即拒绝重启（换 id 重跑，绝不原地续）；--resume 只补缺失单元
//  - 一切身份哈希入 manifest：代码 sha+dirty、matrix/runner 自身、语料三件文件
//  - 有效性：任一加载抛错该单元 invalid（不按 0 计），原因随 rounds 记录
//  - 秘密零涉及：E0a/E0b 全程无 API 调用（零成本）
//
// 用法（在仓库根、openEuler 上）：
//   node --experimental-strip-types experiments/openeuler/shm/run.mjs --exp-dir <dir> [--corpus-root <dir>]

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
	BOOTSTRAP_B, BOOTSTRAP_SEED, CORPUS_DIM, CORPUS_REPRESENTATION, CORPUS_SNAPSHOT, E0A_PAIRS, E0A_SUBSET_SIZES, E0B_K, E0B_QUERIES, E0B_ROUNDS, SHM_NAMESPACE, sha256,
} from "./matrix.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const args = parseArgs(process.argv.slice(2));
const expDir = path.resolve(args["exp-dir"] ?? "");
const corpusRoot = path.resolve(args["corpus-root"] ?? "/root/.pi/agent/synapse/experiments/_corpus-cache");
const sourceCorpusDir = path.join(corpusRoot, "corpus", CORPUS_SNAPSHOT);

// --- gates -----------------------------------------------------------------

if (!fs.existsSync(sourceCorpusDir)) fail(`corpus snapshot ${CORPUS_SNAPSHOT} not found under ${corpusRoot}; pass --corpus-root`);
for (const file of ["meta.json", "vectors.f32", "chunks.json"]) {
	if (!fs.existsSync(path.join(sourceCorpusDir, file))) fail(`corpus is missing ${file}`);
}

const [{ createPosixShmBindings }, matrixSource] = await Promise.all([
	import("../../../src/synapse/shm-bindings.ts"),
	fs.promises.readFile(path.join(here, "matrix.mjs"), "utf-8"),
]);
const bindings = createPosixShmBindings();
if (bindings === null) fail("POSIX shm bindings unavailable (need Linux + koffi); E0 must run on kernel shm, refusing the in-memory fake");

// Self-contained run: drop this namespace's leftover segments (ours by prefix),
// so every number below is produced by this run's own publish, not a survivor.
for (const name of bindings.listOwnSegments()) {
	if (name === `/synapse-${SHM_NAMESPACE}-g0`) bindings.unlink(name);
}

if (fs.existsSync(path.join(expDir, "manifest.json"))) fail("manifest already exists — an experiment is never restarted in place; use a new --exp-dir");
fs.mkdirSync(expDir, { recursive: true });

// --- manifest ---------------------------------------------------------------

const manifest = {
	code: gitIdentity(),
	corpus: corpusIdentity(),
	environment: {
		koffi: koffiVersion(),
		node: process.version,
		platform: `${process.platform} ${process.arch}`,
		uname: uname(),
	},
	kind: "shm-e0",
	matrixSha256: sha256(Buffer.from(matrixSource, "utf-8")),
	runnerSha256: sha256(await fs.promises.readFile(new URL(import.meta.url))),
	shm: { namespace: SHM_NAMESPACE, segmentProvider: "posix-shm_open+mmap" },
	stats: { bootstrapB: BOOTSTRAP_B, bootstrapSeed: BOOTSTRAP_SEED, e0aPairs: E0A_PAIRS, e0aSubsets: E0A_SUBSET_SIZES, e0bK: E0B_K, e0bQueries: E0B_QUERIES, e0bRounds: E0B_ROUNDS },
	startedAt: new Date().toISOString(),
	validity: "a pair is valid only if both loads returned; an error marks the unit invalid (never 0); hits must match the file baseline byte-for-byte or the round is a defect",
};
fs.writeFileSync(path.join(expDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const evidenceDir = path.join(expDir, "evidence");
fs.mkdirSync(evidenceDir, { recursive: true });

// --- E0a: micro-benchmark ----------------------------------------------------

const subsetsDir = path.join(expDir, "work", "subsets");
fs.mkdirSync(subsetsDir, { recursive: true });
const { loadCorpusVectors } = await import("../../../src/synapse/state-retrieval.ts");
const { createShmCorpusPlane } = await import("../../../src/synapse/shm-corpus-plane.ts");

for (const size of E0A_SUBSET_SIZES) {
	const subset = buildSubset(sourceCorpusDir, path.join(subsetsDir, String(size)), size);
	const plane = createShmCorpusPlane({ bindings, namespaceId16: SHM_NAMESPACE });
	const published = plane.publishCorpus(subset.storageRoot, subset.snapshotId);
	if (!published.published) fail(`E0a subset ${size}: publish failed: ${published.reason}`);

	const e0aPath = path.join(expDir, `e0a-${size}.jsonl`);
	const out = fs.createWriteStream(e0aPath, { flags: "a" });
	let invalid = 0;
	for (let pair = 0; pair < E0A_PAIRS; pair++) {
		// Order alternates so drift within the run cannot favour either arm.
		const fileFirst = pair % 2 === 0;
		const sample = (arm) => {
			const t0 = process.hrtime.bigint();
			if (arm === "file") loadCorpusVectors(subset.storageRoot, subset.snapshotId, CORPUS_DIM, CORPUS_REPRESENTATION);
			else plane.loadCorpusVectors(subset.snapshotId, CORPUS_DIM, CORPUS_REPRESENTATION);
			return Number(process.hrtime.bigint() - t0) / 1e6;
		};
		try {
			const first = sample(fileFirst ? "file" : "shm");
			const second = sample(fileFirst ? "shm" : "file");
			const fileMs = fileFirst ? first : second;
			const shmMs = fileFirst ? second : first;
			out.write(`${JSON.stringify({ chunkCount: size, fileMs: +fileMs.toFixed(4), pair, shmBytes: 0, shmMs: +shmMs.toFixed(4), subset: size, unit: "e0a", valid: true, fileBytes: subset.bytes })}\n`);
		} catch (error) {
			invalid += 1;
			out.write(`${JSON.stringify({ chunkCount: size, error: String(error), pair, subset: size, unit: "e0a", valid: false })}\n`);
		}
	}
	out.end();
	const stats = plane.stats();
	fs.writeFileSync(path.join(evidenceDir, `e0a-${size}-plane-stats.json`), `${JSON.stringify({ ...stats, invalid }, null, 2)}\n`);
	plane.close();
}

// --- E0b: cross-process chain metering ---------------------------------------

const workStorage = path.join(expDir, "work", "e0b-storage");
fs.mkdirSync(path.join(workStorage, "corpus", CORPUS_SNAPSHOT), { recursive: true });
for (const file of ["meta.json", "vectors.f32", "chunks.json"]) {
	fs.copyFileSync(path.join(sourceCorpusDir, file), path.join(workStorage, "corpus", CORPUS_SNAPSHOT, file));
}

// Five real query vectors lifted from the corpus (P3-4 fixture pattern).
const vectorsBytes = fs.readFileSync(path.join(sourceCorpusDir, "vectors.f32"));
const queries = [];
for (let q = 0; q < E0B_QUERIES; q++) {
	const buffer = Buffer.alloc(CORPUS_DIM * 4);
	vectorsBytes.copy(buffer, 0, q * CORPUS_DIM * 4 * 37, q * CORPUS_DIM * 4 * 37 + CORPUS_DIM * 4);
	queries.push(buffer.toString("base64"));
}
const queriesPath = path.join(expDir, "work", "e0b-queries.json");
fs.writeFileSync(queriesPath, JSON.stringify({ dim: CORPUS_DIM, k: E0B_K, queries, representation: CORPUS_REPRESENTATION, snapshot: CORPUS_SNAPSHOT }));

// Baseline: the file arm in this process, ledgered, defines the pinned ranking.
const fileLedger = path.join(evidenceDir, "e0b-file-baseline.jsonl");
const baseline = execFileSync(
	process.execPath,
	["--experimental-strip-types", path.join(here, "probe-consume.mjs"), "--arm", "file", "--storage-root", workStorage, "--queries", queriesPath, "--ledger", fileLedger, "--namespace", SHM_NAMESPACE],
	{ encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] },
);
const baselineHits = JSON.parse(baseline).hits;

const e0bPath = path.join(expDir, "e0b.jsonl");
const e0bOut = fs.createWriteStream(e0bPath, { flags: "a" });
for (let round = 1; round <= E0B_ROUNDS; round++) {
	// Every round is a brand-new process: the cross-run residency the segment
	// exists for. The writer (this process) published nothing — round 0 below
	// is the cold publish, exactly one per run.
	if (round === 1) {
		const writerPlane = createShmCorpusPlane({ bindings, namespaceId16: SHM_NAMESPACE });
		const published = writerPlane.publishCorpus(workStorage, CORPUS_SNAPSHOT);
		if (!published.published) fail(`E0b publish failed: ${published.reason}`);
		writerPlane.close();
	}
	const ledger = path.join(evidenceDir, `e0b-shm-r${round}.jsonl`);
	let result;
	try {
		result = JSON.parse(
			execFileSync(
				process.execPath,
				["--experimental-strip-types", path.join(here, "probe-consume.mjs"), "--arm", "shm", "--storage-root", workStorage, "--queries", queriesPath, "--ledger", ledger, "--namespace", SHM_NAMESPACE],
				{ encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] },
			),
		);
	} catch (error) {
		e0bOut.write(`${JSON.stringify({ error: String(error), round, unit: "e0b", valid: false })}\n`);
		continue;
	}
	const hitsMatch = JSON.stringify(result.hits) === JSON.stringify(baselineHits);
	e0bOut.write(
		`${JSON.stringify({ corpusLoads: result.corpusLoads, hitsMatch, round, shmAttaches: result.shmAttaches, shmHits: result.shmHits, unit: "e0b", valid: hitsMatch && result.corpusLoads === 0, wallMs: result.wallMs })}\n`,
	);
}
e0bOut.end();

manifest.completedAt = new Date().toISOString();
fs.writeFileSync(path.join(expDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ expDir, ok: true }));

// --- helpers -----------------------------------------------------------------

function fail(message) {
	console.error(String(message));
	process.exit(1);
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i]?.replace(/^--/, "");
		if (key === undefined) fail("odd argument list");
		out[key] = argv[i + 1];
	}
	return out;
}

function gitIdentity() {
	const run = (cmd) => {
		try {
			return execFileSync("git", cmd, { cwd: repoRoot, encoding: "utf-8" }).trim();
		} catch {
			return null;
		}
	};
	const sha = run(["rev-parse", "HEAD"]);
	if (sha === null) return { repo: repoRoot, sha: null, dirty: ["no-git"] };
	const dirty = run(["status", "--porcelain"]).split("\n").map((line) => line.trim()).filter(Boolean);
	if (dirty.length > 0) fail(`dirty tree refused for a frozen run:\n${dirty.join("\n")}`);
	return { repo: "pi-share-agents", sha, dirty: [] };
}

function corpusIdentity() {
	const files = {};
	for (const file of ["meta.json", "vectors.f32", "chunks.json"]) {
		files[file] = sha256(fs.readFileSync(path.join(sourceCorpusDir, file)));
	}
	return { files, snapshotId: CORPUS_SNAPSHOT };
}

function koffiVersion() {
	try {
		const pkg = createRequire(import.meta.url)("koffi/package.json");
		return pkg.version;
	} catch {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "node_modules", "koffi", "package.json"), "utf-8"));
			return pkg.version;
		} catch {
			return "unknown";
		}
	}
}

function uname() {
	try {
		return execFileSync("uname", ["-a"], { encoding: "utf-8" }).trim();
	} catch {
		return "n/a";
	}
}

/** Builds a legal 64-hex snapshot holding the first `size` chunks, digests recomputed. */
function buildSubset(sourceDir, outDir, size) {
	const meta = JSON.parse(fs.readFileSync(path.join(sourceDir, "meta.json"), "utf-8"));
	const chunks = JSON.parse(fs.readFileSync(path.join(sourceDir, "chunks.json"), "utf-8"));
	if (size > chunks.length) fail(`subset ${size} exceeds corpus (${chunks.length} chunks)`);
	const subChunks = chunks.slice(0, size);
	const subVectors = fs.readFileSync(path.join(sourceDir, "vectors.f32")).subarray(0, size * meta.dim * 4);
	const chunksJson = Buffer.from(JSON.stringify(subChunks), "utf-8");
	const snapshotId = sha256(Buffer.from(`${CORPUS_SNAPSHOT}:subset:${size}`));
	const storageRoot = path.join(outDir, "storage");
	const corpusDir = path.join(storageRoot, "corpus", snapshotId);
	fs.mkdirSync(corpusDir, { recursive: true });
	const subMeta = { ...meta, chunkCount: size, chunksSha256: sha256(chunksJson), corpusSnapshotId: snapshotId, vectorsSha256: sha256(subVectors) };
	fs.writeFileSync(path.join(corpusDir, "meta.json"), `${JSON.stringify(subMeta, null, 2)}\n`);
	fs.writeFileSync(path.join(corpusDir, "chunks.json"), chunksJson);
	fs.writeFileSync(path.join(corpusDir, "vectors.f32"), subVectors);
	// Verify the subset loads through the production file path before any timing.
	loadCorpusVectors(storageRoot, snapshotId, meta.dim, meta.representationId);
	return { bytes: subVectors.byteLength + chunksJson.byteLength + Buffer.byteLength(JSON.stringify(subMeta)), chunkCount: size, snapshotId, storageRoot };
}
