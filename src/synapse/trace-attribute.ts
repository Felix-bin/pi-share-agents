import { canonicalDigest } from "./canonical-json.ts";
import type { MeteringEvent, MeteringIdentity, NotApplicable, Unavailable } from "./metering.ts";
import { classifyTraceIo, type TraceIoBucket, type TraceIoClassification, type TraceProcessIo } from "./trace-classify.ts";
import type { TraceLineErrorReason, TraceLog } from "./trace-log.ts";

/**
 * Joins the kernel-side account to SYNAPSE run identities, and decides whether
 * the joined account is trustworthy enough to report at all (design §4.1, §4.3,
 * §4.4).
 *
 * This is the only module in the feature that makes a judgement. Everything
 * around it moves bytes: the parser keeps three kinds of line apart, the
 * classifier sorts paths into categories. Here the question is different —
 * *may this number be reported as a measurement?* — and a wrong answer is
 * invisible, because a byte count that quietly dropped 3% of its evidence looks
 * exactly like a correct one. The feature exists so that later work can claim
 * measured improvements; a measurement that under-reports under stress makes
 * those claims look better than they are, which is worse than having no
 * measurement. So every choice below resolves towards refusing to report.
 *
 * Three rules follow `metering.ts` verbatim, because the kernel side obeys the
 * same evidence discipline as the application side:
 *
 *  - `"N/A"` means this deployment produced no collection at all;
 *  - `unavailable` means there was collection but its result may not be
 *    reported — a loss report, unreadable lines, or too large a share of bytes
 *    that could not be placed on an identity;
 *  - neither is ever silently replaced by `0`, and a reported number is never
 *    quietly a partial one.
 *
 * Two questions are kept strictly apart, because conflating them is the easiest
 * way to get this module wrong:
 *
 *  - **Attribution** — which run identity do these bytes belong to? This is
 *    *structural* and needs no clock at all. `(pid, startTicks)` decides PID
 *    reuse by construction (design §4.1): the same pid at two start times is
 *    two processes, a deterministic fact, not a time-window guess.
 *  - **Coverage completeness** — does the account contain the whole run? This
 *    is what the clock alignment of design §4.3 is for: detecting that the
 *    collector began observing *after* a process had already started, so the
 *    account is missing that process's opening I/O. A complete-looking total
 *    with a missing prefix is precisely the silent under-report this feature
 *    must not produce.
 *
 * Pure throughout: no filesystem, no `process.platform`, no clock of its own.
 */

/** Identity fields carried by every metering event, lifted back out of one. */
function identityOf(event: MeteringEvent): MeteringIdentity {
	return {
		agent: event.agent,
		attempt: event.attempt,
		mode: event.mode,
		nodeId: event.nodeId,
		runId: event.runId,
		sessionId: event.sessionId,
		snapshotId: event.snapshotId,
	};
}

/**
 * Everything the attribution key is derived from. Both sides of the join —
 * a `process-identity` event and a classified trace process — satisfy it
 * structurally, so neither call site names the fields itself.
 */
export type AttributionKeySource = { pid: number; startTicks: number };

/** An opaque join token. Only `attributionKeyOf` may construct one; nothing else may parse one. */
export type AttributionKey = string;

/**
 * **The single replacement point for the attribution key.**
 *
 * v1 keys on `(pid, startTicks)`. Once S1 puts each agent in its own container,
 * this becomes a cgroup id (design §3.3), and that swap must not reach into the
 * join below. Two things keep it that way: the key is built from a *record*
 * rather than from fields the callers pull apart, so growing `cgroupId` onto
 * `AttributionKeySource` changes this function and the two producers of the
 * data, not the joining code; and the result is treated as opaque everywhere
 * else — nothing in this file, or downstream, parses a key back into a pid.
 *
 * The format is therefore deliberately not a bare `pid:ticks` that invites
 * splitting on `:`.
 */
