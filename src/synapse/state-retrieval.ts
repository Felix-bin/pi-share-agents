import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StoredCorpusMeta } from "./corpus.ts";
import type { ContentStore } from "./content-store.ts";
import type { StateRef } from "./envelope.ts";
import type { MeteringIdentity, MeteringLog } from "./metering.ts";

/**
 * Consumption of a received state vector against the fixed corpus (P3-4).
 *
 * The receiving side decodes exactly what arrived: it reads the payload the
 * envelope names, re-verifies it against the envelope's own claims, and ranks
 * the pinned corpus by cosine. It never re-embeds the original query (spec
 * §8.1) and never lets a verification failure degrade into keyword retrieval
 * (spec §8.2): a state that cannot be proven is not consumed, it is refused.
 */

const CORPUS_DIR = "corpus";
const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{64}$/;

export type StateRetrievalInput = {
	corpusSnapshotId: string;
	k: number;
	/** Verification material carried by the envelope that transported the state. */
	stateRef: StateRef;
};

export type StateRetrievalHit = {
	chunkId: string;
	cosine: number;
	endLine: number;
	path: string;
	startLine: number;
};

export type StateRetrievalResult = {
	corpusSnapshotId: string;
	hits: StateRetrievalHit[];
	representationId: string;
};

export type StateRetrievalDeps = {
	contentStore: ContentStore;
	/** When present, a successful retrieval is recorded as a state-consume event. */
	metering?: { identity: MeteringIdentity; log: MeteringLog };
	/** Root holding corpus/<corpusSnapshotId>/ as build-corpus published it. */
	storageRoot: string;
};

type CorpusVectors = {
	chunkIds: string[];
	chunkMeta: { endLine: number; path: string; startLine: number }[];
	vectors: Float32Array[];
};

/**
 * A corpus as the ranking sees it. Exported so a caller that ranks the same
 * corpus — the delta calibration, which compares a recovered vector's top-k
 * with the true vector's — reaches the hits through the production ranking
 * rather than a second implementation of it.
 */
export type LoadedCorpus = CorpusVectors;

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function decodeFloat32LE(bytes: Uint8Array, label: string): Float32Array {
	if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
		throw new Error(`integrity: ${label} holds ${bytes.byteLength} bytes, not a whole number of float32 values`);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const vector = new Float32Array(bytes.byteLength / 4);
	for (let index = 0; index < vector.length; index += 1) {
		vector[index] = view.getFloat32(index * 4, true);
		if (!Number.isFinite(vector[index]!)) {
			throw new Error(`integrity: ${label} holds a non-finite value at index ${index}`);
		}
	}
	return vector;
}

function normOf(vector: Float32Array): number {
	let normSquared = 0;
	for (const value of vector) normSquared += value * value;
	return Math.sqrt(normSquared);
}

