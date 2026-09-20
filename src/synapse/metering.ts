import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalDigest } from "./canonical-json.ts";
import type { SynapseMode } from "./config.ts";
import type { SynapseErrorClassification } from "./errors.ts";
import { LAUNCH_DEGRADED_REASON_ENV, LAUNCH_TOPOLOGY_ENV } from "../shared/launch-topology.ts";

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
	| { kind: "state-prepare" | "state-send" | "state-receive" | "state-consume"; ok: boolean; payloadBytes: number; representationId: string; stateId: string }
	| { kind: "model-usage"; role: "parent" | "child"; usage: ModelUsage | null }
	| { costUsd: number | null; durationMs: number; inputTokens: number | null; kind: "embedding-call"; ok: boolean; requests: number }
	| { authorisedValidHits: number; kind: "memory-query"; queryId: string }
	| { kind: "memory-reuse"; memoryId: string; sourceAgent: string }
	| { bytes: number; direction: "read" | "write"; kind: "object-io" }
	| { kind: "task-span"; phase: "start" | "end"; taskId: string }
	| { category: SynapseErrorClassification; detail: string; kind: "error" }
	| { cgroupId: string | null; degradedReason?: string; kind: "process-identity"; pid: number; startTicks: number; topology: "process" | "container"; uptimeAtRecordSeconds: number };

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

export type ProcessIdentitySnapshot = {
	cgroupId: string | null;
	degradedReason?: string;
	pid: number;
	startTicks: number;
	/**
	 * Which launch topology this process actually got — not which one was
	 * configured. S1 design §4.3: an S2 experiment that silently mixes a
	 * containerised run with one that fell back to the process model produces a
	 * number nobody can interpret, and nothing in the data would say so.
	 */
	topology: "process" | "container";
	uptimeAtRecordSeconds: number;
};

export type ProcessIdentityOptions = {
	pid?: number;
	readFile?: (filePath: string) => string;
	env?: NodeJS.ProcessEnv;
};

/**
 * Field 22 of /proc/self/stat: process start time in clock ticks since boot.
 * Field 2 (comm) is parenthesised and may itself contain spaces and closing
 * parentheses, so this parses from the LAST ")" rather than splitting the
 * whole line on whitespace, which would misplace every field that follows.
 */
function parseStartTicks(stat: string): number | null {
	const closeParen = stat.lastIndexOf(")");
	if (closeParen === -1) return null;
	const fieldsAfterComm = stat.slice(closeParen + 1).trim().split(/\s+/);
	// fieldsAfterComm[0] is field 3 (state); field 22 is index 22 - 3 = 19.
	const raw = fieldsAfterComm[19];
	if (raw === undefined) return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

/** The first whitespace-separated field of /proc/uptime: seconds since boot. */
function parseUptimeSeconds(uptime: string): number | null {
	const [first] = uptime.trim().split(/\s+/);
	if (first === undefined) return null;
	const value = Number(first);
	return Number.isFinite(value) ? value : null;
}

/**
 * The cgroup path from /proc/self/cgroup, or null when it could not be read.
 *
 * S1 makes this *available*; it does not yet key attribution on it. The swap
 * from `(pid, startTicks)` to a cgroup id (S1 design §4.2) requires S3's trace
 * wire protocol to carry the same id on the kernel side, which is a change to an
 * already-reviewed contract. Recording it here first means that when the swap
 * happens, the run side of the join already has the field, and the change is
 * `attributionKeyOf` plus the collector — not another pass over this file.
 *
 * Unreadable is null, never "": a process outside any cgroup and a read that
 * failed are different facts, and an empty string would join against nothing
 * while looking like a value.
 */
function readCgroupId(readFile: (filePath: string) => string): string | null {
	try {
		for (const line of readFile("/proc/self/cgroup").split("\n")) {
			// cgroup v2 writes a single "0::<path>" line; v1 writes one line per controller.
			const cgroupPath = line.trim().split(":").slice(2).join(":");
			if (cgroupPath) return cgroupPath;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Reads this process's OS identity from /proc, when it exists. A platform
 * without /proc — and any read that fails for another reason — has nothing to
 * bind, so the caller gets null rather than a guess. The file reader is
 * injectable so the field parsing can be proven correct in CI, which runs
 * this file's tests on platforms that never have /proc at all; production
 * code leaves it unset and gets the real filesystem.
 */
export function readProcessIdentity(options: ProcessIdentityOptions = {}): ProcessIdentitySnapshot | null {
	const pid = options.pid ?? process.pid;
	const readFile = options.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf-8"));
	const env = options.env ?? process.env;
	try {
		const startTicks = parseStartTicks(readFile("/proc/self/stat"));
		const uptimeAtRecordSeconds = parseUptimeSeconds(readFile("/proc/uptime"));
		if (startTicks === null || uptimeAtRecordSeconds === null) return null;
		const degradedReason = env[LAUNCH_DEGRADED_REASON_ENV]?.trim();
		return {
			cgroupId: readCgroupId(readFile),
			...(degradedReason ? { degradedReason } : {}),
			pid,
			startTicks,
			topology: env[LAUNCH_TOPOLOGY_ENV] === "container" ? "container" : "process",
			uptimeAtRecordSeconds,
		};
	} catch {
		return null;
	}
}

/**
 * Binds this process's OS identity to a SYNAPSE run identity, when the OS
 * identity is available at all. This is the one event a future kernel-side
 * collector needs to attribute its own records back to a run; it does not
 * participate in any of the totals below (see the guard in aggregateMetering)
 * because it measures process identity, not application work.
 */
export function recordProcessIdentity(log: MeteringLog, identity: MeteringIdentity, options?: ProcessIdentityOptions): MeteringEvent | null {
	const snapshot = readProcessIdentity(options);
	if (snapshot === null) return null;
	return log.record(identity, { kind: "process-identity", ...snapshot });
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
	state: { consumed: number; failedSends: number; prepared: number; received: number; receivedWithoutConsume: number; sent: number; sentBytes: number };
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
		state: { consumed: 0, failedSends: 0, prepared: 0, received: 0, receivedWithoutConsume: 0, sent: 0, sentBytes: 0 },
		storage: { readBytes: 0, writeBytes: 0 },
		text: { handoffBytes: 0 },
	};
	let memoryHits = 0;

	for (const event of events) {
		// process-identity binds an OS process to a run for a future kernel-side
		// joiner; it carries no application work and must not shift the span a
		// log without it would produce.
		if (event.kind !== "process-identity") {
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
				if (event.ok) totals.state.sent += 1;
				else totals.state.failedSends += 1;
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
			case "process-identity":
				// Recorded for a future kernel-side joiner only; nothing here to total.
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
