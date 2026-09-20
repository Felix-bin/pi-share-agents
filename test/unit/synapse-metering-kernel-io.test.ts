import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateWithKernelIo, type KernelIoAccount, type KernelIoReport, type KernelIoSource, type MeteringWithKernelIo } from "../../src/synapse/metering-kernel-io.ts";
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

/** A read or write on an already-open descriptor. Defaults to a write on fd 7, the descriptor `open` hands back. */
function rw(bytes: number, overrides: Partial<TraceDescriptorRecord> = {}): TraceDescriptorRecord {
	return { bytes, fd: 7, nsecs: BEFORE_PROCESS_START_NSECS, pid: 42, ret: bytes, startTicks: PROCESS_START_TICKS, syscall: "write", tid: 42, ...overrides };
}

function open(path: string, overrides: Partial<TracePathRecord> = {}): TracePathRecord {
	return { bytes: 0, fd: -100, nsecs: BEFORE_PROCESS_START_NSECS, path, pid: 42, ret: 7, startTicks: PROCESS_START_TICKS, syscall: "openat", tid: 42, ...overrides };
}

/** An `openat` on its own descriptor, then one call moving `bytes` on it: the smallest complete piece of evidence about one path. */
function ioOn(path: string, fd: number, bytes: number, syscall: "read" | "write"): TraceRecord[] {
	return [open(path, { ret: fd }), rw(bytes, { fd, nsecs: BEFORE_PROCESS_START_NSECS + fd, syscall })];
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
		rw(bytes, { nsecs: nsecs + 1_000, pid, startTicks }),
	];
}

function source(collection: TraceCollection, storageRoot = ROOT): KernelIoSource {
	return { collection, storageRoot };
}

/** A collector already observing before the bound process started: the only way coverage can be proved gap-free. */
function healthySource(): KernelIoSource {
	return source(collected({ records: envelopeWrite(42, PROCESS_START_TICKS, KERNEL_ENVELOPE_WRITE_BYTES, BEFORE_PROCESS_START_NSECS) }));
}

/** A collector whose first observation postdates the process's start: the account is reportable and known to be missing its opening I/O. */
function lateAttachedSource(): KernelIoSource {
	return source(collected({ records: envelopeWrite(42, PROCESS_START_TICKS, KERNEL_ENVELOPE_WRITE_BYTES, AFTER_PROCESS_START_NSECS) }));
}

/**
 * The totals of whichever reporting variant carries them.
 *
 * This is the one place in the suite allowed to look past coverage, and it
 * exists so that every *other* test has to name the variant it means. Note
 * that it cannot be written as `"bytes" in account`: no variant has that
 * property, which is the property requirement 4 rests on.
 */
