import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { canonicalDigest } from "../../src/synapse/canonical-json.ts";
import {
	buildCorpus,
	chunkCorpusFile,
	chunkCorpusFiles,
	corpusSnapshotIdOf,
	SYNAPSE_CORPUS_DEFAULT_ALLOWLIST,
	SYNAPSE_CORPUS_DEFAULT_OVERLAP_LINES,
	SYNAPSE_CORPUS_DEFAULT_WINDOW_LINES,
	SYNAPSE_CORPUS_MAX_WHOLE_FILE_BYTES,
	scanCorpusDirectory,
	type CorpusChunk,
} from "../../src/synapse/corpus.ts";
import { createDeterministicEmbedder } from "../support/deterministic-embedder.ts";

/**
 * The corpus build must be a pure function of its declared inputs: the same
 * source directory, commit and parameters always produce the same chunks, the
 * same snapshot id and the same bytes on disk. Every test here recomputes the
 * expected id from the documented formula rather than trusting the builder.
 */

function chunkIdOf(relativePath: string, startLine: number): string {
	return createHash("sha256").update(`${relativePath}\0${startLine}`, "utf-8").digest("hex").slice(0, 16);
}

function longLine(count = 40): string {
	return "a".repeat(count);
}

let workRoot = "";

beforeEach(() => {
	workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-corpus-"));
});

afterEach(() => {
	fs.rmSync(workRoot, { force: true, recursive: true });
});

describe("synapse corpus chunking", () => {
	it("keeps a whole file within the byte budget as one chunk spanning all lines", () => {
		const text = "alpha\nbeta\ngamma";
		assert.ok(Buffer.byteLength(text, "utf-8") <= SYNAPSE_CORPUS_MAX_WHOLE_FILE_BYTES);
		const [chunk] = chunkCorpusFile({ path: "docs/a.md", text });
		assert.ok(chunk);
		assert.equal(chunk?.startLine, 1);
		assert.equal(chunk?.endLine, 3);
		assert.equal(chunk?.text, text);
		assert.equal(chunk?.chunkId, chunkIdOf("docs/a.md", 1));
	});

	it("does not count a trailing newline as an extra line", () => {
		const withTail = chunkCorpusFile({ path: "a.md", text: "alpha\nbeta\n" });
		const withoutTail = chunkCorpusFile({ path: "a.md", text: "alpha\nbeta" });
		assert.deepEqual(withTail, withoutTail);
		assert.equal(withoutTail[0]?.endLine, 2);
	});

	it("splits an over-budget file into sliding windows with overlap", () => {
		const text = Array.from({ length: 201 }, () => longLine()).join("\n");
		assert.ok(Buffer.byteLength(text, "utf-8") > SYNAPSE_CORPUS_MAX_WHOLE_FILE_BYTES);
		const chunks = chunkCorpusFile({ path: "big.ts", text });
		assert.equal(chunks.length, 2);
		assert.deepEqual(
			chunks.map((chunk) => [chunk.startLine, chunk.endLine]),
			[
				[1, 200],
				[161, 201],
			],
		);
		assert.equal(chunks[0]?.chunkId, chunkIdOf("big.ts", 1));
		assert.equal(chunks[1]?.chunkId, chunkIdOf("big.ts", 161));
		// The overlap is byte-identical inside both windows.
		const firstLines = chunks[0]!.text.split("\n");
		const secondLines = chunks[1]!.text.split("\n");
		assert.deepEqual(secondLines.slice(0, 40), firstLines.slice(160));
	});

	it("does not emit an all-overlap tail chunk", () => {
		const text = Array.from({ length: 200 }, () => longLine()).join("\n");
		const chunks = chunkCorpusFile({ path: "exact.ts", text });
		assert.equal(chunks.length, 1);
		assert.equal(chunks[0]?.endLine, 200);
	});

	it("emits nothing for empty or whitespace-only files", () => {
		assert.deepEqual(chunkCorpusFile({ path: "empty.md", text: "" }), []);
		assert.deepEqual(chunkCorpusFile({ path: "blank.md", text: " \n\t\n" }), []);
	});

	it("treats LF and CRLF inputs identically", () => {
		const lf = chunkCorpusFile({ path: "crlf.md", text: "alpha\nbeta\nsecond\n" });
		const crlf = chunkCorpusFile({ path: "crlf.md", text: "alpha\r\nbeta\r\nsecond\r\n" });
		assert.deepEqual(crlf, lf);
	});

	it("rejects window and overlap parameters that cannot slide", () => {
		assert.throws(() => chunkCorpusFile({ path: "a.md", text: "x" }, { overlapLines: 200, windowLines: 200 }), /overlap/);
		assert.throws(() => chunkCorpusFile({ path: "a.md", text: "x" }, { windowLines: 0 }), /window/);
	});

	it("orders chunks by path code points, then start line", () => {
		const chunks = chunkCorpusFiles([
			{ path: "b.md", text: "one" },
			{ path: "a.md", text: "one" },
			{ path: "a.md2", text: "one" },
		]);
		assert.deepEqual(
			chunks.map((chunk) => chunk.path),
			["a.md", "a.md2", "b.md"],
		);
	});
});

