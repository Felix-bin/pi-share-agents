import { contributedBytes, traceCallFailed, type TraceRecord } from "./trace-log.ts";

/**
 * Turns parsed `synapse-trace` records into "which SYNAPSE category did these
 * bytes belong to?" — the second half of design §4.2.
 *
 * The question is not answerable one record at a time. `read` and `write` are
 * handed a descriptor and no path (the wire contract in `trace-log.ts` forbids
 * a path on them precisely so the collector cannot invent one), so the path has
 * to be reconstructed from the `openat` that produced the descriptor. This
 * module builds that table and spends it, and nothing else: it does not know
 * about runs, identities or clocks. Attribution to a run identity is design
 * §4.1/§4.3 and belongs to the next module; the output here is grouped by
 * `(pid, startTicks)` so that join is a lookup rather than a re-derivation.
 *
 * Pure throughout. No filesystem, no `process.platform`, no `node:path` — the
 * paths in a trace record are kernel paths from a Linux collector, so they are
 * parsed as POSIX text on whatever platform the tests happen to run on. Using
 * `node:path` here would make classification depend on the host's separator
 * and silently change answers between Linux and Windows.
 *
 * Three rules govern what is counted, and all three are about *not* quietly
 * producing a number that looks like a measurement:
 *
 *  - a descriptor with no `openat` behind it (`dup`/`dup2`, an fd inherited
 *    across `fork`, or an open that happened before the collector started) is
 *    counted in an explicit unknown-descriptor bucket, never dropped and never
 *    counted as zero. The wire contract has no `close` and no `dup`, so this
 *    bucket is the honest name for what is genuinely not observable;
 *  - a path under the storage root that matches no known layout entry is
 *    `unclassified` and stays there. It is never assigned to the nearest
 *    plausible category;
 *  - `metering/` and `trace/` are excluded by name, so observation does not
 *    observe itself, and paths outside the storage root are not counted into
 *    any category at all. Both are still tallied, in `ignored`, because
 *    "deliberately not counted" and "never seen" are different facts.
 */

/** The SYNAPSE categories kernel I/O can be attributed to, by storage-root layout (design §4.2 step 3). */
export const SYNAPSE_IO_CATEGORIES = ["envelope", "content", "memory-index"] as const;
export type SynapseIoCategory = (typeof SYNAPSE_IO_CATEGORIES)[number];

/**
 * The storage-root entries each category owns. These names are the layout, not
 * a heuristic: `envelopes/` is `envelope-inbox.ts:30`, `objects/` is
 * `content-store.ts:88`, `memory/` and `supersessions/` are
 * `memory-store.ts:203-204`, and `namespace.json` is `namespace.ts:20`. A
 * writer that grows a new top-level entry lands in `unclassified` until this
 * table learns about it — visibly under-attributed rather than silently
 * misattributed.
 *
 * `receipts/` (`delegation.ts:87-89`) is a real top-level entry this table
 * deliberately does not name: design §4.2 lists three categories and receipts
 * are none of them. So `unclassified` is expected to be nonzero on the very
 * first real trace, and a reader of the result should not read it as a bug.
 */
const CATEGORY_BY_ROOT_ENTRY = new Map<string, SynapseIoCategory>([
	["envelopes", "envelope"],
	["objects", "content"],
	["memory", "memory-index"],
	["supersessions", "memory-index"],
	["namespace.json", "memory-index"],
]);

/**
 * The measurement's own storage. Excluded by name so that writing the metering
 * log, or the trace file itself, cannot show up as SYNAPSE I/O — a feedback
 * loop where the observation inflates the thing it observes.
 */
const EXCLUDED_ROOT_ENTRIES = new Set(["metering", "trace"]);

/**
 * What a path is, relative to the storage root. Four outcomes, deliberately
 * not three: `unclassified` (inside the root, layout unknown) and
 * `outside-root` (not SYNAPSE storage at all) mean different things to a
 * reader of the result — the first is a gap in this table, the second is
 * ordinary unrelated I/O by the same process.
 */
export type TracePathClassification =
	| { category: SynapseIoCategory; kind: "category" }
	| { kind: "excluded" }
	| { kind: "unclassified" }
	| { kind: "outside-root" };

/** Path segments, with empty and `.` segments dropped. Never touches `node:path`: these are kernel paths, always POSIX. */
function posixSegments(value: string): string[] {
	return value.split("/").filter((segment) => segment.length > 0 && segment !== ".");
}

/**
 * Resolves `..` purely, or reports that the path climbs above its own start.
 *
 * Without this, `<root>/../metering/x` passes a textual prefix test and gets
 * counted as SYNAPSE storage — the one path shape that would defeat the
 * `metering/` exclusion.
 */