export function attributionKeyOf(source: AttributionKeySource): AttributionKey {
	return `v1/pid=${source.pid}/startTicks=${source.startTicks}`;
}

/**
 * `USER_HZ`, the unit of field 22 of `/proc/<pid>/stat`. Fixed at 100 on Linux
 * for anything userspace reads out of `/proc`, independently of the kernel's
 * internal `CONFIG_HZ`. Overridable per call so the conversion can be proven on
 * a value other than the one the whole test suite would otherwise share.
 */
export const LINUX_CLOCK_TICKS_PER_SECOND = 100;

const NSECS_PER_SECOND = 1_000_000_000;
const NSECS_PER_MSEC = 1_000_000;

/**
 * A quantity in boot-based nanoseconds, or `unavailable` when it fell outside
 * the range JS integers represent exactly.
 *
 * Nanoseconds since boot pass `Number.MAX_SAFE_INTEGER` after roughly 104 days
 * of uptime. Past that point every comparison in this file silently loses its
 * low bits — which would turn coverage into a coin toss that always looks
 * decided. So the bound is checked rather than assumed, and an unrepresentable
 * reading is reported as missing evidence instead of a rounded number.
 */
function boundedNsecs(value: number): number | Unavailable {
	return Number.isSafeInteger(value) ? value : "unavailable";
}

/**
 * When a process started, in nanoseconds since boot, from its `startTicks`.
 *
 * `startTicks` is floored to a whole clock tick, so this is the start of the
 * tick the process started in: up to one tick (10ms at `USER_HZ` 100) earlier
 * than the true start, never later. Everything downstream that compares it
 * allows that much slack rather than pretending the reading is exact.
 */
export function processStartNsecs(startTicks: number, ticksPerSecond: number = LINUX_CLOCK_TICKS_PER_SECOND): number {
	return Math.round(startTicks * (NSECS_PER_SECOND / ticksPerSecond));
}

/**
 * The boot-based instant that a process's `monotonicMs` readings count from.
 *
 * This is the whole of design §4.3, and the reason `process-identity` carries
 * `uptimeAtRecordSeconds` at all. `MeteringEvent.monotonicMs` is per-process
 * hrtime, counted from an origin inside that process (`metering.ts:81-82`);
 * trace `nsecs` is boot-based. The two are different sources and comparing them
 * directly is simply wrong. But the `process-identity` event was recorded at a
 * moment for which *both* readings exist — `uptimeAtRecordSeconds` on the boot
 * basis and its own `monotonicMs` on the process basis — so their difference is
 * the process's hrtime origin expressed on the boot basis. Add any other
 * `monotonicMs` of the same process to it and that event lands on the trace's
 * timeline, with no drift introduced: the conversion is one subtraction of two
 * readings taken at the same instant, not a rate estimate.
 *
 * Note that this origin is *not* the process's start: the hrtime origin is
 * taken when the metering log is created, some way into the process's life
 * (`metering.ts:81`). `processStartNsecs` is the start; this is the log epoch.
 * Conflating them would date every event earlier than it happened.
 */
export function meteringEpochNsecs(uptimeAtRecordSeconds: number, monotonicMs: number): number {
	return Math.round(uptimeAtRecordSeconds * NSECS_PER_SECOND) - monotonicMs * NSECS_PER_MSEC;
}

/** Places a `monotonicMs` reading of one process on the boot-based timeline the trace uses. */
export function bootNsecsOf(epochNsecs: number, monotonicMs: number): number {
	return epochNsecs + monotonicMs * NSECS_PER_MSEC;
}

/** Read plus write bytes in one bucket. Failures are counted elsewhere and are not bytes. */
export function bucketBytes(bucket: TraceIoBucket): number {
	return bucket.readBytes + bucket.writeBytes;
}

