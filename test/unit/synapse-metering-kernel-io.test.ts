import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateWithKernelIo, type KernelIoAccount, type KernelIoSource, type MeteringWithKernelIo } from "../../src/synapse/metering-kernel-io.ts";
import { aggregateMetering, type MeteringEvent, type MeteringIdentity } from "../../src/synapse/metering.ts";
import type { TraceCollection } from "../../src/synapse/trace-attribute.ts";
import type { TraceDescriptorRecord, TraceLineError, TraceLog, TraceLossReport, TracePathRecord, TraceRecord } from "../../src/synapse/trace-log.ts";

const ROOT = "/var/synapse";
/** The root a Windows host would produce: never POSIX-absolute, and therefore never usable against kernel paths. */
const WINDOWS_ROOT = "C:\\Users\\runner\\synapse";

/**
 * Magic byte counts, chosen so every number this suite cares about is unique
 * and so their sum appears nowhere by accident — the "never summed" assertions
 * search the whole serialised result for it.
 */
const APPLICATION_ENVELOPE_BYTES = 1_111;
const KERNEL_ENVELOPE_WRITE_BYTES = 22_222;
const SUM_THAT_MUST_NOT_APPEAR = APPLICATION_ENVELOPE_BYTES + KERNEL_ENVELOPE_WRITE_BYTES;

/** Boot-based instants. The process starts at tick 1000 = 10s after boot; the collector may be observing before or after that. */
const PROCESS_START_TICKS = 1_000;
const BEFORE_PROCESS_START_NSECS = 9_000_000_000;
const AFTER_PROCESS_START_NSECS = 20_000_000_000;

function identity(overrides: Partial<MeteringIdentity> = {}): MeteringIdentity {
	return { agent: "researcher", attempt: 1, mode: "synapse", nodeId: "run-1/0", runId: "run-1", sessionId: "sess-1", snapshotId: null, ...overrides };
}

/** The one event kind that binds an OS process to a run. Its three readings are mutually consistent: started 10s after boot, log created 5s later, sampled 1s after that. */
function identityEvent(pid = 42, startTicks = PROCESS_START_TICKS): MeteringEvent {
	return {
		...identity(),
		eventId: `event-identity-${pid}-${startTicks}`,
		kind: "process-identity",
		monotonicMs: 1_000,
		pid,
		schemaVersion: 1,
		startTicks,
		ts: "2026-09-19T00:00:00.000Z",
		uptimeAtRecordSeconds: 16,
	};
}

/**
 * A metering log that exercises most of `aggregateMetering`: the point of the
 * identity assertions is that none of these totals shift when a kernel column
 * is added beside them, so a thin log would prove very little.
 */
function applicationEvents(): MeteringEvent[] {
	const base = { ...identity(), schemaVersion: 1, ts: "2026-09-19T00:00:00.000Z" };
	return [
		identityEvent(),
		{ ...base, envelopeBytes: APPLICATION_ENVELOPE_BYTES, eventId: "event-delivered", kind: "message-delivered", messageId: "m-1", monotonicMs: 1_100, textBytes: 640 },
		{ ...base, eventId: "event-received", kind: "message-received", messageId: "m-1", monotonicMs: 1_200 },
		{ ...base, bytes: 4_096, direction: "write", eventId: "event-object-io", kind: "object-io", monotonicMs: 1_300 },
		{ ...base, eventId: "event-task-start", kind: "task-span", monotonicMs: 1_000, phase: "start", taskId: "t-1" },
		{ ...base, eventId: "event-task-end", kind: "task-span", monotonicMs: 1_900, phase: "end", taskId: "t-1" },
		{ ...base, eventId: "event-usage-parent", kind: "model-usage", monotonicMs: 1_500, role: "parent", usage: { cacheRead: 10, cacheWrite: 20, cost: 0.5, input: 300, output: 40 } },
		{ ...base, eventId: "event-usage-child", kind: "model-usage", monotonicMs: 1_600, role: "child", usage: { cacheRead: 1, cacheWrite: 2, cost: 0.25, input: 30, output: 4 } },
		{ ...base, category: "timeout", detail: "retried once", eventId: "event-error", kind: "error", monotonicMs: 1_700 },
		{ ...base, authorisedValidHits: 2, eventId: "event-memory-query", kind: "memory-query", monotonicMs: 1_800, queryId: "q-1" },
	];
}

