import { aggregateMetering, type MeteringEvent, type MeteringTotals, type NotApplicable } from "./metering.ts";
import {
	attributeKernelIo,
	bucketBytes,
	type AttributedProcessIo,
	type KernelIoAttribution,
	type KernelIoAttributionOptions,
	type KernelIoDiagnostics,
	type KernelIoUnavailableReason,
	type TraceCollection,
	type TraceLineErrorCounts,
} from "./trace-attribute.ts";
import { SYNAPSE_IO_CATEGORIES, type SynapseIoCategory, type TraceIoBucket } from "./trace-classify.ts";

/**
 * The aggregation entry point of design §3.4: the application-level totals
 * `aggregateMetering` already produces, beside the kernel-side account
 * `attributeKernelIo` judged, in one result and in two columns that are never
 * added together.
 *
 * This module composes; it decides nothing. Every judgement was already made
 * one layer down and is re-stated here without being softened: an account that
 * was refused stays refused, `"N/A"` stays `"N/A"`, and no quantity is
 * recomputed from evidence the judgement rejected. The whole value of the
 * layer below is that it will not report a number it cannot stand behind, and
 * the easiest way to throw that away is a convenience field up here that hands
 * the number over anyway.
 *
 * Three rules follow from that, and they are what the result shape is for:
 *
 *  - **Kernel bytes and `envelopeBytes` are two columns, never a sum**
 *    (design §5.1). They are not the same quantity measured twice: one is the
 *    envelope the application serialised, the other is what the kernel saw the
 *    VFS move, and the difference between them is the interesting reading.
 *    `MeteringTotals.control.transportBytes` therefore stays `"N/A"` under
 *    every input this function accepts — a VFS byte may be served entirely
 *    from page cache and touch no transport at all, so filling it with kernel
 *    bytes would be a category error. It becomes a real number when a later
 *    phase replaces file delivery with a socket, and not before.
 *  - **Coverage cannot be read past.** The kernel side is a discriminated
 *    union whose two byte-carrying variants are distinguished by *coverage*,
 *    not merely by success — and, load-bearingly, **no byte-bearing property
 *    is common to them**. The totals sit behind `noGapFound` on one and
 *    `withKnownGaps` on the other, so every path to a byte number goes through
 *    a symbol that states which of the two it is. Design §4.4 allows a
 *    late-attached collector to be reported rather than refused only on the
 *    condition that the caller cannot overlook that, and a sibling `coverage`
 *    field beside a `bytes` field is exactly the shape that gets overlooked.
 *
 *    A shared `bytes` field would have been that shape in disguise: with the
 *    same property on both variants, `if (k.kind === "not-collected" ||
 *    k.kind === "refused") return 0;` — or `"bytes" in k` — type-checks and
 *    reads a gapped total without the word "gap" appearing anywhere in the
 *    caller. Three such consumers are compiled as a negative test in
 *    `synapse-metering-kernel-io.test.ts`; they must not type-check, and the
 *    `@ts-expect-error` on each fails the build if this shape ever lets one in
 *    again. The discriminant alone does not close this: only the absence of a
 *    common byte-bearing property does.
 *  - **A withheld account is withheld here too.** The `refused` and
 *    `not-collected` variants carry no byte quantity at all — not the
 *    attributed ledger, not the unattributed one, not the pathless volume.
 *    `attributeKernelIo` keeps some of those populated on a refused result
 *    deliberately, as the denominators its diagnostics would be meaningless
 *    without, and its own comment says they must not be read as totals.
 *    Re-surfacing them on this result would turn a refusal into a number with
 *    an asterisk, which is the failure the layer below exists to prevent. A
 *    caller diagnosing a refusal calls `attributeKernelIo` directly, where
 *    those quantities are labelled as the evidence they are.
 *
 * Pure: no filesystem, no clock, no `process.platform`. The kernel side is
 * whatever the caller hands in, and a caller that hands in nothing gets
 * `"N/A"` rather than a zero.
 */

