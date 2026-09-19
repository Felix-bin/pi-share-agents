import { mergeHistograms, readLatency, writeLatency, type LatencySummary } from "./histogram.ts";
import { OBSERVATION_CATEGORIES, type CollectorSnapshot, type ObservationCounters, type ObservationProcessSnapshot } from "./protocol.ts";

/**
 * Turns a stream of cumulative collector snapshots into something a view can
 * read without knowing anything about sockets, pids or kernel maps.
 *
 * The invariants this file exists to hold:
 *
 *   - Nothing is counted twice. Snapshot counters are cumulative, so a repeated
 *     or out-of-order snapshot is discarded by sequence and a live registration
 *     is replaced rather than added to.
 *   - Nothing is silently lost. A registration that disappears — because the
 *     process ended or the collector restarted — keeps its last cumulative
 *     value as a sealed contribution, and the interruption is recorded as a gap.
 *   - Nothing is invented. A run with no measurement is `unavailable`, not zero,
 *     and a run whose coverage started late says so instead of implying it was
 *     watched from the beginning.
 *
 * Every function here is pure. The socket lives in `client.ts`; the reason for
 * the split is that all the accounting rules above are then testable without
 * one.
 */

/** Three missed one-second snapshots is the point at which the numbers stop being live. */
export const OBSERVATION_STALE_AFTER_MS = 3000;

/** Registration later than this after a run began means the start was not watched. */
export const OBSERVATION_LATE_REGISTRATION_MS = 250;

export type ObservationCoverageState = "active" | "disabled" | "partial" | "stale" | "unavailable";

export type ObservationGapReason = "collector-restart" | "disconnected";

export type ObservationGap = {
	fromMs: number;
	reason: ObservationGapReason;
	toMs: number | null;
};

export type ObservationLink = "connected" | "disabled" | "disconnected" | "never-connected" | "unsupported";

export type ObservationQuality = {
	classifyIncomplete: number;
	mapOverflows: number;
	unpairedReturns: number;
};

/**
 * The four categories, spelled out rather than expressed as a dictionary: the
 * set is fixed by the kernel-side classifier, and naming it here is what makes
 * a forgotten category a compile error instead of a missing column.
 */
export type ObservationCategoryCounters = {
	content: ObservationCounters;
	envelope: ObservationCounters;
	memoryIndex: ObservationCounters;
	unclassified: ObservationCounters;
};

type RegistrationRecord = {
	attribution: "exclusive" | "shared";
	categories: ObservationCategoryCounters;
	nodeId: string;
	observedFromMs: number;
	pid: number;
	runId: string;
};

export type ObservationState = {
	collectorInstance: string | null;
	gaps: readonly ObservationGap[];
	lastSequence: number;
	lastSnapshotAtMs: number | null;
	link: ObservationLink;
	/** Latest cumulative value per live registration, keyed by registration id. */
	live: ReadonlyMap<string, RegistrationRecord>;
	quality: ObservationQuality;
	/** Final values of registrations that ended; their bytes stay in the totals. */
	sealed: readonly RegistrationRecord[];
	unsupportedDetail: string | null;
};

export function emptyObservationState(link: ObservationLink, unsupportedDetail: string | null = null): ObservationState {
	return {
		collectorInstance: null,
		gaps: [],
		lastSequence: 0,
		lastSnapshotAtMs: null,
		link,
		live: new Map(),
		quality: { classifyIncomplete: 0, mapOverflows: 0, unpairedReturns: 0 },
		sealed: [],
		unsupportedDetail,
	};
}

function emptyCounters(): ObservationCounters {
	return { failedOps: 0, readBytes: 0, readHist: [], readNs: 0, readOps: 0, writeBytes: 0, writeHist: [], writeNs: 0, writeOps: 0 };
}

function emptyCategories(): ObservationCategoryCounters {
	return { content: emptyCounters(), envelope: emptyCounters(), memoryIndex: emptyCounters(), unclassified: emptyCounters() };
}

