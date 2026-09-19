import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalDigest } from "./canonical-json.ts";
import type { SynapseMode } from "./config.ts";
import type { SynapseErrorClassification } from "./errors.ts";
import type { StateFallbackReason } from "./state-payload.ts";

/**
 * Append-only measurement log and its aggregation.
 *
 * The log is the primary record and the aggregate is derived: totals can be
 * recomputed from the raw lines at any time, and a line is never rewritten.
 * That is what lets a finished experiment be re-scored without re-running it.
 *
 * Two rules shape every counter here. A quantity that was not reported is
 * `unavailable`, never zero — a provider that omits usage must not look like a
 * run that used nothing. And nothing is counted twice: bytes are attributed
 * where they were spent, the receiving side never adds to the sent totals, and
 * a duplicated delivery record is recognised as duplication rather than volume.
 */

export const SYNAPSE_METERING_SCHEMA_VERSION = 1;

/** A number that was never reported, as distinct from a reported zero. */
export type Unavailable = "unavailable";
/** A quantity this deployment cannot produce at all, such as socket bytes. */
export type NotApplicable = "N/A";

export type ModelUsage = {
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	input: number;
	output: number;
};

export type MeteringIdentity = {
	agent: string;
	attempt: number;
	mode: SynapseMode;
	nodeId: string;
	runId: string;
	sessionId: string;
	snapshotId: string | null;
};

export type MeteringPayload =
	| { envelopeBytes: number; kind: "message-delivered"; messageId: string; textBytes: number }
	| { kind: "message-received"; messageId: string }
	| { category: SynapseErrorClassification; kind: "message-failed"; messageId: string }
	| {
			/**
			 * Which encoding crossed. Optional so events written before the delta path
			 * existed still parse; a reader aggregating delta bytes must treat a missing
			 * value as the full-vector path rather than as "unknown".
			 */
			encoding?: "delta" | "float32-vector";
			/**
			 * Why a full vector was sent where a residual was possible; set only on the
			 * sender's own events. This is the trigger-rate evidence: without it, a
			 * situation where the residual path never engages is indistinguishable from
			 * one where it engages and loses.
			 */
			fallbackReason?: StateFallbackReason;
			kind: "state-prepare" | "state-send" | "state-receive";
			/**
			 * Set on the send half of a recovery hop, so a reader can see that this
			 * particular delivery was a retry. The count lives on `state-restore`: a hop
			 * is one event there, and counting it here as well would double it.
			 */
			restore?: "resend" | "full-vector";
			ok: boolean;
			payloadBytes: number;
			representationId: string;
			stateId: string;
		}
	| {
			/** The corpus snapshot the state was ranked against; only a real retrieval consumes. */
			corpusSnapshotId: string;
			/** Which encoding was consumed; optional for events written before delta existed. */
			encoding?: "delta" | "float32-vector";
			/** How many corpus chunks the consumer asked to rank. */
			k: number;
			kind: "state-consume";
			ok: boolean;
			payloadBytes: number;
			/** The CAS object the decoded vector came from. */
			payloadId: string;
			representationId: string;
			stateId: string;
		}
	| {
			/**
			 * One recovery hop actually taken: `resend` repeated the same bytes,
			 * `full-vector` replaced an unrebuildable residual, `text` left the state
			 * plane for a re-embedded search. Recorded whether or not the hop worked,
			 * because "how often did the state plane need recovering" is a question
			 * about attempts, not about successes.
			 */
			hop: "full-vector" | "resend" | "text";
			kind: "state-restore";
			ok: boolean;
		}
	| { kind: "model-usage"; role: "parent" | "child"; usage: ModelUsage | null }
	| { costUsd: number | null; durationMs: number; inputTokens: number | null; kind: "embedding-call"; ok: boolean; requests: number }
	| { authorisedValidHits: number; kind: "memory-query"; queryId: string }
	| { kind: "memory-reuse"; memoryId: string; sourceAgent: string }
	| {
			bytes: number;
			direction: "read" | "write";
			kind: "object-io";
			/**
			 * Why the bytes moved, for the reads that are a cost of the residual path
			 * rather than of the memory path. `base-rebuild` is a receiver rebuilding
			 * the base a residual names; `base-selection` is a sender ranking its own
			 * records to pick one. Absent means an ordinary content or corpus read,
			 * which is the only thing a pre-delta event could have been.
			 */
			purpose?: "base-rebuild" | "base-selection" | "ranking";
		}
	| { kind: "task-span"; phase: "start" | "end"; taskId: string }
	| { category: SynapseErrorClassification; detail: string; kind: "error" };