/**
 * What this caller has to offer the kernel side.
 *
 * `collection` is `attributeKernelIo`'s own discriminated statement and is
 * passed straight through, which is the point of reusing the type rather than
 * accepting a nullable trace: "this deployment runs no collector" is
 * `{ kind: "not-collected" }` and can be spelled no other way. An empty
 * `TraceLog` is a different statement — a collector that ran and produced no
 * line — and the two are not interchangeable. Every non-Linux host takes the
 * `not-collected` path and must answer `"N/A"`; spelling it as an empty
 * `collected` trace would instead put a never-absolute storage root in front of
 * the root check and turn every one of those runs into a refused measurement,
 * indistinguishable from real breakage.
 *
 * `storageRoot` is read only when a collector ran (`attributeKernelIo` answers
 * the `not-collected` case before it ever looks at the root), and it must be
 * POSIX-absolute when one did: trace paths are kernel paths from a Linux
 * collector, so a Windows-shaped root is as unusable as a relative one and is
 * refused rather than quietly matching nothing.
 */
export type KernelIoSource = {
	collection: TraceCollection;
	/** Calibration hooks of design §7.3, passed through untouched. */
	options?: KernelIoAttributionOptions;
	storageRoot: string;
};

/**
 * The default second argument: no collector, and therefore no root to check.
 *
 * The empty root is never read — `attributeKernelIo` returns `"N/A"` for
 * `not-collected` before the root check, and the check is unreachable from
 * this value because the only branch that reaches it needs a `trace` this
 * variant does not have. Were it ever read it would be *refused*, not
 * accepted, so the placeholder cannot decay into a false pass.
 */
const NO_KERNEL_COLLECTION: KernelIoSource = { collection: { kind: "not-collected" }, storageRoot: "" };

/** Read and write bytes of one column, kept apart because design §7.3 predicts envelope *write* volume and folding reads in would make that unfalsifiable. */
export type KernelByteColumn = { readBytes: number; writeBytes: number };

/**
 * The kernel-side volumes of an account that may be reported, summed over
 * every attributed process.
 *
 * These are reporting volumes and nothing else. The two byte *currencies* of
 * `trace-attribute.ts` are judgement machinery and stay there: no predicate in
 * this module takes a byte count, because this module makes no judgement —
 * `coverage.complete`, the orphan share and every refusal were decided one
 * layer down, on placed bytes, before any of these totals were formed.
 */
export type KernelIoBytes = {
	/** Attributed VFS bytes per SYNAPSE category (design §4.2). Every category present even at zero: that zero is evidence, not a gap. */
	byCategory: Record<SynapseIoCategory, KernelByteColumn>;
	/**
	 * Bytes on descriptors no observed `openat` produced — an inherited stdio
	 * fd, a `dup`, or an open that predates the collector.
	 *
	 * Volume, never a measurement of SYNAPSE I/O: these bytes resolved to no
	 * path, so they are evidence about nothing and no judgement below was made
	 * on them. Present because a run's kernel traffic is not honestly described
	 * without them, and because a large value beside small `placedBytes` is the
	 * signature of a collector that attached late.
	 */
	pathlessBytes: number;
	/** Read plus write over every category and `unclassified`: the bytes whose path resolved under the storage root. Never comparable with, and never added to, an application-level total. */
	placedBytes: number;
	/** Inside the storage root, matching no known layout entry — `receipts/` is expected here. Never merged into a category. */
	unclassified: KernelByteColumn;
};

/**
 * The one comparison this feature exists to make, stated as two columns.
 *
 * Design §5.1: the two numbers are *not* summed and *not* interchangeable. The
 * application counted the envelope it serialised; the kernel counted what the
 * VFS moved for it. A gap between them is a finding — write amplification,
 * retries, a delivery path doing more work than the payload justifies — and
 * adding them would destroy exactly that finding while looking like a bigger,
 * better number.
 */