function addCounters(into: ObservationCounters, from: ObservationCounters): ObservationCounters {
	return {
		failedOps: into.failedOps + from.failedOps,
		readBytes: into.readBytes + from.readBytes,
		readHist: mergeHistograms(into.readHist, from.readHist),
		readNs: into.readNs + from.readNs,
		readOps: into.readOps + from.readOps,
		writeBytes: into.writeBytes + from.writeBytes,
		writeHist: mergeHistograms(into.writeHist, from.writeHist),
		writeNs: into.writeNs + from.writeNs,
		writeOps: into.writeOps + from.writeOps,
	};
}

function recordOf(process: ObservationProcessSnapshot): RegistrationRecord {
	return {
		attribution: process.attribution,
		categories: process.categories,
		nodeId: process.nodeId,
		observedFromMs: process.observedFromMs,
		pid: process.pid,
		runId: process.runId,
	};
}

export type SnapshotOutcome = "applied" | "duplicate" | "restart";

export type ApplySnapshotResult = {
	outcome: SnapshotOutcome;
	state: ObservationState;
};

/**
 * Folds one snapshot into the state.
 *
 * A snapshot from a new collector instance starts a new observation interval:
 * its counters restart from zero, so the previous interval is sealed and the
 * span between them is kept as an explicit gap rather than closed over.
 */
export function applySnapshot(state: ObservationState, snapshot: CollectorSnapshot): ApplySnapshotResult {
	const restarted = state.collectorInstance !== null && state.collectorInstance !== snapshot.collectorInstance;
	if (!restarted && snapshot.sequence <= state.lastSequence) {
		// Cumulative counters make a replayed snapshot harmless to drop, and
		// applying it would move the "last seen" time backwards.
		return { outcome: "duplicate", state };
	}

	const sealed = [...state.sealed];
	const gaps = [...state.gaps];
	const previous = new Map(state.live);

	if (restarted) {
		sealed.push(...previous.values());
		previous.clear();
		gaps.push({ fromMs: state.lastSnapshotAtMs ?? snapshot.emittedAtMs, reason: "collector-restart", toMs: snapshot.emittedAtMs });
	}

	const live = new Map<string, RegistrationRecord>();
	for (const process of snapshot.processes) {
		live.set(process.registrationId, recordOf(process));
	}
	// A registration the collector no longer reports has finished. Its last
	// cumulative value is its final one and must stay in the run's totals.
	for (const [registrationId, record] of previous) {
		if (!live.has(registrationId)) sealed.push(record);
	}

	const closedGaps = gaps.map((gap): ObservationGap => (gap.toMs === null ? { ...gap, toMs: snapshot.emittedAtMs } : gap));

	return {
		outcome: restarted ? "restart" : "applied",
		state: {
			collectorInstance: snapshot.collectorInstance,
			gaps: closedGaps,
			lastSequence: snapshot.sequence,
			lastSnapshotAtMs: snapshot.emittedAtMs,
			link: "connected",
			live,
			quality: snapshot.quality,
			sealed,
			unsupportedDetail: null,
		},
	};
}

/**
 * Records that the socket went away. Live registrations are sealed because
 * their counters stop advancing, and an open-ended gap starts: a reconnect
 * closes it, and until then the view is stale rather than current.
 */
export function applyDisconnect(state: ObservationState, atMs: number): ObservationState {
	if (state.link === "disconnected") return state;
	return {
		...state,
		gaps: [...state.gaps, { fromMs: state.lastSnapshotAtMs ?? atMs, reason: "disconnected", toMs: null }],
		link: "disconnected",
		live: new Map(),
		sealed: [...state.sealed, ...state.live.values()],
	};
}

export type ObservationCategoryView = {
	failedOps: number;
	readBytes: number;
	readLatency: LatencySummary;
	readOps: number;
	writeBytes: number;
	writeLatency: LatencySummary;
	writeOps: number;
};

export type ObservationCategoryViews = {
	content: ObservationCategoryView;
	envelope: ObservationCategoryView;
	memoryIndex: ObservationCategoryView;
	unclassified: ObservationCategoryView;
};