function write(bytes: number, overrides: Partial<TraceDescriptorRecord> = {}): TraceDescriptorRecord {
	return { bytes, fd: 7, nsecs: BEFORE_PROCESS_START_NSECS, pid: 42, ret: bytes, startTicks: PROCESS_START_TICKS, syscall: "write", tid: 42, ...overrides };
}

function open(path: string, overrides: Partial<TracePathRecord> = {}): TracePathRecord {
	return { bytes: 0, fd: -100, nsecs: BEFORE_PROCESS_START_NSECS, path, pid: 42, ret: 7, startTicks: PROCESS_START_TICKS, syscall: "openat", tid: 42, ...overrides };
}

type TraceLogOverrides = { errors?: TraceLineError[]; losses?: TraceLossReport[]; records?: TraceRecord[] };

/** A collector that ran and produced this output — including the case where it produced nothing at all. */
function collected(overrides: TraceLogOverrides = {}): TraceCollection {
	const trace: TraceLog = { errors: overrides.errors ?? [], losses: overrides.losses ?? [], records: overrides.records ?? [] };
	return { kind: "collected", trace };
}

/** One `openat` plus one `write` of an envelope, by one process, at a given instant. */
function envelopeWrite(pid: number, startTicks: number, bytes: number, nsecs: number): TraceRecord[] {
	return [
		open(`${ROOT}/envelopes/m-${pid}-${startTicks}.json`, { nsecs, pid, startTicks }),
		write(bytes, { nsecs: nsecs + 1_000, pid, startTicks }),
	];
}

function source(collection: TraceCollection, storageRoot = ROOT): KernelIoSource {
	return { collection, storageRoot };
}

/** A collector already observing before the bound process started: the only way coverage can be proved gap-free. */
function healthySource(): KernelIoSource {
	return source(collected({ records: envelopeWrite(42, PROCESS_START_TICKS, KERNEL_ENVELOPE_WRITE_BYTES, BEFORE_PROCESS_START_NSECS) }));
}

/**
 * Every number in a serialised result, including any that appear inside
 * strings. Deliberately over-inclusive: an assertion that a value appears
 * *nowhere* is only worth having if it looks everywhere.
 */
function numbersIn(value: MeteringWithKernelIo | KernelIoAccount): number[] {
	return [...JSON.stringify(value).matchAll(/\d+(?:\.\d+)?/gu)].map((match) => Number(match[0]));
}

function accountOfKind<Kind extends KernelIoAccount["kind"]>(account: KernelIoAccount, kind: Kind): Extract<KernelIoAccount, { kind: Kind }> {
	assert.equal(account.kind, kind, `expected a ${kind} account, got ${JSON.stringify(account)}`);
	// SAFETY: the assertion above is `node:assert/strict`'s, so control only
	// reaches this line when the discriminant is exactly `kind`; the narrowing is
	// one TypeScript cannot follow through an assertion helper it does not own.
	return account as Extract<KernelIoAccount, { kind: Kind }>;
}

