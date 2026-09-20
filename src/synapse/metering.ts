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

/**
 * Bumped to 2 when `object-io` gained the `payload-read` purpose, and to 3 when the
 * `vector-cache` kind was added. Both changes are additive: every field that existed
 * before kept its meaning, so an older log still aggregates (a component it never
 * recorded is reported as 0) and the frozen full-account definition is unaffected.
 */
export const SYNAPSE_METERING_SCHEMA_VERSION = 3;

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
			/**
			 * Why the state plane had to recover: the classification of the failure that
			 * forced the hop, with `state-verify` split out of `integrity` because the two
			 * need different remedies — a re-send cannot fix a meaning that drifted — and
			 * because a recovered run would otherwise leave no trace of the refusal at all
			 * (the hop says a recovery happened, not what it was for). Absent on events
			 * written before this field existed.
			 */
			cause?: SynapseErrorClassification | "state-verify";
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
			 * records to pick one. `payload-read` is a receiver reading the state
			 * payload object back out of the store: the state path's own read, present
			 * on both arms and therefore neutral to the arm comparison, which is why
			 * the frozen full-account definition does not name it — it is reported
			 * beside that figure instead of inside it. Absent means an ordinary content
			 * or corpus read, which is the only thing a pre-delta event could have been.
			 */
			purpose?: "base-rebuild" | "base-selection" | "payload-read" | "ranking";
		}
	| { kind: "task-span"; phase: "start" | "end"; taskId: string }
	/**
	 * One ranking's reads, split into those served from the process cache and those
	 * that had to go to the store. Recorded because "fewer reads" and "fewer records"
	 * look identical in the account, and the difference decides whether a cache-on run
	 * is comparable to a cache-off one.
	 */
	| { hits: number; kind: "vector-cache"; misses: number }
	| { category: SynapseErrorClassification; detail: string; kind: "error" };

