import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { writeAtomicJson } from "../shared/atomic-json.ts";
import { canonicalDigest } from "./canonical-json.ts";
import type { ContentStore } from "./content-store.ts";
import type { SourceFingerprint } from "./source-fingerprint.ts";

/**
 * Immutable record log for SYNAPSE shared memory.
 *
 * Records, supersession events and objects are separate immutable files. A
 * record is published only after its body is proven present, so a reader never
 * follows a reference into nothing; an orphan discovered later is reported
 * rather than skipped, because silently dropping it would understate what the
 * run actually depended on.
 *
 * Status is not stored in the record. It is derived by replaying supersession
 * events at load time, which is what keeps records immutable while still
 * letting a later observation retire an earlier one.
 */

export const SYNAPSE_DEFAULT_MAX_LOADED_RECORDS = 1000;

const MEMORY_KINDS = ["evidence", "tool-result", "conclusion", "strategy"] as const;
const MEMORY_ASSURANCES = ["observation", "derived"] as const;
const SUPERSESSION_REASONS = ["source-changed", "superseded-by-newer-observation", "corrected"] as const;
const ID_PATTERN = "^[0-9a-f]{64}$";
const RECORD_SUFFIX = ".json";

export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * How much the record claims for itself. There is deliberately no third value:
 * a record can report what was observed or what was derived, but it can never
 * assert that it was accepted (§6.3).
 */
export type MemoryAssurance = (typeof MEMORY_ASSURANCES)[number];

/** Effective status after replaying supersession events. */
export type MemoryStatus = "active" | "superseded" | "conflict";

export type MemoryProvenance = {
	agent: string;
	attempt: number;
	runId: string;
	sessionId: string;
};

export type MemoryRecord = {
	assurance: MemoryAssurance;
	contentId: string;
	createdAt: string;
	kind: MemoryKind;
	memoryId: string;
	provenance: MemoryProvenance;
	recordStatus: MemoryStatus;
	source: SourceFingerprint | null;
	summary: string;
	tags: string[];
	taskTopic: string;
};

export type MemoryPublishInput = {
	assurance: MemoryAssurance;
	contentId: string;
	kind: MemoryKind;
	/**
	 * Identity of the logical operation that produced this record. A retry of the
	 * same operation must pass the same value so it lands on the same record
	 * instead of duplicating an observation.
	 */
	operationId: string;
	provenance: MemoryProvenance;
	source?: SourceFingerprint;
	summary: string;
	tags: string[];
	taskTopic: string;
};

export type SupersessionReason = (typeof SUPERSESSION_REASONS)[number];

export type SupersessionInput = {
	host: string;
	newId: string;
	oldId: string;
	reason: SupersessionReason;
	sourceChange?: { after: string; before: string; path: string };
};

export type SupersessionEvent = SupersessionInput & { eventId: string; recordedAt: string };

export type MemoryListOptions = {
	includeSuperseded?: boolean;
};

export type MemoryStoreOptions = {
	contentStore: ContentStore;
	maxLoadedRecords?: number;
	now?: () => Date;
};

export type MemoryStore = {
	get: (memoryId: string) => MemoryRecord;
	list: (options?: MemoryListOptions) => MemoryRecord[];
	publish: (input: MemoryPublishInput) => MemoryRecord;
	recordPath: (memoryId: string) => string;
	status: (memoryId: string) => MemoryStatus;
	supersede: (input: SupersessionInput) => SupersessionEvent;
};