function resolveSegments(segments: readonly string[]): string[] | null {
	const resolved: string[] = [];
	for (const segment of segments) {
		if (segment !== "..") {
			resolved.push(segment);
			continue;
		}
		if (resolved.length === 0) return null;
		resolved.pop();
	}
	return resolved;
}

/**
 * Classifies one path against the storage root by its first relative segment.
 *
 * Deliberately a prefix test on the path as written, with no rename following.
 * Both SYNAPSE writers create their temporary file in the *same directory* as
 * the target — `atomic-json.ts:59-61` uses `path.join(path.dirname(filePath), …)`
 * and `content-store.ts:180` uses `path.join(dir, ".<contentId>.<pid>.<ms>.tmp")`
 * — so a `.tmp` file's prefix is already `envelopes/` or `objects/` and the
 * bytes land in the right category before the rename ever happens.
 * Reconstructing the temp→final mapping would buy per-file identity, which
 * this design does not claim (design §4.2, revised). A future writer that put
 * its temporary file somewhere else would show up as `unclassified`, which is
 * visible, rather than as a wrong category, which is not.
 *
 * A relative path, or one that climbs above the root, is `outside-root`: the
 * collector is expected to emit resolved absolute paths, and a path this
 * function cannot place is reported as unplaced rather than guessed at.
 *
 * Both arguments must be absolute. Segments alone cannot tell `/var/synapse/x`
 * from `var/synapse/x`, so without this check a relative path that happened to
 * mirror the root's segments would classify *into a category* — the one failure
 * direction that is invisible in the result. An empty or relative storage root
 * is rejected for the same reason: it would make every path match.
 */
export function classifyTracePath(storageRoot: string, filePath: string): TracePathClassification {
	if (!storageRoot.startsWith("/") || !filePath.startsWith("/")) return { kind: "outside-root" };
	const rootSegments = resolveSegments(posixSegments(storageRoot));
	const pathSegments = resolveSegments(posixSegments(filePath));
	if (rootSegments === null || pathSegments === null) return { kind: "outside-root" };
	if (pathSegments.length < rootSegments.length) return { kind: "outside-root" };
	for (const [index, segment] of rootSegments.entries()) {
		if (pathSegments[index] !== segment) return { kind: "outside-root" };
	}

	const entry = pathSegments[rootSegments.length];
	// The storage root itself: inside the root, but naming no layout entry.
	if (entry === undefined) return { kind: "unclassified" };
	if (EXCLUDED_ROOT_ENTRIES.has(entry)) return { kind: "excluded" };
	const category = CATEGORY_BY_ROOT_ENTRY.get(entry);
	if (category === undefined) return { kind: "unclassified" };
	return { category, kind: "category" };
}

/**
 * Byte and failure totals for one bucket.
 *
 * Read and write bytes stay apart because they are not interchangeable
 * downstream: the self-consistency check of spec §7.3 predicts envelope *write*
 * volume against `envelopeBytes`, and folding reads in would make that
 * prediction unfalsifiable.
 *
 * Failures are counted, never folded into bytes. A failed call moved nothing —
 * `contributedBytes` returns 0 for it — but "nothing moved because the call
 * failed" and "nothing moved because nothing was asked for" are different
 * facts, and a bucket that shows only zero bytes cannot tell them apart.
 */
export type TraceIoBucket = {
	/** Failed `openat` / `renameat2` naming a path in this bucket. */
	failedPathCalls: number;
	failedReads: number;
	failedWrites: number;
	readBytes: number;
	writeBytes: number;
};

function emptyBucket(): TraceIoBucket {
	return { failedPathCalls: 0, failedReads: 0, failedWrites: 0, readBytes: 0, writeBytes: 0 };
}

/**
 * I/O by one process, identified the way design §4.1 identifies it:
 * `(pid, startTicks)`, so a reused pid is two processes rather than one
 * process with an impossible history. The next stage joins this key against
 * the `process-identity` metering events.
 *
 * Every category is present even at zero. That zero is evidence — these
 * records were read and none of them touched that category — not a missing
 * quantity dressed up as one.
 */
export type TraceProcessIo = {
	categories: Record<SynapseIoCategory, TraceIoBucket>;
	pid: number;
	startTicks: number;
	/** Inside the storage root, matching no known layout entry. Never merged into a category. */
	unclassified: TraceIoBucket;
	/** Read/write on a descriptor no observed `openat` produced: `dup`/`dup2`, a `fork`-inherited fd, or an open that predates the collector. */
	unknownDescriptor: TraceIoBucket;
};