/**
 * Every byte one process moved that the join was responsible for placing.
 *
 * `unclassified` and `unknownDescriptor` are included on purpose. They are
 * bytes this process really moved inside SYNAPSE storage, so leaving them out
 * of the denominator would shrink the visible unattributed share — the one
 * direction of error that hides a problem instead of showing it. `excluded` and
 * `outsideRoot` bytes are *not* here: the classifier keeps them run-level
 * precisely because they were deliberately never attributable to a category.
 */
export function traceIoBytes(io: TraceProcessIo): number {
	let total = bucketBytes(io.unclassified) + bucketBytes(io.unknownDescriptor);
	for (const bucket of Object.values(io.categories)) total += bucketBytes(bucket);
	return total;
}

/**
 * Whether the account for one process can be claimed to start at its beginning.
 *
 * `observedFromStart` is a *proved* property, not an assumed one: it holds only
 * when the trace contains a line from before the process existed, which is what
 * shows the collector was already running. Anything else — a collector whose
 * first line postdates the process, or a clock reading that cannot be trusted —
 * leaves it false, with the size of the unobserved window reported alongside so
 * a reader can see how much of the process's life carries no evidence.
 */
export type ProcessCoverage = {
	observedFromStart: boolean;
	/** Nanoseconds of this process's life that elapsed before the collector's earliest observation. */
	unobservedPrefixNsecs: number | Unavailable;
};

/** One attributed process: what it moved, who it belongs to, and how much of it was observed. */
export type AttributedProcessIo = {
	coverage: ProcessCoverage;
	/**
	 * Every distinct identity bound to this key, in first-seen order.
	 *
	 * Normally one. It is an array because one OS process legitimately records
	 * `process-identity` more than once — `createDelegationDeps` runs on
	 * whichever side opens a delegation (`delegation.ts:96-110`), so a parent
	 * that opens two delegations binds its single pid to two `nodeId`s. Those
	 * bytes are genuinely the run's, and genuinely not divisible between the
	 * nodes at pid granularity. Reporting both and letting the caller total at a
	 * granularity they all agree on is the honest answer; picking the first is a
	 * guess that no reader could see.
	 */
	identities: MeteringIdentity[];
	io: TraceProcessIo;
	key: AttributionKey;
};

export type KernelIoCoverage = {
	/**
	 * True only when the account demonstrably holds the whole run: some byte was
	 * attributed, every attributed process was observed from its start, no bound
	 * identity is missing from the trace entirely, and no observed byte was left
	 * unattributed.
	 *
	 * Each condition closes a way for an account to look whole while it is not,
	 * and three of them are about things that have *no row to be false on*:
	 *
	 *  - a process that did all its I/O before the collector started emits no
	 *    trace line at all, so it is invisible to any check that walks only what
	 *    the trace contains;
	 *  - a row that moved no attributable byte certifies nothing. Counting rows
	 *    rather than bytes is what let a run whose every byte fell outside the
	 *    storage root certify itself complete;
	 *  - orphaned bytes under the 1% threshold are reported rather than refused,
	 *    but bytes that could not be placed on an identity are still bytes this
	 *    account does not hold.
	 */
	complete: boolean;
	/** Earliest boot-based reading in the whole trace; `"N/A"` with no trace, `unavailable` when no line carried one. */
	observedFromNsecs: number | Unavailable | NotApplicable;
	processesWithUnobservedPrefix: number;
};

/** Unreadable lines by the reason the parser gave, every reason present even at zero: a zero here is evidence, not a gap. */
export type TraceLineErrorCounts = Record<TraceLineErrorReason, number>;

/**
 * Why an account that exists may not be reported. All applicable reasons are
 * given, never just the first — a reader who fixes the loss should not then
 * discover the threshold.
 *
 * `no-bytes-under-storage-root` is the one that is not about the collector: it
 * fires when the collector observed byte movement and none of it was under the
 * storage root at all. The root was then syntactically usable but named a
 * different tree than the collector reports paths against — the expected first
 * failure once each agent runs in its own iSulad container, where the collector
 * sees host paths and Pi sees container paths. Without it, a total mismatch
 * comes back as an account of zero bytes with nothing to object to.
 */
