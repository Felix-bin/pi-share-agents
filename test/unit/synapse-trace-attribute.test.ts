import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MeteringEvent, MeteringIdentity } from "../../src/synapse/metering.ts";
import {
	attributeKernelIo,
	attributionKeyOf,
	bootNsecsOf,
	bucketBytes,
	LINUX_CLOCK_TICKS_PER_SECOND,
	meteringEpochNsecs,
	processStartNsecs,
	traceIoBytes,
	UNATTRIBUTED_SHARE_THRESHOLD,
	type AttributedProcessIo,
	type KernelIoAttribution,
} from "../../src/synapse/trace-attribute.ts";
import type { TraceDescriptorRecord, TraceLineError, TraceLog, TraceLossReport, TracePathRecord, TraceRecord } from "../../src/synapse/trace-log.ts";

const ROOT = "/var/synapse";

/** Ticks and nanoseconds for the same boot-based instant, at `USER_HZ` 100. */
const TICKS_PER_SECOND = LINUX_CLOCK_TICKS_PER_SECOND;
const NSECS_PER_TICK = 1_000_000_000 / TICKS_PER_SECOND;

function identity(overrides: Partial<MeteringIdentity> = {}): MeteringIdentity {
	return {
		agent: "researcher",
		attempt: 1,
		mode: "isolated",
		nodeId: "run-1/0",
		runId: "run-1",
		sessionId: "sess-1",
		snapshotId: null,
		...overrides,
	};
}

type IdentityEventOverrides = {
	identity?: MeteringIdentity;
	monotonicMs?: number;
	pid?: number;
	startTicks?: number;
	uptimeAtRecordSeconds?: number;
};

/** A `process-identity` metering event: the only event kind that binds an OS process to a run. */
function identityEvent(overrides: IdentityEventOverrides = {}): MeteringEvent {
	// Defaults are mutually consistent: a process that started at tick 1000
	// (10s after boot) whose metering log was created 5s later, sampled 1s after
	// that.
	const startTicks = overrides.startTicks ?? 1_000;
	const monotonicMs = overrides.monotonicMs ?? 1_000;
	const uptimeAtRecordSeconds = overrides.uptimeAtRecordSeconds ?? 16;
	return {
		...(overrides.identity ?? identity()),
		eventId: `event-${startTicks}-${overrides.pid ?? 42}`,
		kind: "process-identity",
		monotonicMs,
		pid: overrides.pid ?? 42,
		schemaVersion: 1,
		startTicks,
		ts: "2026-09-19T00:00:00.000Z",
		uptimeAtRecordSeconds,
	};
}

/** An application-layer event: carries a run identity but no OS identity, so it must bind nothing. */
function objectIoEvent(): MeteringEvent {
	return {
		...identity(),
		bytes: 4_096,
		direction: "write",
		eventId: "event-io",
		kind: "object-io",
		monotonicMs: 1_200,
		schemaVersion: 1,
		ts: "2026-09-19T00:00:00.000Z",
	};
}

function rw(overrides: Partial<TraceDescriptorRecord> = {}): TraceDescriptorRecord {
	return { bytes: 100, fd: 7, nsecs: 20_000_000_000, pid: 42, ret: 100, startTicks: 1_000, syscall: "write", tid: 42, ...overrides };
}

function open(path: string, overrides: Partial<TracePathRecord> = {}): TracePathRecord {
	return { bytes: 0, fd: -100, nsecs: 20_000_000_000, path, pid: 42, ret: 7, startTicks: 1_000, syscall: "openat", tid: 42, ...overrides };
}

type TraceLogOverrides = { errors?: TraceLineError[]; losses?: TraceLossReport[]; records?: TraceRecord[] };

function traceLog(overrides: TraceLogOverrides = {}): TraceLog {
	return { errors: overrides.errors ?? [], losses: overrides.losses ?? [], records: overrides.records ?? [] };
}