describe("synapse corpus snapshot id", () => {
	it("digests exactly the documented fields, recomputed independently", () => {
		const chunkIds = [chunkIdOf("a.md", 1), chunkIdOf("b.ts", 1)];
		const input = {
			allowlist: [".md", ".ts"],
			chunkIds,
			overlapLines: SYNAPSE_CORPUS_DEFAULT_OVERLAP_LINES,
			sourceCommit: "0123abcd",
			windowLines: SYNAPSE_CORPUS_DEFAULT_WINDOW_LINES,
		};
		assert.equal(
			corpusSnapshotIdOf(input),
			canonicalDigest({
				allowlist: [".md", ".ts"],
				chunkIds,
				overlapLines: SYNAPSE_CORPUS_DEFAULT_OVERLAP_LINES,
				sourceCommit: "0123abcd",
				windowLines: SYNAPSE_CORPUS_DEFAULT_WINDOW_LINES,
			}),
		);
	});

	it("sorts and dedupes the allowlist before digesting", () => {
		const noChunks: string[] = [];
		const base = { chunkIds: noChunks, overlapLines: 40, sourceCommit: "s", windowLines: 200 };
		const first = corpusSnapshotIdOf({ ...base, allowlist: [".md", ".ts", ".md"] });
		const second = corpusSnapshotIdOf({ ...base, allowlist: [".ts", ".md"] });
		assert.equal(first, second);
	});

	it("changes when the source commit, a chunk, or a parameter changes", () => {
		const chunkIds = [chunkIdOf("a.md", 1)];
		const base = { allowlist: [".md"], chunkIds, overlapLines: 40, sourceCommit: "c1", windowLines: 200 };
		const id = corpusSnapshotIdOf(base);
		assert.notEqual(corpusSnapshotIdOf({ ...base, sourceCommit: "c2" }), id);
		assert.notEqual(corpusSnapshotIdOf({ ...base, windowLines: 100 }), id);
		assert.notEqual(corpusSnapshotIdOf({ ...base, chunkIds: [chunkIdOf("a.md", 161)] }), id);
	});
});

