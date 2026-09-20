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
 * Byte totals come in two types for the same reason — `PlacedBytes` is the only
 * currency a judgement may be made in, `TracedBytes` is volume to report and
 * never to judge on. See the currency section below for why that is a type and
 * not a convention.
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
 * Any evidence at all that a bucket's paths were used: bytes that moved, or a
 * call that named them and failed.
 *
 * A failed call moved nothing, but it proves the path was reached for — which
 * is exactly what a root check needs to know. A mismatched root whose every
 * call failed (a whole tree that is not there) would otherwise leave no bytes
 * anywhere and no objection to raise.
 */
export function bucketTouched(bucket: TraceIoBucket): boolean {
	return bucketBytes(bucket) > 0 || bucket.failedPathCalls > 0 || bucket.failedReads > 0 || bucket.failedWrites > 0;
}

/** Whether any path of this process resolved under the storage root, successfully or not. */
function touchedStorageRoot(io: TraceProcessIo): boolean {
	if (bucketTouched(io.unclassified)) return true;
	return Object.values(io.categories).some((bucket) => bucketTouched(bucket));
}

/*
 * ─────────────────────────── the two byte currencies ───────────────────────────
 *
 * Everything from here to the end of `sumTraced` exists because four review
 * rounds found the same defect behind four different scalars. Each round a
 * judgement about SYNAPSE I/O was being made on a total that included bytes
 * whose path never resolved anywhere — rows, then all traced bytes, then the
 * completeness conjunct, then the orphan-share threshold — and each time the
 * fix converted that one scalar and left the next one waiting.
 *
 * Both totals are `number` at runtime and they are *not* interchangeable, so
 * they are different types:
 *
 *  - `PlacedBytes` — bytes whose path the classifier resolved under the storage
 *    root. **This is the judgement currency.** Every predicate about SYNAPSE
 *    I/O in this module takes it and nothing else.
 *  - `TracedBytes` — every byte the join had to place, the pathless ones
 *    included. **Reporting volume only.** No predicate accepts it.
 *
 * Why pathless bytes may never reach a predicate: a read or write on a
 * descriptor no observed `openat` produced has no path, so it is evidence about
 * nothing. It is also guaranteed to be present on every real run — the parent
 * opens the stdout/stderr log files and hands those descriptors to every
 * backgrounded agent process as its stdio (`async-execution.ts:709-729`) — so a
 * predicate that admits it is a predicate that can be satisfied on every run
 * that will ever happen. That is precisely how rounds 2 and 4 failed.
 *
 * The rule is enforced by the type checker rather than by care: a `TracedBytes`
 * is not assignable to a `PlacedBytes`, so `unattributedShareOf`,
 * `coverage.complete` and every other judgement below physically cannot be
 * handed the wrong quantity. The casts in this section are the only place
 * either currency is minted, and `anti-slop/require-safety-comment-for-type-assertion`
 * makes any new one a reviewable event rather than a quiet edit.
 */

declare const PLACED_BYTES: unique symbol;
declare const TRACED_BYTES: unique symbol;

/**
 * Bytes whose path the classifier resolved to somewhere under the storage root:
 * the three categories plus `unclassified`. The only currency a judgement about
 * SYNAPSE I/O may be made in.
 */
export type PlacedBytes = number & { readonly [PLACED_BYTES]: "resolved under the storage root" };

/**
 * Every byte one process moved that the join was responsible for placing,
 * whether or not a path was ever resolved for it. Report it as volume; never
 * judge on it. `excluded` and `outsideRoot` bytes are not here — the classifier
 * keeps those run-level precisely because they were never attributable.
 */
export type TracedBytes = number & { readonly [TRACED_BYTES]: "observed, path resolved or not" };

/** Bytes of this process that reached a path under the storage root. */
export function placedBytesOf(io: TraceProcessIo): PlacedBytes {
	let total = bucketBytes(io.unclassified);
	for (const bucket of Object.values(io.categories)) total += bucketBytes(bucket);
	// SAFETY: every term is a bucket the classifier filled only after the path
	// resolved under the storage root — the categories and `unclassified` — which
	// is the definition of `PlacedBytes`. `unknownDescriptor` is not summed here.
	return total as PlacedBytes;
}