const ProvenanceSchema = Type.Object(
	{
		agent: Type.String({ minLength: 1 }),
		attempt: Type.Integer({ minimum: 0 }),
		runId: Type.String({ minLength: 1 }),
		sessionId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const FingerprintSchema = Type.Object(
	{
		byteLength: Type.Integer({ minimum: 0 }),
		digest: Type.String({ pattern: ID_PATTERN }),
		path: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const RecordSchema = Type.Object(
	{
		assurance: Type.Union([Type.Literal("observation"), Type.Literal("derived")]),
		contentId: Type.String({ pattern: ID_PATTERN }),
		createdAt: Type.String({ minLength: 20 }),
		kind: Type.Union([Type.Literal("evidence"), Type.Literal("tool-result"), Type.Literal("conclusion"), Type.Literal("strategy")]),
		memoryId: Type.String({ pattern: ID_PATTERN }),
		provenance: ProvenanceSchema,
		recordStatus: Type.Literal("active"),
		source: Type.Union([FingerprintSchema, Type.Null()]),
		summary: Type.String(),
		tags: Type.Array(Type.String()),
		taskTopic: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const EventSchema = Type.Object(
	{
		eventId: Type.String({ pattern: ID_PATTERN }),
		host: Type.String({ minLength: 1 }),
		newId: Type.String({ pattern: ID_PATTERN }),
		oldId: Type.String({ pattern: ID_PATTERN }),
		reason: Type.Union([Type.Literal("source-changed"), Type.Literal("superseded-by-newer-observation"), Type.Literal("corrected")]),
		recordedAt: Type.String({ minLength: 20 }),
		sourceChange: Type.Optional(
			Type.Object(
				{ after: Type.String(), before: Type.String(), path: Type.String() },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

const recordValidator = Compile(RecordSchema);
const eventValidator = Compile(EventSchema);

function assertKnownKind(kind: MemoryKind): void {
	if (!MEMORY_KINDS.includes(kind)) {
		throw new Error(`unsupported memory kind: ${JSON.stringify(kind)}`);
	}
}

function assertKnownAssurance(assurance: MemoryAssurance): void {
	if (!MEMORY_ASSURANCES.includes(assurance)) {
		throw new Error(`unsupported memory assurance: ${JSON.stringify(assurance)}`);
	}
}

function assertId(label: string, id: string): void {
	if (!new RegExp(ID_PATTERN).test(id)) {
		throw new Error(`invalid ${label}: ${JSON.stringify(id)}`);
	}
}

function readJsonFiles(dir: string): string[] {
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	// Temp files from an interrupted publication are dot-prefixed and never a
	// bare id, so ignoring anything that is not `<64 hex>.json` is enough.
	return entries.filter((entry) => entry.endsWith(RECORD_SUFFIX) && new RegExp(ID_PATTERN).test(entry.slice(0, -RECORD_SUFFIX.length)));
}

export function createMemoryStore(rootDir: string, options: MemoryStoreOptions): MemoryStore {
	const maxLoadedRecords = options.maxLoadedRecords ?? SYNAPSE_DEFAULT_MAX_LOADED_RECORDS;
	const now = options.now ?? (() => new Date());
	const recordsDir = path.join(rootDir, "memory");
	const eventsDir = path.join(rootDir, "supersessions");

	function recordPath(memoryId: string): string {
		assertId("memory id", memoryId);
		return path.join(recordsDir, `${memoryId}${RECORD_SUFFIX}`);
	}

	function readRecord(memoryId: string): MemoryRecord {
		let raw = "";
		try {
			raw = fs.readFileSync(recordPath(memoryId), "utf-8");
		} catch {
			throw new Error(`unknown-memory: ${memoryId}`);
		}
		const parsed = JSON.parse(raw);
		if (!recordValidator.Check(parsed)) {
			throw new Error(`integrity: malformed memory record ${memoryId}`);
		}
		if (parsed.memoryId !== memoryId) {
			throw new Error(`integrity: record ${memoryId} claims ${parsed.memoryId}`);
		}
		return parsed;
	}

	function readEvents(): SupersessionEvent[] {
		const events: SupersessionEvent[] = [];
		for (const entry of readJsonFiles(eventsDir)) {
			const parsed = JSON.parse(fs.readFileSync(path.join(eventsDir, entry), "utf-8"));
			if (!eventValidator.Check(parsed)) {
				throw new Error(`integrity: malformed supersession event ${entry}`);
			}
			events.push(parsed);
		}
		return events;
	}

	/**
	 * A record retired by two different successors is a fork. Both successors are
	 * kept and the ancestor is flagged; choosing between them by timestamp or
	 * similarity would be this layer inventing a truth it cannot observe.
	 */
	function statusIndex(): Map<string, MemoryStatus> {
		const successors = new Map<string, Set<string>>();
		for (const event of readEvents()) {
			const known = successors.get(event.oldId) ?? new Set<string>();
			known.add(event.newId);
			successors.set(event.oldId, known);
		}
		const index = new Map<string, MemoryStatus>();
		for (const [oldId, newIds] of successors) {
			index.set(oldId, newIds.size > 1 ? "conflict" : "superseded");
		}
		return index;
	}

	function withStatus(record: MemoryRecord, index: Map<string, MemoryStatus>): MemoryRecord {
		return { ...record, recordStatus: index.get(record.memoryId) ?? "active" };
	}

	return {
		get(memoryId: string): MemoryRecord {
			return withStatus(readRecord(memoryId), statusIndex());
		},

		list(listOptions: MemoryListOptions = {}): MemoryRecord[] {
			const index = statusIndex();
			const loaded: MemoryRecord[] = [];
			for (const entry of readJsonFiles(recordsDir)) {
				const record = withStatus(readRecord(entry.slice(0, -RECORD_SUFFIX.length)), index);
				if (!options.contentStore.has(record.contentId)) {
					throw new Error(`orphan: memory ${record.memoryId} references missing object ${record.contentId}`);
				}
				if (record.recordStatus !== "active" && listOptions.includeSuperseded !== true) continue;
				loaded.push(record);
			}
			loaded.sort((left, right) => {
				if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
				return left.memoryId < right.memoryId ? -1 : 1;
			});
			return loaded.slice(0, maxLoadedRecords);
		},

		publish(input: MemoryPublishInput): MemoryRecord {
			assertKnownKind(input.kind);
			assertKnownAssurance(input.assurance);
			if (!options.contentStore.has(input.contentId)) {
				throw new Error(`object-unavailable: ${input.contentId}`);
			}
			const memoryId = canonicalDigest({
				assurance: input.assurance,
				contentId: input.contentId,
				kind: input.kind,
				operationId: input.operationId,
				provenance: { ...input.provenance },
				taskTopic: input.taskTopic,
			});
			const candidate: MemoryRecord = {
				assurance: input.assurance,
				contentId: input.contentId,
				createdAt: now().toISOString(),
				kind: input.kind,
				memoryId,
				provenance: { ...input.provenance },
				recordStatus: "active",
				source: input.source ?? null,
				summary: input.summary,
				tags: [...input.tags],
				taskTopic: input.taskTopic,
			};
			const target = recordPath(memoryId);
			if (fs.existsSync(target)) {
				const existing = readRecord(memoryId);
				// A retry keeps the original creation time; anything else under the
				// same id means two processes disagree about the same observation.
				const { createdAt: _ignored, ...existingRest } = existing;
				const { createdAt: _alsoIgnored, ...candidateRest } = candidate;
				if (canonicalDigest(existingRest) !== canonicalDigest(candidateRest)) {
					throw new Error(`integrity: memory ${memoryId} already published with different content`);
				}
				return existing;
			}
			fs.mkdirSync(recordsDir, { recursive: true });
			writeAtomicJson(target, candidate);
			return candidate;
		},

		recordPath,

		status(memoryId: string): MemoryStatus {
			readRecord(memoryId);
			return statusIndex().get(memoryId) ?? "active";
		},

		supersede(input: SupersessionInput): SupersessionEvent {
			readRecord(input.oldId);
			readRecord(input.newId);
			const eventId = canonicalDigest({
				host: input.host,
				newId: input.newId,
				oldId: input.oldId,
				reason: input.reason,
				sourceChange: input.sourceChange === undefined ? null : { ...input.sourceChange },
			});
			const target = path.join(eventsDir, `${eventId}${RECORD_SUFFIX}`);
			const event: SupersessionEvent = { ...input, eventId, recordedAt: now().toISOString() };
			if (fs.existsSync(target)) {
				const parsed = JSON.parse(fs.readFileSync(target, "utf-8"));
				if (!eventValidator.Check(parsed)) {
					throw new Error(`integrity: malformed supersession event ${eventId}`);
				}
				return parsed;
			}
			fs.mkdirSync(eventsDir, { recursive: true });
			writeAtomicJson(target, event);
			return event;
		},
	};
}