describe("synapse corpus directory scan", () => {
	it("includes only allowlisted utf-8 text files with posix relative paths", () => {
		const root = path.join(workRoot, "scan");
		fs.mkdirSync(path.join(root, "sub"), { recursive: true });
		fs.writeFileSync(path.join(root, "a.md"), "alpha\n");
		fs.writeFileSync(path.join(root, "sub", "b.ts"), "export const b = 1;\n");
		fs.writeFileSync(path.join(root, "c.bin"), "binary-ish");
		fs.writeFileSync(path.join(root, "d.md"), Buffer.from([0xff, 0xfe, 0xfd]));
		const scanned = scanCorpusDirectory(root, SYNAPSE_CORPUS_DEFAULT_ALLOWLIST);
		assert.deepEqual(
			scanned.files.map((file) => file.path),
			["a.md", "sub/b.ts"],
		);
		assert.deepEqual(scanned.skipped, ["d.md"]);
	});

	it("never descends into a .git directory", () => {
		const root = path.join(workRoot, "scan-git");
		fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
		fs.writeFileSync(path.join(root, ".git", "hooks", "note.md"), "vcs metadata\n");
		fs.writeFileSync(path.join(root, "real.md"), "content\n");
		const scanned = scanCorpusDirectory(root, [".md"]);
		assert.deepEqual(
			scanned.files.map((file) => file.path),
			["real.md"],
		);
	});

	it("sorts nested files into one global path order regardless of depth", () => {
		const root = path.join(workRoot, "scan-nested");
		fs.mkdirSync(path.join(root, "docs", "deep"), { recursive: true });
		fs.writeFileSync(path.join(root, "z.md"), "z\n");
		fs.writeFileSync(path.join(root, "docs", "m.md"), "m\n");
		fs.writeFileSync(path.join(root, "docs", "deep", "a.md"), "a\n");
		const scanned = scanCorpusDirectory(root, [".md"]);
		assert.deepEqual(
			scanned.files.map((file) => file.path),
			["docs/deep/a.md", "docs/m.md", "z.md"],
		);
	});

	it("rejects an allowlist entry without a leading dot before anything is read", () => {
		assert.throws(() => scanCorpusDirectory(workRoot, ["md"]), /must start with/);
	});
});