export type ObservationRunView =
	| { coverage: "disabled" | "unavailable"; detail: string; measured: false }
	| {
			attribution: "exclusive" | "shared";
			categories: ObservationCategoryViews;
			coverage: "active" | "partial" | "stale";
			gaps: readonly ObservationGap[];
			/** Named reasons the numbers are not a complete account of the run. */
			incompleteReasons: readonly string[];
			measured: true;
			observedFromMs: number;
			processes: number;
			totals: ObservationCategoryView;
	  };

export type ProjectRunRequest = {
	nowMs: number;
	runId: string;
	/** When the run began, so a late registration can be reported as a late one. */
	runStartedAtMs: number | null;
};

function viewOf(counters: ObservationCounters): ObservationCategoryView {
	return {
		failedOps: counters.failedOps,
		readBytes: counters.readBytes,
		readLatency: readLatency(counters),
		readOps: counters.readOps,
		writeBytes: counters.writeBytes,
		writeLatency: writeLatency(counters),
		writeOps: counters.writeOps,
	};
}

export function projectRun(state: ObservationState, request: ProjectRunRequest): ObservationRunView {
	if (state.link === "disabled") {
		return { coverage: "disabled", detail: "systemObservation.enabled is false", measured: false };
	}
	if (state.link === "unsupported") {
		return { coverage: "unavailable", detail: state.unsupportedDetail ?? "this platform has no kernel file I/O observation", measured: false };
	}
	if (state.link === "never-connected") {
		return { coverage: "unavailable", detail: "no collector snapshot has been received", measured: false };
	}

	const contributing = [...state.sealed, ...state.live.values()].filter((record) => record.runId === request.runId);
	if (contributing.length === 0) {
		return { coverage: "unavailable", detail: "this run has no registered process", measured: false };
	}

	const categories = emptyCategories();
	// Counted by pid, not by registration: one process observed across a
	// collector restart contributes two records but is still one process.
	const pids = new Set<number>();
	let combined = emptyCounters();
	let shared = false;
	let observedFromMs = Number.POSITIVE_INFINITY;
	for (const record of contributing) {
		pids.add(record.pid);
		if (record.attribution === "shared") shared = true;
		observedFromMs = Math.min(observedFromMs, record.observedFromMs);
		for (const category of OBSERVATION_CATEGORIES) {
			categories[category] = addCounters(categories[category], record.categories[category]);
			combined = addCounters(combined, record.categories[category]);
		}
	}

	const incompleteReasons: string[] = [];
	if (request.runStartedAtMs !== null && observedFromMs > request.runStartedAtMs + OBSERVATION_LATE_REGISTRATION_MS) {
		incompleteReasons.push(`observation started ${observedFromMs - request.runStartedAtMs}ms after the run`);
	}
	for (const gap of state.gaps) {
		incompleteReasons.push(gap.reason === "collector-restart" ? "collector restarted mid-run" : "collector connection was lost");
	}
	if (state.quality.classifyIncomplete > 0) incompleteReasons.push(`${state.quality.classifyIncomplete} files could not be classified`);
	if (state.quality.mapOverflows > 0) incompleteReasons.push(`${state.quality.mapOverflows} measurements dropped at a capacity limit`);
	if (state.quality.unpairedReturns > 0) incompleteReasons.push(`${state.quality.unpairedReturns} operations were seen only at return`);
	if (shared) incompleteReasons.push("one process is shared by several agents and is reported once");

	const stale = state.link === "disconnected" || state.lastSnapshotAtMs === null || request.nowMs - state.lastSnapshotAtMs >= OBSERVATION_STALE_AFTER_MS;
	const coverage = stale ? "stale" : incompleteReasons.length > 0 ? "partial" : "active";

	const categoryViews: ObservationCategoryViews = {
		content: viewOf(categories.content),
		envelope: viewOf(categories.envelope),
		memoryIndex: viewOf(categories.memoryIndex),
		unclassified: viewOf(categories.unclassified),
	};

	return {
		attribution: shared ? "shared" : "exclusive",
		categories: categoryViews,
		coverage,
		gaps: state.gaps,
		incompleteReasons,
		measured: true,
		observedFromMs,
		processes: pids.size,
		totals: viewOf(combined),
	};
}