function reportOf(account: KernelIoAccount): KernelIoReport | null {
	if (account.kind === "reported-no-gap-found") return account.noGapFound;
	if (account.kind === "reported-with-gaps") return account.withKnownGaps;
	return null;
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
		assert.equal(reportOf(account), null, "a deployment that collected nothing must not report a byte total");
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
			lateAttachedSource(),
		];
		for (const input of [undefined, ...inputs]) {
			const result = input === undefined ? aggregateWithKernelIo(events) : aggregateWithKernelIo(events, input);
			assert.equal(result.application.control.transportBytes, "N/A", `transportBytes must stay N/A for ${JSON.stringify(input)}`);
			assert.equal(reportOf(result.kernel)?.envelope.transportBytes ?? "N/A", "N/A");
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
		const { noGapFound } = accountOfKind(result.kernel, "reported-no-gap-found");

		assert.equal(noGapFound.envelope.applicationEnvelopeBytes, APPLICATION_ENVELOPE_BYTES);
		assert.equal(noGapFound.envelope.kernelEnvelopeWriteBytes, KERNEL_ENVELOPE_WRITE_BYTES);
		assert.equal(result.application.control.envelopeBytes, APPLICATION_ENVELOPE_BYTES);
		assert.equal(noGapFound.bytes.byCategory.envelope.writeBytes, KERNEL_ENVELOPE_WRITE_BYTES);
		assert.equal(noGapFound.bytes.placedBytes, KERNEL_ENVELOPE_WRITE_BYTES);
		// Nowhere in the whole result — not in the columns, not in a convenience
		// total, not inside a per-process row — do the two columns appear added
		// together. Kernel VFS bytes and serialised envelope bytes are different
		// quantities and their sum means nothing (design §5.1).
		assert.ok(!numbersIn(result).includes(SUM_THAT_MUST_NOT_APPEAR), "the application and kernel envelope columns must never be summed");
	});

	it("does not sum the two columns on a gapped account either", () => {
		// The same search, on the variant a real run will almost always produce.
		// A sum reintroduced on this path only would have gone unnoticed.
		const result = aggregateWithKernelIo(applicationEvents(), lateAttachedSource());
		const { withKnownGaps } = accountOfKind(result.kernel, "reported-with-gaps");
		assert.equal(withKnownGaps.envelope.applicationEnvelopeBytes, APPLICATION_ENVELOPE_BYTES);
		assert.equal(withKnownGaps.envelope.kernelEnvelopeWriteBytes, KERNEL_ENVELOPE_WRITE_BYTES);
		assert.ok(!numbersIn(result).includes(SUM_THAT_MUST_NOT_APPEAR), "the application and kernel envelope columns must never be summed");
	});

	it("totals every category and both directions, keeping unclassified out of the categories", () => {
		// One process touching four different parts of the storage root, reading on
		// two of them. Every column of the result is a different number, so a
		// column wired to the wrong bucket — or a read counted as a write — cannot
		// pass by coincidence.
		const records = [
			...ioOn(`${ROOT}/envelopes/m-1.json`, 7, 1_000, "write"),
			...ioOn(`${ROOT}/objects/ab/cd`, 8, 2_000, "read"),
			...ioOn(`${ROOT}/objects/ef/gh`, 9, 4_000, "write"),
			...ioOn(`${ROOT}/memory/index.json`, 10, 8_000, "read"),
			// `receipts/` is a real top-level entry the layout table deliberately
			// does not name: inside the root, no known category.
			...ioOn(`${ROOT}/receipts/r-1.json`, 11, 16_000, "write"),
			...ioOn(`${ROOT}/receipts/r-1.json`, 12, 32_000, "read"),
		];
		const account = aggregateWithKernelIo(applicationEvents(), source(collected({ records }))).kernel;

		const { noGapFound } = accountOfKind(account, "reported-no-gap-found");
		assert.deepEqual(noGapFound.bytes.byCategory.envelope, { readBytes: 0, writeBytes: 1_000 });
		assert.deepEqual(noGapFound.bytes.byCategory.content, { readBytes: 2_000, writeBytes: 4_000 });
		assert.deepEqual(noGapFound.bytes.byCategory["memory-index"], { readBytes: 8_000, writeBytes: 0 });
		assert.deepEqual(noGapFound.bytes.unclassified, { readBytes: 32_000, writeBytes: 16_000 });
		assert.equal(noGapFound.bytes.pathlessBytes, 0);
		// The one total the module recomputes rather than accumulates: it must be
		// every column, both directions, categories and unclassified alike.
		assert.equal(noGapFound.bytes.placedBytes, 1_000 + 2_000 + 4_000 + 8_000 + 16_000 + 32_000);
	});

	it("keeps every category present even at zero, and pathless bytes out of the placed total", () => {
		// A write on a descriptor no observed `openat` produced: an inherited
		// stdio fd, which every backgrounded agent here has. It resolved to no
		// path, so it is volume and nothing else.
		const records = [rw(KERNEL_ENVELOPE_WRITE_BYTES)];
		const account = aggregateWithKernelIo(applicationEvents(), source(collected({ records }))).kernel;

		const { gaps, withKnownGaps } = accountOfKind(account, "reported-with-gaps");
		assert.equal(withKnownGaps.bytes.pathlessBytes, KERNEL_ENVELOPE_WRITE_BYTES);
		assert.equal(withKnownGaps.bytes.placedBytes, 0);
		assert.equal(withKnownGaps.bytes.byCategory.envelope.writeBytes, 0);
		assert.deepEqual(withKnownGaps.bytes.unclassified, { readBytes: 0, writeBytes: 0 });
		assert.deepEqual(Object.keys(withKnownGaps.bytes.byCategory).sort(), ["content", "envelope", "memory-index"]);
		assert.equal(gaps.noAttributedBytesUnderStorageRoot, true);
		// The application column is untouched by an account made entirely of bytes
		// that certify nothing.
		assert.equal(withKnownGaps.envelope.applicationEnvelopeBytes, APPLICATION_ENVELOPE_BYTES);
		assert.equal(withKnownGaps.envelope.kernelEnvelopeWriteBytes, 0);
	});

	it("carries the per-process rows, each with the identities it was bound to", () => {
		const { noGapFound } = accountOfKind(aggregateWithKernelIo(applicationEvents(), healthySource()).kernel, "reported-no-gap-found");
		assert.equal(noGapFound.processes.length, 1);
		const [row] = noGapFound.processes;
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
		const account = aggregateWithKernelIo(applicationEvents(), lateAttachedSource()).kernel;

		const { gaps, withKnownGaps } = accountOfKind(account, "reported-with-gaps");
		assert.equal(gaps.processesWithUnobservedPrefix, 1);
		assert.equal(withKnownGaps.bytes.placedBytes, KERNEL_ENVELOPE_WRITE_BYTES);
		const [row] = withKnownGaps.processes;
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

		const { gaps, withKnownGaps } = accountOfKind(account, "reported-with-gaps");
		assert.equal(gaps.unattributedProcesses, 1);
		assert.equal(withKnownGaps.bytes.placedBytes, KERNEL_ENVELOPE_WRITE_BYTES, "an orphan's bytes belong to no run and must not be folded into one");
		assert.ok(gaps.unattributedShare !== "N/A");
		assert.ok(gaps.unattributedShare <= gaps.unattributedShareThreshold);
	});

	it("reports an identity that produced no trace line at all as a gap", () => {
		const events = [...applicationEvents(), identityEvent(77, 3_000)];
		const account = aggregateWithKernelIo(events, healthySource()).kernel;

		const { gaps } = accountOfKind(account, "reported-with-gaps");
		assert.equal(gaps.identitiesWithoutTrace, 1);
		assert.equal(gaps.processesWithUnobservedPrefix, 0);
	});

	it("leaves no outcome in which bytes can be read without the coverage or refusal state", () => {
		const events = applicationEvents();
		const outcomes: KernelIoAccount[] = [
			aggregateWithKernelIo(events).kernel,
			aggregateWithKernelIo(events, source(collected(), WINDOWS_ROOT)).kernel,
			aggregateWithKernelIo(events, healthySource()).kernel,
			aggregateWithKernelIo(events, lateAttachedSource()).kernel,
		];

		for (const account of outcomes) {
			// Exhaustive by discriminant, deliberately not by exclusion: naming all
			// four cases is the only way to reach the two that hold bytes, and each
			// byte-bearing branch had to name its own coverage state to get at them.
			switch (account.kind) {
				case "not-collected":
					assert.equal(reportOf(account), null, "a deployment that collected nothing must carry no bytes");
					break;
				case "refused":
					assert.ok(account.reasons.length > 0, "a refusal must say why");
					assert.equal(reportOf(account), null, "a refused account must carry no bytes");
					break;
				case "reported-no-gap-found":
					assert.ok(account.noGapFound.bytes.placedBytes >= 0);
					break;
				case "reported-with-gaps":
					assert.ok(account.withKnownGaps.bytes.placedBytes >= 0);
					assert.ok(account.gaps.processesWithUnobservedPrefix > 0 || account.gaps.unattributedProcesses > 0 || account.gaps.identitiesWithoutTrace > 0 || account.gaps.noAttributedBytesUnderStorageRoot);
					break;
			}
		}
		assert.deepEqual(
			outcomes.map((account) => account.kind),
			["not-collected", "refused", "reported-no-gap-found", "reported-with-gaps"],
		);
	});
});