describe("synapse metering aggregation with kernel I/O: no kernel input", () => {
	it("produces application totals field for field identical to aggregateMetering", () => {
		const events = applicationEvents();
		const result = aggregateWithKernelIo(events);
		const expected = aggregateMetering(events);
		assert.deepEqual(result.application, expected);
		assert.deepEqual(Object.keys(result.application).sort(), Object.keys(expected).sort());
	});

	it("answers N/A rather than a zero account, and does not call it a refusal", () => {
		const account = aggregateWithKernelIo(applicationEvents()).kernel;
		assert.equal(account.kind, "not-collected");
		assert.ok(!("bytes" in account), "a deployment that collected nothing must not report a byte total");
		assert.ok(!("reasons" in account), "no collection is not a refusal and must carry no refusal reasons");
	});

	it("says the same thing when the collection is stated explicitly, root or no root", () => {
		// The `not-collected` answer is reached before the storage root is looked
		// at, so a deployment with no collector cannot be tripped by the root it
		// happens to have configured — which on Windows is never usable.
		const events = applicationEvents();
		const omitted = aggregateWithKernelIo(events);
		assert.deepEqual(aggregateWithKernelIo(events, source({ kind: "not-collected" })), omitted);
		assert.deepEqual(aggregateWithKernelIo(events, source({ kind: "not-collected" }, WINDOWS_ROOT)), omitted);
	});
});

describe("synapse metering aggregation with kernel I/O: transportBytes", () => {
	it("stays N/A under every input, collected or not, reported or refused", () => {
		const events = applicationEvents();
		const inputs: KernelIoSource[] = [
			source({ kind: "not-collected" }),
			source({ kind: "not-collected" }, WINDOWS_ROOT),
			source(collected(), WINDOWS_ROOT),
			source(collected()),
			source(collected({ losses: [{ count: 12, kind: "lost", nsecs: BEFORE_PROCESS_START_NSECS }] })),
			healthySource(),
			source(collected({ records: envelopeWrite(42, PROCESS_START_TICKS, KERNEL_ENVELOPE_WRITE_BYTES, AFTER_PROCESS_START_NSECS) })),
		];
		for (const input of [undefined, ...inputs]) {
			const result = input === undefined ? aggregateWithKernelIo(events) : aggregateWithKernelIo(events, input);
			assert.equal(result.application.control.transportBytes, "N/A", `transportBytes must stay N/A for ${JSON.stringify(input)}`);
			if ("envelope" in result.kernel) assert.equal(result.kernel.envelope.transportBytes, "N/A");
		}
	});

	it("never perturbs the application column, whatever the kernel side says", () => {
		const events = applicationEvents();
		const expected = aggregateMetering(events);
		assert.deepEqual(aggregateWithKernelIo(events, healthySource()).application, expected);
		assert.deepEqual(aggregateWithKernelIo(events, source(collected(), WINDOWS_ROOT)).application, expected);
	});
});

describe("synapse metering aggregation with kernel I/O: no collection is not a refusal", () => {
	it("separates a deployment that collects nothing from a collector whose account was refused", () => {
		const events = applicationEvents();
		// The same empty trace, spelled the two ways. On a Windows host the root is
		// never POSIX-absolute, so spelling "no collector ran" as an empty
		// `collected` trace would refuse every run on the platform.
		const notCollected = aggregateWithKernelIo(events, source({ kind: "not-collected" }, WINDOWS_ROOT)).kernel;
		const collectedOnWindowsRoot = aggregateWithKernelIo(events, source(collected(), WINDOWS_ROOT)).kernel;

		assert.equal(notCollected.kind, "not-collected");
		const refused = accountOfKind(collectedOnWindowsRoot, "refused");
		assert.deepEqual([...refused.reasons], ["unusable-storage-root"]);
		assert.notEqual(notCollected.kind, refused.kind);
	});
});

