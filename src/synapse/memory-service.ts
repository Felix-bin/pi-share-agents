import { createHash } from "node:crypto";
import { isPathInScope, isReadable, requireWritable, type AccessScope } from "./access.ts";
import type { Embedder } from "./embedding.ts";
import { SYNAPSE_VECTOR_MEDIA_TYPE } from "./embedding.ts";
import { createContentStore, type ContentStore } from "./content-store.ts";
import {
	createMemoryStore,
	type MemoryAssurance,
	type MemoryKind,
	type MemoryProvenance,
	type MemoryEmbeddingRef,
	type MemoryRecord,
	type MemoryStore,
	type SupersessionEvent,
	type SupersessionReason,
} from "./memory-store.ts";
import type { MeteringIdentity, MeteringLog } from "./metering.ts";
import { selectPredictedBase, type PredictedBase } from "./predict-base.ts";
import { searchMemories, type MemoryQuery, type SemanticComponent, type SemanticScoring } from "./retrieval.ts";
import { captureSource, checkSource } from "./source-fingerprint.ts";
import type { StateRef } from "./envelope.ts";
import { retrieveWithState, type StateRetrievalResult } from "./state-retrieval.ts";

/**
 * Host-side implementation of the model-visible `synapse_read` / `synapse_write`
 * tools.
 *
 * Identity is supplied by the host, never by the caller: the model chooses what
 * to remember, not who remembered it. Every read is authorised before anything
 * about the record is returned, summaries included, and validity is recomputed
 * from the bytes on disk rather than trusted from the record.
 */

export const SYNAPSE_DEFAULT_SEARCH_K = 5;
export const SYNAPSE_MAX_SEARCH_K = 20;
export const SYNAPSE_MAX_GET_BYTES = 16 * 1024;
export const SYNAPSE_MAX_SUMMARY_BYTES = 2048;

/** Whether the source behind a record still says what the record says it said. */
export type MemoryValidity = "current" | "stale" | "unavailable";

export type MemoryServiceOptions = {
	/** The corpus a stateId search ranks; null (the default) keeps the state path off. */
	corpusSnapshotId?: string | null;
	/** When present, remember embeds each record and stores the vector in the CAS. */
	embedder?: Embedder;
	maxLoadedRecords?: number;
	/** Paired log and identity for the service's own metering (vector object writes). */
	metering?: { identity: MeteringIdentity; log: MeteringLog };
	maxObjectBytes?: number;
	now?: () => Date;
	provenance: MemoryProvenance;
	scope: AccessScope;
	storeRoot: string;
	worktreeRoot: string;
};

export type RememberInput = {
	content: string;
	kind: MemoryKind;
	operationId: string;
	sourcePath?: string;
	summary: string;
	tags: string[];
	topic: string;
};

export type RememberResult = {
	record: MemoryRecord;
	validity: MemoryValidity;
};

export type SearchInput = {
	includeHistorical?: boolean;
	k?: number;
	query?: string;
	/** State-plane retrieval: the CAS payload id a received envelope carried. */
	stateId?: string;
	/** The envelope's verification material for that payload; required with stateId. */
	stateRef?: StateRef;
	tags?: string[];
};

export type SearchHit = {
	assurance: MemoryAssurance;
	components: { keyword: number; semantic: SemanticComponent; tag: number };
	/** The bytes this memory is about, so a handoff can name what it carries. */
	contentId: string;
	createdAt: string;
	historical: boolean;
	memoryId: string;
	score: number;
	sourceAgent: string;
	sourcePath: string | null;
	summary: string;
	tags: string[];
	taskTopic: string;
	validity: MemoryValidity;
};

export type SearchResult = {
	results: SearchHit[];
	/** "ok" when the ranking carried measured cosine values, else "unavailable". */
	semantic: "ok" | "unavailable";
};

export type GetInput = {
	allowHistorical?: boolean;
	limitBytes?: number;
	memoryId: string;
	offsetBytes?: number;
};

export type GetResult = {
	historical: boolean;
	memoryId: string;
	nextOffsetBytes: number;
	text: string;
	totalBytes: number;
	validity: MemoryValidity;
};

