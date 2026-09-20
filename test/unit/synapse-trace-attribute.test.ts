import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MeteringEvent, MeteringIdentity } from "../../src/synapse/metering.ts";
import {
	attributeKernelIo,
	attributionKeyOf,
	bootNsecsOf,
	bucketBytes,
	bucketTouched,
	LINUX_CLOCK_TICKS_PER_SECOND,
	meteringEpochNsecs,
	pathlessBytesOf,
	placedBytesOf,
	processStartNsecs,
	tracedBytesOf,
	UNATTRIBUTED_SHARE_THRESHOLD,
	type AttributedProcessIo,
	type KernelIoAttribution,
	type StorageRootEvidence,
	type TraceCollection,
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

/** A collector that ran and produced this output — including the case where it produced nothing. */
function collected(overrides: TraceLogOverrides = {}): TraceCollection {
	const trace: TraceLog = { errors: overrides.errors ?? [], losses: overrides.losses ?? [], records: overrides.records ?? [] };
	return { kind: "collected", trace };
}

/** No collector ran. Not spellable as an empty `collected()`, which is the point of the discriminant. */
const NOT_COLLECTED: TraceCollection = { kind: "not-collected" };

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

/** The root evidence of a result that got as far as classifying something. */
function rootEvidence(result: KernelIoAttribution): StorageRootEvidence {
	const evidence = result.diagnostics.storageRootEvidence;
	assert.ok(evidence !== "N/A", "expected classification to have run and produced storage-root evidence");
	return evidence;
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
		const result = attributeKernelIo([identityEvent()], collected({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
		const row = rowFor(result, 42, 1_000);
		assert.equal(onlyIdentity(row).runId, "run-1");
		assert.equal(row.io.categories.envelope.writeBytes, 500);
		assert.equal(result.diagnostics.attributedBytes.placed, 500);
		assert.equal(result.diagnostics.unattributedBytes.placed, 0);
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

		const result = attributeKernelIo(events, collected({ records }), ROOT);
		assert.equal(attributedRows(result).length, 2);

		const older = rowFor(result, 42, 1_000);
		const newer = rowFor(result, 42, 5_000);
		assert.equal(onlyIdentity(older).agent, "researcher");
		assert.equal(onlyIdentity(newer).agent, "writer");
		// No cross-contamination in either direction.
		assert.equal(older.io.categories.envelope.writeBytes, 300);
		assert.equal(newer.io.categories.envelope.writeBytes, 700);
		assert.notEqual(older.key, newer.key);
		assert.equal(result.diagnostics.attributedBytes.placed, 1_000);
	});

	it("binds identities only from process-identity events, never from an event that merely shares the run", () => {
		const result = attributeKernelIo([objectIoEvent()], collected({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
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
		const result = attributeKernelIo(events, collected({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
		const row = rowFor(result, 42, 1_000);
		assert.deepEqual(
			row.identities.map((bound) => bound.nodeId),
			["run-1/0", "run-1/1"],
		);
		assert.equal(result.diagnostics.ambiguousProcesses, 1);
		// Ambiguity is about which node owns the bytes, not about whether they
		// were attributed: the run is known, so they are not orphans.
		assert.equal(result.diagnostics.unattributedBytes.placed, 0);
	});

	it("counts a bound identity that produced no observed I/O", () => {
		const events = [identityEvent({ pid: 42 }), identityEvent({ pid: 99, startTicks: 1_100 })];
		const result = attributeKernelIo(events, collected({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
		assert.equal(result.diagnostics.identityKeys, 2);
		assert.equal(result.diagnostics.identityKeysWithoutTrace, 1);
	});
});

describe("synapse kernel I/O attribution: orphan records", () => {
	it("counts a trace process with no identity mapping instead of dropping or guessing it", () => {
		const records = [...envelopeWrite(42, 1_000, 900), ...envelopeWrite(77, 4_000, 100, 30_000_000_000)];
		const result = attributeKernelIo([identityEvent()], collected({ records }), ROOT);

		assert.equal(result.diagnostics.unattributedProcesses.length, 1);
		const [orphan] = result.diagnostics.unattributedProcesses;
		assert.ok(orphan !== undefined);
		assert.equal(orphan.pid, 77);
		assert.equal(orphan.startTicks, 4_000);
		// The orphan is kept whole, not reduced to a number.
		assert.equal(orphan.categories.envelope.writeBytes, 100);
		assert.equal(result.diagnostics.unattributedBytes.placed, 100);
		assert.equal(result.diagnostics.attributedBytes.placed, 900);
		// Exactly 10%: over the 1% threshold, so nothing may be reported.
		assert.equal(result.diagnostics.unattributedShare, 0.1);
		assert.equal(result.attributed, "unavailable");
	});

	it("counts unclassified bytes in the share and keeps pathless ones out of both sides of it", () => {
		// `unclassified` bytes resolved to a path under the root, so they are
		// SYNAPSE I/O the join was responsible for placing and they belong in the
		// share on whichever side they fall. An orphan's `unknownDescriptor` bytes
		// resolved to no path at all and belong in neither: they are evidence about
		// nothing, and counting them would make the share partly a measure of how
		// much unrelated stdout traffic the run happened to produce.
		const records: TraceRecord[] = [
			...envelopeWrite(42, 1_000, 50_000),
			open(`${ROOT}/receipts/req-1.json`, { nsecs: 21_000_000_000, ret: 9 }),
			rw({ bytes: 50_000, fd: 9, nsecs: 21_000_001_000, ret: 50_000 }),
			// No openat behind fd 4: an unknown descriptor, still real bytes.
			rw({ bytes: 200, fd: 4, nsecs: 30_000_000_000, pid: 77, ret: 200, startTicks: 4_000 }),
		];
		const result = attributeKernelIo([identityEvent()], collected({ records }), ROOT);
		assert.equal(result.diagnostics.attributedBytes.placed, 100_000);
		assert.equal(result.diagnostics.unattributedBytes.placed, 0);
		// The orphaned bytes are not lost — they are reported as volume and as a
		// whole process, they simply do not get a vote on the judgement.
		assert.equal(result.diagnostics.unattributedBytes.traced, 200);
		assert.equal(result.diagnostics.unattributedShare, 0);
		assert.equal(result.diagnostics.unattributedProcesses.length, 1);
		assert.equal(rootEvidence(result).pathlessBytes, 200);
		// And they still deny completeness, which is what keeps this from being a
		// hole: an orphan made entirely of pathless bytes is still an orphan.
		assert.equal(result.diagnostics.coverage.complete, false);
		const row = rowFor(result, 42, 1_000);
		// `receipts/` is a real storage-root entry that no category owns.
		assert.equal(row.io.unclassified.writeBytes, 50_000);
		assert.equal(tracedBytesOf(row.io), 100_000);
		assert.equal(placedBytesOf(row.io), 100_000);
	});

	it("counts read bytes as well as written ones, on both sides of the share", () => {
		// Reads and writes stay apart in the buckets but both are bytes the join
		// was responsible for placing. A denominator that summed only writes
		// would understate every read-heavy run's orphaned share.
		const records: TraceRecord[] = [
			open(`${ROOT}/objects/ab/abcdef.bin`, { nsecs: 20_000_000_000, ret: 8 }),
			rw({ bytes: 900, fd: 8, nsecs: 20_000_001_000, ret: 900, syscall: "read" }),
			open(`${ROOT}/objects/cd/cdef01.bin`, { nsecs: 30_000_000_000, pid: 77, ret: 8, startTicks: 4_000 }),
			rw({ bytes: 100, fd: 8, nsecs: 30_000_001_000, pid: 77, ret: 100, startTicks: 4_000, syscall: "read" }),
		];
		const result = attributeKernelIo([identityEvent()], collected({ records }), ROOT);
		assert.equal(result.diagnostics.attributedBytes.placed, 900);
		assert.equal(result.diagnostics.unattributedBytes.placed, 100);
		assert.equal(result.diagnostics.unattributedShare, 0.1);
		const [orphan] = result.diagnostics.unattributedProcesses;
		assert.ok(orphan !== undefined);
		assert.equal(orphan.categories.content.readBytes, 100);
		assert.equal(bucketBytes(orphan.categories.content), 100);
		assert.equal(tracedBytesOf(orphan), 100);
	});

	it("leaves deliberately ignored bytes out of the account and still reports them", () => {
		const records: TraceRecord[] = [
			...envelopeWrite(42, 1_000, 500),
			open("/etc/hosts", { nsecs: 21_000_000_000, ret: 11 }),
			rw({ bytes: 4_000, fd: 11, nsecs: 21_000_001_000, ret: 4_000 }),
			open(`${ROOT}/metering/run-1.jsonl`, { nsecs: 21_000_002_000, ret: 12 }),
			rw({ bytes: 800, fd: 12, nsecs: 21_000_003_000, ret: 800 }),
		];
		const result = attributeKernelIo([identityEvent()], collected({ records }), ROOT);
		// Ignored bytes are neither attributed nor unattributed: including them
		// in the denominator would dilute the unattributed share.
		assert.equal(result.diagnostics.attributedBytes.placed, 500);
		assert.equal(result.diagnostics.unattributedBytes.placed, 0);
		assert.equal(bucketBytes(result.diagnostics.ignored.outsideRoot), 4_000);
		assert.equal(bucketBytes(result.diagnostics.ignored.excluded), 800);
	});
});

describe("synapse kernel I/O attribution: refusing to report", () => {
	it("refuses the whole run's result when the collector admits it lost events", () => {
		const result = attributeKernelIo(
			[identityEvent()],
			collected({ losses: [{ count: 17, kind: "lost", nsecs: 25_000_000_000 }], records: envelopeWrite(42, 1_000, 500) }),
			ROOT,
		);
		assert.equal(result.attributed, "unavailable");
		assert.deepEqual(result.unavailableReasons, ["collector-reported-loss"]);
		assert.equal(result.diagnostics.lossReports, 1);
		assert.equal(result.diagnostics.lostEventsHighWater, 17);
		// The partial sum is visible as evidence, but it is not the result: the
		// account itself is refused, so no caller can mistake it for a total.
		assert.equal(result.diagnostics.attributedBytes.placed, 500);
		assert.equal(Array.isArray(result.attributed), false, "a refused account must not also be readable as rows");
	});

	it("does not sum cumulative loss counts", () => {
		const losses: TraceLossReport[] = [
			{ count: 5, kind: "lost", nsecs: 25_000_000_000 },
			{ count: 9, kind: "lost", nsecs: 26_000_000_000 },
		];
		const result = attributeKernelIo([identityEvent()], collected({ losses, records: envelopeWrite(42, 1_000, 500) }), ROOT);
		assert.equal(result.diagnostics.lossReports, 2);
		assert.equal(result.diagnostics.lostEventsHighWater, 9);
	});

	it("refuses the result when a line could not be read, including a collector killed mid-write", () => {
		const errors: TraceLineError[] = [{ detail: "line ends before the JSON document closes", line: 12, reason: "truncated" }];
		const result = attributeKernelIo([identityEvent()], collected({ errors, records: envelopeWrite(42, 1_000, 500) }), ROOT);
		assert.equal(result.attributed, "unavailable");
		assert.deepEqual(result.unavailableReasons, ["unreadable-lines"]);
		assert.equal(result.diagnostics.traceLines.errors.truncated, 1);
		assert.equal(result.diagnostics.traceLines.errors.malformed, 0);
	});

	it("refuses the result when the unattributed share is over the threshold", () => {
		// 1.5% orphaned.
		const records = [...envelopeWrite(42, 1_000, 985), ...envelopeWrite(77, 4_000, 15, 30_000_000_000)];
		const result = attributeKernelIo([identityEvent()], collected({ records }), ROOT);
		assert.equal(result.attributed, "unavailable");
		assert.deepEqual(result.unavailableReasons, ["unattributed-over-threshold"]);
		assert.equal(result.diagnostics.unattributedShare, 0.015);
		assert.equal(result.diagnostics.unattributedShareThreshold, UNATTRIBUTED_SHARE_THRESHOLD);
	});

	it("does not let a megabyte of inherited-stdout traffic dilute an orphaned run out of the threshold", () => {
		// The production shape, and the fourth door the same defect came through.
		//
		// `async-execution.ts:709-729` opens the stdout and stderr log files in the
		// parent and hands those descriptors to every backgrounded agent process as
		// its stdio. No `openat` by the child ever appears in the trace for them, so
		// on every real run a bound process carries `unknownDescriptor` bytes — here
		// a megabyte of ordinary agent chatter on fd 1.
		//
		// Meanwhile a second process moved 9,000 bytes of genuine envelope traffic
		// under the storage root and bound no identity at all: every byte that
		// actually resolved to SYNAPSE storage was orphaned, a 100% attribution
		// loss. Against a denominator of all traced bytes that reads
		// 9_000 / 1_009_000 = 0.89%, under the 1% threshold, so the run came back
		// with no reasons and an attributed row — the pathless traffic, which is
		// present on every run that will ever happen, paying for the orphan.
		const records: TraceRecord[] = [
			rw({ bytes: 1_000_000, fd: 1, nsecs: 20_000_000_000, ret: 1_000_000 }),
			...envelopeWrite(99, 7_000, 9_000, 21_000_000_000),
		];
		const result = attributeKernelIo([identityEvent()], collected({ records }), ROOT);

		// Judged on placed bytes, the share is what it always was: all of it.
		assert.equal(result.diagnostics.unattributedShare, 1);
		assert.equal(result.attributed, "unavailable");
		assert.deepEqual(result.unavailableReasons, ["unattributed-over-threshold"]);

		// The two currencies, so the dilution is legible rather than inferred.
		assert.equal(result.diagnostics.attributedBytes.traced, 1_000_000);
		assert.equal(result.diagnostics.attributedBytes.placed, 0);
		assert.equal(result.diagnostics.unattributedBytes.placed, 9_000);
		assert.equal(result.diagnostics.unattributedBytes.traced, 9_000);
		// The old denominator, pinned so the regression stays readable.
		assert.ok(9_000 / (1_000_000 + 9_000) < UNATTRIBUTED_SHARE_THRESHOLD);

		// The root is right and the diagnostics say so: this is an attribution
		// failure, not a misconfiguration, and the reason set must not suggest one.
		assert.deepEqual(rootEvidence(result), { pathlessBytes: 1_000_000, pathsOutsideRoot: false, pathsUnderRoot: true });
		assert.equal(result.diagnostics.coverage.complete, false);
	});

	it("reports every applicable reason, not just the first one found", () => {
		const records = [...envelopeWrite(42, 1_000, 900), ...envelopeWrite(77, 4_000, 100, 30_000_000_000)];
		const result = attributeKernelIo(
			[identityEvent()],
			collected({
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
			collected({ records: [...envelopeWrite(42, 1_000, 998), ...envelopeWrite(77, 4_000, 2, 30_000_000_000)] }),
			ROOT,
		);
		assert.equal(attributedRows(underThreshold).length, 1);
		assert.deepEqual(underThreshold.unavailableReasons, []);
		assert.equal(underThreshold.diagnostics.unattributedShare, 0.002);
		assert.equal(underThreshold.diagnostics.unattributedProcesses.length, 1);

		// Exactly 1%: the comparison is strictly greater, so this is reported.
		const atThreshold = attributeKernelIo(
			[identityEvent()],
			collected({ records: [...envelopeWrite(42, 1_000, 990), ...envelopeWrite(77, 4_000, 10, 30_000_000_000)] }),
			ROOT,
		);
		assert.equal(atThreshold.diagnostics.unattributedShare, 0.01);
		assert.deepEqual(atThreshold.unavailableReasons, []);
		assert.equal(attributedRows(atThreshold).length, 1);
	});

	it("honours a calibrated threshold without changing what is reported", () => {
		const records = [...envelopeWrite(42, 1_000, 900), ...envelopeWrite(77, 4_000, 100, 30_000_000_000)];
		const result = attributeKernelIo([identityEvent()], collected({ records }), ROOT, { unattributedShareThreshold: 0.2 });
		assert.equal(attributedRows(result).length, 1);
		assert.equal(result.diagnostics.unattributedShare, 0.1);
		assert.equal(result.diagnostics.unattributedShareThreshold, 0.2);
	});

	it("reports a share of no bytes as N/A rather than a zero share", () => {
		// The collector saw calls but no byte moved: there is no share to state.
		const result = attributeKernelIo([identityEvent()], collected({ records: [open(`${ROOT}/envelopes/m1.json`)] }), ROOT);
		assert.equal(result.diagnostics.unattributedShare, "N/A");
		assert.deepEqual(result.unavailableReasons, []);
		assert.equal(attributedRows(result).length, 1);
	});
});

describe("synapse kernel I/O attribution: an unusable storage root", () => {
	// Every path in the trace would classify as `outside-root` against a root no
	// path can be placed against, putting the run's whole I/O in `ignored` — a
	// bucket no judgement reads. The account would come back empty, unorphaned
	// and unrefused: a 100% attribution loss wearing the face of a clean pass.
	for (const badRoot of ["var/synapse", "C:\\synapse", "", "./var/synapse"]) {
		it(`refuses the result rather than reporting an empty account against ${JSON.stringify(badRoot)}`, () => {
			const records = [...envelopeWrite(42, 1_000, 50_000)];
			const result = attributeKernelIo([identityEvent()], collected({ records }), badRoot);
			assert.equal(result.attributed, "unavailable");
			assert.deepEqual(result.unavailableReasons, ["unusable-storage-root"]);
			// Nothing was classified, so no byte total is claimed either way.
			assert.equal(result.diagnostics.attributedBytes.placed, 0);
			assert.equal(result.diagnostics.attributedBytes.traced, 0);
			assert.equal(bucketBytes(result.diagnostics.ignored.outsideRoot), 0);
			assert.equal(result.diagnostics.unattributedShare, "N/A");
			// No path was classified against any root, so there is nothing to say
			// about this one. `pathsUnderRoot: false` would be a claim nobody made.
			assert.equal(result.diagnostics.storageRootEvidence, "N/A");
			assert.equal(result.diagnostics.coverage.complete, false);
			// The lines that were there are still counted: the root was unusable,
			// the collector's output was not.
			assert.equal(result.diagnostics.traceLines.records, records.length);
		});
	}

	it("refuses a root that is absolute but names a different tree than the collector reports", () => {
		// The syntactic check passes and every path still lands outside the root.
		// This is the expected first failure once each agent runs in its own
		// iSulad container: the collector on the host reports host paths while Pi
		// inside the container sees container paths.
		const result = attributeKernelIo([identityEvent()], collected({ records: envelopeWrite(42, 1_000, 50_000) }), "/srv/other-tree");
		assert.equal(result.attributed, "unavailable");
		assert.deepEqual(result.unavailableReasons, ["no-path-under-storage-root"]);
		assert.equal(result.diagnostics.attributedBytes.placed, 0);
		assert.equal(result.diagnostics.unattributedBytes.placed, 0);
		// The evidence that it was a mismatch and not a quiet run: every byte the
		// collector saw is sitting outside the root.
		assert.equal(bucketBytes(result.diagnostics.ignored.outsideRoot), 50_000);
		assert.equal(result.diagnostics.coverage.complete, false);
		// And the evidence that it was a wrong root rather than a collector that
		// attached late: the run moved nothing on a descriptor without a path.
		assert.deepEqual(rootEvidence(result), { pathlessBytes: 0, pathsOutsideRoot: true, pathsUnderRoot: false });
	});

	it("refuses a mismatched root that one write to an inherited fd would otherwise excuse", () => {
		// The shape this actually takes in production. The collector runs on the
		// host and reports host paths (`/host/var/synapse/...`); Pi, inside its
		// iSulad container, supplies `/var/synapse`. Meanwhile every backgrounded
		// agent process writes to a stdout log descriptor it inherited, which no
		// `openat` in the trace created — `async-execution.ts` passes those fds as
		// the child's stdio — so `unknownDescriptor` is never empty on a real run.
		//
		// Those 240 pathless bytes are bytes, and they are attributed; they simply
		// say nothing about whether the root matched. A guard counting attributed
		// bytes would be satisfied by them on every run that will ever happen,
		// while 1,000,000 bytes of real envelope traffic sit unplaced.
		const records: TraceRecord[] = [
			rw({ bytes: 240, fd: 1, nsecs: 20_000_000_000, ret: 240 }),
			open("/host/var/synapse/envelopes/m2.json", { nsecs: 20_000_001_000, ret: 7 }),
			rw({ bytes: 1_000_000, fd: 7, nsecs: 20_000_002_000, ret: 1_000_000 }),
		];
		const result = attributeKernelIo([identityEvent()], collected({ records }), ROOT);

		assert.equal(result.attributed, "unavailable");
		assert.deepEqual(result.unavailableReasons, ["no-path-under-storage-root"]);
		assert.equal(result.diagnostics.coverage.complete, false);
		// The pre-fix reading, kept visible: bytes were attributed, every one of
		// them pathless, while the real traffic sits outside the root.
		assert.equal(result.diagnostics.attributedBytes.traced, 240);
		assert.equal(result.diagnostics.attributedBytes.placed, 0);
		assert.equal(bucketBytes(result.diagnostics.ignored.outsideRoot), 1_000_000);
		// Nothing resolved under the root, on either side, so there is no share to
		// state. `0` here would read as "nothing was orphaned", which is the
		// opposite of what happened.
		assert.equal(result.diagnostics.unattributedShare, "N/A");
		// 240 pathless bytes against a megabyte outside the root: a wrong root,
		// not a collector that attached after the descriptors were opened.
		assert.deepEqual(rootEvidence(result), { pathlessBytes: 240, pathsOutsideRoot: true, pathsUnderRoot: false });
	});

	it("does not confuse pathless bytes with bytes placed under the root", () => {
		// Observed from before the process started, so coverage is not what is
		// under test here.
		const records: TraceRecord[] = [rw({ bytes: 240, fd: 1, nsecs: 5_000_000_000, ret: 240 }), ...envelopeWrite(42, 1_000, 500, 5_000_001_000)];
		const result = attributeKernelIo([identityEvent()], collected({ records }), ROOT);
		const row = rowFor(result, 42, 1_000);
		// Both totals are right and they are different quantities: the reported
		// volume keeps the inherited-fd bytes, every judgement leaves them out.
		assert.equal(tracedBytesOf(row.io), 740);
		assert.equal(placedBytesOf(row.io), 500);
		assert.equal(pathlessBytesOf(row.io), 240);
		assert.equal(row.io.unknownDescriptor.writeBytes, 240);
		assert.equal(result.diagnostics.attributedBytes.traced, 740);
		assert.equal(result.diagnostics.attributedBytes.placed, 500);
		assert.deepEqual(result.unavailableReasons, []);
		assert.equal(result.diagnostics.coverage.complete, true);
	});

	it("names what it saw rather than blaming a root that is right", () => {
		// The false positive the activity test introduced, and the reason it used
		// to report. The root is correct and the run wrote a megabyte of genuine
		// envelope traffic — but on a descriptor opened before the collector
		// attached, so no `openat` is in the trace and those bytes carry no path.
		// The only path the collector did resolve is an unrelated library read.
		//
		// Refusing is right: with no path under the root there is nothing to stand
		// an account on. Blaming the root is not — it would send an operator to
		// re-check a correct configuration. The reason now states only what was
		// observed, and the evidence beside it names the real cause.
		const records: TraceRecord[] = [
			rw({ bytes: 1_000_000, fd: 7, nsecs: 20_000_000_000, ret: 1_000_000 }),
			open("/etc/ssl/certs/ca-certificates.crt", { nsecs: 20_000_001_000, ret: 11 }),
			rw({ bytes: 4_096, fd: 11, nsecs: 20_000_002_000, ret: 4_096, syscall: "read" }),
		];
		const result = attributeKernelIo([identityEvent()], collected({ records }), ROOT);

		assert.equal(result.attributed, "unavailable");
		assert.deepEqual(result.unavailableReasons, ["no-path-under-storage-root"]);
		// A megabyte on descriptors nobody could place is the late-attach
		// signature; the wrong-root case above shows 240 bytes in the same field.
		assert.deepEqual(rootEvidence(result), { pathlessBytes: 1_000_000, pathsOutsideRoot: true, pathsUnderRoot: false });
		assert.equal(result.diagnostics.attributedBytes.traced, 1_000_000);
		assert.equal(result.diagnostics.attributedBytes.placed, 0);
	});

	it("refuses a mismatched root whose only evidence is calls that failed", () => {
		// A root naming a tree that is not there produces failures and no bytes at
		// all. `bucketBytes` sees nothing to object to; a failed call still proves
		// the path was reached for, and that is what the root check needs.
		const records: TraceRecord[] = [
			open("/host/var/synapse/envelopes/m2.json", { nsecs: 20_000_000_000, ret: -2 }),
			rw({ bytes: 512, fd: 9, nsecs: 20_000_001_000, ret: -9 }),
		];
		const result = attributeKernelIo([identityEvent()], collected({ records }), ROOT);
		assert.equal(result.attributed, "unavailable");
		assert.deepEqual(result.unavailableReasons, ["no-path-under-storage-root"]);
		assert.equal(bucketBytes(result.diagnostics.ignored.outsideRoot), 0);
		assert.equal(result.diagnostics.ignored.outsideRoot.failedPathCalls, 1);
		assert.equal(bucketTouched(result.diagnostics.ignored.outsideRoot), true);
	});

	it("takes a failed call under the root as proof the root matched", () => {
		// The mirror image: the same failure, under the configured root. The root
		// is evidently right, so there is nothing to refuse — even though not one
		// byte moved anywhere.
		const records: TraceRecord[] = [open(`${ROOT}/envelopes/m2.json`, { nsecs: 20_000_000_000, ret: -2 })];
		const result = attributeKernelIo([identityEvent()], collected({ records }), ROOT);
		assert.deepEqual(result.unavailableReasons, []);
		assert.equal(rowFor(result, 42, 1_000).io.categories.envelope.failedPathCalls, 1);
		assert.equal(result.diagnostics.coverage.complete, false);
	});

	it("does not refuse a run whose only observed bytes were the measurement's own storage", () => {
		// `metering/` matches only after the root prefix matched, so excluded
		// bytes are evidence the root is right — the opposite of a mismatch.
		const records: TraceRecord[] = [
			open(`${ROOT}/metering/run-1.jsonl`, { nsecs: 20_000_000_000, ret: 12 }),
			rw({ bytes: 800, fd: 12, nsecs: 20_000_001_000, ret: 800 }),
		];
		const result = attributeKernelIo([identityEvent()], collected({ records }), ROOT);
		assert.deepEqual(result.unavailableReasons, []);
		assert.equal(bucketBytes(result.diagnostics.ignored.excluded), 800);
		// Nothing attributable moved, so the account certifies nothing either.
		assert.equal(result.diagnostics.coverage.complete, false);
	});

	it("reports what the collector said even on the bad-root path", () => {
		// A bad root does not make a ring-buffer overflow disappear, and a loss
		// count of zero next to one loss report would be an "I did not look" zero.
		const result = attributeKernelIo(
			[identityEvent()],
			collected({
				errors: [{ detail: "line is not valid JSON", line: 3, reason: "malformed" }],
				losses: [{ count: 9, kind: "lost", nsecs: 25_000_000_000 }],
				records: envelopeWrite(42, 1_000, 50_000),
			}),
			"var/synapse",
		);
		assert.deepEqual(result.unavailableReasons, ["collector-reported-loss", "unreadable-lines", "unusable-storage-root"]);
		assert.equal(result.diagnostics.lossReports, 1);
		assert.equal(result.diagnostics.lostEventsHighWater, 9);
		assert.equal(result.diagnostics.traceLines.errors.malformed, 1);
	});

	it("distinguishes a collector that ran and saw nothing from no collector at all", () => {
		// Same storage root, same events, same absence of trace lines. The only
		// difference is which of the two facts the caller stated, and it decides
		// whether the root is examined at all — which is why the input is a
		// discriminant and not a nullable trace a caller could fumble.
		const ranAndSawNothing = attributeKernelIo([identityEvent()], collected(), "var/synapse");
		const neverRan = attributeKernelIo([identityEvent()], NOT_COLLECTED, "var/synapse");
		assert.equal(ranAndSawNothing.attributed, "unavailable");
		assert.equal(neverRan.attributed, "N/A");
	});

	it("checks the root of an empty trace file too, instead of calling it no collection", () => {
		// An empty trace file is weak evidence of nothing happening, and a
		// misconfigured root explains it better than a quiet run. Only `null` —
		// "no collector ran" — skips the root check; see the `null` case above.
		const result = attributeKernelIo([identityEvent()], collected(), "var/synapse");
		assert.equal(result.attributed, "unavailable");
		assert.deepEqual(result.unavailableReasons, ["unusable-storage-root"]);
	});

	it("still reports N/A on a host that collected nothing, whatever shape its storage root has", () => {
		// A Windows checkout's storage root is never POSIX-absolute and never
		// collects. Refusing there would turn "this deployment does not collect"
		// into "this run's measurement failed", on every run.
		const result = attributeKernelIo([identityEvent()], NOT_COLLECTED, "C:\\Users\\dev\\synapse");
		assert.equal(result.attributed, "N/A");
		assert.deepEqual(result.unavailableReasons, []);
	});

	it("accepts the absolute root the collector actually reports paths against", () => {
		const result = attributeKernelIo([identityEvent()], collected({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
		assert.deepEqual(result.unavailableReasons, []);
		assert.equal(result.diagnostics.attributedBytes.placed, 500);
	});
});

describe("synapse kernel I/O attribution: no collection at all", () => {
	it("reports N/A when this deployment ran no collector", () => {
		const result = attributeKernelIo([identityEvent()], NOT_COLLECTED, ROOT);
		assert.equal(result.attributed, "N/A");
		assert.equal(result.diagnostics.unattributedShare, "N/A");
		assert.equal(result.diagnostics.coverage.observedFromNsecs, "N/A");
		assert.deepEqual(result.unavailableReasons, []);
		assert.equal(result.diagnostics.attributedBytes.placed, 0);
		assert.equal(result.diagnostics.storageRootEvidence, "N/A");
		assert.equal(result.diagnostics.traceLines.records, 0);
	});

	it("treats a trace with nothing in it the same as no trace, never as a run that did no I/O", () => {
		const result = attributeKernelIo([identityEvent()], collected(), ROOT);
		assert.equal(result.attributed, "N/A");
		assert.notEqual(result.attributed, "unavailable");
		assert.deepEqual(result.diagnostics.unattributedProcesses, []);
	});

	it("does not report N/A once the trace holds any line at all, even an unreadable one", () => {
		const result = attributeKernelIo([identityEvent()], collected({ errors: [{ detail: "line is not valid JSON", line: 1, reason: "malformed" }] }), ROOT);
		assert.equal(result.attributed, "unavailable");
		assert.deepEqual(result.unavailableReasons, ["unreadable-lines"]);
	});
});

describe("synapse kernel I/O attribution: clock alignment across the two bases", () => {
	it("states the tick rate userspace reads out of /proc", () => {
		// `USER_HZ` is 100 for everything read out of /proc, whatever the kernel's
		// internal CONFIG_HZ. The whole boot-based timeline rests on it.
		assert.equal(LINUX_CLOCK_TICKS_PER_SECOND, 100);
	});

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
		const result = attributeKernelIo([event], collected({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
		assert.equal(result.diagnostics.clockInconsistentIdentityEvents, 1);
		const row = rowFor(result, 42, 1_000);
		assert.equal(row.coverage.unobservedPrefixNsecs, "unavailable");
		assert.equal(row.coverage.observedFromStart, false);
	});

	it("accepts the tick of slack that flooring start ticks costs", () => {
		// startTicks floors to a tick boundary, so a log epoch may read up to one
		// tick before the computed start without the bases disagreeing.
		const event = identityEvent({ monotonicMs: 0, startTicks: 1_000, uptimeAtRecordSeconds: 9.995 });
		const result = attributeKernelIo([event], collected({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
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
			collected({ records }),
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
		const result = attributeKernelIo([identityEvent()], collected({ records: envelopeWrite(42, 1_000, 500) }), ROOT);
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
			collected({ records }),
			ROOT,
		);
		assert.equal(rowFor(result, 42, 1_000).coverage.unobservedPrefixNsecs, 5_000_000_000);
	});

	it("counts a loss report's own timestamp as an observation", () => {
		// A loss report proves the collector was running at that instant even
		// though the events it covers are gone.
		const result = attributeKernelIo(
			[identityEvent()],
			collected({ losses: [{ count: 3, kind: "lost", nsecs: 8_000_000_000 }], records: envelopeWrite(42, 1_000, 500) }),
			ROOT,
		);
		assert.equal(result.diagnostics.coverage.observedFromNsecs, 8_000_000_000);
		assert.equal(result.diagnostics.coverage.complete, true);
		// Coverage being provable does not rescue a run that lost events.
		assert.equal(result.attributed, "unavailable");
	});

	it("carries a non-standard tick rate all the way through the join, not just into the conversion", () => {
		// At USER_HZ 250 the same startTicks names a different instant, so the
		// unobserved prefix has to change with it. A rate wired into the
		// conversion but not reachable from here would leave this at 10s.
		const event = identityEvent({ monotonicMs: 1_000, startTicks: 1_000, uptimeAtRecordSeconds: 16 });
		const result = attributeKernelIo([event], collected({ records: envelopeWrite(42, 1_000, 500) }), ROOT, { ticksPerSecond: 250 });
		assert.equal(rowFor(result, 42, 1_000).coverage.unobservedPrefixNsecs, 20_000_000_000 - 4_000_000_000);
		assert.equal(result.diagnostics.clockInconsistentIdentityEvents, 0);
	});

	it("reports a reading past the exactly-representable range as unavailable rather than rounding it", () => {
		// Nanoseconds since boot leave the safe-integer range after ~104 days of
		// uptime. A rounded reading would produce a coverage answer that looks
		// every bit as decided as a real one.
		const beyondSafe = Number.MAX_SAFE_INTEGER + 4_096;
		const lateTrace = collected({ records: envelopeWrite(42, 1_000, 500, beyondSafe) });
		const observed = attributeKernelIo([identityEvent()], lateTrace, ROOT);
		assert.equal(observed.diagnostics.coverage.observedFromNsecs, "unavailable");
		assert.equal(rowFor(observed, 42, 1_000).coverage.unobservedPrefixNsecs, "unavailable");
		assert.equal(rowFor(observed, 42, 1_000).coverage.observedFromStart, false);

		// The same bound on the other side of the comparison: a start time that
		// cannot be represented exactly is not a start time this module will use.
		const farStartTicks = 2_000_000_000;
		const farEvent = identityEvent({ monotonicMs: 1_000, startTicks: farStartTicks, uptimeAtRecordSeconds: 21_000_000 });
		const started = attributeKernelIo([farEvent], collected({ records: envelopeWrite(42, farStartTicks, 500, 1_000_000_000) }), ROOT);
		assert.equal(started.diagnostics.coverage.observedFromNsecs, 1_000_000_000);
		assert.equal(rowFor(started, 42, farStartTicks).coverage.unobservedPrefixNsecs, "unavailable");
		assert.equal(started.diagnostics.coverage.complete, false);
	});

	it("does not call an account complete while a bound process is missing from the trace entirely", () => {
		// The process that did all its I/O before the collector started emits no
		// trace line at all, so it has no row and no per-process coverage to be
		// false. A `complete` that walked only the rows would call this — one of
		// the emptiest results the module can produce — a whole account of the run.
		const events = [identityEvent({ pid: 42 }), identityEvent({ pid: 99, startTicks: 1_100, uptimeAtRecordSeconds: 17 })];
		const records: TraceRecord[] = [rw({ bytes: 0, fd: 3, nsecs: 5_000_000_000, pid: 42, ret: 0, startTicks: 1_000 })];
		const result = attributeKernelIo(events, collected({ records }), ROOT);

		assert.equal(result.diagnostics.identityKeysWithoutTrace, 1);
		// Everything a row-walking check could see says "complete": the one
		// process present was observed from its start and nothing was orphaned.
		assert.equal(result.diagnostics.coverage.processesWithUnobservedPrefix, 0);
		assert.equal(result.diagnostics.unattributedShare, "N/A");
		assert.deepEqual(result.unavailableReasons, []);
		assert.equal(result.diagnostics.coverage.complete, false);
	});

	it("does call a healthy account complete", () => {
		// The positive control for every denial below: bytes attributed, observed
		// from the start, every bound key present, nothing orphaned.
		const result = attributeKernelIo([identityEvent()], collected({ records: envelopeWrite(42, 1_000, 500, 5_000_000_000) }), ROOT);
		assert.deepEqual(result.unavailableReasons, []);
		assert.equal(result.diagnostics.coverage.complete, true);
	});

	it("does not call an account complete while any observed byte was left unattributed", () => {
		// 0.02%: reported rather than refused, but 200 bytes this account does not
		// hold are 200 bytes that make it not whole.
		const records = [...envelopeWrite(42, 1_000, 999_800, 5_000_000_000), ...envelopeWrite(77, 4_000, 200, 30_000_000_000)];
		const result = attributeKernelIo([identityEvent()], collected({ records }), ROOT);
		assert.deepEqual(result.unavailableReasons, []);
		assert.equal(attributedRows(result).length, 1);
		assert.equal(rowFor(result, 42, 1_000).coverage.observedFromStart, true);
		assert.equal(result.diagnostics.coverage.processesWithUnobservedPrefix, 0);
		assert.equal(result.diagnostics.coverage.complete, false);
	});

	it("does not let a row that moved no attributable byte certify the account", () => {
		const result = attributeKernelIo(
			[identityEvent()],
			collected({ records: [open(`${ROOT}/envelopes/m1.json`, { nsecs: 5_000_000_000 })] }),
			ROOT,
		);
		assert.equal(attributedRows(result).length, 1);
		assert.equal(rowFor(result, 42, 1_000).coverage.observedFromStart, true);
		assert.equal(result.diagnostics.attributedBytes.placed, 0);
		assert.equal(result.diagnostics.coverage.complete, false);
	});

	it("does not call an empty account complete", () => {
		// Nothing was attributed, so there is no process whose coverage was
		// proved; `complete` must not read as "the whole run is accounted for".
		const result = attributeKernelIo([], collected({ records: envelopeWrite(77, 4_000, 0) }), ROOT);
		assert.equal(result.diagnostics.coverage.complete, false);
	});
});