export type KernelIoUnavailableReason =
	| "collector-reported-loss"
	| "no-bytes-under-storage-root"
	| "unattributed-over-threshold"
	| "unreadable-lines"
	| "unusable-storage-root";

/**
 * Everything the judgement was made from, reported whether or not it went
 * against the account. A caller must be able to see "0.2% unattributed" on a
 * result that passed, and the exact reason on one that did not.
 *
 * The byte totals here stay populated even when the account is `unavailable`.
 * They are evidence *about* the account, not the account: a share means nothing
 * without its denominator. They are not a substitute for a result that was
 * refused, and using them as one would defeat the entire point of this module.
 *
 * Two outcomes are reached before any classification runs — no collection, and
 * an unusable storage root — and on those paths `attributedBytes` and
 * `unattributedBytes` read `0` while being typed `number`, which is
 * indistinguishable from a genuine zero except by looking at `attributed` and
 * `unavailableReasons` first. That is the same shape the `"N/A"` path has
 * always had, and it is why neither field may be read before those two.
 */
export type KernelIoDiagnostics = {
	/** Keys bound to more than one identity: real bytes, not splittable across nodes. */
	ambiguousProcesses: number;
	attributedBytes: number;
	/** `process-identity` events whose two clock bases contradict each other (see `meteringEpochNsecs`). */
	clockInconsistentIdentityEvents: number;
	coverage: KernelIoCoverage;
	identityKeys: number;
	/** Keys that bound an identity but produced no observed I/O at all. Any of these denies `coverage.complete`. */
	identityKeysWithoutTrace: number;
	/** Seen and deliberately not attributed, straight from the classifier. */
	ignored: { excluded: TraceIoBucket; outsideRoot: TraceIoBucket };
	lossReports: number;
	/** Highest `count` any loss report carried. Loss counts are cumulative, so they are not summed. */
	lostEventsHighWater: number;
	traceLines: { errors: TraceLineErrorCounts; losses: number; records: number };
	unattributedBytes: number;
	/** The orphans themselves, never dropped: trace processes no `process-identity` event claimed. */
	unattributedProcesses: TraceProcessIo[];
	/** `"N/A"` when no attributable bytes were observed at all — a share of nothing is not a zero share. */
	unattributedShare: number | NotApplicable;
	unattributedShareThreshold: number;
};

export type KernelIoAttribution = {
	/** Always present, in every outcome. */
	diagnostics: KernelIoDiagnostics;
	/**
	 * The per-process kernel account, or why there is none to report.
	 * `"N/A"`: this deployment collected nothing. `unavailable`: it collected,
	 * and the result may not be used — see `unavailableReasons`.
	 */
	attributed: AttributedProcessIo[] | Unavailable | NotApplicable;
	unavailableReasons: KernelIoUnavailableReason[];
};

/**
 * The share of attributable bytes that may land in `unattributed` before the
 * whole kernel-side result is refused. Design §4.4 fixes it at 1% and calls it
 * a number to be calibrated on real hardware (§7.3) — so it is a named constant
 * rather than a literal buried in a comparison.
 *
 * The comparison is strictly greater: exactly 1% passes, and the actual share
 * is reported either way.
 */
export const UNATTRIBUTED_SHARE_THRESHOLD = 0.01;

export type KernelIoAttributionOptions = {
	/** Calibration hook for design §7.3. Raising it weakens the only check on orphaned bytes. */
	unattributedShareThreshold?: number;
	/** `USER_HZ`. Only a test, or a hypothetical non-standard `/proc`, should set it. */
	ticksPerSecond?: number;
};

function emptyBucket(): TraceIoBucket {
	return { failedPathCalls: 0, failedReads: 0, failedWrites: 0, readBytes: 0, writeBytes: 0 };
}