/** One `openat` plus one `write` of `bytes` to an envelope, by one process. */
function envelopeWrite(pid: number, startTicks: number, bytes: number, nsecs = 20_000_000_000): TraceRecord[] {
	return [
		open(`${ROOT}/envelopes/m-${pid}-${startTicks}.json`, { nsecs, pid, startTicks }),
		rw({ bytes, nsecs: nsecs + 1_000, pid, ret: bytes, startTicks }),
	];
}

function attributedRows(result: KernelIoAttribution): AttributedProcessIo[] {
	assert.ok(Array.isArray(result.attributed), `expected an attributed account, got ${JSON.stringify(result.attributed)}`);
	return result.attributed;
}

function rowFor(result: KernelIoAttribution, pid: number, startTicks: number): AttributedProcessIo {
	const row = attributedRows(result).find((candidate) => candidate.io.pid === pid && candidate.io.startTicks === startTicks);
	assert.ok(row !== undefined, `no attributed row for pid ${pid} at startTicks ${startTicks}`);
	return row;
}

function onlyIdentity(row: AttributedProcessIo): MeteringIdentity {
	assert.equal(row.identities.length, 1, "expected exactly one bound identity");
	const [first] = row.identities;
	assert.ok(first !== undefined);
	return first;
}

describe("synapse kernel I/O attribution: the key", () => {
	it("separates the same pid at two start times, and is stable for the same pair", () => {
		assert.notEqual(attributionKeyOf({ pid: 42, startTicks: 1_000 }), attributionKeyOf({ pid: 42, startTicks: 2_000 }));
		assert.notEqual(attributionKeyOf({ pid: 42, startTicks: 1_000 }), attributionKeyOf({ pid: 43, startTicks: 1_000 }));
		assert.equal(attributionKeyOf({ pid: 42, startTicks: 1_000 }), attributionKeyOf({ pid: 42, startTicks: 1_000 }));
	});

	it("does not collide when a pid and a start time trade digits", () => {
		// A key built by concatenating the two numbers without a field marker
		// would make (pid 1, ticks 12) and (pid 11, ticks 2) the same process.
		assert.notEqual(attributionKeyOf({ pid: 1, startTicks: 12 }), attributionKeyOf({ pid: 11, startTicks: 2 }));
	});
});