export type ServiceSupersedeInput = {
	newId: string;
	oldId: string;
	reason: SupersessionReason;
};

/**
 * Query ranking over shared memory, or — when the input carries a stateId —
 * consumption of a received state vector against the pinned corpus. The two
 * overloads make the shape follow the input at the type level: a stateId
 * search yields corpus hits, a query search yields memory rankings, and
 * neither borrows the other's shape.
 */
export interface MemoryService {
	get(input: GetInput): GetResult;
	/**
	 * The predicted base a delta handoff would encode against: the ranking's
	 * first record that still owns a usable vector, or null when none does.
	 * Selection is `selectPredictedBase`, so this method and the calibration
	 * that froze the delta parameters agree on the order by construction.
	 */
	predictBase(query: MemoryQuery): Promise<PredictedBase | null>;
	remember(input: RememberInput): Promise<RememberResult>;
	search(input: SearchInput & { stateId: string }): StateRetrievalResult;
	search(input: SearchInput): SearchResult;
	/**
	 * Semantic ranking for the read tool: embeds the query (two-level cache),
	 * loads each record's digest-verified vector from the CAS, and applies the
	 * frozen 0.3/0.2/0.5 split. Falls back to keyword ranking with the
	 * `unavailable` marker when no embedder is configured. The stateId path
	 * needs no embedder at all — the vector already arrived — so it works here
	 * exactly as in the sync search.
	 */
	searchSemantic(input: SearchInput & { stateId: string }): Promise<StateRetrievalResult>;
	searchSemantic(input: SearchInput): Promise<SearchResult>;
	supersede(input: ServiceSupersedeInput): SupersessionEvent;
}