function emptyErrorCounts() {
	// `satisfies` rather than an annotation: the literal keeps its own type, and
	// adding a rejection reason to `TraceLineErrorReason` breaks this line
	// instead of quietly leaving that reason uncounted.
	return { malformed: 0, "too-long": 0, truncated: 0 } satisfies TraceLineErrorCounts;
}

/** Highest `count` any loss report carried. Cumulative counts are not summed; a trace with no losses genuinely has none. */
function lossHighWater(trace: TraceLog): number {
	let highWater = 0;
	for (const loss of trace.losses) highWater = Math.max(highWater, loss.count);
	return highWater;
}

/**
 * The reasons that come from the collector's own output rather than from the
 * join. Shared by every outcome so that a result reached early cannot quietly
 * report fewer reasons than the same trace would produce later on.
 */
function collectorReasons(trace: TraceLog): KernelIoUnavailableReason[] {
	const reasons: KernelIoUnavailableReason[] = [];
	// Any admitted loss condemns the whole run's kernel-side result. The loss is
	// cumulative and undirected: there is no way to know which process's bytes
	// went missing, so there is no subset that survives it.
	if (trace.losses.length > 0) reasons.push("collector-reported-loss");
	// A line that could not be read is a record that cannot be counted, which is
	// the same hole a loss report admits to — design §6 requires exactly this for
	// the truncated trace of a collector killed mid-write, and a malformed or
	// over-long line is no more countable than a truncated one.
	if (trace.errors.length > 0) reasons.push("unreadable-lines");
	return reasons;
}

/**
 * Diagnostics for an outcome reached before any classification happened: every
 * quantity the join would have produced is absent rather than zero.
 *
 * What the collector itself reported is *not* absent, and is counted here in
 * full — line counts, loss reports and the loss high-water mark alike. Those
 * facts were read off the trace, not derived from a classification that never
 * ran, and reporting a `0` for one of them would be the exact "I did not look"
 * zero that `metering.ts` forbids from its first comment onwards.
 */
function unclassifiedDiagnostics(threshold: number, observedFromNsecs: number | Unavailable | NotApplicable, trace: TraceLog | null): KernelIoDiagnostics {
	const errors = emptyErrorCounts();
	for (const error of trace?.errors ?? []) errors[error.reason] += 1;
	return {
		ambiguousProcesses: 0,
		attributedBytes: 0,
		clockInconsistentIdentityEvents: 0,
		coverage: { complete: false, observedFromNsecs, processesWithUnobservedPrefix: 0 },
		identityKeys: 0,
		identityKeysWithoutTrace: 0,
		ignored: { excluded: emptyBucket(), outsideRoot: emptyBucket() },
		lossReports: trace?.losses.length ?? 0,
		lostEventsHighWater: trace === null ? 0 : lossHighWater(trace),
		traceLines: { errors, losses: trace?.losses.length ?? 0, records: trace?.records.length ?? 0 },
		unattributedBytes: 0,
		unattributedProcesses: [],
		unattributedShare: "N/A",
		unattributedShareThreshold: threshold,
	};
}

/** The `"N/A"` outcome: no trace input, so nothing was collected and nothing may be inferred. */
function notCollected(threshold: number): KernelIoAttribution {
	return { attributed: "N/A", diagnostics: unclassifiedDiagnostics(threshold, "N/A", null), unavailableReasons: [] };
}

