import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyDisconnect,
	applySnapshot,
	emptyObservationState,
	projectRun,
	OBSERVATION_STALE_AFTER_MS,
	type ObservationState,
} from "../../src/observation/aggregate.ts";
import type { CollectorSnapshot, ObservationCounters, ObservationProcessSnapshot } from "../../src/observation/protocol.ts";

type CounterOverrides = {
	failedOps?: number;
	readBytes?: number;
	readNs?: number;
	readOps?: number;
	writeBytes?: number;
	writeNs?: number;
	writeOps?: number;
};

function counters(overrides: CounterOverrides = {}): ObservationCounters {
	const readOps = overrides.readOps ?? 0;
	const writeOps = overrides.writeOps ?? 0;
	return {
		failedOps: overrides.failedOps ?? 0,
		readBytes: overrides.readBytes ?? 0,
		readHist: readOps === 0 ? [] : [[10, readOps]],
		readNs: overrides.readNs ?? 0,
		readOps,
		writeBytes: overrides.writeBytes ?? 0,
		writeHist: writeOps === 0 ? [] : [[12, writeOps]],
		writeNs: overrides.writeNs ?? 0,
		writeOps,
	};
}

type ProcessOverrides = {
	attribution?: "exclusive" | "shared";
	envelope?: ObservationCounters;
	observedFromMs?: number;
	pid?: number;
	registrationId?: string;
	runId?: string;
};

function processSnapshot(overrides: ProcessOverrides = {}): ObservationProcessSnapshot {
	return {
		attribution: overrides.attribution ?? "exclusive",
		categories: { content: counters(), envelope: overrides.envelope ?? counters(), memoryIndex: counters(), unclassified: counters() },
		exited: false,
		nodeId: "node-1",
		observedFromMs: overrides.observedFromMs ?? 1000,
		pid: overrides.pid ?? 42,
		registrationId: overrides.registrationId ?? "c1-42-77",
		runId: overrides.runId ?? "run-1",
		startTicks: 77,
	};
}

type SnapshotOverrides = {
	classifyIncomplete?: number;
	collectorInstance?: string;
	emittedAtMs?: number;
	mapOverflows?: number;
	processes?: ObservationProcessSnapshot[];
	sequence?: number;
};

function snapshot(overrides: SnapshotOverrides = {}): CollectorSnapshot {
	return {
		collectorInstance: overrides.collectorInstance ?? "c1",
		emittedAtMs: overrides.emittedAtMs ?? 2000,
		processes: overrides.processes ?? [processSnapshot()],
		protocol: "synapse-io/1",
		quality: { classifyIncomplete: overrides.classifyIncomplete ?? 0, mapOverflows: overrides.mapOverflows ?? 0, unpairedReturns: 0 },
		sequence: overrides.sequence ?? 1,
		type: "snapshot",
	};
}

function connected(): ObservationState {
	return emptyObservationState("never-connected");
}

function measured(state: ObservationState, nowMs: number, runStartedAtMs: number | null = null) {
	const view = projectRun(state, { nowMs, runId: "run-1", runStartedAtMs });
	assert.equal(view.measured, true, "expected a measured view");
	if (!view.measured) throw new Error("unreachable");
	return view;
}

describe("cumulative snapshots are never counted twice", () => {
	it("replaces a live registration's counters instead of adding to them", () => {
		let state = connected();
		state = applySnapshot(state, snapshot({ envelope: undefined, processes: [processSnapshot({ envelope: counters({ readBytes: 100, readOps: 1 }) })], sequence: 1 })).state;
		state = applySnapshot(state, snapshot({ processes: [processSnapshot({ envelope: counters({ readBytes: 250, readOps: 3 }) })], sequence: 2 })).state;
		const view = measured(state, 2000);
		assert.equal(view.totals.readBytes, 250);
		assert.equal(view.totals.readOps, 3);
	});

	it("discards a replayed or out-of-order snapshot by sequence", () => {
		let state = connected();
		state = applySnapshot(state, snapshot({ processes: [processSnapshot({ envelope: counters({ readBytes: 250, readOps: 3 }) })], sequence: 2 })).state;
		const replay = applySnapshot(state, snapshot({ processes: [processSnapshot({ envelope: counters({ readBytes: 100, readOps: 1 }) })], sequence: 2 }));
		assert.equal(replay.outcome, "duplicate");
		assert.equal(measured(replay.state, 2000).totals.readBytes, 250);
	});
});