/** Bytes of this process on descriptors no observed `openat` produced: traced, and by construction never placed. */
export function pathlessBytesOf(io: TraceProcessIo): TracedBytes {
	// SAFETY: `unknownDescriptor` is exactly the bucket whose bytes resolved to no
	// path, so this is a traced quantity and the return type refuses to let it be
	// read as a placed one.
	return bucketBytes(io.unknownDescriptor) as TracedBytes;
}

/** Every byte of this process the join had to place, placed or pathless. */
export function tracedBytesOf(io: TraceProcessIo): TracedBytes {
	// SAFETY: the placed bytes plus the pathless ones is by definition every byte
	// the join saw for this process, which is what `TracedBytes` names.
	return (placedBytesOf(io) + pathlessBytesOf(io)) as TracedBytes;
}

/** Adds two volumes. There is deliberately no such adder that will accept a placed and a traced total together. */
export function sumTraced(left: TracedBytes, right: TracedBytes): TracedBytes {
	// SAFETY: both parameters are already traced totals and the parameter types
	// make it impossible to pass a placed one, so the sum is a traced total too.
	return (left + right) as TracedBytes;
}

/**
 * One side of the join's byte totals, in both currencies at once.
 *
 * Deliberately not a bare `number` on either side of the join. A reader — or a
 * future edit — has to name which currency it wants before it can get a number
 * at all, and naming `.traced` inside a predicate is then a visible choice
 * rather than the default that four rounds kept landing on.
 */
export type ByteLedger = { placed: PlacedBytes; traced: TracedBytes };

/** A ledger with nothing in it. Both totals are genuinely zero, not a stand-in for a quantity nobody looked at. */
function emptyLedger(): ByteLedger {
	// SAFETY: zero is a valid total in either currency — no byte has been added to
	// this ledger yet, in either sense of "added".
	return { placed: 0 as PlacedBytes, traced: 0 as TracedBytes };
}

/** The only way a ledger grows: one whole process at a time, each currency summed with its own. */
function ledgerWith(ledger: ByteLedger, io: TraceProcessIo): ByteLedger {
	// SAFETY: `placedBytesOf` and `tracedBytesOf` are the only producers of the
	// two currencies and neither is assignable where the other is expected, so
	// each sum here stays in the currency both of its terms were already in.
	return { placed: (ledger.placed + placedBytesOf(io)) as PlacedBytes, traced: (ledger.traced + tracedBytesOf(io)) as TracedBytes };
}