/**
 * The caller handed a storage root no path can be placed against.
 *
 * `classifyTracePath` rejects a relative or empty root for a reason (see commit
 * 344ad1e one layer down): segments alone cannot tell `/var/synapse/x` from
 * `var/synapse/x`, and an empty root is a prefix of everything. Rejected there,
 * every path in the trace becomes `outside-root` — which lands the run's entire
 * I/O in `ignored`, a bucket no judgement here reads. The account then comes
 * back empty, with no orphans, a `"N/A"` share and no reasons: a total loss of
 * attribution wearing the face of a clean pass.
 *
 * So the root is checked *before* classification, and a bad one refuses the
 * whole result. The test is `startsWith("/")` and nothing more: trace paths are
 * kernel paths from a Linux collector, parsed as POSIX text on whatever host
 * runs this, so a Windows-shaped root is exactly as unusable as a relative one.
 *
 * Syntax is all this can catch. A root that is absolute but names a different
 * tree than the collector reports paths against passes here and is caught by
 * `no-bytes-under-storage-root` after classification instead.
 *
 * Whatever the collector reported is still reported: a bad root does not make a
 * ring-buffer overflow disappear, so the loss and unreadable-line reasons are
 * given alongside this one.
 */
function unusableStorageRoot(threshold: number, trace: TraceLog): KernelIoAttribution {
	return {
		attributed: "unavailable",
		diagnostics: unclassifiedDiagnostics(threshold, "unavailable", trace),
		unavailableReasons: [...collectorReasons(trace), "unusable-storage-root"],
	};
}

type IdentityBinding = {
	/** Distinct identities, first-seen order. */
	identities: MeteringIdentity[];
	/** True when some `process-identity` event for this key had contradictory clock readings. */
	clockSuspect: boolean;
	seen: Set<string>;
};

/** The design §4.1 table, plus the one fact the clock check produced on the way past. */
type IdentityTable = { bindings: Map<AttributionKey, IdentityBinding>; clockInconsistentEvents: number };

/**
 * Design §4.1: `(pid, startTicks) → MeteringIdentity`, built from the
 * `process-identity` events and nothing else. No other event kind carries an OS
 * identity, so no other event kind can bind one.
 *
 * The clock check on the way past is not part of attribution — attribution is
 * structural and needs no clock — it only records whether this key's readings
 * may later be trusted to answer the *coverage* question.
 */
function bindIdentities(events: readonly MeteringEvent[], ticksPerSecond: number): IdentityTable {
	const bindings = new Map<AttributionKey, IdentityBinding>();
	// One tick of slack: `startTicks` is floored to a tick boundary, so a log
	// epoch may legitimately read up to a tick before the computed start.
	const tickSlackNsecs = Math.round(NSECS_PER_SECOND / ticksPerSecond);
	let clockInconsistentEvents = 0;

	for (const event of events) {
		if (event.kind !== "process-identity") continue;
		const key = attributionKeyOf(event);
		const existing = bindings.get(key);
		const binding = existing ?? { clockSuspect: false, identities: [], seen: new Set<string>() };
		if (existing === undefined) bindings.set(key, binding);

		const identity = identityOf(event);
		const fingerprint = canonicalDigest(identity);
		if (!binding.seen.has(fingerprint)) {
			binding.seen.add(fingerprint);
			binding.identities.push(identity);
		}

		// The metering log cannot have been created before the process that
		// created it started. When the readings say otherwise the two bases
		// disagree, and any coverage answer derived from them would be a fiction.
		const epoch = meteringEpochNsecs(event.uptimeAtRecordSeconds, event.monotonicMs);
		const start = processStartNsecs(event.startTicks, ticksPerSecond);
		if (epoch + tickSlackNsecs < start) {
			clockInconsistentEvents += 1;
			binding.clockSuspect = true;
		}
	}

	return { bindings, clockInconsistentEvents };
}

/**
 * The earliest boot-based reading anywhere in the trace. Unreadable lines carry
 * none and cannot contribute.
 *
 * Bounded like every other reading on this timeline: a collector on a host up
 * for more than ~104 days emits `nsecs` past the exactly-representable range,
 * and a coverage answer computed from a rounded reading would look every bit as
 * decided as a real one.
 */