export type TraceIoClassification = {
	/**
	 * Seen and deliberately not attributed. `excluded` is `metering/` and
	 * `trace/`; `outsideRoot` is everything that is not SYNAPSE storage. Kept
	 * because a reader who finds a run's totals smaller than expected needs to
	 * see where the rest of the I/O went.
	 */
	ignored: { excluded: TraceIoBucket; outsideRoot: TraceIoBucket };
	/** One entry per observed `(pid, startTicks)`, in first-seen order. */
	processes: TraceProcessIo[];
};

function keyOf(pid: number, startTicks: number, fd: number): string {
	return `${pid}:${startTicks}:${fd}`;
}

function processKeyOf(record: TraceRecord): string {
	return `${record.pid}:${record.startTicks}`;
}

function emptyProcessIo(pid: number, startTicks: number): TraceProcessIo {
	return {
		categories: { content: emptyBucket(), envelope: emptyBucket(), "memory-index": emptyBucket() },
		pid,
		startTicks,
		unclassified: emptyBucket(),
		unknownDescriptor: emptyBucket(),
	};
}

/** Adds one record to a bucket, reusing the contract's own byte and failure rules rather than re-deriving them from `ret`. */
function accumulate(bucket: TraceIoBucket, record: TraceRecord): void {
	if (record.syscall === "openat" || record.syscall === "renameat2") {
		if (traceCallFailed(record)) bucket.failedPathCalls += 1;
		return;
	}
	if (traceCallFailed(record)) {
		if (record.syscall === "read") bucket.failedReads += 1;
		else bucket.failedWrites += 1;
		return;
	}
	const moved = contributedBytes(record);
	if (record.syscall === "read") bucket.readBytes += moved;
	else bucket.writeBytes += moved;
}

/**
 * Replays trace records in order, maintaining `(pid, startTicks, fd) → path
 * classification`, and totals the bytes each SYNAPSE category received.
 *
 * Three things about the descriptor table are load-bearing:
 *
 *  - **It is keyed by the process, not by the fd number.** Two processes both
 *    writing on fd 7 are two different files; a table keyed by fd alone would
 *    hand one process's bytes to the other's category. `startTicks` is in the
 *    key as well as `pid`, so a pid reused after a process exits starts with an
 *    empty table instead of inheriting a dead process's mappings — the same
 *    fact that makes pid reuse decidable in design §4.1 makes table cleanup
 *    decidable here, without needing a process-exit event.
 *  - **The newly allocated descriptor is `ret`, not `fd`.** For `openat`, `fd`
 *    is the *directory* descriptor the call was relative to (usually the
 *    negative `AT_FDCWD`); mapping on it would key the whole table to one
 *    constant. `renameat2` never creates a mapping at all: its `ret` is a
 *    status, and treating a status as a descriptor would map fd 0.
 *  - **Last `openat` wins.** The contract carries no `close`, so fd reuse
 *    cannot be observed directly — but it does not need to be. The kernel can
 *    only hand out an fd number that is currently free, so the first use of a
 *    reused number is always an `openat`, and overwriting the mapping there is
 *    exactly right. A *failed* `openat` allocates nothing and therefore
 *    overwrites nothing: it is counted as a failure and leaves the previous
 *    mapping alone.
 *
 * Records are consumed in the order given. The caller is responsible for that
 * order being the order the syscalls happened — `parseTraceLog` preserves the
 * collector's line order, which is the collector's `nsecs` order.
 */
export function classifyTraceIo(records: readonly TraceRecord[], storageRoot: string): TraceIoClassification {
	const descriptors = new Map<string, TracePathClassification>();
	const processes = new Map<string, TraceProcessIo>();
	const excluded = emptyBucket();
	const outsideRoot = emptyBucket();

	const bucketFor = (owner: TraceProcessIo, classification: TracePathClassification): TraceIoBucket => {
		if (classification.kind === "category") return owner.categories[classification.category];
		if (classification.kind === "unclassified") return owner.unclassified;
		return classification.kind === "excluded" ? excluded : outsideRoot;
	};

	for (const record of records) {
		const processKey = processKeyOf(record);
		const existing = processes.get(processKey);
		const owner = existing ?? emptyProcessIo(record.pid, record.startTicks);
		if (existing === undefined) processes.set(processKey, owner);

		if (record.syscall === "openat" || record.syscall === "renameat2") {
			const classification = classifyTracePath(storageRoot, record.path);
			accumulate(bucketFor(owner, classification), record);
			if (record.syscall === "openat" && !traceCallFailed(record)) {
				descriptors.set(keyOf(record.pid, record.startTicks, record.ret), classification);
			}
			continue;
		}

		const classification = descriptors.get(keyOf(record.pid, record.startTicks, record.fd));
		accumulate(classification === undefined ? owner.unknownDescriptor : bucketFor(owner, classification), record);
	}

	return { ignored: { excluded, outsideRoot }, processes: [...processes.values()] };
}