describe("nothing measured is silently lost", () => {
	it("keeps the final counters of a registration the collector stopped reporting", () => {
		let state = connected();
		state = applySnapshot(state, snapshot({ processes: [processSnapshot({ envelope: counters({ readBytes: 500, readOps: 5 }) })], sequence: 1 })).state;
		state = applySnapshot(state, snapshot({ emittedAtMs: 3000, processes: [], sequence: 2 })).state;
		const view = measured(state, 3000);
		assert.equal(view.totals.readBytes, 500, "a finished process keeps its bytes in the run total");
	});

	it("seals the old interval and records a gap when the collector restarts", () => {
		let state = connected();
		state = applySnapshot(state, snapshot({ processes: [processSnapshot({ envelope: counters({ readBytes: 500, readOps: 5 }) })], sequence: 9 })).state;
		const restarted = applySnapshot(
			state,
			snapshot({
				collectorInstance: "c2",
				emittedAtMs: 8000,
				processes: [processSnapshot({ envelope: counters({ readBytes: 40, readOps: 1 }), registrationId: "c2-42-77", observedFromMs: 7500 })],
				sequence: 1,
			}),
		);
		assert.equal(restarted.outcome, "restart");
		const view = measured(restarted.state, 8000);
		assert.equal(view.totals.readBytes, 540, "both intervals count, and neither is counted twice");
		assert.equal(view.processes, 1, "one process observed across two intervals is still one process");
		assert.equal(view.gaps.length, 1);
		assert.equal(view.gaps[0]?.reason, "collector-restart");
		assert.equal(view.coverage, "partial");
	});

	it("seals live registrations when the connection drops and leaves the gap open", () => {
		let state = connected();
		state = applySnapshot(state, snapshot({ processes: [processSnapshot({ envelope: counters({ readBytes: 500, readOps: 5 }) })], sequence: 1 })).state;
		state = applyDisconnect(state, 2500);
		const view = measured(state, 2600);
		assert.equal(view.totals.readBytes, 500);
		assert.equal(view.coverage, "stale");
		assert.equal(view.gaps[0]?.toMs, null, "an unfinished gap has no end yet");
	});
});

describe("nothing is invented", () => {
	it("reports a disabled feature as disabled, not as zero bytes", () => {
		const view = projectRun(emptyObservationState("disabled"), { nowMs: 1, runId: "run-1", runStartedAtMs: null });
		assert.equal(view.measured, false);
		assert.equal(view.coverage, "disabled");
	});

	it("reports an unsupported platform with the reason it was given", () => {
		const view = projectRun(emptyObservationState("unsupported", "this host reports win32"), { nowMs: 1, runId: "run-1", runStartedAtMs: null });
		assert.equal(view.measured, false);
		assert.equal(view.measured === false ? view.detail : "", "this host reports win32");
	});

	it("reports a run with no registered process as unavailable rather than idle", () => {
		const state = applySnapshot(connected(), snapshot({ processes: [processSnapshot({ runId: "other-run" })] })).state;
		const view = projectRun(state, { nowMs: 2000, runId: "run-1", runStartedAtMs: null });
		assert.equal(view.measured, false);
		assert.equal(view.coverage, "unavailable");
	});

	it("leaves latency unavailable when no operation was timed", () => {
		const state = applySnapshot(connected(), snapshot()).state;
		const view = measured(state, 2000);
		assert.equal(view.totals.readLatency.meanNs, null);
		assert.equal(view.totals.readLatency.approxP95Ns, null);
	});
});

describe("coverage states", () => {
	it("is active only when live, complete and uninterrupted", () => {
		const state = applySnapshot(connected(), snapshot({ processes: [processSnapshot({ envelope: counters({ readBytes: 10, readOps: 1 }), observedFromMs: 1000 })] })).state;
		assert.equal(measured(state, 2100, 1000).coverage, "active");
	});

	it("is partial when observation began after the run did", () => {
		const state = applySnapshot(connected(), snapshot({ processes: [processSnapshot({ observedFromMs: 5000 })] })).state;
		const view = measured(state, 2100, 1000);
		assert.equal(view.coverage, "partial");
		assert.match(view.incompleteReasons.join(" "), /4000ms after the run/);
	});

	it("is partial when the kernel side dropped or could not classify anything", () => {
		const overflowed = applySnapshot(connected(), snapshot({ mapOverflows: 7 })).state;
		assert.match(measured(overflowed, 2100).incompleteReasons.join(" "), /7 measurements dropped/);
		const unclassified = applySnapshot(connected(), snapshot({ classifyIncomplete: 2, sequence: 1 })).state;
		assert.match(measured(unclassified, 2100).incompleteReasons.join(" "), /2 files could not be classified/);
	});

	it("marks a process several agents share and says so once", () => {
		const state = applySnapshot(connected(), snapshot({ processes: [processSnapshot({ attribution: "shared" })] })).state;
		const view = measured(state, 2100);
		assert.equal(view.attribution, "shared");
		assert.match(view.incompleteReasons.join(" "), /shared by several agents/);
	});

	it("goes stale once snapshots stop arriving", () => {
		const state = applySnapshot(connected(), snapshot({ emittedAtMs: 2000 })).state;
		assert.equal(measured(state, 2000 + OBSERVATION_STALE_AFTER_MS - 1).coverage, "active");
		assert.equal(measured(state, 2000 + OBSERVATION_STALE_AFTER_MS).coverage, "stale");
	});
});

describe("concurrent runs", () => {
	it("keeps two runs on two processes apart", () => {
		const state = applySnapshot(
			connected(),
			snapshot({
				processes: [
					processSnapshot({ envelope: counters({ readBytes: 100, readOps: 1 }), pid: 42, registrationId: "c1-42-77", runId: "run-1" }),
					processSnapshot({ envelope: counters({ readBytes: 900, readOps: 9 }), pid: 43, registrationId: "c1-43-78", runId: "run-2" }),
				],
			}),
		).state;
		assert.equal(measured(state, 2000).totals.readBytes, 100);
		const other = projectRun(state, { nowMs: 2000, runId: "run-2", runStartedAtMs: null });
		assert.equal(other.measured === true ? other.totals.readBytes : -1, 900);
	});
});