describe("synapse metering aggregation with kernel I/O: a refused account", () => {
	it("reports the reasons and reaches no byte total through any field", () => {
		const records = envelopeWrite(42, PROCESS_START_TICKS, KERNEL_ENVELOPE_WRITE_BYTES, BEFORE_PROCESS_START_NSECS);
		const losses: TraceLossReport[] = [{ count: 12, kind: "lost", nsecs: BEFORE_PROCESS_START_NSECS }];
		const account = aggregateWithKernelIo(applicationEvents(), source(collected({ losses, records }))).kernel;

		const refused = accountOfKind(account, "refused");
		assert.deepEqual([...refused.reasons], ["collector-reported-loss"]);
		assert.deepEqual(Object.keys(refused).sort(), ["kind", "reasons", "traceLines"]);
		assert.deepEqual(refused.traceLines, { errors: { malformed: 0, "too-long": 0, truncated: 0 }, losses: 1, records: 2 });
		// The bytes were observed and could be totalled; the point is that nothing
		// on a refused result does. The diagnostics of `attributeKernelIo` keep
		// them as denominators and say they are not totals — re-exposing them here
		// would hand back the account that module withheld.
		assert.ok(!numbersIn(refused).includes(KERNEL_ENVELOPE_WRITE_BYTES), "a refused account must not surface the bytes it refused to report");
	});

	it("gives every applicable reason, not just the first", () => {
		const errors: TraceLineError[] = [{ detail: "cut off mid-write", line: 3, reason: "truncated" }];
		const losses: TraceLossReport[] = [{ count: 4, kind: "lost", nsecs: BEFORE_PROCESS_START_NSECS }];
		const account = aggregateWithKernelIo(applicationEvents(), source(collected({ errors, losses }), WINDOWS_ROOT)).kernel;

		const refused = accountOfKind(account, "refused");
		assert.deepEqual([...refused.reasons].sort(), ["collector-reported-loss", "unreadable-lines", "unusable-storage-root"]);
		assert.equal(refused.traceLines.errors.truncated, 1);
	});
});

describe("synapse metering aggregation with kernel I/O: a healthy account", () => {
	it("reports kernel bytes and envelopeBytes side by side and never as a sum", () => {
		const result = aggregateWithKernelIo(applicationEvents(), healthySource());
		const reported = accountOfKind(result.kernel, "reported-no-gap-found");

		assert.equal(reported.envelope.applicationEnvelopeBytes, APPLICATION_ENVELOPE_BYTES);
		assert.equal(reported.envelope.kernelEnvelopeWriteBytes, KERNEL_ENVELOPE_WRITE_BYTES);
		assert.equal(result.application.control.envelopeBytes, APPLICATION_ENVELOPE_BYTES);
		assert.equal(reported.bytes.byCategory.envelope.writeBytes, KERNEL_ENVELOPE_WRITE_BYTES);
		assert.equal(reported.bytes.placedBytes, KERNEL_ENVELOPE_WRITE_BYTES);
		// Nowhere in the whole result — not in the columns, not in a convenience
		// total, not inside a per-process row — do the two columns appear added
		// together. Kernel VFS bytes and serialised envelope bytes are different
		// quantities and their sum means nothing (design §5.1).
		assert.ok(!numbersIn(result).includes(SUM_THAT_MUST_NOT_APPEAR), "the application and kernel envelope columns must never be summed");
	});

	it("keeps every category present even at zero, and pathless bytes out of the placed total", () => {
		// A write on a descriptor no observed `openat` produced: an inherited
		// stdio fd, which every backgrounded agent here has. It resolved to no
		// path, so it is volume and nothing else.
		const records = [write(KERNEL_ENVELOPE_WRITE_BYTES)];
		const account = aggregateWithKernelIo(applicationEvents(), source(collected({ records }))).kernel;

		const reported = accountOfKind(account, "reported-with-gaps");
		assert.equal(reported.bytes.pathlessBytes, KERNEL_ENVELOPE_WRITE_BYTES);
		assert.equal(reported.bytes.placedBytes, 0);
		assert.equal(reported.bytes.byCategory.envelope.writeBytes, 0);
		assert.deepEqual(Object.keys(reported.bytes.byCategory).sort(), ["content", "envelope", "memory-index"]);
		assert.equal(reported.gaps.noAttributedBytesUnderStorageRoot, true);
		// The application column is untouched by an account made entirely of bytes
		// that certify nothing.
		assert.equal(reported.envelope.applicationEnvelopeBytes, APPLICATION_ENVELOPE_BYTES);
		assert.equal(reported.envelope.kernelEnvelopeWriteBytes, 0);
	});

	it("carries the per-process rows, each with the identities it was bound to", () => {
		const reported = accountOfKind(aggregateWithKernelIo(applicationEvents(), healthySource()).kernel, "reported-no-gap-found");
		assert.equal(reported.processes.length, 1);
		const [row] = reported.processes;
		assert.ok(row !== undefined);
		assert.equal(row.io.pid, 42);
		assert.deepEqual(
			row.identities.map((bound) => bound.runId),
			["run-1"],
		);
		assert.equal(row.coverage.observedFromStart, true);
	});
});

