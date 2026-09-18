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
import { searchMemories, type SemanticComponent } from "./retrieval.ts";
import { captureSource, checkSource } from "./source-fingerprint.ts";

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
	/** Reserved for the state plane; unavailable until an embedding provider is wired. */
	stateId?: string;
	tags?: string[];
};

export type SearchHit = {
	assurance: MemoryAssurance;
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
	semantic: SemanticComponent;
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

export type MemoryService = {
	get: (input: GetInput) => GetResult;
	remember: (input: RememberInput) => Promise<RememberResult>;
	search: (input: SearchInput) => SearchResult;
	supersede: (input: ServiceSupersedeInput) => SupersessionEvent;
};

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

	function authorisedRecord(memoryId: string): MemoryRecord {
		const record = memoryStore.get(memoryId);
		if (!isReadable(record, options.scope)) {
			// Reported the same way as a write refusal, so probing for a record's
			// existence tells the caller nothing it is not allowed to know.
			throw new Error(`not-authorised: ${options.scope.agent} may not read ${memoryId}`);
		}
		return record;
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

		search(input: SearchInput): SearchResult {
			if (input.stateId !== undefined) {
				throw new Error("capability-unavailable: state-retrieval is not wired in this build");
			}
			if (input.query === undefined) {
				throw new Error("query-required: supply query (stateId is not available in this build)");
			}
			const k = input.k ?? SYNAPSE_DEFAULT_SEARCH_K;
			if (!Number.isInteger(k) || k < 1 || k > SYNAPSE_MAX_SEARCH_K) {
				throw new Error(`k-out-of-range: ${k} is not an integer in 1..${SYNAPSE_MAX_SEARCH_K}`);
			}
			const ranked = searchMemories({
				includeSuperseded: input.includeHistorical === true,
				limit: k,
				query: { tags: input.tags, text: input.query },
				records: memoryStore.list({ includeSuperseded: input.includeHistorical === true }),
				scope: options.scope,
			});
			return {
				results: ranked.map((entry) => ({
					assurance: entry.record.assurance,
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
				semantic: "unavailable",
			};
		},

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