export type EnvelopeBytesSideBySide = {
	/** `MeteringTotals.control.envelopeBytes`: envelope bytes the application serialised. */
	applicationEnvelopeBytes: number;
	/** Kernel-side VFS *write* bytes classified `envelope` and attributed to a run. */
	kernelEnvelopeWriteBytes: number;
	/**
	 * Always `"N/A"`, on every path through this module.
	 *
	 * Restated here, at the one place a reader is tempted, because the
	 * temptation is specifically to call the kernel number beside it a
	 * transport byte. Today's delivery is a file write that may be served
	 * entirely from page cache without touching any transport; §5.1 leaves this
	 * for the phase that replaces file delivery with a socket.
	 */
	transportBytes: NotApplicable;
};

/**
 * Which of `coverage.complete`'s conditions the account failed, and by how
 * much. Reported alongside the bytes, in the variant a caller must name to
 * reach them at all.
 *
 * None of these refused the account — design §4.4 reports them rather than
 * refusing, and each is a way the account can be smaller than the run without
 * any row in it being wrong. Read the bytes as "at least this much", never as
 * the whole run.
 */
export type KernelIoGaps = {
	/** Identities bound by a `process-identity` event that produced no observed I/O at all. Their bytes, if any, are in nobody's account. */
	identitiesWithoutTrace: number;
	/** Not one attributed byte resolved to a path under the storage root, so `placedBytes` is 0 and the account certifies nothing about SYNAPSE I/O. */
	noAttributedBytesUnderStorageRoot: boolean;
	/** Attributed processes whose account cannot be claimed to start where the process did: the collector's earliest observation postdates their start. */
	processesWithUnobservedPrefix: number;
	/** Trace processes no run identity claimed. Real kernel I/O, kept out of every total here rather than folded into the nearest plausible run. */
	unattributedProcesses: number;
	/** The orphaned share of placed bytes that was judged against the threshold; `"N/A"` when nothing was placed, because a share of nothing is not a zero share. */
	unattributedShare: number | NotApplicable;
	unattributedShareThreshold: number;
};

/** Line counts the collector's own output supports, with no byte quantity among them: these are facts about the trace file, not about the account it was refused for. */
export type KernelTraceLines = { errors: TraceLineErrorCounts; losses: number; records: number };

/**
 * Everything an account that may be reported carries: the totals, the §5.1
 * columns, and the per-process rows.
 *
 * It is a type of its own rather than three fields on each variant so that the
 * two reporting variants can carry it under *different property names*. That
 * is the whole mechanism: `noGapFound` and `withKnownGaps` are the only routes
 * to a byte number in this module, and each names the coverage state of what
 * it holds. Flattening this back onto both variants would restore a common
 * `bytes` property, and with it the exclusion-form consumer — "not
 * `not-collected`, not `refused`, therefore `.bytes`" — that reads a gapped
 * total without ever mentioning a gap.
 */
export type KernelIoReport = {
	bytes: KernelIoBytes;
	envelope: EnvelopeBytesSideBySide;
	/** The per-process rows, each with its own `coverage` and the identities it was bound to. A row with more than one identity is not divisible between them. */
	processes: readonly AttributedProcessIo[];
};

/**
 * The kernel side of the result: four outcomes, and bytes on exactly two of
 * them, under two different names.
 *
 * A caller cannot reach a byte total without naming, in its own source, either
 * `noGapFound` or `withKnownGaps` — and cannot reach one at all on the two
 * outcomes where the layer below declined to produce one. Narrowing by
 * exclusion does not get there: with no `bytes` property on any variant,
 * `"bytes" in account` yields `unknown` and `account.bytes` after ruling out
 * the two non-reporting kinds does not type-check.
 */