/**
 * The acceptance criterion for requirement 4, written as code that must *not*
 * type-check.
 *
 * These are the three consumers a review wrote against an earlier shape of this
 * module, where `bytes`, `envelope` and `processes` were properties of both
 * reporting variants. All three compiled clean then, and all three read a
 * gapped byte total without the word "gap" appearing anywhere in them — which
 * is exactly what design §4.4's ruling on late-attached collectors forbids,
 * since that ruling accepted a reported gap only on the condition that a caller
 * cannot overlook it.
 *
 * Each `@ts-expect-error` below fails the build if the line beneath it ever
 * compiles again, so this function is a live guard rather than a comment.
 * `tsconfig.synapse-tests.json` is what checks it — the default `tsconfig.json`
 * includes only `src/`, so running plain `tsc --noEmit` proves nothing here.
 *
 * It is executed as well as compiled (see the test below): the reads are of
 * properties that do not exist, so they are `undefined` at runtime rather than
 * throwing, and the assertions there state that no byte total came back.
 */
function consumersThatMustNotCompile(account: KernelIoAccount): (number | undefined)[] {
	// 1. Exclusion by property presence. No variant declares `bytes`, so the
	//    narrowed type is `KernelIoAccount & Record<"bytes", unknown>` and the
	//    property is `unknown`: nothing can be read off it.
	// @ts-expect-error requirement 4: a byte total must not be reachable without naming the coverage state that qualifies it.
	const one = "bytes" in account ? account.bytes.placedBytes : 0;

	// 2. Exclusion by discriminant — the form that shipped in this suite's own
	//    coverage test and demonstrated the hole rather than closing it.
	let two: number | undefined = 0;
	if (account.kind !== "not-collected" && account.kind !== "refused") {
		try {
			// @ts-expect-error requirement 4: ruling out the two non-reporting kinds must not be enough to reach bytes.
			two = account.bytes.placedBytes + account.envelope.kernelEnvelopeWriteBytes;
		} catch {
			// There is no `bytes` property to read `placedBytes` off, so this throws
			// at run time as surely as it fails to compile. Recorded as "reached no
			// number" rather than allowed to fail the test on the TypeError.
			two = undefined;
		}
	}

	// 3. The per-process rows by the same exclusion, which is the other route to
	//    a byte number: every row carries its category buckets.
	// @ts-expect-error requirement 4: the per-process rows are a byte total too and must not be reachable by exclusion.
	const three = "processes" in account ? account.processes.length : 0;

	return [one, two, three];
}