describe("synapse metering aggregation with kernel I/O: coverage on every path", () => {
	it("surfaces a late-attached collector as a gap a caller has to name to read the bytes at all", () => {
		const records = envelopeWrite(42, PROCESS_START_TICKS, KERNEL_ENVELOPE_WRITE_BYTES, AFTER_PROCESS_START_NSECS);
		const account = aggregateWithKernelIo(applicationEvents(), source(collected({ records }))).kernel;

		const reported = accountOfKind(account, "reported-with-gaps");
		assert.equal(reported.gaps.processesWithUnobservedPrefix, 1);
		assert.equal(reported.bytes.placedBytes, KERNEL_ENVELOPE_WRITE_BYTES);
		const [row] = reported.processes;
		assert.ok(row !== undefined);
		assert.equal(row.coverage.observedFromStart, false);
		assert.equal(row.coverage.unobservedPrefixNsecs, 10_000_000_000);
	});

	it("keeps an orphan's bytes out of the totals and says one was left over", () => {
		const records = [
			...envelopeWrite(42, PROCESS_START_TICKS, KERNEL_ENVELOPE_WRITE_BYTES, BEFORE_PROCESS_START_NSECS),
			...envelopeWrite(99, 2_000, 100, BEFORE_PROCESS_START_NSECS + 500_000_000),
		];
		const account = aggregateWithKernelIo(applicationEvents(), source(collected({ records }))).kernel;

		const reported = accountOfKind(account, "reported-with-gaps");
		assert.equal(reported.gaps.unattributedProcesses, 1);
		assert.equal(reported.bytes.placedBytes, KERNEL_ENVELOPE_WRITE_BYTES, "an orphan's bytes belong to no run and must not be folded into one");
		assert.ok(reported.gaps.unattributedShare !== "N/A");
		assert.ok(reported.gaps.unattributedShare <= reported.gaps.unattributedShareThreshold);
	});

	it("reports an identity that produced no trace line at all as a gap", () => {
		const events = [...applicationEvents(), identityEvent(77, 3_000)];
		const account = aggregateWithKernelIo(events, healthySource()).kernel;

		const reported = accountOfKind(account, "reported-with-gaps");
		assert.equal(reported.gaps.identitiesWithoutTrace, 1);
		assert.equal(reported.gaps.processesWithUnobservedPrefix, 0);
	});

	it("leaves no outcome in which bytes can be read without the coverage or refusal state", () => {
		const events = applicationEvents();
		const lateRecords = envelopeWrite(42, PROCESS_START_TICKS, KERNEL_ENVELOPE_WRITE_BYTES, AFTER_PROCESS_START_NSECS);
		const outcomes: KernelIoAccount[] = [
			aggregateWithKernelIo(events).kernel,
			aggregateWithKernelIo(events, source(collected(), WINDOWS_ROOT)).kernel,
			aggregateWithKernelIo(events, healthySource()).kernel,
			aggregateWithKernelIo(events, source(collected({ records: lateRecords }))).kernel,
		];

		for (const account of outcomes) {
			if (account.kind === "not-collected" || account.kind === "refused") {
				assert.ok(!("bytes" in account), "an account with no reportable result must carry no bytes");
				continue;
			}
			// The two byte-carrying variants are told apart by coverage, so the
			// caller above has already branched on it to get here. `gaps` exists on
			// exactly one of them, and it is the one whose bytes are incomplete.
			assert.equal("gaps" in account, account.kind === "reported-with-gaps");
			assert.ok(account.bytes.placedBytes >= 0);
		}
		assert.deepEqual(
			outcomes.map((account) => account.kind),
			["not-collected", "refused", "reported-no-gap-found", "reported-with-gaps"],
		);
	});
});
