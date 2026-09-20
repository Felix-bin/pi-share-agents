import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../shared/atomic-json.ts";
import { canonicalDigest } from "./canonical-json.ts";
import type { Embedder } from "./embedding.ts";
import { SYNAPSE_EMBEDDING_BATCH_LIMIT } from "./embedding.ts";

/**
 * Fixed-corpus construction and its snapshot identity (P3-3).
 *
 * "Given a commit ⇒ a uniquely determined chunk set" is the precondition the
 * state plane's retrieval reproducibility stands on, so every rule here is a
 * pure function of declared inputs: no clocks, no locale collation, no syntax
 * parsing. The embedding batch limit is a frozen constant recorded in
 * meta.json; it is not a free parameter, and changing it changes the provider's
 * batch composition — and therefore the vector bytes — which is why consumers
 * verify the recorded representation identity before trusting vectors.f32.
 */

export const SYNAPSE_CORPUS_DEFAULT_WINDOW_LINES = 200;
export const SYNAPSE_CORPUS_DEFAULT_OVERLAP_LINES = 40;
/** A whole file at or under this many UTF-8 bytes embeds as a single chunk. */
export const SYNAPSE_CORPUS_MAX_WHOLE_FILE_BYTES = 6000;
export const SYNAPSE_CORPUS_DEFAULT_ALLOWLIST = [".json", ".md", ".py", ".ts", ".txt", ".yaml"];

export type CorpusChunk = {
	chunkId: string;
	endLine: number;
	path: string;
	startLine: number;
	text: string;
};

export type CorpusFile = {
	/** POSIX-style path relative to the corpus root. */
	path: string;
	text: string;
};

export type ChunkOptions = {
	overlapLines?: number;
	windowLines?: number;
};

export type CorpusSnapshotIdInput = {
	allowlist: readonly string[];
	chunkIds: readonly string[];
	overlapLines: number;
	sourceCommit: string;
	windowLines: number;
};

export type ScanResult = {
	files: CorpusFile[];
	/** Allowlisted files whose bytes were not valid UTF-8; reported, never silently dropped. */
	skipped: string[];
};

export type BuildCorpusOptions = {
	allowlist?: readonly string[];
	corpusRoot: string;
	embedder: Embedder;
	overlapLines?: number;
	sourceCommit: string;
	storageRoot: string;
	windowLines?: number;
};

export type CorpusBuildResult = {
	/** True when an identical snapshot was already published and nothing was rewritten. */
	alreadyPresent: boolean;
	chunks: CorpusChunk[];
	corpusSnapshotId: string;
	/** Largest chunk text in UTF-8 bytes; window chunks may exceed the whole-file budget by design. */
	maxChunkBytes: number;
	skippedFiles: string[];
	vectorBytes: number;
};