function earliestObservation(trace: TraceLog): number | Unavailable {
	let earliest: number | null = null;
	for (const record of trace.records) earliest = earliest === null ? record.nsecs : Math.min(earliest, record.nsecs);
	for (const loss of trace.losses) earliest = earliest === null ? loss.nsecs : Math.min(earliest, loss.nsecs);
	return earliest === null ? "unavailable" : boundedNsecs(earliest);
}

/**
 * Coverage for one attributed process: how much of its life predates anything
 * the collector saw.
 *
 * A zero prefix is the proof that matters — the trace holds a line from before
 * this process existed, so the collector was already running and the account
 * starts where the process does. A positive prefix is a bound, not a
 * measurement of lost bytes: the process may have done nothing in that window.
 * It is reported as the size of the window with no evidence in it, which is
 * exactly what a reader needs in order not to read the total as a full account.
 */
function coverageOf(io: TraceProcessIo, observedFromNsecs: number | Unavailable, clockSuspect: boolean, ticksPerSecond: number): ProcessCoverage {
	if (observedFromNsecs === "unavailable" || clockSuspect) return { observedFromStart: false, unobservedPrefixNsecs: "unavailable" };
	const start = boundedNsecs(processStartNsecs(io.startTicks, ticksPerSecond));
	if (start === "unavailable") return { observedFromStart: false, unobservedPrefixNsecs: "unavailable" };
	const prefix = Math.max(0, observedFromNsecs - start);
	return { observedFromStart: prefix === 0, unobservedPrefixNsecs: prefix };
}

/**
 * Joins classified kernel I/O to run identities and decides whether the result
 * may be reported (design §4.4).
 *
 * **`trace` must be `null` when no collector ran**, and an empty `TraceLog` must
 * mean a collector that ran and produced a file with nothing in it. The two are
 * not interchangeable, and a caller may not substitute one for the other:
 *
 *  - `null` says "there is nothing to place", so the storage root is never
 *    examined and the answer is `"N/A"`. This is the path every non-Linux host
 *    takes, where the storage root is not POSIX-absolute and never could be;
 *  - an empty `TraceLog` still has its root checked, and a bad root there is
 *    refused rather than reported as `"N/A"`. An empty trace file is weak
 *    evidence of nothing happening, and a misconfigured root is a likelier
 *    explanation for it than a quiet run — so that case is not allowed to look
 *    like a clean "this deployment does not collect".
 *
 * Passing an empty `TraceLog` to mean "no collector" would therefore turn every
 * Windows run into a refused measurement. Both still answer `"N/A"` when the
 * root is sound; the distinction only decides which failures stay visible.
 *
 * `storageRoot` must be absolute whenever a trace exists; see
 * `unusableStorageRoot` for what that catches and `no-bytes-under-storage-root`
 * for what it cannot.
 */