export type KernelIoAccount =
	/**
	 * `"N/A"`: no kernel-side measurement exists to report, and none may be
	 * inferred. This is the answer on every host that runs no collector, and it
	 * is emphatically not a refusal — nothing is wrong with a run that was
	 * never observed from the kernel. It is also the answer when a collector ran
	 * and its trace held no line, loss or error whatsoever, which
	 * `attributeKernelIo` treats identically (a root it could not use would have
	 * been refused before reaching that point).
	 */
	| { kind: "not-collected" }
	/**
	 * `unavailable`: a collector ran and its account may not be used. Every
	 * applicable reason is given, never just the first.
	 *
	 * Deliberately byte-free. The layer below withheld the account; a byte
	 * total here — even a diagnostic one, even labelled — would be read as a
	 * measurement, and a measurement that quietly dropped part of its evidence
	 * is the failure this whole feature is built to avoid. `traceLines` is what
	 * the collector's own output supports without any of that: how many lines
	 * it wrote and how many could not be read.
	 */
	| { kind: "refused"; reasons: readonly KernelIoUnavailableReason[]; traceLines: KernelTraceLines }
	/**
	 * An account with no front-edge gap and no orphan in what was observed. Its
	 * totals are behind `noGapFound`, which is the claim being made about them.
	 *
	 * Named for what was tested, not for wholeness: coverage is examined at the
	 * front edge only, so a collector that died mid-run leaves a suffix with no
	 * evidence in it and nothing here can notice. Read it as "no gap was
	 * found", never as "this is the whole run".
	 */
	| { kind: "reported-no-gap-found"; noGapFound: KernelIoReport }
	/**
	 * An account that is reportable and known to be missing something: see
	 * `gaps`. On real traces this is the ordinary outcome — one orphan process
	 * anywhere is enough — which is why it carries the bytes rather than
	 * refusing them.
	 *
	 * Its totals are behind `withKnownGaps`, so a caller cannot spend them
	 * without having written that word; `gaps` beside it says which condition
	 * failed and by how much.
	 */
	| { gaps: KernelIoGaps; kind: "reported-with-gaps"; withKnownGaps: KernelIoReport };

/**
 * The two columns. `application` is byte-for-byte what `aggregateMetering`
 * returns for the same events — this module adds a column beside it and
 * changes nothing inside it, so an existing caller that moves to this function
 * reads identical totals.
 */
export type MeteringWithKernelIo = { application: MeteringTotals; kernel: KernelIoAccount };

function emptyColumn(): KernelByteColumn {
	return { readBytes: 0, writeBytes: 0 };
}

/** Adds one classified bucket into a column. Failures are counted by the layer below and are not bytes, so nothing here folds them in. */
function addBucket(column: KernelByteColumn, bucket: TraceIoBucket): void {
	column.readBytes += bucket.readBytes;
	column.writeBytes += bucket.writeBytes;
}

function columnTotal(column: KernelByteColumn): number {
	return column.readBytes + column.writeBytes;
}

/**
 * Totals the attributed rows into reporting columns.
 *
 * Every category is listed from `SYNAPSE_IO_CATEGORIES` rather than from the
 * rows, so a category no process touched reports a zero that means "looked,
 * saw none" — and a category added to the classifier breaks this annotation
 * instead of quietly going uncounted.
 */
function totalKernelBytes(rows: readonly AttributedProcessIo[]): KernelIoBytes {
	// `satisfies` rather than an annotation: the literal keeps its own type, and a
	// category added to the classifier breaks this line instead of quietly going
	// uncounted.
	const byCategory = { content: emptyColumn(), envelope: emptyColumn(), "memory-index": emptyColumn() } satisfies Record<SynapseIoCategory, KernelByteColumn>;
	const unclassified = emptyColumn();
	let pathlessBytes = 0;

	for (const row of rows) {
		for (const category of SYNAPSE_IO_CATEGORIES) addBucket(byCategory[category], row.io.categories[category]);
		addBucket(unclassified, row.io.unclassified);
		pathlessBytes += bucketBytes(row.io.unknownDescriptor);
	}

	// Recomputed from the columns rather than accumulated in parallel: the total
	// and the breakdown cannot drift apart if only one of them exists.
	let placedBytes = columnTotal(unclassified);
	for (const category of SYNAPSE_IO_CATEGORIES) placedBytes += columnTotal(byCategory[category]);

	return { byCategory, pathlessBytes, placedBytes, unclassified };
}