describe("synapse kernel I/O attribution: joining trace records to run identities", () => {
	it("attributes a process's bytes to the identity its pid and start time were bound to", () => {
		const result = attributeKernelIo([identityEvent()], traceLog({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
		const row = rowFor(result, 42, 1_000);
		assert.equal(onlyIdentity(row).runId, "run-1");
		assert.equal(row.io.categories.envelope.writeBytes, 500);
		assert.equal(result.diagnostics.attributedBytes, 500);
		assert.equal(result.diagnostics.unattributedBytes, 0);
		assert.deepEqual(result.unavailableReasons, []);
	});

	it("keeps a reused pid apart: two start times are two processes, not one history", () => {
		const first = identity({ agent: "researcher", nodeId: "run-1/0" });
		const second = identity({ agent: "writer", attempt: 2, nodeId: "run-1/1" });
		const events = [
			identityEvent({ identity: first, startTicks: 1_000 }),
			identityEvent({ identity: second, startTicks: 5_000, uptimeAtRecordSeconds: 56 }),
		];
		const records = [...envelopeWrite(42, 1_000, 300), ...envelopeWrite(42, 5_000, 700, 60_000_000_000)];

		const result = attributeKernelIo(events, traceLog({ records }), ROOT);
		assert.equal(attributedRows(result).length, 2);

		const older = rowFor(result, 42, 1_000);
		const newer = rowFor(result, 42, 5_000);
		assert.equal(onlyIdentity(older).agent, "researcher");
		assert.equal(onlyIdentity(newer).agent, "writer");
		// No cross-contamination in either direction.
		assert.equal(older.io.categories.envelope.writeBytes, 300);
		assert.equal(newer.io.categories.envelope.writeBytes, 700);
		assert.notEqual(older.key, newer.key);
		assert.equal(result.diagnostics.attributedBytes, 1_000);
	});

	it("binds identities only from process-identity events, never from an event that merely shares the run", () => {
		const result = attributeKernelIo([objectIoEvent()], traceLog({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
		assert.equal(result.diagnostics.identityKeys, 0);
		assert.equal(result.diagnostics.unattributedProcesses.length, 1);
	});

	it("reports every identity a single process was bound to instead of picking one", () => {
		// `createDelegationDeps` runs per opened delegation, so one process can
		// bind its pid to two nodes. Those bytes are not divisible between them.
		const events = [
			identityEvent({ identity: identity({ nodeId: "run-1/0" }) }),
			identityEvent({ identity: identity({ nodeId: "run-1/1" }), monotonicMs: 2_000, uptimeAtRecordSeconds: 17 }),
		];
		const result = attributeKernelIo(events, traceLog({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
		const row = rowFor(result, 42, 1_000);
		assert.deepEqual(
			row.identities.map((bound) => bound.nodeId),
			["run-1/0", "run-1/1"],
		);
		assert.equal(result.diagnostics.ambiguousProcesses, 1);
		// Ambiguity is about which node owns the bytes, not about whether they
		// were attributed: the run is known, so they are not orphans.
		assert.equal(result.diagnostics.unattributedBytes, 0);
	});

	it("counts a bound identity that produced no observed I/O", () => {
		const events = [identityEvent({ pid: 42 }), identityEvent({ pid: 99, startTicks: 1_100 })];
		const result = attributeKernelIo(events, traceLog({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
		assert.equal(result.diagnostics.identityKeys, 2);
		assert.equal(result.diagnostics.identityKeysWithoutTrace, 1);
	});
});

describe("synapse kernel I/O attribution: orphan records", () => {
	it("counts a trace process with no identity mapping instead of dropping or guessing it", () => {
		const records = [...envelopeWrite(42, 1_000, 900), ...envelopeWrite(77, 4_000, 100, 30_000_000_000)];
		const result = attributeKernelIo([identityEvent()], traceLog({ records }), ROOT);

		assert.equal(result.diagnostics.unattributedProcesses.length, 1);
		const [orphan] = result.diagnostics.unattributedProcesses;
		assert.ok(orphan !== undefined);
		assert.equal(orphan.pid, 77);
		assert.equal(orphan.startTicks, 4_000);
		// The orphan is kept whole, not reduced to a number.
		assert.equal(orphan.categories.envelope.writeBytes, 100);
		assert.equal(result.diagnostics.unattributedBytes, 100);
		assert.equal(result.diagnostics.attributedBytes, 900);
		// Exactly 10%: over the 1% threshold, so nothing may be reported.
		assert.equal(result.diagnostics.unattributedShare, 0.1);
		assert.equal(result.attributed, "unavailable");
	});

	it("counts unclassified and unknown-descriptor bytes towards the share rather than out of it", () => {
		// An orphan whose bytes went to an unknown descriptor still displaces a
		// known share of the account; leaving either side out of the denominator
		// would make the orphaned share look smaller than it is.
		const records: TraceRecord[] = [
			...envelopeWrite(42, 1_000, 50_000),
			open(`${ROOT}/receipts/req-1.json`, { nsecs: 21_000_000_000, ret: 9 }),
			rw({ bytes: 50_000, fd: 9, nsecs: 21_000_001_000, ret: 50_000 }),
			// No openat behind fd 4: an unknown descriptor, still real bytes.
			rw({ bytes: 200, fd: 4, nsecs: 30_000_000_000, pid: 77, ret: 200, startTicks: 4_000 }),
		];
		const result = attributeKernelIo([identityEvent()], traceLog({ records }), ROOT);
		assert.equal(result.diagnostics.attributedBytes, 100_000);
		assert.equal(result.diagnostics.unattributedBytes, 200);
		assert.equal(result.diagnostics.unattributedShare, 200 / 100_200);
		const row = rowFor(result, 42, 1_000);
		// `receipts/` is a real storage-root entry that no category owns.
		assert.equal(row.io.unclassified.writeBytes, 50_000);
		assert.equal(traceIoBytes(row.io), 100_000);
	});

	it("leaves deliberately ignored bytes out of the account and still reports them", () => {
		const records: TraceRecord[] = [
			...envelopeWrite(42, 1_000, 500),
			open("/etc/hosts", { nsecs: 21_000_000_000, ret: 11 }),
			rw({ bytes: 4_000, fd: 11, nsecs: 21_000_001_000, ret: 4_000 }),
			open(`${ROOT}/metering/run-1.jsonl`, { nsecs: 21_000_002_000, ret: 12 }),
			rw({ bytes: 800, fd: 12, nsecs: 21_000_003_000, ret: 800 }),
		];
		const result = attributeKernelIo([identityEvent()], traceLog({ records }), ROOT);
		// Ignored bytes are neither attributed nor unattributed: including them
		// in the denominator would dilute the unattributed share.
		assert.equal(result.diagnostics.attributedBytes, 500);
		assert.equal(result.diagnostics.unattributedBytes, 0);
		assert.equal(bucketBytes(result.diagnostics.ignored.outsideRoot), 4_000);
		assert.equal(bucketBytes(result.diagnostics.ignored.excluded), 800);
	});
});

describe("synapse kernel I/O attribution: refusing to report", () => {
	it("refuses the whole run's result when the collector admits it lost events", () => {
		const result = attributeKernelIo(
			[identityEvent()],
			traceLog({ losses: [{ count: 17, kind: "lost", nsecs: 25_000_000_000 }], records: envelopeWrite(42, 1_000, 500) }),
			ROOT,
		);
		assert.equal(result.attributed, "unavailable");
		assert.deepEqual(result.unavailableReasons, ["collector-reported-loss"]);
		assert.equal(result.diagnostics.lossReports, 1);
		assert.equal(result.diagnostics.lostEventsHighWater, 17);
		// The partial sum is visible as evidence, but it is not the result: the
		// account itself is refused, so no caller can mistake it for a total.
		assert.equal(result.diagnostics.attributedBytes, 500);
		assert.notEqual(result.attributed, result.diagnostics.attributedBytes);
	});

	it("does not sum cumulative loss counts", () => {
		const losses: TraceLossReport[] = [
			{ count: 5, kind: "lost", nsecs: 25_000_000_000 },
			{ count: 9, kind: "lost", nsecs: 26_000_000_000 },
		];
		const result = attributeKernelIo([identityEvent()], traceLog({ losses, records: envelopeWrite(42, 1_000, 500) }), ROOT);
		assert.equal(result.diagnostics.lossReports, 2);
		assert.equal(result.diagnostics.lostEventsHighWater, 9);
	});

	it("refuses the result when a line could not be read, including a collector killed mid-write", () => {
		const errors: TraceLineError[] = [{ detail: "line ends before the JSON document closes", line: 12, reason: "truncated" }];
		const result = attributeKernelIo([identityEvent()], traceLog({ errors, records: envelopeWrite(42, 1_000, 500) }), ROOT);
		assert.equal(result.attributed, "unavailable");
		assert.deepEqual(result.unavailableReasons, ["unreadable-lines"]);
		assert.equal(result.diagnostics.traceLines.errors.truncated, 1);
		assert.equal(result.diagnostics.traceLines.errors.malformed, 0);
	});

	it("refuses the result when the unattributed share is over the threshold", () => {
		// 1.5% orphaned.
		const records = [...envelopeWrite(42, 1_000, 985), ...envelopeWrite(77, 4_000, 15, 30_000_000_000)];
		const result = attributeKernelIo([identityEvent()], traceLog({ records }), ROOT);
		assert.equal(result.attributed, "unavailable");
		assert.deepEqual(result.unavailableReasons, ["unattributed-over-threshold"]);
		assert.equal(result.diagnostics.unattributedShare, 0.015);
		assert.equal(result.diagnostics.unattributedShareThreshold, UNATTRIBUTED_SHARE_THRESHOLD);
	});

	it("reports every applicable reason, not just the first one found", () => {
		const records = [...envelopeWrite(42, 1_000, 900), ...envelopeWrite(77, 4_000, 100, 30_000_000_000)];
		const result = attributeKernelIo(
			[identityEvent()],
			traceLog({
				errors: [{ detail: "line is not valid JSON", line: 3, reason: "malformed" }],
				losses: [{ count: 2, kind: "lost", nsecs: 25_000_000_000 }],
				records,
			}),
			ROOT,
		);
		assert.deepEqual(result.unavailableReasons, ["collector-reported-loss", "unreadable-lines", "unattributed-over-threshold"]);
	});

	it("reports the actual share on a result that passed, and passes at exactly the threshold", () => {
		// 0.2% orphaned: under the threshold, so the account stands — and the
		// share it stands with is still visible.
		const underThreshold = attributeKernelIo(
			[identityEvent()],
			traceLog({ records: [...envelopeWrite(42, 1_000, 998), ...envelopeWrite(77, 4_000, 2, 30_000_000_000)] }),
			ROOT,
		);
		assert.equal(attributedRows(underThreshold).length, 1);
		assert.deepEqual(underThreshold.unavailableReasons, []);
		assert.equal(underThreshold.diagnostics.unattributedShare, 0.002);
		assert.equal(underThreshold.diagnostics.unattributedProcesses.length, 1);

		// Exactly 1%: the comparison is strictly greater, so this is reported.
		const atThreshold = attributeKernelIo(
			[identityEvent()],
			traceLog({ records: [...envelopeWrite(42, 1_000, 990), ...envelopeWrite(77, 4_000, 10, 30_000_000_000)] }),
			ROOT,
		);
		assert.equal(atThreshold.diagnostics.unattributedShare, 0.01);
		assert.deepEqual(atThreshold.unavailableReasons, []);
		assert.equal(attributedRows(atThreshold).length, 1);
	});

	it("honours a calibrated threshold without changing what is reported", () => {
		const records = [...envelopeWrite(42, 1_000, 900), ...envelopeWrite(77, 4_000, 100, 30_000_000_000)];
		const result = attributeKernelIo([identityEvent()], traceLog({ records }), ROOT, { unattributedShareThreshold: 0.2 });
		assert.equal(attributedRows(result).length, 1);
		assert.equal(result.diagnostics.unattributedShare, 0.1);
		assert.equal(result.diagnostics.unattributedShareThreshold, 0.2);
	});

	it("reports a share of no bytes as N/A rather than a zero share", () => {
		// The collector saw calls but no byte moved: there is no share to state.
		const result = attributeKernelIo([identityEvent()], traceLog({ records: [open(`${ROOT}/envelopes/m1.json`)] }), ROOT);
		assert.equal(result.diagnostics.unattributedShare, "N/A");
		assert.deepEqual(result.unavailableReasons, []);
		assert.equal(attributedRows(result).length, 1);
	});
});

describe("synapse kernel I/O attribution: no collection at all", () => {
	it("reports N/A when this deployment ran no collector", () => {
		const result = attributeKernelIo([identityEvent()], null, ROOT);
		assert.equal(result.attributed, "N/A");
		assert.equal(result.diagnostics.unattributedShare, "N/A");
		assert.equal(result.diagnostics.coverage.observedFromNsecs, "N/A");
		assert.deepEqual(result.unavailableReasons, []);
		assert.equal(result.diagnostics.attributedBytes, 0);
		assert.equal(result.diagnostics.traceLines.records, 0);
	});

	it("treats a trace with nothing in it the same as no trace, never as a run that did no I/O", () => {
		const result = attributeKernelIo([identityEvent()], traceLog(), ROOT);
		assert.equal(result.attributed, "N/A");
		assert.notEqual(result.attributed, "unavailable");
		assert.deepEqual(result.diagnostics.unattributedProcesses, []);
	});

	it("does not report N/A once the trace holds any line at all, even an unreadable one", () => {
		const result = attributeKernelIo([identityEvent()], traceLog({ errors: [{ detail: "line is not valid JSON", line: 1, reason: "malformed" }] }), ROOT);
		assert.equal(result.attributed, "unavailable");
		assert.deepEqual(result.unavailableReasons, ["unreadable-lines"]);
	});
});

describe("synapse kernel I/O attribution: clock alignment across the two bases", () => {
	it("converts start ticks to nanoseconds since boot without drift", () => {
		assert.equal(processStartNsecs(0), 0);
		assert.equal(processStartNsecs(1), NSECS_PER_TICK);
		assert.equal(processStartNsecs(1_234_567), 12_345_670_000_000);
		// The tick rate is a parameter, not a welded-in 100.
		assert.equal(processStartNsecs(250, 250), 1_000_000_000);
	});

	it("puts a per-process hrtime reading onto the boot-based timeline the trace uses", () => {
		// The identity event is the one instant read on both bases: 12345.67s
		// since boot, 670ms into this process's metering log.
		const epoch = meteringEpochNsecs(12_345.67, 670);
		assert.equal(epoch, 12_345_000_000_000);
		// Every later reading of the same process converts by the same offset,
		// so the two clocks stay exactly aligned however long the run lasts.
		assert.equal(bootNsecsOf(epoch, 670), 12_345_670_000_000);
		assert.equal(bootNsecsOf(epoch, 1_500), 12_346_500_000_000);
		assert.equal(bootNsecsOf(epoch, 3_600_000), 12_345_000_000_000 + 3_600_000_000_000);
		// Drift across the whole span is zero, not merely small.
		assert.equal(bootNsecsOf(epoch, 3_600_000) - bootNsecsOf(epoch, 0), 3_600 * 1_000_000_000);
	});

	it("keeps the log epoch distinct from the process start", () => {
		// The hrtime origin is taken when the metering log is created, well after
		// the process started; treating it as the start would date every event
		// early by exactly that gap.
		const start = processStartNsecs(1_000);
		const epoch = meteringEpochNsecs(16, 1_000);
		assert.equal(start, 10_000_000_000);
		assert.equal(epoch, 15_000_000_000);
		assert.ok(epoch > start);
	});

	it("flags a process-identity event whose two clock bases contradict each other", () => {
		// The metering log cannot predate the process that created it. Here the
		// readings claim it did, so no coverage answer may be derived from them.
		const event = identityEvent({ monotonicMs: 5_000, startTicks: 1_000, uptimeAtRecordSeconds: 10 });
		const result = attributeKernelIo([event], traceLog({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
		assert.equal(result.diagnostics.clockInconsistentIdentityEvents, 1);
		const row = rowFor(result, 42, 1_000);
		assert.equal(row.coverage.unobservedPrefixNsecs, "unavailable");
		assert.equal(row.coverage.observedFromStart, false);
	});

	it("accepts the tick of slack that flooring start ticks costs", () => {
		// startTicks floors to a tick boundary, so a log epoch may read up to one
		// tick before the computed start without the bases disagreeing.
		const event = identityEvent({ monotonicMs: 0, startTicks: 1_000, uptimeAtRecordSeconds: 9.995 });
		const result = attributeKernelIo([event], traceLog({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
		assert.equal(result.diagnostics.clockInconsistentIdentityEvents, 0);
	});
});

describe("synapse kernel I/O attribution: coverage completeness", () => {
	it("proves full coverage when the trace holds a line from before the process started", () => {
		// Process started at tick 1000 (10s); the collector was already emitting
		// at 9s, so nothing of this process's life predates the observation.
		const records: TraceRecord[] = [
			rw({ bytes: 64, fd: 3, nsecs: 9_000_000_000, pid: 7, ret: 64, startTicks: 100 }),
			...envelopeWrite(42, 1_000, 500),
		];
		const result = attributeKernelIo(
			[identityEvent(), identityEvent({ identity: identity({ nodeId: "run-1/9" }), pid: 7, startTicks: 100, uptimeAtRecordSeconds: 6 })],
			traceLog({ records }),
			ROOT,
		);
		const row = rowFor(result, 42, 1_000);
		assert.equal(row.coverage.observedFromStart, true);
		assert.equal(row.coverage.unobservedPrefixNsecs, 0);
		assert.equal(result.diagnostics.coverage.observedFromNsecs, 9_000_000_000);
	});

	it("detects a collector that started after the run, rather than reporting a full account", () => {
		// The process started at 10s since boot; the earliest line in the whole
		// trace is at 20s. The first 10s of this process carries no evidence, so
		// the total is not a full account and must not read as one.
		const result = attributeKernelIo([identityEvent()], traceLog({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
		const row = rowFor(result, 42, 1_000);
		assert.equal(row.coverage.observedFromStart, false);
		assert.equal(row.coverage.unobservedPrefixNsecs, 10_000_000_000);
		assert.equal(result.diagnostics.coverage.complete, false);
		assert.equal(result.diagnostics.coverage.processesWithUnobservedPrefix, 1);
		// Incomplete coverage is a stated fact about the account, not a reason to
		// withhold it: design §4.4 withholds on loss, unreadable lines and the
		// orphan threshold. The caller sees an account that says what it misses.
		assert.equal(attributedRows(result).length, 1);
		assert.deepEqual(result.unavailableReasons, []);
	});

	it("measures the unobserved prefix from the process start, not from its first observed call", () => {
		// The collector's first line is at 15s and this process's first observed
		// call is at 20s: the gap that matters is the one before 15s, because
		// after that the collector was watching and saw nothing.
		const records: TraceRecord[] = [
			rw({ bytes: 64, fd: 3, nsecs: 15_000_000_000, pid: 7, ret: 64, startTicks: 100 }),
			...envelopeWrite(42, 1_000, 500),
		];
		const result = attributeKernelIo(
			[identityEvent(), identityEvent({ identity: identity({ nodeId: "run-1/9" }), pid: 7, startTicks: 100, uptimeAtRecordSeconds: 6 })],
			traceLog({ records }),
			ROOT,
		);
		assert.equal(rowFor(result, 42, 1_000).coverage.unobservedPrefixNsecs, 5_000_000_000);
	});

	it("counts a loss report's own timestamp as an observation", () => {
		// A loss report proves the collector was running at that instant even
		// though the events it covers are gone.
		const result = attributeKernelIo(
			[identityEvent()],
			traceLog({ losses: [{ count: 3, kind: "lost", nsecs: 8_000_000_000 }], records: envelopeWrite(42, 1_000, 500) }),
			ROOT,
		);
		assert.equal(result.diagnostics.coverage.observedFromNsecs, 8_000_000_000);
		assert.equal(result.diagnostics.coverage.complete, true);
		// Coverage being provable does not rescue a run that lost events.
		assert.equal(result.attributed, "unavailable");
	});

	it("does not call an empty account complete", () => {
		// Nothing was attributed, so there is no process whose coverage was
		// proved; `complete` must not read as "the whole run is accounted for".
		const result = attributeKernelIo([], traceLog({ records: envelopeWrite(77, 4_000, 0) }), ROOT);
		assert.equal(result.diagnostics.coverage.complete, false);
	});
});