/** The pathless part of a ledger: bytes it traced whose path never resolved. Volume, never a predicate. */
export function pathlessBytesIn(ledger: ByteLedger): TracedBytes {
	// SAFETY: `ledgerWith` maintains `traced = placed + pathless` term by term, so
	// the difference is the pathless part, and it is a traced quantity.
	return (ledger.traced - ledger.placed) as TracedBytes;
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
	 * True when four conditions hold together, and it claims nothing beyond
	 * them: some byte was both placed under the storage root and attributed to
	 * an identity; every attributed process was observed from its start; no
	 * bound identity is missing from the trace entirely; and no observed byte
	 * was left unattributed.
	 *
	 * Each condition closes a way for an account to look whole while it is not,
	 * and three of them are about things that have *no row to be false on*:
	 *
	 *  - a process that did all its I/O before the collector started emits no
	 *    trace line at all, so it is invisible to any check that walks only what
	 *    the trace contains;
	 *  - a row whose bytes never resolved to a path under the root certifies
	 *    nothing about the root. Counting rows, and then counting bytes that
	 *    include pathless `unknownDescriptor` traffic, are the two ways this has
	 *    already been got wrong, which is why the first conjunct is stated in
	 *    `PlacedBytes` and cannot be restated in anything else;
	 *  - orphaned bytes under the 1% threshold are reported rather than refused,
	 *    but bytes that could not be placed on an identity are still bytes this
	 *    account does not hold.
	 *
	 * Two things it deliberately does **not** promise, because nothing in this
	 * module tests them:
	 *
	 *  - **that the account reaches the end of the run.** Coverage is examined
	 *    at the front edge only — the collector's earliest observation against
	 *    each process's start. A collector that died, was detached, or had its
	 *    trace file truncated part-way through leaves a suffix with no evidence
	 *    in it and there is no field here that can notice;
	 *  - **that any particular kind of SYNAPSE I/O was seen.** The first
	 *    conjunct counts placed bytes without asking which category they landed
	 *    in, so an account holding nothing but `unclassified` bytes can satisfy
	 *    it.
	 *
	 * So read it as "no front-edge gap and no orphan in what *was* observed",
	 * not as "this is the whole run". It is a deliberately narrow claim even so,
	 * and on real traces it will read `false` routinely — one orphan process
	 * anywhere is enough. `false` therefore means "not proved whole", not "known
	 * broken"; the fields beside it say which condition failed and by how much.
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
 * `no-path-under-storage-root` is the one that is not about the collector, and
 * it is named for what was *observed* rather than for a cause, on purpose. What
 * it states is exactly this: every path the collector resolved fell outside the
 * configured storage root, and not one fell under it. Two different faults
 * produce that, and this module cannot tell them apart:
 *
 *  - the root names a different tree than the collector reports paths against —
 *    the expected first failure once each agent runs in its own iSulad
 *    container, where the collector sees host paths and Pi sees container
 *    paths. Without this reason a total mismatch comes back as an account of
 *    zero bytes with nothing to object to;
 *  - the collector attached after the run had already opened its files, so the
 *    real SYNAPSE traffic arrived on descriptors with no `openat` behind them
 *    and carries no path to resolve. The root may be perfectly correct.
 *
 * `diagnostics.storageRootEvidence` is what separates them: a large
 * `pathlessBytes` beside `pathsOutsideRoot` says the run was busy on
 * descriptors nobody could place, which is the late-attach signature, while a
 * small one beside heavy outside-root traffic says the root is wrong. An
 * earlier name for this reason blamed the root outright and would have sent an
 * operator to re-check a correct one.
 */
export type KernelIoUnavailableReason =
	| "collector-reported-loss"
	| "no-path-under-storage-root"
	| "unattributed-over-threshold"
	| "unreadable-lines"
	| "unusable-storage-root";

/**
 * What the trace said about the configured storage root, reported whether or
 * not it produced a refusal.
 *
 * `"N/A"` on the two outcomes reached before classification ran: no collection
 * at all, and a syntactically unusable root. Writing `false`/`false`/`0` there
 * would be the "I did not look" zero `metering.ts` forbids — it reads exactly
 * like a collector that watched and saw no path anywhere.
 */
export type StorageRootEvidence = {
	/** Some observed path resolved under the configured root: bytes moved, or a call named it and failed. */
	pathsUnderRoot: boolean;
	/** Some observed path resolved, and fell outside the configured root. */
	pathsOutsideRoot: boolean;
	/**
	 * Bytes moved on descriptors no observed `openat` produced, across every
	 * process. High next to no paths under the root is a collector that attached
	 * late, not a wrong root.
	 */
	pathlessBytes: TracedBytes;
};

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
 * an unusable storage root — and on those paths both ledgers read `0` in both
 * currencies, which is indistinguishable from a genuine zero except by looking
 * at `attributed` and `unavailableReasons` first. That is the same shape the
 * `"N/A"` path has always had, and it is why neither ledger may be read before
 * those two. (`storageRootEvidence` does not have that problem: it says
 * `"N/A"`.)
 */
export type KernelIoDiagnostics = {
	/** Keys bound to more than one identity: real bytes, not splittable across nodes. */
	ambiguousProcesses: number;
	/**
	 * Bytes that reached an identity. `.placed` is what the share and
	 * `coverage.complete` are computed from; `.traced` is the volume to report,
	 * and can be far larger — every backgrounded agent writes to an inherited
	 * stdout descriptor that resolves to no path at all.
	 */
	attributedBytes: ByteLedger;
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
	/** Whether the collector's paths and the configured root describe the same tree; `"N/A"` before classification ran. */
	storageRootEvidence: StorageRootEvidence | NotApplicable;
	traceLines: { errors: TraceLineErrorCounts; losses: number; records: number };
	/**
	 * Bytes no identity claimed. `.placed` is the share's numerator;
	 * `.traced - .placed` is orphaned traffic that resolved to no path, which is
	 * evidence about nothing and is therefore kept out of every judgement. An
	 * orphan made entirely of such bytes still denies `coverage.complete` and
	 * still appears whole in `unattributedProcesses`.
	 */
	unattributedBytes: ByteLedger;
	/** The orphans themselves, never dropped: trace processes no `process-identity` event claimed. */
	unattributedProcesses: TraceProcessIo[];
	/**
	 * The share of *placed* bytes that no identity claimed —
	 * `unattributed.placed / (attributed.placed + unattributed.placed)`.
	 *
	 * `"N/A"` when no byte resolved to a path under the storage root at all: a
	 * share of nothing is not a zero share. The denominator is placed bytes and
	 * not traced bytes because pathless traffic is present on every real run and
	 * would dilute the ratio until it could not trip — a megabyte written to an
	 * inherited stdout descriptor once hid a complete attribution loss below the
	 * 1% threshold.
	 */
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

/**
 * What this deployment collected, stated so that "no collector ran" cannot be
 * spelled any other way.
 *
 * The distinction is load-bearing and the two cases are not interchangeable:
 * `not-collected` skips the storage-root check entirely and answers `"N/A"`,
 * which is the path every non-Linux host takes — on Windows the storage root is
 * never POSIX-absolute and never could be. A `collected` trace has its root
 * checked even when the file turned out empty, because an empty trace file is
 * weak evidence of nothing happening and a misconfigured root explains it
 * better than a quiet run.
 *
 * Hence the discriminant rather than `TraceLog | null`. A caller that spelled
 * "no collector" as an empty `TraceLog` would turn every Windows run into a
 * refused measurement, indistinguishable from real breakage — and a comment
 * saying "pass null" is not a thing the type system can hold the caller to.
 */
export type TraceCollection = { kind: "not-collected" } | { kind: "collected"; trace: TraceLog };

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
		attributedBytes: emptyLedger(),
		clockInconsistentIdentityEvents: 0,
		coverage: { complete: false, observedFromNsecs, processesWithUnobservedPrefix: 0 },
		identityKeys: 0,
		identityKeysWithoutTrace: 0,
		ignored: { excluded: emptyBucket(), outsideRoot: emptyBucket() },
		lossReports: trace?.losses.length ?? 0,
		lostEventsHighWater: trace === null ? 0 : lossHighWater(trace),
		// No path was classified against any root, so there is no evidence about
		// the root either way. `false` here would read as "the collector watched
		// and resolved nothing under it", which is a different and much stronger
		// claim than "nobody looked".
		storageRootEvidence: "N/A",
		traceLines: { errors, losses: trace?.losses.length ?? 0, records: trace?.records.length ?? 0 },
		unattributedBytes: emptyLedger(),
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
 * `no-path-under-storage-root` after classification instead.
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
 * The share of SYNAPSE bytes that reached no identity — the one check this
 * module makes on orphaned traffic, and the only quantity design §4.4 puts a
 * threshold on.
 *
 * The parameter types are the whole point. Both sides are `PlacedBytes`, so
 * nothing that resolved to no path can be handed to this function, by accident
 * or by a later edit that reaches for the nearest byte total. The ratio then
 * answers the question it is named for: of the bytes that demonstrably were
 * SYNAPSE storage I/O, how much of it could not be placed on a run?
 *
 * A denominator of pathless bytes instead is not a weaker version of this
 * check, it is no check at all: every backgrounded agent writes to an inherited
 * stdout descriptor, so the denominator is always inflated by traffic that is
 * never orphaned and never SYNAPSE, and the ratio is driven below any threshold
 * that could be set. One 1,000,000-byte stdout write once excused nine
 * thousand bytes of wholly unattributed envelope traffic — a 100% attribution
 * loss reported as 0.89%.
 *
 * `"N/A"` when nothing was placed at all: a share of nothing is not a zero
 * share, the same answer `metering.ts` gives `memory.hitRate` with no queries.
 */
function unattributedShareOf(attributed: PlacedBytes, unattributed: PlacedBytes): number | NotApplicable {
	const placed = attributed + unattributed;
	return placed === 0 ? "N/A" : unattributed / placed;
}

/**
 * Whether any byte at all reached a path under the storage root.
 *
 * A function rather than a bare `> 0` in the expression that wants it, because
 * `> 0` is the one comparison a `TracedBytes` would also satisfy: both
 * currencies are `number` underneath, so an inequality against a literal
 * type-checks whichever one is on the left. The parameter type makes the wrong
 * currency a compile error at the only site that asks this question.
 */
function anyPlaced(bytes: PlacedBytes): boolean {
	return bytes > 0;
}

/**
 * Joins classified kernel I/O to run identities and decides whether the result
 * may be reported (design §4.4).
 *
 * `collection` says whether a collector ran at all; see `TraceCollection` for
 * why that is a discriminant and not a nullable trace. `storageRoot` must be
 * absolute whenever one did — see `unusableStorageRoot` for what that catches
 * and `no-path-under-storage-root` for what it cannot.
 */
export function attributeKernelIo(
	events: readonly MeteringEvent[],
	collection: TraceCollection,
	storageRoot: string,
	options: KernelIoAttributionOptions = {},
): KernelIoAttribution {
	const threshold = options.unattributedShareThreshold ?? UNATTRIBUTED_SHARE_THRESHOLD;
	const ticksPerSecond = options.ticksPerSecond ?? LINUX_CLOCK_TICKS_PER_SECOND;
	if (collection.kind === "not-collected") return notCollected(threshold);
	const trace = collection.trace;
	if (!storageRoot.startsWith("/")) return unusableStorageRoot(threshold, trace);
	if (trace.records.length === 0 && trace.losses.length === 0 && trace.errors.length === 0) {
		return notCollected(threshold);
	}

	const { bindings, clockInconsistentEvents } = bindIdentities(events, ticksPerSecond);
	const classification: TraceIoClassification = classifyTraceIo(trace.records, storageRoot);
	const observedFromNsecs = earliestObservation(trace);

	const attributed: AttributedProcessIo[] = [];
	const unattributedProcesses: TraceProcessIo[] = [];
	const usedKeys = new Set<AttributionKey>();
	let attributedBytes = emptyLedger();
	let unattributedBytes = emptyLedger();
	let ambiguousProcesses = 0;
	let processesWithUnobservedPrefix = 0;
	// Evidence that the supplied root is the tree the collector reports paths
	// against, gathered over every process whether or not it was attributed: a
	// root either matches the trace or it does not, and which run a path belongs
	// to has nothing to do with it. `excluded` activity counts as the root
	// matching, because `metering/` and `trace/` match only after the root prefix
	// already matched.
	let pathsUnderRoot = bucketTouched(classification.ignored.excluded);

	for (const io of classification.processes) {
		if (touchedStorageRoot(io)) pathsUnderRoot = true;
		const key = attributionKeyOf(io);
		const binding = bindings.get(key);
		if (binding === undefined) {
			// An orphan: real kernel I/O no run claimed. It is counted, kept whole
			// and never folded into any run's total — attributing it to the nearest
			// plausible identity is exactly the invisible error this module exists
			// to prevent.
			unattributedProcesses.push(io);
			unattributedBytes = ledgerWith(unattributedBytes, io);
			continue;
		}
		usedKeys.add(key);
		if (binding.identities.length > 1) ambiguousProcesses += 1;
		const coverage = coverageOf(io, observedFromNsecs, binding.clockSuspect, ticksPerSecond);
		if (!coverage.observedFromStart) processesWithUnobservedPrefix += 1;
		attributed.push({ coverage, identities: binding.identities, io, key });
		attributedBytes = ledgerWith(attributedBytes, io);
	}

	const errors = emptyErrorCounts();
	for (const error of trace.errors) errors[error.reason] += 1;

	const unattributedShare = unattributedShareOf(attributedBytes.placed, unattributedBytes.placed);

	const unavailableReasons = collectorReasons(trace);
	if (unattributedShare !== "N/A" && unattributedShare > threshold) unavailableReasons.push("unattributed-over-threshold");
	// Every path the collector resolved fell outside the storage root, and not
	// one fell under it. The root is syntactically fine, so either it names a
	// different tree than the collector reports paths against, or the collector
	// attached after the run opened its files and the SYNAPSE traffic arrived
	// with no path to resolve. `storageRootEvidence` carries what separates the
	// two; this reason states only what was seen, because a name that blamed the
	// root would send an operator to re-check a correct one.
	//
	// Refusing either way rather than merely denying `complete`, because the
	// benign reading — "this run genuinely did no SYNAPSE I/O" — is an account of
	// zero bytes, which is worth nothing to a caller even when it is true.
	// Trading a worthless-but-honest result for a defence against a total,
	// invisible attribution loss is not a close call.
	//
	// Two things this test is careful about, both learned the hard way:
	//
	//  - it asks whether any *path* resolved under the root, not whether any byte
	//    was attributed. `unknownDescriptor` bytes have no path — and every
	//    backgrounded agent here writes to an inherited fd — so a byte-total test
	//    was satisfied by one stdout write on every run that will ever happen;
	//  - a failed call is evidence too. A root that names a tree which is not
	//    there produces failures and no bytes, and a bytes-only test would find
	//    nothing to object to.
	const pathsOutsideRoot = bucketTouched(classification.ignored.outsideRoot);
	if (!pathsUnderRoot && pathsOutsideRoot) unavailableReasons.push("no-path-under-storage-root");

	const identityKeysWithoutTrace = bindings.size - usedKeys.size;

	return {
		attributed: unavailableReasons.length > 0 ? "unavailable" : attributed,
		diagnostics: {
			ambiguousProcesses,
			attributedBytes,
			clockInconsistentIdentityEvents: clockInconsistentEvents,
			coverage: {
				// Stated in placed bytes, and `anyPlaced` is what keeps it unstatable
				// in anything else — a bare `> 0` would have accepted `.traced` just
				// as happily. Rows were tried, then traced bytes, and both certified
				// an account whose every classified byte had fallen outside the root.
				// A bound process that emitted no trace line at all has no row here to
				// be false on, and orphaned bytes deny it too: under the threshold
				// they are reported rather than refused, but they are still bytes this
				// account lacks — including an orphan whose bytes were all pathless
				// and so never reached the share at all.
				complete:
					anyPlaced(attributedBytes.placed) &&
					processesWithUnobservedPrefix === 0 &&
					identityKeysWithoutTrace === 0 &&
					unattributedProcesses.length === 0,
				observedFromNsecs,
				processesWithUnobservedPrefix,
			},
			identityKeys: bindings.size,
			identityKeysWithoutTrace,
			ignored: classification.ignored,
			lossReports: trace.losses.length,
			lostEventsHighWater: lossHighWater(trace),
			storageRootEvidence: {
				pathlessBytes: sumTraced(pathlessBytesIn(attributedBytes), pathlessBytesIn(unattributedBytes)),
				pathsOutsideRoot,
				pathsUnderRoot,
			},
			traceLines: { errors, losses: trace.losses.length, records: trace.records.length },
			unattributedBytes,
			unattributedProcesses,
			unattributedShare,
			unattributedShareThreshold: threshold,
		},
		unavailableReasons,
	};
}