/** The design §5.1 columns. Note that nothing in this function adds its two inputs together, and no field of its result is their sum. */
function envelopeSideBySide(application: MeteringTotals, bytes: KernelIoBytes): EnvelopeBytesSideBySide {
	return {
		applicationEnvelopeBytes: application.control.envelopeBytes,
		kernelEnvelopeWriteBytes: bytes.byCategory.envelope.writeBytes,
		transportBytes: "N/A",
	};
}

/** Restates the conditions `coverage.complete` failed on, from the diagnostics that decided it. Nothing is re-judged: every value here was computed one layer down. */
function gapsOf(diagnostics: KernelIoDiagnostics, bytes: KernelIoBytes): KernelIoGaps {
	return {
		identitiesWithoutTrace: diagnostics.identityKeysWithoutTrace,
		noAttributedBytesUnderStorageRoot: bytes.placedBytes === 0,
		processesWithUnobservedPrefix: diagnostics.coverage.processesWithUnobservedPrefix,
		unattributedProcesses: diagnostics.unattributedProcesses.length,
		unattributedShare: diagnostics.unattributedShare,
		unattributedShareThreshold: diagnostics.unattributedShareThreshold,
	};
}

/**
 * Projects the attribution result onto the reporting union.
 *
 * The three outcomes of `attributed` map one-to-one and are never collapsed:
 * `"N/A"` is not a refusal, a refusal is not an empty account, and an empty
 * account that was reported is a genuine zero. `coverage.complete` then
 * chooses between the two reporting variants, which is the only place this
 * module reads a judgement — and it copies one, it does not make one.
 */
function accountOf(application: MeteringTotals, attribution: KernelIoAttribution): KernelIoAccount {
	const { attributed, diagnostics, unavailableReasons } = attribution;
	if (attributed === "N/A") return { kind: "not-collected" };
	if (attributed === "unavailable") return { kind: "refused", reasons: unavailableReasons, traceLines: diagnostics.traceLines };

	const bytes = totalKernelBytes(attributed);
	const report: KernelIoReport = { bytes, envelope: envelopeSideBySide(application, bytes), processes: attributed };
	if (diagnostics.coverage.complete) return { kind: "reported-no-gap-found", noGapFound: report };
	return { gaps: gapsOf(diagnostics, bytes), kind: "reported-with-gaps", withKnownGaps: report };
}

/**
 * Aggregates a metering log, and — when a collector ran — the kernel-side
 * account of the same run beside it (design §3.4).
 *
 * Called with one argument this is `aggregateMetering` plus a `kernel` column
 * that says `"N/A"`: the application totals are field-for-field what
 * `aggregateMetering` produces for the same events, because they *are* what it
 * produces. `aggregateMetering` itself is untouched, and every existing caller
 * of it keeps behaving byte-identically; only a caller that explicitly supplies
 * a collection gets kernel-side data.
 *
 * The name is deliberately not `aggregateWithTransport` (design §3.4): what it
 * adds is kernel VFS bytes, and calling those transport bytes — or summing
 * them with `envelopeBytes` — is the category error §5.1 exists to forbid.
 */
export function aggregateWithKernelIo(events: readonly MeteringEvent[], source: KernelIoSource = NO_KERNEL_COLLECTION): MeteringWithKernelIo {
	const application = aggregateMetering(events);
	const attribution = attributeKernelIo(events, source.collection, source.storageRoot, source.options);
	return { application, kernel: accountOf(application, attribution) };
}