/** Loads and fully verifies the published corpus; every mismatch is fatal. */
export function loadCorpusVectors(storageRoot: string, corpusSnapshotId: string, expectedDim: number, representationId: string): CorpusVectors {
	// The id reaches path.join before anything is read: a non-hex value with
	// separators must be refused here, at the boundary, rather than trusted to
	// stay inside the storage root (config pins the shape today; the P3-5
	// envelope consumer passes ids from the wire).
	if (!SNAPSHOT_ID_PATTERN.test(corpusSnapshotId)) {
		throw new Error(`invalid corpus snapshot id: ${JSON.stringify(corpusSnapshotId)}`);
	}
	const corpusDir = path.join(storageRoot, CORPUS_DIR, corpusSnapshotId);
	let metaRaw: string;
	try {
		metaRaw = fs.readFileSync(path.join(corpusDir, "meta.json"), "utf-8");
	} catch {
		throw new Error(`object-unavailable: corpus snapshot ${corpusSnapshotId} is not published under ${storageRoot}`);
	}
	let meta: StoredCorpusMeta;
	try {
		// SAFETY: the file was written by buildCorpus over a plain meta object; anything that
		// fails to parse, or parses to a non-object (JSON allows null), is corruption.
		meta = JSON.parse(metaRaw) as StoredCorpusMeta;
	} catch {
		throw new Error(`integrity: corpus snapshot ${corpusSnapshotId} has an unreadable meta.json`);
	}
	// Branching on the domain value, not on the parse shape: a meta that is not
	// an object (JSON allows null) has no corpusSnapshotId field to compare.
	if (meta === null || meta.corpusSnapshotId === undefined) {
		throw new Error(`integrity: corpus snapshot ${corpusSnapshotId} has an unreadable meta.json`);
	}
	if (meta.corpusSnapshotId !== corpusSnapshotId) {
		throw new Error(`integrity: corpus snapshot directory ${corpusSnapshotId} holds meta naming ${meta.corpusSnapshotId}`);
	}
	// Representation identity is checked before any vector is decoded: vectors
	// from incomparable spaces must fail as a compatibility error, never be
	// silently compared (spec §8.2).
	if (meta.representationId !== representationId) {
		throw new Error(
			`representation-mismatch: state payload is ${representationId}, corpus ${corpusSnapshotId} is ${meta.representationId}; the spaces are incomparable`,
		);
	}
	if (meta.dim !== expectedDim) {
		throw new Error(`representation-mismatch: state payload declares dim ${expectedDim}, corpus ${corpusSnapshotId} holds ${meta.dim}-dimensional vectors`);
	}

	let vectorsBytes: Buffer;
	let chunksBytes: Buffer;
	let chunks: { chunkId: string; endLine: number; path: string; startLine: number }[];
	try {
		vectorsBytes = fs.readFileSync(path.join(corpusDir, "vectors.f32"));
	} catch {
		throw new Error(`object-unavailable: corpus snapshot ${corpusSnapshotId} is missing vectors.f32`);
	}
	if (sha256Hex(vectorsBytes) !== meta.vectorsSha256) {
		throw new Error(`integrity: corpus snapshot ${corpusSnapshotId} vectors.f32 no longer matches its published digest`);
	}
	try {
		chunksBytes = fs.readFileSync(path.join(corpusDir, "chunks.json"));
	} catch {
		throw new Error(`object-unavailable: corpus snapshot ${corpusSnapshotId} is missing chunks.json`);
	}
	try {
		// SAFETY: chunks.json was written by writeAtomicJson over the chunk array; anything that
		// fails to parse, or parses to a non-object (JSON allows null), is corruption.
		chunks = JSON.parse(chunksBytes.toString("utf-8")) as typeof chunks;
	} catch {
		throw new Error(`integrity: corpus snapshot ${corpusSnapshotId} has an unreadable chunks.json`);
	}
	// The domain value is the array itself: anything JSON parsed that is not an
	// array (null, a number, an object) is not a chunk list.
	if (!Array.isArray(chunks)) {
		throw new Error(`integrity: corpus snapshot ${corpusSnapshotId} has an unreadable chunks.json`);
	}
	// The digest covers the exact published bytes, the same serialisation the
	// builder froze, so a rewritten file is refused however small the edit.
	if (sha256Hex(chunksBytes) !== meta.chunksSha256) {
		throw new Error(`integrity: corpus snapshot ${corpusSnapshotId} chunks.json no longer matches its published digest`);
	}
	if (chunks.length !== meta.chunkCount || vectorsBytes.byteLength !== meta.chunkCount * meta.dim * 4) {
		throw new Error(`integrity: corpus snapshot ${corpusSnapshotId} disagrees with its published files (chunk count vs vectors)`);
	}

	const vectors: Float32Array[] = [];
	for (let index = 0; index < chunks.length; index += 1) {
		const vector = decodeFloat32LE(vectorsBytes.subarray(index * meta.dim * 4, (index + 1) * meta.dim * 4), `corpus chunk ${chunks[index]?.chunkId}`);
		if (normOf(vector) === 0) {
			throw new Error(`integrity: corpus snapshot ${corpusSnapshotId} holds an all-zero vector for chunk ${chunks[index]?.chunkId}`);
		}
		vectors.push(vector);
	}
	return { chunkIds: chunks.map((chunk) => chunk.chunkId), chunkMeta: chunks.map(({ endLine, path: chunkPath, startLine }) => ({ endLine, path: chunkPath, startLine })), vectors };
}

/**
 * Ranks every chunk of a loaded corpus against one query vector: cosine
 * descending, ties by chunk id ascending. It is the only ranking in the build,
 * so a caller comparing a recovered vector against a true one measures the order
 * the wire path actually produces.
 */