export function attributeKernelIo(
	events: readonly MeteringEvent[],
	trace: TraceLog | null,
	storageRoot: string,
	options: KernelIoAttributionOptions = {},
): KernelIoAttribution {
	const threshold = options.unattributedShareThreshold ?? UNATTRIBUTED_SHARE_THRESHOLD;
	const ticksPerSecond = options.ticksPerSecond ?? LINUX_CLOCK_TICKS_PER_SECOND;
	if (trace !== null && !storageRoot.startsWith("/")) return unusableStorageRoot(threshold, trace);
	if (trace === null || (trace.records.length === 0 && trace.losses.length === 0 && trace.errors.length === 0)) {
		return notCollected(threshold);
	}

	const { bindings, clockInconsistentEvents } = bindIdentities(events, ticksPerSecond);
	const classification: TraceIoClassification = classifyTraceIo(trace.records, storageRoot);
	const observedFromNsecs = earliestObservation(trace);

	const attributed: AttributedProcessIo[] = [];
	const unattributedProcesses: TraceProcessIo[] = [];
	const usedKeys = new Set<AttributionKey>();
	let attributedBytes = 0;
	let unattributedBytes = 0;
	let ambiguousProcesses = 0;
	let processesWithUnobservedPrefix = 0;

	for (const io of classification.processes) {
		const key = attributionKeyOf(io);
		const binding = bindings.get(key);
		if (binding === undefined) {
			// An orphan: real kernel I/O no run claimed. It is counted, kept whole
			// and never folded into any run's total — attributing it to the nearest
			// plausible identity is exactly the invisible error this module exists
			// to prevent.
			unattributedProcesses.push(io);
			unattributedBytes += traceIoBytes(io);
			continue;
		}
		usedKeys.add(key);
		if (binding.identities.length > 1) ambiguousProcesses += 1;
		const coverage = coverageOf(io, observedFromNsecs, binding.clockSuspect, ticksPerSecond);
		if (!coverage.observedFromStart) processesWithUnobservedPrefix += 1;
		attributed.push({ coverage, identities: binding.identities, io, key });
		attributedBytes += traceIoBytes(io);
	}

	const errors = emptyErrorCounts();
	for (const error of trace.errors) errors[error.reason] += 1;

	const totalBytes = attributedBytes + unattributedBytes;
	// A share of no bytes is not a zero share: nothing was observed to be
	// missing because nothing was observed at all. `metering.ts` answers the
	// same question the same way for `memory.hitRate` with zero queries.
	const unattributedShare: number | NotApplicable = totalBytes === 0 ? "N/A" : unattributedBytes / totalBytes;

	const unavailableReasons = collectorReasons(trace);
	if (unattributedShare !== "N/A" && unattributedShare > threshold) unavailableReasons.push("unattributed-over-threshold");
	// The collector watched real bytes move and not one of them was under the
	// storage root. The root is syntactically fine, so it named a different tree
	// than the collector reports paths against — the expected first failure when
	// each agent moves into its own iSulad container and the collector, on the
	// host, sees host paths while Pi sees container paths.
	//
	// Refusing rather than merely denying `complete`, because the alternative
	// reading — "this run genuinely did no SYNAPSE I/O" — is an account of zero
	// bytes, which is worth nothing to a caller even when it is true. Trading a
	// worthless-but-honest result for a defence against a total, invisible
	// attribution loss is not a close call.
	//
	// `excluded` bytes are deliberately not part of this test: `metering/` and
	// `trace/` only match after the root prefix matched, so seeing any of them
	// is evidence the root is right.
	if (totalBytes === 0 && bucketBytes(classification.ignored.outsideRoot) > 0) unavailableReasons.push("no-bytes-under-storage-root");

	const identityKeysWithoutTrace = bindings.size - usedKeys.size;

	return {
		attributed: unavailableReasons.length > 0 ? "unavailable" : attributed,
		diagnostics: {
			ambiguousProcesses,
			attributedBytes,
			clockInconsistentIdentityEvents: clockInconsistentEvents,
			coverage: {
				// Counted in bytes, not in rows. A row that moved no attributable
				// byte certifies nothing — that is how a run whose every byte fell
				// outside the storage root used to certify itself complete — and a
				// bound process that emitted no trace line at all has no row here to
				// be false on. Orphaned bytes deny it too: under the threshold they
				// are reported rather than refused, but they are still bytes this
				// account does not hold.
				complete:
					attributedBytes > 0 && processesWithUnobservedPrefix === 0 && identityKeysWithoutTrace === 0 && unattributedProcesses.length === 0,
				observedFromNsecs,
				processesWithUnobservedPrefix,
			},
			identityKeys: bindings.size,
			identityKeysWithoutTrace,
			ignored: classification.ignored,
			lossReports: trace.losses.length,
			lostEventsHighWater: lossHighWater(trace),
			traceLines: { errors, losses: trace.losses.length, records: trace.records.length },
			unattributedBytes,
			unattributedProcesses,
			unattributedShare,
			unattributedShareThreshold: threshold,
		},
		unavailableReasons,
	};
}