describe("synapse metering aggregation with kernel I/O: requirement 4 acceptance", () => {
	it("reaches no byte total through any exclusion-form consumer, at compile time or at run time", () => {
		const events = applicationEvents();
		for (const account of [aggregateWithKernelIo(events).kernel, aggregateWithKernelIo(events, healthySource()).kernel, aggregateWithKernelIo(events, lateAttachedSource()).kernel]) {
			// Every entry is a fallback or `undefined`: not one of these consumers
			// got a number out of any account, gapped or not.
			for (const reached of consumersThatMustNotCompile(account)) assert.ok(reached === 0 || reached === undefined, `an exclusion-form consumer reached ${JSON.stringify(reached)}`);
		}
	});

	it("puts the totals behind a name that states their coverage, on both reporting variants", () => {
		const events = applicationEvents();
		const gapFree = accountOfKind(aggregateWithKernelIo(events, healthySource()).kernel, "reported-no-gap-found");
		const gapped = accountOfKind(aggregateWithKernelIo(events, lateAttachedSource()).kernel, "reported-with-gaps");

		// No byte-bearing property is common to the two variants: that, and not
		// the discriminant, is what makes the consumers above impossible.
		assert.deepEqual(Object.keys(gapFree).sort(), ["kind", "noGapFound"]);
		assert.deepEqual(Object.keys(gapped).sort(), ["gaps", "kind", "withKnownGaps"]);
		assert.deepEqual(Object.keys(gapFree.noGapFound).sort(), ["bytes", "envelope", "processes"]);
		assert.deepEqual(Object.keys(gapped.withKnownGaps).sort(), ["bytes", "envelope", "processes"]);
	});
});