export type MeteringEvent = MeteringIdentity &
	MeteringPayload & {
		eventId: string;
		monotonicMs: number;
		schemaVersion: number;
		ts: string;
	};

export type MeteringLogOptions = {
	monotonicMs?: () => number;
	now?: () => Date;
};

export type MeteringLog = {
	path: string;
	record: (identity: MeteringIdentity, payload: MeteringPayload) => MeteringEvent;
};

export function createMeteringLog(logPath: string, options: MeteringLogOptions = {}): MeteringLog {
	const now = options.now ?? (() => new Date());
	const started = process.hrtime.bigint();
	const monotonicMs = options.monotonicMs ?? (() => Number((process.hrtime.bigint() - started) / 1_000_000n));

	return {
		path: logPath,
		record(identity: MeteringIdentity, payload: MeteringPayload): MeteringEvent {
			const body = { ...identity, ...payload, monotonicMs: monotonicMs(), schemaVersion: SYNAPSE_METERING_SCHEMA_VERSION, ts: now().toISOString() };
			// A nonce keeps two genuinely separate events with identical content
			// distinguishable; without it a repeated send would look like one event
			// written twice, which is the opposite of what the log must show.
			const event: MeteringEvent = { ...body, eventId: canonicalDigest({ ...body, nonce: randomUUID() }) };
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf-8");
			return event;
		},
	};
}

export function readMeteringLog(logPath: string): MeteringEvent[] {
	let raw = "";
	try {
		raw = fs.readFileSync(logPath, "utf-8");
	} catch {
		return [];
	}
	const events: MeteringEvent[] = [];
	for (const [index, line] of raw.split("\n").entries()) {
		if (line.trim().length === 0) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// A line that cannot be read is missing evidence, not absent evidence.
			throw new Error(`integrity: metering log line ${index + 1} is not valid JSON`);
		}
	}
	return events;
}

export type UsageTotals = {
	cacheRead: number | Unavailable;
	cacheWrite: number | Unavailable;
	input: number | Unavailable;
	output: number | Unavailable;
};

export type MeteringTotals = {
	control: { envelopeBytes: number; transportBytes: NotApplicable };
	duration: { byTask: Record<string, number | Unavailable>; totalMs: number | Unavailable; unfinishedTasks: string[] };
	embedding: { costUsd: number | Unavailable; durationMs: number; failed: number; inputTokens: number | Unavailable; requests: number };
	errors: Record<string, number>;
	memory: { crossAgentReuses: number; hitRate: number | NotApplicable; queries: number; reuses: number };
	messages: { delivered: number; duplicateDeliveries: number; failed: number; received: number };
	model: { child: UsageTotals; complete: boolean; parent: UsageTotals; totalCost: number | Unavailable };
	state: {
		/** Receiver-side reads that rebuilt a residual's base: the delta path's own cost. */
		baseReadBytes: number;
		/** Sender-side reads that ranked records to choose a base: a cost of selecting one. */
		baseSelectionReadBytes: number;
		consumed: number;
		/**
		 * Payload bytes that were SENT as a residual. Deliberately the sending side's
		 * figure, the same side `sentBytes` counts: receive and consume observe the
		 * same message again, so adding them would report one message as three. Whether
		 * a residual was consumed is answered by `consumed` and by `decodeDelta:` errors,
		 * not by inflating this number.
		 */
		deltaPayloadBytes: number;
		failedSends: number;
		prepared: number;
		received: number;
		receivedWithoutConsume: number;
		/** Recovery hops taken, by any kind including the text fallback: one `state-restore` event each. */
		restoreCount: number;
		sent: number;
		sentBytes: number;
	};
	storage: { readBytes: number; writeBytes: number };
	text: { handoffBytes: number };
};