describe("synapse corpus build", () => {
	const embedder = createDeterministicEmbedder(8);

	function seedCorpus(root: string): void {
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n\nUse shared memory.\n");
		fs.writeFileSync(path.join(root, "notes.md"), "residual observations\n");
	}

	it("writes chunks, vectors and meta with the documented layout", async () => {
		const corpusRoot = path.join(workRoot, "corpus-src");
		const storageRoot = path.join(workRoot, "storage");
		seedCorpus(corpusRoot);
		const result = await buildCorpus({
			allowlist: [".md"],
			corpusRoot,
			embedder,
			sourceCommit: "frozen1",
			storageRoot,
		});
		// The id is recomputed from the documented formula over the produced chunks.
		const expectedChunks = chunkCorpusFiles([
			{ path: "docs/guide.md", text: "# Guide\n\nUse shared memory.\n" },
			{ path: "notes.md", text: "residual observations\n" },
		]);
		assert.deepEqual(result.chunks, expectedChunks);
		assert.equal(
			result.corpusSnapshotId,
			corpusSnapshotIdOf({
				allowlist: [".md"],
				chunkIds: expectedChunks.map((chunk) => chunk.chunkId),
				overlapLines: SYNAPSE_CORPUS_DEFAULT_OVERLAP_LINES,
				sourceCommit: "frozen1",
				windowLines: SYNAPSE_CORPUS_DEFAULT_WINDOW_LINES,
			}),
		);
		const dir = path.join(storageRoot, "corpus", result.corpusSnapshotId);
		assert.ok(fs.existsSync(dir));
		// chunks.json mirrors the chunk list exactly.
		// SAFETY: the file was just written by buildCorpus over a plain chunk array.
		const storedChunks = JSON.parse(fs.readFileSync(path.join(dir, "chunks.json"), "utf-8")) as CorpusChunk[];
		assert.deepEqual(storedChunks, expectedChunks);
		// vectors.f32 is the concatenated little-endian float32 stub vectors.
		const storedVectors = fs.readFileSync(path.join(dir, "vectors.f32"));
		assert.equal(storedVectors.byteLength, expectedChunks.length * 8 * 4);
		const expectedBuffer = Buffer.alloc(storedVectors.byteLength);
		for (const [index, chunk] of expectedChunks.entries()) {
			const vector = await awaitVector(chunk.text);
			for (let dim = 0; dim < 8; dim += 1) {
				expectedBuffer.writeFloatLE(vector[dim]!, index * 8 * 4 + dim * 4);
			}
		}
		assert.deepEqual(storedVectors.equals(expectedBuffer), true);
		// meta.json carries the identity a consumer must agree with.
		type CorpusMeta = {
			allowlist: string[];
			batchLimit: number;
			chunkCount: number;
			chunksSha256: string;
			corpusSnapshotId: string;
			dim: number;
			maxChunkBytes: number;
			overlapLines: number;
			representationId: string;
			sourceCommit: string;
			vectorsSha256: string;
			windowLines: number;
		};
		// SAFETY: the file was just written by buildCorpus over a plain meta object.
		const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8")) as CorpusMeta;
		assert.equal(meta.corpusSnapshotId, result.corpusSnapshotId);
		assert.equal(meta.dim, 8);
		assert.equal(meta.representationId, embedder.representationId);
		assert.equal(meta.chunkCount, expectedChunks.length);
		assert.equal(meta.sourceCommit, "frozen1");
		assert.equal(meta.windowLines, SYNAPSE_CORPUS_DEFAULT_WINDOW_LINES);
		assert.equal(meta.overlapLines, SYNAPSE_CORPUS_DEFAULT_OVERLAP_LINES);
		assert.deepEqual(meta.allowlist, [".md"]);
		assert.equal(meta.vectorsSha256, createHash("sha256").update(storedVectors).digest("hex"));
		assert.equal(meta.chunksSha256, createHash("sha256").update(JSON.stringify(expectedChunks, null, 2), "utf-8").digest("hex"));
		assert.equal(meta.maxChunkBytes, Math.max(...expectedChunks.map((chunk) => Buffer.byteLength(chunk.text, "utf-8"))));
		assert.equal(Number.isInteger(meta.batchLimit) && meta.batchLimit >= 1, true);
	});

	it("rebuilds the identical snapshot id and bytes for the same input", async () => {
		const corpusRoot = path.join(workRoot, "corpus-idem");
		seedCorpus(corpusRoot);
		const first = await buildCorpus({
			allowlist: [".md"],
			corpusRoot,
			embedder,
			sourceCommit: "frozen1",
			storageRoot: path.join(workRoot, "s1"),
		});
		const second = await buildCorpus({
			allowlist: [".md"],
			corpusRoot,
			embedder,
			sourceCommit: "frozen1",
			storageRoot: path.join(workRoot, "s2"),
		});
		assert.equal(second.corpusSnapshotId, first.corpusSnapshotId);
		const read = (root: string, name: string) => fs.readFileSync(path.join(root, "corpus", first.corpusSnapshotId, name));
		assert.deepEqual(read(path.join(workRoot, "s2"), "vectors.f32").equals(read(path.join(workRoot, "s1"), "vectors.f32")), true);
		assert.deepEqual(read(path.join(workRoot, "s2"), "chunks.json").equals(read(path.join(workRoot, "s1"), "chunks.json")), true);
	});

	it("changes the snapshot id when the source commit changes", async () => {
		const corpusRoot = path.join(workRoot, "corpus-commit");
		seedCorpus(corpusRoot);
		const first = await buildCorpus({ allowlist: [".md"], corpusRoot, embedder, sourceCommit: "c1", storageRoot: path.join(workRoot, "c1") });
		const second = await buildCorpus({ allowlist: [".md"], corpusRoot, embedder, sourceCommit: "c2", storageRoot: path.join(workRoot, "c2") });
		assert.notEqual(second.corpusSnapshotId, first.corpusSnapshotId);
	});

	it("is a no-op when the identical snapshot is already published", async () => {
		const corpusRoot = path.join(workRoot, "corpus-idempotent");
		const storageRoot = path.join(workRoot, "idempotent-storage");
		seedCorpus(corpusRoot);
		const first = await buildCorpus({ allowlist: [".md"], corpusRoot, embedder, sourceCommit: "frozen1", storageRoot });
		assert.equal(first.alreadyPresent, false);
		// Overwrite chunks.json with junk of the same length: an identical
		// rebuild must not rewrite it (and the guard does not hash the file
		// again on the no-op path — the meta digest is the contract).
		const chunksPath = path.join(storageRoot, "corpus", first.corpusSnapshotId, "chunks.json");
		fs.writeFileSync(chunksPath, Buffer.alloc(fs.statSync(chunksPath).size, 0x20));
		const second = await buildCorpus({ allowlist: [".md"], corpusRoot, embedder, sourceCommit: "frozen1", storageRoot });
		assert.equal(second.alreadyPresent, true);
		assert.deepEqual(fs.readFileSync(chunksPath), Buffer.alloc(fs.statSync(chunksPath).size, 0x20));
	});

	it("refuses an idempotent hit under a different embedding space", async () => {
		// The snapshot id does not depend on the vectors, so a corpus built with the
		// offline placeholder embedder carries the same id as the real one. Without
		// this refusal a later real build reports "already present" and the store is
		// left ranking stub vectors while every run claims to rank semantically —
		// and the published byte count would have matched, so nothing else notices.
		const corpusRoot = path.join(workRoot, "corpus-space");
		const storageRoot = path.join(workRoot, "space-storage");
		seedCorpus(corpusRoot);
		const placeholder = {
			async embedBatch(texts: readonly string[]) {
				return texts.map(() => ({ cached: false, latencyMs: 0, promptTokens: null, vector: new Float32Array(8) }));
			},
			async embedQuery() {
				return { cached: false, latencyMs: 0, promptTokens: null, vector: new Float32Array(8) };
			},
			representationId: "deterministic-test/sha256/v1",
		};
		const first = await buildCorpus({ allowlist: [".md"], corpusRoot, embedder: placeholder, sourceCommit: "frozen1", storageRoot });
		assert.equal(first.alreadyPresent, false);
		// A different space: the same id, the same chunk set, the same byte count —
		// only the space differs, which is exactly what nothing else would catch.
		const realSpace = createDeterministicEmbedder(8, "siliconflow/BAAI/bge-m3/1024");
		await assert.rejects(
			buildCorpus({ allowlist: [".md"], corpusRoot, embedder: realSpace, sourceCommit: "frozen1", storageRoot }),
			/was published under representation deterministic-test\/sha256\/v1/,
		);
		// Re-embedding in the same space stays a no-op: the refusal is about the
		// space, not about the provider promising bit-identical output.
		assert.equal(
			(await buildCorpus({ allowlist: [".md"], corpusRoot, embedder: placeholder, sourceCommit: "frozen1", storageRoot })).alreadyPresent,
			true,
		);
		// And a distinct space gets its own directory rather than colliding.
		const elsewhere = await buildCorpus({ allowlist: [".md"], corpusRoot, embedder: realSpace, sourceCommit: "frozen1", storageRoot: path.join(workRoot, "space-storage-fresh") });
		assert.equal(elsewhere.corpusSnapshotId, first.corpusSnapshotId, "the id is the corpus, not the vectors");
	});

	it("refuses to rebuild the same id over different chunk content", async () => {
		const corpusRoot = path.join(workRoot, "corpus-mutated");
		const storageRoot = path.join(workRoot, "mutated-storage");
		seedCorpus(corpusRoot);
		const first = await buildCorpus({ allowlist: [".md"], corpusRoot, embedder, sourceCommit: "frozen1", storageRoot });
		// Same path, same start line — the id formula cannot see the change.
		fs.writeFileSync(path.join(corpusRoot, "notes.md"), "mutated observations\n");
		await assert.rejects(
			buildCorpus({ allowlist: [".md"], corpusRoot, embedder, sourceCommit: "frozen1", storageRoot }),
			/different chunk content/,
		);
		// The published snapshot was left untouched.
		const dir = path.join(storageRoot, "corpus", first.corpusSnapshotId);
		// SAFETY: the file was written by the first buildCorpus call above.
		const stored = JSON.parse(fs.readFileSync(path.join(dir, "chunks.json"), "utf-8")) as CorpusChunk[];
		assert.equal(stored.some((chunk) => chunk.text.includes("residual")), true);
		assert.equal(stored.some((chunk) => chunk.text.includes("mutated")), false);
	});

	it("refuses to publish an empty corpus", async () => {
		const corpusRoot = path.join(workRoot, "corpus-empty");
		fs.mkdirSync(corpusRoot, { recursive: true });
		fs.writeFileSync(path.join(corpusRoot, "ignored.bin"), "not text\n");
		await assert.rejects(
			buildCorpus({ allowlist: [".md"], corpusRoot, embedder, sourceCommit: "frozen1", storageRoot: path.join(workRoot, "empty-storage") }),
			/empty after allowlist filtering/,
		);
	});

	it("names a legacy meta without chunksSha256 instead of accusing it of drift", async () => {
		const corpusRoot = path.join(workRoot, "corpus-legacy");
		const storageRoot = path.join(workRoot, "legacy-storage");
		seedCorpus(corpusRoot);
		const first = await buildCorpus({ allowlist: [".md"], corpusRoot, embedder, sourceCommit: "frozen1", storageRoot });
		const metaPath = path.join(storageRoot, "corpus", first.corpusSnapshotId, "meta.json");
		// SAFETY: the file was written by buildCorpus above; the edit simulates a pre-guard format.
		const legacy = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as { chunksSha256?: string; maxChunkBytes?: number };
		delete legacy.chunksSha256;
		delete legacy.maxChunkBytes;
		fs.writeFileSync(metaPath, JSON.stringify(legacy), "utf-8");
		await assert.rejects(
			buildCorpus({ allowlist: [".md"], corpusRoot, embedder, sourceCommit: "frozen1", storageRoot }),
			/predates the immutability guard/,
		);
	});

	it("refuses a published snapshot whose meta disagrees with the files on disk", async () => {
		const corpusRoot = path.join(workRoot, "corpus-hollow");
		const storageRoot = path.join(workRoot, "hollow-storage");
		seedCorpus(corpusRoot);
		const first = await buildCorpus({ allowlist: [".md"], corpusRoot, embedder, sourceCommit: "frozen1", storageRoot });
		const metaPath = path.join(storageRoot, "corpus", first.corpusSnapshotId, "meta.json");
		// SAFETY: the file was written by buildCorpus above; the rewrite keeps only the guard key.
		const hollow = { chunksSha256: (JSON.parse(fs.readFileSync(metaPath, "utf-8")) as { chunksSha256: string }).chunksSha256 };
		fs.writeFileSync(metaPath, JSON.stringify(hollow), "utf-8");
		await assert.rejects(
			buildCorpus({ allowlist: [".md"], corpusRoot, embedder, sourceCommit: "frozen1", storageRoot }),
			/disagrees with its published files/,
		);
	});

	it("refuses a published snapshot whose vectors.f32 was truncated, meta intact", async () => {
		const corpusRoot = path.join(workRoot, "corpus-truncated");
		const storageRoot = path.join(workRoot, "truncated-storage");
		seedCorpus(corpusRoot);
		const first = await buildCorpus({ allowlist: [".md"], corpusRoot, embedder, sourceCommit: "frozen1", storageRoot });
		const vectorsPath = path.join(storageRoot, "corpus", first.corpusSnapshotId, "vectors.f32");
		fs.writeFileSync(vectorsPath, fs.readFileSync(vectorsPath).subarray(0, 4));
		await assert.rejects(
			buildCorpus({ allowlist: [".md"], corpusRoot, embedder, sourceCommit: "frozen1", storageRoot }),
			/disagrees with its published files/,
		);
	});
});

/** Re-derives the stub vector for a text through the public embedder API. */
async function awaitVector(text: string): Promise<Float32Array> {
	return (await createDeterministicEmbedder(8).embedQuery(text)).vector;
}