/** The meta.json a published snapshot carries; P3-4 consumes it read-only. */
export type StoredCorpusMeta = {
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

/** CRLF and stray CR both collapse to LF, so line numbers mean the same thing everywhere. */
function normalizeNewlines(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

function chunkIdOf(relativePath: string, startLine: number): string {
	return createHash("sha256").update(`${relativePath}\0${startLine}`, "utf-8").digest("hex").slice(0, 16);
}

function normalizeAllowlist(allowlist: readonly string[]): string[] {
	for (const extension of allowlist) {
		// A missing dot would match nothing (path.extname returns ".md", not "md")
		// and the scan would silently come back empty.
		if (!extension.startsWith(".")) {
			throw new Error(`allowlist entries must start with ".": ${JSON.stringify(extension)}`);
		}
	}
	return [...new Set(allowlist.map((extension) => extension.toLowerCase()))].sort();
}

export function corpusSnapshotIdOf(input: CorpusSnapshotIdInput): string {
	return canonicalDigest({
		allowlist: normalizeAllowlist(input.allowlist),
		chunkIds: [...input.chunkIds],
		overlapLines: input.overlapLines,
		sourceCommit: input.sourceCommit,
		windowLines: input.windowLines,
	});
}

export function chunkCorpusFile(file: CorpusFile, options: ChunkOptions = {}): CorpusChunk[] {
	const windowLines = options.windowLines ?? SYNAPSE_CORPUS_DEFAULT_WINDOW_LINES;
	const overlapLines = options.overlapLines ?? SYNAPSE_CORPUS_DEFAULT_OVERLAP_LINES;
	if (!Number.isInteger(windowLines) || windowLines < 1) {
		throw new Error(`windowLines must be an integer >= 1, got ${windowLines}`);
	}
	if (!Number.isInteger(overlapLines) || overlapLines < 0 || overlapLines >= windowLines) {
		throw new Error(`overlapLines must be an integer in 0..${windowLines - 1}, got ${overlapLines}`);
	}
	const normalized = normalizeNewlines(file.text);
	// A file with no visible characters has nothing to embed and no line
	// structure worth naming; it produces no chunk and no id input.
	if (normalized.trim().length === 0) return [];
	const lines = normalized.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();

	const chunkAt = (startLine: number): CorpusChunk => {
		const endLine = Math.min(startLine + windowLines - 1, lines.length);
		return {
			chunkId: chunkIdOf(file.path, startLine),
			endLine,
			path: file.path,
			startLine,
			text: lines.slice(startLine - 1, endLine).join("\n"),
		};
	};
	if (Buffer.byteLength(normalized, "utf-8") <= SYNAPSE_CORPUS_MAX_WHOLE_FILE_BYTES) {
		return [chunkAt(1)];
	}
	const step = windowLines - overlapLines;
	const chunks: CorpusChunk[] = [];
	let startLine = 1;
	for (;;) {
		const chunk = chunkAt(startLine);
		chunks.push(chunk);
		// Every window must introduce at least one new line; a window that would
		// lie entirely inside the previous one carries no new content.
		if (chunk.endLine >= lines.length) break;
		startLine += step;
	}
	return chunks;
}

export function chunkCorpusFiles(files: readonly CorpusFile[], options: ChunkOptions = {}): CorpusChunk[] {
	const ordered = [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	const chunks: CorpusChunk[] = [];
	for (const file of ordered) {
		// Within one file the windows are already in start-line order.
		chunks.push(...chunkCorpusFile(file, options));
	}
	return chunks;
}

export function scanCorpusDirectory(corpusRoot: string, allowlist: readonly string[]): ScanResult {
	const extensions = new Set(normalizeAllowlist(allowlist));
	const files: CorpusFile[] = [];
	const skipped: string[] = [];
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const walk = (dir: string): void => {
		const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
		for (const entry of entries) {
			// An exported snapshot carries no VCS metadata; skipping .git guards a
			// corpus root accidentally pointed at a live checkout.
			if (entry.isDirectory() && entry.name === ".git") continue;
			const relative = path.relative(corpusRoot, path.join(dir, entry.name)).split(path.sep).join("/");
			const allowlisted = extensions.has(path.extname(entry.name).toLowerCase());
			if (entry.isDirectory()) {
				walk(path.join(dir, entry.name));
				continue;
			}
			// Symlinks and other special files are reported rather than silently
			// dropped: a snapshot is a plain tree, and a link would let two scans
			// disagree about what was read.
			if (!entry.isFile()) {
				if (allowlisted) skipped.push(relative);
				continue;
			}
			if (!allowlisted) continue;
			let bytes: Buffer;
			try {
				bytes = fs.readFileSync(path.join(dir, entry.name));
			} catch {
				skipped.push(relative);
				continue;
			}
			try {
				files.push({ path: relative, text: decoder.decode(bytes) });
			} catch {
				skipped.push(relative);
			}
		}
	};
	walk(corpusRoot);
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	skipped.sort();
	return { files, skipped };
}

function writeVectorBytes(target: string, vectors: readonly Float32Array[], dim: number): number {
	const totalBytes = vectors.length * dim * 4;
	const buffer = Buffer.alloc(totalBytes);
	for (const [index, vector] of vectors.entries()) {
		if (vector.length !== dim) {
			throw new Error(`corpus vector ${index} holds ${vector.length} floats, expected ${dim}`);
		}
		for (let element = 0; element < dim; element += 1) {
			// Explicit little-endian writes: a Float32Array's own buffer follows
			// the platform byte order, which would flip the file on big-endian hosts.
			buffer.writeFloatLE(vector[element]!, index * dim * 4 + element * 4);
		}
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const tempPath = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		fs.writeFileSync(tempPath, buffer);
		fs.renameSync(tempPath, target);
	} finally {
		fs.rmSync(tempPath, { force: true });
	}
	return totalBytes;
}

function serializedChunksSha256(chunks: readonly CorpusChunk[]): string {
	// The same serialization writeAtomicJson will emit, so the digest describes
	// the exact bytes a consumer reads back from chunks.json.
	return createHash("sha256").update(JSON.stringify(chunks, null, 2), "utf-8").digest("hex");
}

export async function buildCorpus(options: BuildCorpusOptions): Promise<CorpusBuildResult> {
	const windowLines = options.windowLines ?? SYNAPSE_CORPUS_DEFAULT_WINDOW_LINES;
	const overlapLines = options.overlapLines ?? SYNAPSE_CORPUS_DEFAULT_OVERLAP_LINES;
	const allowlist = normalizeAllowlist(options.allowlist ?? SYNAPSE_CORPUS_DEFAULT_ALLOWLIST);
	const scan = scanCorpusDirectory(options.corpusRoot, allowlist);
	const chunks = chunkCorpusFiles(scan.files, { overlapLines, windowLines });
	if (chunks.length === 0) {
		const skippedDetail = scan.skipped.length > 0 ? `; skipped unreadable files: ${scan.skipped.join(", ")}` : "";
		throw new Error(`corpus is empty after allowlist filtering (root: ${options.corpusRoot}${skippedDetail}); refusing to publish an empty snapshot`);
	}
	const corpusSnapshotId = corpusSnapshotIdOf({
		allowlist,
		chunkIds: chunks.map((chunk) => chunk.chunkId),
		overlapLines,
		sourceCommit: options.sourceCommit,
		windowLines,
	});
	const chunksSha256 = serializedChunksSha256(chunks);
	const maxChunkBytes = chunks.reduce((max, chunk) => Math.max(max, Buffer.byteLength(chunk.text, "utf-8")), 0);
	const targetDir = path.join(options.storageRoot, "corpus", corpusSnapshotId);
	const metaPath = path.join(targetDir, "meta.json");
	const vectorsPath = path.join(targetDir, "vectors.f32");
	if (fs.existsSync(metaPath)) {
		// A published snapshot is immutable. Vectors are exempt from the check —
		// providers do not promise bit-identical re-embedding (spec §8.1) — but
		// chunk content is fully determined by the inputs, so the same id coming
		// to mean different chunks is a broken build, not a new snapshot.
		let stored: StoredCorpusMeta;
		try {
			// SAFETY: the file was written by buildCorpus over a plain meta object; a failed parse is corruption.
			stored = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as StoredCorpusMeta;
		} catch {
			throw new Error(`integrity: corpus snapshot ${corpusSnapshotId} has an unreadable meta.json; refusing to overwrite`);
		}
		if (stored.chunksSha256 === undefined) {
			throw new Error(
				`integrity: corpus snapshot ${corpusSnapshotId} predates the immutability guard (meta.json has no chunksSha256); publish to a fresh storage root`,
			);
		}
		if (stored.chunksSha256 !== chunksSha256) {
			throw new Error(
				`integrity: corpus snapshot ${corpusSnapshotId} already exists with different chunk content; a changed corpus needs a new source commit, not a rebuild under the same id`,
			);
		}
		// The snapshot id is a function of the source and the chunking, not of the
		// vectors — which is what makes it authoritative, and also what makes this
		// the one idempotent hit that must not be taken silently: a snapshot built
		// with the offline placeholder embedder carries the same id as a real one, so
		// a later real build would report "already present" and leave a corpus of
		// stub vectors in a store that then claims to rank semantically.
		//
		// This is not the exemption above. Re-embedding with the same provider may
		// differ bit for bit and is allowed; embedding under a different
		// representation is a different space, and its vectors are not comparable
		// with anything the run ranks against them.
		// A meta without a representation id is not evidence of another space — it is
		// a corrupt or legacy file, and the checks around this one already refuse
		// those. Only a stated, different space is refused here.
		if (stored.representationId !== undefined && stored.representationId !== options.embedder.representationId) {
			throw new Error(
				`integrity: corpus snapshot ${corpusSnapshotId} was published under representation ${stored.representationId}, this build embeds with ${options.embedder.representationId}; an idempotent hit here would leave the store ranking vectors from another space — publish to a fresh storage root`,
			);
		}
		// meta.json is written last, so it existing means the snapshot was
		// published; vectors missing alongside it is corruption, not an idempotent hit.
		let publishedBytes: number;
		try {
			publishedBytes = fs.statSync(vectorsPath).size;
		} catch {
			throw new Error(`integrity: corpus snapshot ${corpusSnapshotId} is published but vectors.f32 is missing; refusing to treat it as complete`);
		}
		if (stored.chunkCount !== chunks.length || publishedBytes !== stored.chunkCount * stored.dim * 4) {
			throw new Error(`integrity: corpus snapshot ${corpusSnapshotId} disagrees with its published files (meta vs disk); refusing to treat it as complete`);
		}
		return { alreadyPresent: true, chunks, corpusSnapshotId, maxChunkBytes, skippedFiles: scan.skipped, vectorBytes: publishedBytes };
	}
	const embeddings = await options.embedder.embedBatch(chunks.map((chunk) => chunk.text));
	if (embeddings.length !== chunks.length) {
		throw new Error(`corpus embedding returned ${embeddings.length} vectors for ${chunks.length} chunks`);
	}
	const dim = embeddings[0]?.vector.length ?? 0;
	for (const embedding of embeddings) {
		if (embedding.vector.length !== dim) {
			throw new Error(`corpus embedding dimension drift: ${embedding.vector.length} vs ${dim}`);
		}
	}
	fs.mkdirSync(targetDir, { recursive: true });
	const vectorBytes = writeVectorBytes(vectorsPath, embeddings.map((e) => e.vector), dim);
	const storedVectors = fs.readFileSync(vectorsPath);
	const meta: StoredCorpusMeta = {
		allowlist,
		batchLimit: SYNAPSE_EMBEDDING_BATCH_LIMIT,
		chunkCount: chunks.length,
		chunksSha256,
		corpusSnapshotId,
		dim,
		maxChunkBytes,
		overlapLines,
		representationId: options.embedder.representationId,
		sourceCommit: options.sourceCommit,
		vectorsSha256: createHash("sha256").update(storedVectors).digest("hex"),
		windowLines,
	};
	writeAtomicJson(path.join(targetDir, "chunks.json"), chunks);
	writeAtomicJson(metaPath, meta);
	return { alreadyPresent: false, chunks, corpusSnapshotId, maxChunkBytes, skippedFiles: scan.skipped, vectorBytes };
}