export type MeteringEvent = MeteringIdentity &
	MeteringPayload & {
		eventId: string;
		monotonicMs: number;
		schemaVersion: number;
		ts: string;
		/**
		 * Which process wrote the row. A background child is a second process
		 * appending to the same per-run file, and `monotonicMs` counts from the
		 * moment *its* log instance was created — so a difference between two
		 * monotonic readings is a duration only when both rows share a writer.
		 * Recorded on every event from this build on; optional because a file
		 * written before it has none, and a run with no writer recorded anywhere is
		 * read the old way, as a single writer's log.
		 */
		writer?: number;
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
			const body = { ...identity, ...payload, monotonicMs: monotonicMs(), schemaVersion: SYNAPSE_METERING_SCHEMA_VERSION, ts: now().toISOString(), writer: process.pid };
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

/** The frozen definition of the full-account figure; printed with the number, never re-worded. */
export const FULL_ACCOUNT_DEFINITION =
	"payload (first transmissions) + recovery re-transmissions + envelope control bytes + receiver base rebuilds + sender base-selection reads; embedding calls are counted as calls and tokens, never as bytes";

/** Why the hot-base row must be labelled whenever it is printed. */
export const HOT_BASE_NOTE =
	"derived: the cold figure minus base reads; no build of this extension keeps base vectors resident, so this row is arithmetic rather than a measurement";

/** Recovery hops taken, by kind. */
export type FallbackHops = { fullVector: number; resend: number; text: number };

export type FullAccount = {
	/**
	 * The figure's definition, carried with the number rather than left in a
	 * comment, so a report prints what it actually computed. This is the frozen
	 * definition: payload (first transmissions) + recovery re-transmissions +
	 * envelope control bytes + the receiver's base rebuilds + the sender's
	 * base-selection reads. Changing it after the criteria were frozen would be
	 * moving the goalposts, which is why the extra components below are reported
	 * separately instead of being folded in.
	 */
	definition: string;
	/**
	 * Components, each attributed where it was spent. Bytes are never counted
	 * twice: `payloadBytes` and `resendBytes` partition the state plane's sent
	 * bytes by first transmission versus recovery hop.
	 */
	components: {
		/** Receiver-side reads that rebuilt a residual's base: the delta path's own cost. */
		baseRebuildReadBytes: number;
		/** Sender-side reads that ranked records to choose a base: the cost of selecting one. */
		baseSelectionReadBytes: number;
		/** Envelope control bytes. */
		controlBytes: number;
		/** Payload bytes of first transmissions. */
		payloadBytes: number;
		/** Payload bytes of recovery re-transmissions: a hop's bytes still crossed the wire. */
		resendBytes: number;
	};
	/** Calls the frozen definition counts as calls rather than as bytes. */
	embeddingCalls: { inputTokens: number | Unavailable; requests: number };
	/**
	 * Components the state path also causes but the frozen definition does not
	 * name. Reported so nothing is hidden, excluded so the frozen figure stays
	 * the frozen figure.
	 */
	notNamed: {
		/** Receiver reads of the payload object itself: present on both arms. */
		payloadReadBytes: number;
		/** Corpus ranking reads: the retrieval the state is used for, not its transfer. */
		rankingReadBytes: number;
	};
	/**
	 * The recovery chain, which the frozen ② counts as bytes and as hops.
	 *
	 * Its byte-shaped costs are already inside `components`: a `resend` or
	 * `full-vector` hop is a send, so its payload bytes sit in `resendBytes`. What
	 * the hop also costs is reported where it lands rather than guessed here: a
	 * `text` hop re-embeds the query (see `embeddingCalls`) and runs a second
	 * search (see `notNamed.rankingReadBytes`), and the text it renders into the
	 * child's context has no metering event at all — the gap the pre-registration
	 * declares in §3 (c).
	 */
	fallback: {
		/** Hops taken, by kind. Their total is pre-registered metric ④ (`state.restoreCount`). */
		hops: FallbackHops;
		/**
		 * `false` when the sends that declared themselves hops do not match the hops
		 * recorded: a write site that forgot to mark a recovery send. The split
		 * between `payloadBytes` and `resendBytes` is then wrong — ② itself is not,
		 * because both components are inside it — so this flag invalidates the
		 * breakdown, not the headline figure. Reported rather than repaired, because
		 * a guess at which send was the hop would be indistinguishable from a fact.
		 */
		partitionConsistent: boolean;
		/** Sends that carried the hop marker. Compared against `hops` above. */
		sendsWithRestore: number;
	};
	/**
	 * `bytes` with the base reads removed — the same path when the base is
	 * resident. **Derived from the cold figure, not measured**: no build of this
	 * extension keeps base vectors resident, so a report must label this row as
	 * derived and must not print it beside the measured column as if it were one.
	 * The field name says `ifBaseResident` so the conditional survives even a
	 * consumer that drops the `derived` flag.
	 */
	hotBase: { bytesIfBaseResident: number; derived: true; note: string };
	/** Sum of `components`. Tokens are units of their own and are never added to it. */
	bytes: number;
};

export type MeteringTotals = {
	control: { envelopeBytes: number; transportBytes: NotApplicable };
	duration: { byTask: Record<string, number | Unavailable>; totalMs: number | Unavailable; unfinishedTasks: string[] };
	embedding: { costUsd: number | Unavailable; durationMs: number; failed: number; inputTokens: number | Unavailable; requests: number };
	errors: Record<string, number>;
	fullAccount: FullAccount;
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
		/** Ranking reads served from the process cache rather than from the store. */
		vectorCacheHits: number;
		/** Ranking reads that had to go to the store. */
		vectorCacheMisses: number;
		/**
		 * Receiver-side semantic refusals: hops taken because the decoded state no longer
		 * matched the query. Counted on the hop, so a chain that refuses twice (the first
		 * attempt and its replacement) is two refusals rather than one.
		 */
		verificationRefusals: number;
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
	// Only the parent opens a task span, so the writer that recorded one is the
	// parent — the process whose log origin precedes every child's. The run's span
	// is taken from that writer alone; mixing in a child's readings would subtract
	// two different clocks and silently shorten the duration.
	//
	// The other writer's rows are not discarded: every byte, count and error below
	// still comes from the whole file, because those are sums and not durations.
	const parentWriter = events.find((event) => event.kind === "task-span")?.writer;
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
	// Full-account components that the `state` block does not already hold. The
	// sent bytes are partitioned by whether the delivery was a first transmission
	// or a recovery hop, so the two never overlap and their sum is `sentBytes`.
	let firstSendBytes = 0;
	let resendBytes = 0;
	let sendsWithRestore = 0;
	const hops: FallbackHops = { fullVector: 0, resend: 0, text: 0 };
	let payloadReadBytes = 0;
	let rankingReadBytes = 0;

	const totals: MeteringTotals = {
		control: { envelopeBytes: 0, transportBytes: "N/A" },
		duration: { byTask, totalMs: "unavailable", unfinishedTasks: [] },
		embedding: { costUsd: 0, durationMs: 0, failed: 0, inputTokens: 0, requests: 0 },
		errors,
		fullAccount: {
			bytes: 0,
			components: { baseRebuildReadBytes: 0, baseSelectionReadBytes: 0, controlBytes: 0, payloadBytes: 0, resendBytes: 0 },
			definition: FULL_ACCOUNT_DEFINITION,
			embeddingCalls: { inputTokens: 0, requests: 0 },
			fallback: {
				hops: { fullVector: 0, resend: 0, text: 0 },
				partitionConsistent: true,
				sendsWithRestore: 0,
			},
			hotBase: { bytesIfBaseResident: 0, derived: true, note: HOT_BASE_NOTE },
			notNamed: { payloadReadBytes: 0, rankingReadBytes: 0 },
		},
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
			/** Ranking reads served from the process cache rather than from the store. */
			vectorCacheHits: 0,
			/** Ranking reads that had to go to the store. */
			vectorCacheMisses: 0,
			verificationRefusals: 0,
		},
		storage: { readBytes: 0, writeBytes: 0 },
		text: { handoffBytes: 0 },
	};
	let memoryHits = 0;

	for (const event of events) {
		if (parentWriter === undefined || event.writer === parentWriter) {
			firstMonotonic = firstMonotonic === null ? event.monotonicMs : Math.min(firstMonotonic, event.monotonicMs);
			lastMonotonic = lastMonotonic === null ? event.monotonicMs : Math.max(lastMonotonic, event.monotonicMs);
		}
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
				// Recovery hops are separated from first transmissions rather than
				// added on top of them: both are already inside `sentBytes`, so a
				// second counter that merely restated the total would double it.
				if (event.restore === undefined) firstSendBytes += event.payloadBytes;
				else {
					resendBytes += event.payloadBytes;
					sendsWithRestore += 1;
				}
				if (event.encoding === "delta") totals.state.deltaPayloadBytes += event.payloadBytes;
				if (event.ok) totals.state.sent += 1;
				else totals.state.failedSends += 1;
				break;
			case "state-restore":
				totals.state.restoreCount += 1;
				if (event.cause === "state-verify") totals.state.verificationRefusals += 1;
				if (event.hop === "resend") hops.resend += 1;
				else if (event.hop === "full-vector") hops.fullVector += 1;
				else hops.text += 1;
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
				// holds memory, content and corpus traffic. The rule is one line: the
				// event's own `purpose` decides the component, and an event without one
				// is an ordinary content or corpus read that no arm owns.
				if (event.purpose === "base-rebuild") totals.state.baseReadBytes += event.bytes;
				else if (event.purpose === "base-selection") totals.state.baseSelectionReadBytes += event.bytes;
				else if (event.purpose === "payload-read") payloadReadBytes += event.bytes;
				else if (event.purpose === "ranking") rankingReadBytes += event.bytes;
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
			case "vector-cache":
				totals.state.vectorCacheHits += event.hits;
				totals.state.vectorCacheMisses += event.misses;
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
	totals.duration.totalMs =
		parentWriter === undefined || firstMonotonic === null || lastMonotonic === null ? "unavailable" : lastMonotonic - firstMonotonic;

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

	// The full account is assembled last, so its embedding component reports the
	// finished figure rather than a partial one, and so a reader can recompute it
	// from the same components the raw log lists.
	const fullAccountComponents = {
		baseRebuildReadBytes: totals.state.baseReadBytes,
		baseSelectionReadBytes: totals.state.baseSelectionReadBytes,
		controlBytes: totals.control.envelopeBytes,
		payloadBytes: firstSendBytes,
		resendBytes,
	};
	const fullAccountBytes =
		fullAccountComponents.baseRebuildReadBytes +
		fullAccountComponents.baseSelectionReadBytes +
		fullAccountComponents.controlBytes +
		fullAccountComponents.payloadBytes +
		fullAccountComponents.resendBytes;
	totals.fullAccount = {
		bytes: fullAccountBytes,
		components: fullAccountComponents,
		definition: FULL_ACCOUNT_DEFINITION,
		embeddingCalls: { inputTokens: totals.embedding.inputTokens, requests: totals.embedding.requests },
		// The two counters answer the same question from opposite ends: a hop records
		// itself, and the send it performs declares itself a hop. A send that forgot
		// the marker moves bytes from `resendBytes` to `payloadBytes` — inside ②
		// either way — so this flag invalidates the breakdown rather than the figure.
		fallback: {
			hops: { fullVector: hops.fullVector, resend: hops.resend, text: hops.text },
			partitionConsistent: sendsWithRestore === hops.resend + hops.fullVector,
			sendsWithRestore,
		},
		hotBase: {
			bytesIfBaseResident: fullAccountBytes - fullAccountComponents.baseRebuildReadBytes - fullAccountComponents.baseSelectionReadBytes,
			derived: true,
			note: HOT_BASE_NOTE,
		},
		notNamed: { payloadReadBytes, rankingReadBytes },
	};
	return totals;
}