function utf8Length(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Observation vs derivation is decided by the host from what the record can
 * point at, not by the caller. A record backed by verified source bytes reports
 * an observation; anything else reports a derivation.
 */
function assuranceOf(kind: MemoryKind, hasSource: boolean): MemoryAssurance {
	return hasSource && (kind === "evidence" || kind === "tool-result") ? "observation" : "derived";
}

export function createMemoryService(options: MemoryServiceOptions): MemoryService {
	const now = options.now ?? (() => new Date());
	const contentStore: ContentStore = createContentStore(options.storeRoot, { maxObjectBytes: options.maxObjectBytes });
	const memoryStore: MemoryStore = createMemoryStore(options.storeRoot, {
		contentStore,
		maxLoadedRecords: options.maxLoadedRecords,
		now,
	});

	function validityOf(record: MemoryRecord): MemoryValidity {
		if (record.source === null) return "current";
		const checked = checkSource(options.worktreeRoot, record.source);
		return checked.status === "current" ? "current" : checked.status === "stale" ? "stale" : "unavailable";
	}

	/**
	 * The records that may take part in a semantic ranking, with their vectors
	 * loaded from the content store. Authorisation runs before any read, so a
	 * denied record's corrupt object cannot fail a search that would never have
	 * shown it, and a record embedded under another representation is left out
	 * rather than scored with a foreign cosine.
	 */
	function loadRecordVectors(records: readonly MemoryRecord[], embedder: Embedder): Map<string, Float32Array> {
		const recordVectors = new Map<string, Float32Array>();
		for (const record of records) {
			if (record.embedding === null) continue;
			if (!isReadable(record, options.scope)) continue;
			if (record.embedding.representationId !== embedder.representationId) continue;
			// The store re-verifies the digest on every read. An unreadable object
			// (missing, digest mismatch), bytes that are not a whole number of
			// float32 values, or a float count that contradicts the record are
			// corruption and are reported together with the record that points at
			// them.
			let bytes: Uint8Array;
			try {
				bytes = contentStore.read(record.embedding.objectId);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				throw new Error(`integrity: vector object ${record.embedding.objectId} for memory ${record.memoryId} cannot be read: ${detail}`);
			}
			if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
				throw new Error(
					`integrity: vector object ${record.embedding.objectId} for memory ${record.memoryId} holds ${bytes.byteLength} bytes, not a whole number of float32 values`,
				);
			}
			const vector = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
			if (vector.length !== record.embedding.dim) {
				throw new Error(
					`integrity: vector object ${record.embedding.objectId} for memory ${record.memoryId} holds ${vector.length} floats, record claims ${record.embedding.dim}`,
				);
			}
			for (let index = 0; index < vector.length; index += 1) {
				if (!Number.isFinite(vector[index]!)) {
					throw new Error(
						`integrity: vector object ${record.embedding.objectId} for memory ${record.memoryId} holds a non-finite value at index ${index}`,
					);
				}
			}
			options.metering?.log.record(options.metering.identity, { bytes: bytes.byteLength, direction: "read", kind: "object-io" });
			recordVectors.set(record.memoryId, vector);
		}
		return recordVectors;
	}

	function rankMemories(input: SearchInput, k: number, semantic: SemanticScoring | undefined, records?: readonly MemoryRecord[]): SearchResult {
		const ranked = searchMemories({
			includeSuperseded: input.includeHistorical === true,
			limit: k,
			query: { tags: input.tags, text: input.query ?? "" },
			// A caller that already listed the records (the semantic path) passes them
			// in, so a search never scans the store twice.
			records: records ?? memoryStore.list({ includeSuperseded: input.includeHistorical === true }),
			scope: options.scope,
			semantic,
		});
		return {
			results: ranked.map((entry) => ({
				assurance: entry.record.assurance,
				components: entry.components,
				contentId: entry.record.contentId,
				createdAt: entry.record.createdAt,
				historical: entry.historical,
				memoryId: entry.record.memoryId,
				score: entry.score,
				sourceAgent: entry.record.provenance.agent,
				sourcePath: entry.record.source?.path ?? null,
				summary: entry.record.summary,
				tags: entry.record.tags,
				taskTopic: entry.record.taskTopic,
				validity: validityOf(entry.record),
			})),
			semantic: semantic === undefined ? "unavailable" : "ok",
		};
	}

	/**
	 * Shared front-door validation for both search entry points; returns the
	 * effective k. Query and stateId are mutually exclusive inputs: a caller
	 * that supplies both is confused about which plane it is searching, and a
	 * stateId without its envelope material cannot be verified at all.
	 */
	function validateSearchInput(input: SearchInput): number {
		if (input.stateId !== undefined && input.query !== undefined) {
			throw new Error("query-required: supply exactly one of query or stateId, not both");
		}
		if (input.stateId === undefined && input.query === undefined) {
			throw new Error("query-required: supply query or stateId");
		}
		if (input.stateId !== undefined) {
			const stateRef = input.stateRef;
			if (stateRef === undefined) {
				throw new Error("stateRef-required: a stateId search requires the envelope's stateRef verification material");
			}
			if (stateRef.payloadId !== input.stateId) {
				throw new Error(`integrity: stateId ${input.stateId} does not match stateRef.payloadId ${stateRef.payloadId}`);
			}
		}
		const k = input.k ?? SYNAPSE_DEFAULT_SEARCH_K;
		if (!Number.isInteger(k) || k < 1 || k > SYNAPSE_MAX_SEARCH_K) {
			throw new Error(`k-out-of-range: ${k} is not an integer in 1..${SYNAPSE_MAX_SEARCH_K}`);
		}
		return k;
	}

	/** The stateId path: decode the verified payload and rank the pinned corpus. */
	function stateSearch(stateRef: StateRef, k: number): StateRetrievalResult {
		const pinned = options.corpusSnapshotId;
		if (pinned === null || pinned === undefined) {
			throw new Error("synapse.corpusSnapshotId is not configured; state retrieval needs a pinned corpus snapshot");
		}
		return retrieveWithState(
			{ contentStore, metering: options.metering, storageRoot: options.storeRoot },
			{ corpusSnapshotId: pinned, k, stateRef },
		);
	}

	function authorisedRecord(memoryId: string): MemoryRecord {
		const record = memoryStore.get(memoryId);
		if (!isReadable(record, options.scope)) {
			// Reported the same way as a write refusal, so probing for a record's
			// existence tells the caller nothing it is not allowed to know.
			throw new Error(`not-authorised: ${options.scope.agent} may not read ${memoryId}`);
		}
		return record;
	}

	// The overloads make the output shape follow the input shape at each call
	// site; the one wide implementation below is what both overloads narrow.
	function search(input: SearchInput & { stateId: string }): StateRetrievalResult;
	function search(input: SearchInput): SearchResult;
	function search(input: SearchInput): SearchResult | StateRetrievalResult {
		const k = validateSearchInput(input);
		if (input.stateId !== undefined && input.stateRef !== undefined) return stateSearch(input.stateRef, k);
		return rankMemories(input, k, undefined);
	}

	async function searchSemantic(input: SearchInput & { stateId: string }): Promise<StateRetrievalResult>;
	async function searchSemantic(input: SearchInput): Promise<SearchResult>;
	async function searchSemantic(input: SearchInput): Promise<SearchResult | StateRetrievalResult> {
		const k = validateSearchInput(input);
		// The state path is fully local — payload, corpus and arithmetic — so it
		// needs no embedder and cannot be degraded by a provider outage.
		if (input.stateId !== undefined && input.stateRef !== undefined) return stateSearch(input.stateRef, k);
		if (options.embedder === undefined) return rankMemories(input, k, undefined);
		const embedder = options.embedder;
		// validateSearchInput has already rejected an undefined query.
		const query = input.query ?? "";
		// An empty query has no text to embed: ranking stays on keyword and tag
		// rather than spending an embedding call on an empty string.
		if (query.trim() === "") return rankMemories(input, k, undefined);
		const records = memoryStore.list({ includeSuperseded: input.includeHistorical === true });
		const recordVectors = loadRecordVectors(records, embedder);
		// No usable vectors at all means the semantic component never took part:
		// report it unavailable instead of stamping "ok" on a keyword ranking.
		if (recordVectors.size === 0) return rankMemories(input, k, undefined, records);
		// A provider outage must not take keyword retrieval down with it: the
		// search falls back with the unavailable marker. When a metering log is
		// attached, the failed embedding-call event stays in it as the record of
		// what happened. The write path deliberately does not degrade — a memory
		// stored without its vector would be a permanent semantic blind spot,
		// so remember propagates the failure instead.
		const embedded = await embedder.embedQuery(query).catch(() => null);
		if (embedded === null) return rankMemories(input, k, undefined, records);
		// A stored vector that disagrees with the query dimension despite a
		// matching representation is corrupt; the record degrades to a zero
		// component rather than aborting the whole search.
		for (const [memoryId, vector] of recordVectors) {
			if (vector.length !== embedded.vector.length) recordVectors.delete(memoryId);
		}
		if (recordVectors.size === 0) return rankMemories(input, k, undefined, records);
		return rankMemories(input, k, { queryVector: embedded.vector, recordVectors }, records);
	}

	return {
		get(input: GetInput): GetResult {
			const record = authorisedRecord(input.memoryId);
			const historical = record.recordStatus !== "active";
			if (historical && input.allowHistorical !== true) {
				throw new Error(`historical: ${input.memoryId} was superseded; pass allowHistorical to read it anyway`);
			}
			const limit = Math.min(input.limitBytes ?? SYNAPSE_MAX_GET_BYTES, SYNAPSE_MAX_GET_BYTES);
			const range = contentStore.readTextRange(record.contentId, input.offsetBytes ?? 0, limit);
			return {
				historical,
				memoryId: record.memoryId,
				nextOffsetBytes: range.nextOffsetBytes,
				text: range.text,
				totalBytes: range.totalBytes,
				validity: validityOf(record),
			};
		},

		/**
		 * A provider outage propagates here instead of degrading to a keyword
		 * order. Calibration validity depends on the base coming from the very
		 * ranking the retrieval path reports; a base picked from a different order
		 * would be a different experiment, and the caller's honest fallback is a
		 * full vector, not a quieter base.
		 */
		async predictBase(query: MemoryQuery): Promise<PredictedBase | null> {
			const embedder = options.embedder;
			// No embedder means no query vector, and no empty query has one either.
			if (embedder === undefined || query.text.trim() === "") return null;
			const records = memoryStore.list({ includeSuperseded: false });
			const recordVectors = loadRecordVectors(records, embedder);
			if (recordVectors.size === 0) return null;
			const embedded = await embedder.embedQuery(query.text);
			// A stored vector whose dimension disagrees with the query's despite a
			// matching representation is corrupt; the record drops out rather than
			// aborting the selection.
			for (const [memoryId, vector] of recordVectors) {
				if (vector.length !== embedded.vector.length) recordVectors.delete(memoryId);
			}
			return selectPredictedBase({ query, records, scope: options.scope, semantic: { queryVector: embedded.vector, recordVectors }, validityOf });
		},

		async remember(input: RememberInput): Promise<RememberResult> {
			requireWritable(options.scope);
			if (utf8Length(input.summary) > SYNAPSE_MAX_SUMMARY_BYTES) {
				throw new Error(`summary-too-large: ${utf8Length(input.summary)} > ${SYNAPSE_MAX_SUMMARY_BYTES}`);
			}
			let source: MemoryRecord["source"] = null;
			if (input.sourcePath !== undefined) {
				const captured = captureSource(options.worktreeRoot, input.sourcePath);
				if (captured.status === "unavailable") {
					throw new Error(`${captured.reason}: ${input.sourcePath}`);
				}
				source = captured.fingerprint;
				// The grant is checked against the fingerprint just taken, so a record
				// can never be filed under a path the writer may not reach.
				if (!isPathInScope(source.path, options.scope)) {
					throw new Error(`not-authorised: ${options.scope.agent} may not record ${input.sourcePath}`);
				}
			}
			const contentId = contentStore.put(new TextEncoder().encode(input.content), "text/plain");
			// The embedded text is the deterministic concatenation taskTopic + "\n" +
			// summary: the same record inputs always produce the same embedding input.
			let embedding: MemoryEmbeddingRef | undefined;
			if (options.embedder !== undefined) {
				const embedded = await options.embedder.embedQuery(`${input.topic}\n${input.summary}`);
				const vectorBytes = new Uint8Array(embedded.vector.buffer, embedded.vector.byteOffset, embedded.vector.byteLength);
				// Bytes are attributed only where they were spent: a put that would land
				// on an already-stored object (retry, warm L2) writes nothing and must
				// not inflate storage.writeBytes. The content id is the sha-256 of the
				// bytes, the same digest the store addresses objects by.
				const vectorId = createHash("sha256").update(vectorBytes).digest("hex");
				const isNewVector = !contentStore.has(vectorId);
				const objectId = contentStore.put(vectorBytes, SYNAPSE_VECTOR_MEDIA_TYPE);
				embedding = { dim: embedded.vector.length, objectId, representationId: options.embedder.representationId };
				if (isNewVector) {
					options.metering?.log.record(options.metering.identity, { bytes: vectorBytes.byteLength, direction: "write", kind: "object-io" });
				}
			}
			const record = memoryStore.publish({
				assurance: assuranceOf(input.kind, source !== null),
				contentId,
				embedding,
				kind: input.kind,
				operationId: input.operationId,
				provenance: options.provenance,
				source: source ?? undefined,
				summary: input.summary,
				tags: input.tags,
				taskTopic: input.topic,
			});
			return { record, validity: validityOf(record) };
		},

		search,

		searchSemantic,

		supersede(input: ServiceSupersedeInput): SupersessionEvent {
			requireWritable(options.scope);
			const oldRecord = authorisedRecord(input.oldId);
			authorisedRecord(input.newId);
			const sourceChange =
				oldRecord.source === null
					? undefined
					: {
							after: checkSourceDigest(options.worktreeRoot, oldRecord),
							before: oldRecord.source.digest,
							path: oldRecord.source.path,
						};
			return memoryStore.supersede({ host: options.scope.agent, newId: input.newId, oldId: input.oldId, reason: input.reason, sourceChange });
		},
	};
}

function checkSourceDigest(worktreeRoot: string, record: MemoryRecord): string {
	if (record.source === null) return "";
	const checked = checkSource(worktreeRoot, record.source);
	if (checked.status === "stale") return checked.current.digest;
	if (checked.status === "current") return record.source.digest;
	return "";
}