export function rankCorpusChunks(corpus: CorpusVectors, queryVector: Float32Array, k: number): StateRetrievalHit[] {
	const queryNorm = normOf(queryVector);
	if (queryNorm === 0) {
		throw new Error("integrity: query vector is all zeros; cosine against it is undefined");
	}
	const hits: StateRetrievalHit[] = corpus.vectors.map((vector, index) => {
		// A corpus vector of another width cannot be compared; failing here beats
		// scoring every later element against `undefined`.
		if (vector.length !== queryVector.length) {
			throw new Error(`representation-mismatch: corpus chunk ${corpus.chunkIds[index]} holds ${vector.length} floats, the query vector holds ${queryVector.length}`);
		}
		let dot = 0;
		for (let element = 0; element < vector.length; element += 1) dot += queryVector[element]! * vector[element]!;
		const meta = corpus.chunkMeta[index]!;
		return { chunkId: corpus.chunkIds[index]!, cosine: dot / (queryNorm * normOf(vector)), endLine: meta.endLine, path: meta.path, startLine: meta.startLine };
	});
	hits.sort((left, right) => (left.cosine !== right.cosine ? right.cosine - left.cosine : left.chunkId < right.chunkId ? -1 : 1));
	return hits.slice(0, k);
}

export function retrieveWithState(deps: StateRetrievalDeps, input: StateRetrievalInput): StateRetrievalResult {
	const stateRef = input.stateRef;
	// The service front door validates k, but this module is also callable
	// directly (tests, the P3-5 envelope consumer): a non-positive or fractional
	// k must fail loudly rather than silently truncate through slice semantics.
	if (!Number.isInteger(input.k) || input.k < 1) {
		throw new Error(`k-out-of-range: ${input.k} is not an integer >= 1`);
	}
	// Residual coding is a declared encoding but not a decodable one in this
	// build; claiming otherwise would let negotiation advertise a path that
	// cannot exist.
	if (stateRef.encoding !== "float32-vector") {
		throw new Error(`representation-mismatch: state payload encoding ${JSON.stringify(stateRef.encoding)} cannot be consumed in this build; only float32-vector is decodable`);
	}
	// The store re-verifies the payload's digest on every read; the envelope's
	// sha256 is then checked against the same bytes, so a ref naming one object
	// while claiming another's digest is refused rather than trusted.
	let payload: Uint8Array;
	try {
		payload = deps.contentStore.read(stateRef.payloadId);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		// The store already classifies: a missing object is unavailability, a
		// digest mismatch is corruption. Both keep their category here instead of
		// being relabelled, so the run log's fixed vocabulary stays truthful.
		if (detail.startsWith("integrity:")) throw new Error(detail);
		throw new Error(`object-unavailable: state payload ${stateRef.payloadId} cannot be read: ${detail}`);
	}
	if (sha256Hex(payload) !== stateRef.sha256) {
		throw new Error(`integrity: state payload ${stateRef.payloadId} does not match the envelope's sha256 ${stateRef.sha256}`);
	}
	if (payload.byteLength !== stateRef.byteLength) {
		throw new Error(`integrity: state payload ${stateRef.payloadId} holds ${payload.byteLength} bytes, the envelope declared ${stateRef.byteLength}`);
	}
	const queryVector = decodeFloat32LE(payload, `state payload ${stateRef.payloadId}`);
	if (queryVector.length !== stateRef.dim) {
		throw new Error(`integrity: state payload ${stateRef.payloadId} holds ${queryVector.length} floats, the envelope declared dim ${stateRef.dim}`);
	}

	const corpus = loadCorpusVectors(deps.storageRoot, input.corpusSnapshotId, stateRef.dim, stateRef.representationId);
	// The zero-norm refusal lives inside the ranking now; the payload keeps its
	// own message because the id is what a reader can act on.
	if (normOf(queryVector) === 0) {
		throw new Error(`integrity: state payload ${stateRef.payloadId} is an all-zero vector; cosine against it is undefined`);
	}
	const hits = rankCorpusChunks(corpus, queryVector, input.k);

	// Consumption is the receipt that proves the state was used: only a
	// retrieval that ranked the corpus is counted, and send/receive alone
	// never is (spec §10.1). The stateId key is the payload id by contract —
	// P3-5's send/receive events must use the same value or the
	// receivedWithoutConsume reconciliation counts states that were consumed.
	deps.metering?.log.record(deps.metering.identity, {
		corpusSnapshotId: input.corpusSnapshotId,
		k: input.k,
		kind: "state-consume",
		ok: true,
		payloadBytes: stateRef.byteLength,
		payloadId: stateRef.payloadId,
		representationId: stateRef.representationId,
		stateId: stateRef.payloadId,
	});
	return { corpusSnapshotId: input.corpusSnapshotId, hits, representationId: stateRef.representationId };
}