type UsageAccumulator = { cacheRead: number; cacheWrite: number; cost: number; input: number; missing: boolean; output: number; reported: boolean };

function emptyUsage(): UsageAccumulator {
	return { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, missing: false, output: 0, reported: false };
}

function projectUsage(accumulated: UsageAccumulator): UsageTotals {
	if (accumulated.missing || !accumulated.reported) {
		return { cacheRead: "unavailable", cacheWrite: "unavailable", input: "unavailable", output: "unavailable" };
	}
	return { cacheRead: accumulated.cacheRead, cacheWrite: accumulated.cacheWrite, input: accumulated.input, output: accumulated.output };
}

export function aggregateMetering(events: readonly MeteringEvent[]): MeteringTotals {
	const deliveredKeys = new Set<string>();
	const parent = emptyUsage();
	const child = emptyUsage();
	const errors: Record<string, number> = {};
	const starts = new Map<string, number>();
	const byTask: Record<string, number | Unavailable> = {};
	const consumedStates = new Set<string>();
	const receivedStates = new Set<string>();
	let embeddingCost = 0;
	let embeddingCostMissing = false;
	let embeddingTokens = 0;
	let embeddingTokensMissing = false;
	let firstMonotonic: number | null = null;
	let lastMonotonic: number | null = null;

	const totals: MeteringTotals = {
		control: { envelopeBytes: 0, transportBytes: "N/A" },
		duration: { byTask, totalMs: "unavailable", unfinishedTasks: [] },
		embedding: { costUsd: 0, durationMs: 0, failed: 0, inputTokens: 0, requests: 0 },
		errors,
		memory: { crossAgentReuses: 0, hitRate: "N/A", queries: 0, reuses: 0 },
		messages: { delivered: 0, duplicateDeliveries: 0, failed: 0, received: 0 },
		model: { child: projectUsage(child), complete: false, parent: projectUsage(parent), totalCost: 0 },
		state: {
			baseReadBytes: 0,
			baseSelectionReadBytes: 0,
			consumed: 0,
			deltaPayloadBytes: 0,
			failedSends: 0,
			prepared: 0,
			received: 0,
			receivedWithoutConsume: 0,
			restoreCount: 0,
			sent: 0,
			sentBytes: 0,
		},
		storage: { readBytes: 0, writeBytes: 0 },
		text: { handoffBytes: 0 },
	};
	let memoryHits = 0;

	for (const event of events) {
		firstMonotonic = firstMonotonic === null ? event.monotonicMs : Math.min(firstMonotonic, event.monotonicMs);
		lastMonotonic = lastMonotonic === null ? event.monotonicMs : Math.max(lastMonotonic, event.monotonicMs);

		switch (event.kind) {
			case "message-delivered": {
				// Identity includes the attempt, so a retry is a new delivery while a
				// re-recorded delivery of the same attempt is duplication.
				const key = `${event.runId}/${event.nodeId}/${event.attempt}/${event.messageId}`;
				if (deliveredKeys.has(key)) totals.messages.duplicateDeliveries += 1;
				else {
					deliveredKeys.add(key);
					totals.messages.delivered += 1;
				}
				totals.text.handoffBytes += event.textBytes;
				totals.control.envelopeBytes += event.envelopeBytes;
				break;
			}
			case "message-received":
				totals.messages.received += 1;
				break;
			case "message-failed":
				totals.messages.failed += 1;
				errors[event.category] = (errors[event.category] ?? 0) + 1;
				break;
			case "state-prepare":
				if (event.ok) totals.state.prepared += 1;
				break;
			case "state-send":
				// Bytes count on every attempt: a failed send still crossed the wire.
				totals.state.sentBytes += event.payloadBytes;
				if (event.encoding === "delta") totals.state.deltaPayloadBytes += event.payloadBytes;
				if (event.ok) totals.state.sent += 1;
				else totals.state.failedSends += 1;
				break;
			case "state-restore":
				totals.state.restoreCount += 1;
				break;
			case "state-receive":
				if (event.ok) {
					totals.state.received += 1;
					receivedStates.add(event.stateId);
				}
				break;
			case "state-consume":
				if (event.ok) {
					totals.state.consumed += 1;
					consumedStates.add(event.stateId);
				}
				break;
			case "model-usage":
				{
					const target = event.role === "parent" ? parent : child;
					if (event.usage === null) target.missing = true;
					else {
						target.reported = true;
						target.cacheRead += event.usage.cacheRead;
						target.cacheWrite += event.usage.cacheWrite;
						target.cost += event.usage.cost;
						target.input += event.usage.input;
						target.output += event.usage.output;
					}
				}
				break;
			case "embedding-call":
				totals.embedding.requests += event.requests;
				totals.embedding.durationMs += event.durationMs;
				if (!event.ok) totals.embedding.failed += 1;
				if (event.costUsd === null) embeddingCostMissing = true;
				else embeddingCost += event.costUsd;
				if (event.inputTokens === null) embeddingTokensMissing = true;
				else embeddingTokens += event.inputTokens;
				break;
			case "memory-query":
				totals.memory.queries += 1;
				if (event.authorisedValidHits > 0) memoryHits += 1;
				break;
			case "memory-reuse":
				totals.memory.reuses += 1;
				if (event.sourceAgent !== event.agent) totals.memory.crossAgentReuses += 1;
				break;
			case "object-io":
				if (event.direction === "read") totals.storage.readBytes += event.bytes;
				else totals.storage.writeBytes += event.bytes;
				// The residual path's reads are broken out so the full-account
				// comparison does not have to infer them from a storage total that also
				// holds memory, content and corpus traffic.
				if (event.purpose === "base-rebuild") totals.state.baseReadBytes += event.bytes;
				else if (event.purpose === "base-selection") totals.state.baseSelectionReadBytes += event.bytes;
				break;
			case "task-span":
				if (event.phase === "start") starts.set(event.taskId, event.monotonicMs);
				else {
					const start = starts.get(event.taskId);
					// A task spans wall clock. Summing nested work would double-count
					// two children that ran at the same time.
					byTask[event.taskId] = start === undefined ? "unavailable" : event.monotonicMs - start;
					starts.delete(event.taskId);
				}
				break;
			case "error":
				errors[event.category] = (errors[event.category] ?? 0) + 1;
				break;
		}
	}

	for (const taskId of starts.keys()) {
		byTask[taskId] = "unavailable";
		totals.duration.unfinishedTasks.push(taskId);
	}
	totals.duration.unfinishedTasks.sort();
	totals.duration.totalMs = firstMonotonic === null || lastMonotonic === null ? "unavailable" : lastMonotonic - firstMonotonic;

	totals.memory.hitRate = totals.memory.queries === 0 ? "N/A" : memoryHits / totals.memory.queries;
	totals.embedding.costUsd = embeddingCostMissing ? "unavailable" : embeddingCost;
	totals.embedding.inputTokens = embeddingTokensMissing ? "unavailable" : embeddingTokens;

	totals.model.parent = projectUsage(parent);
	totals.model.child = projectUsage(child);
	// Token savings may only be computed when every required report is present,
	// so completeness is part of the result rather than something a reader has
	// to infer from the absence of a field.
	totals.model.complete = parent.reported && child.reported && !parent.missing && !child.missing;
	totals.model.totalCost = totals.model.complete ? parent.cost + child.cost : "unavailable";

	totals.state.receivedWithoutConsume = [...receivedStates].filter((stateId) => !consumedStates.has(stateId)).length;
	return totals;
}
