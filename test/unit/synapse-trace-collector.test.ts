import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AT_FDCWD, createCollectorState, translateBpftraceLine, unpairedCalls, type CollectorOptions, type CollectorState, type CollectorStep } from "../../src/synapse/trace-collector.ts";
import { parseTraceLine } from "../../src/synapse/trace-log.ts";

/**
 * The collector's pure half, proven against the parser it must satisfy.
 *
 * The kernel half cannot run in CI, so the claim tested here is the one that
 * can be: whatever bpftrace prints, what the collector writes is either a line
 * `parseTraceLine` accepts with the same values, or a line it rejects — never a
 * record carrying a guessed path, and never a loss that goes unreported.
 */

const options = (overrides: Partial<CollectorOptions> = {}): CollectorOptions => ({
	nowBootNsecs: () => 5_000,
	resolveDirectory: () => "/srv/work",
	stringLimit: 200,
	...overrides,
});

const printf = (data: string): string => JSON.stringify({ data: `${data}\n`, type: "printf" });

/** A path-carrying call as the kernel half prints it: entry with the path, exit with the return value. */
function pathCall(syscall: string, dirfd: number, ret: number, rawPath: string, state: CollectorState, opts: CollectorOptions, seq = 1): string[] {
	const entry = linesOf(translateBpftraceLine(printf(`OPEN\t${syscall}\t41\t41\t9000\t1\t${dirfd}\t4100\t${seq}\t${rawPath}`), state, opts));
	assert.deepEqual(entry, [], "the entry half waits for its return value");
	return linesOf(translateBpftraceLine(printf(`RET\t4100\t${seq}\t${ret}`), state, opts));
}

function linesOf(step: CollectorStep): string[] {
	assert.equal(step.kind, "lines", JSON.stringify(step));
	return step.kind === "lines" ? step.lines : [];
}

describe("synapse-trace collector translation", () => {
	it("turns a read/write line into a record the parser accepts with the same values", () => {
		const [line] = linesOf(translateBpftraceLine(printf("IO\twrite\t41\t42\t9000\t123456\t7\t4096\t1024"), createCollectorState(), options()));
		const parsed = parseTraceLine(line!);
		assert.equal(parsed.kind, "record");
		assert.deepEqual(parsed.kind === "record" && parsed.record, { bytes: 4096, fd: 7, nsecs: 123456, pid: 41, ret: 1024, startTicks: 9000, syscall: "write", tid: 42 });
	});

	it("escapes a path bpftrace printed raw, so a quote or a tab cannot break the line", () => {
		const raw = '/srv/store/objects/ab/we"ird\tname';
		const [line] = pathCall("openat", AT_FDCWD, 5, raw, createCollectorState(), options());
		const parsed = parseTraceLine(line!);
		assert.equal(parsed.kind === "record" && parsed.record.syscall === "openat" && parsed.record.path, raw);
	});

	it("resolves a relative path against the directory the call named", () => {
		const seen: Array<[number, number]> = [];
		const [line] = pathCall("openat", AT_FDCWD, 5, "store/envelopes/x.json", createCollectorState(), options({ resolveDirectory: (pid, dirfd) => (seen.push([pid, dirfd]), "/srv/work") }));
		assert.deepEqual(seen, [[41, AT_FDCWD]]);
		const parsed = parseTraceLine(line!);
		assert.equal(parsed.kind === "record" && parsed.record.syscall === "openat" && parsed.record.path, "/srv/work/store/envelopes/x.json");
	});

	it("never guesses a path it cannot resolve: the record is written pathless and the parser rejects it", () => {
		const [line] = pathCall("openat", AT_FDCWD, 5, "relative/only", createCollectorState(), options({ resolveDirectory: () => null }));
		const parsed = parseTraceLine(line!);
		assert.equal(parsed.kind, "error");
	});

	it("refuses a path that fills bpftrace's string limit, since it may be a prefix of the real one", () => {
		const long = `/${"a".repeat(198)}`;
		const [line] = pathCall("renameat2", AT_FDCWD, 0, long, createCollectorState(), options());
		assert.equal(parseTraceLine(line!).kind, "error");
		const [short] = pathCall("renameat2", AT_FDCWD, 0, `/${"a".repeat(100)}`, createCollectorState(), options());
		assert.equal(parseTraceLine(short!).kind, "record");
	});

	it("reports every bpftrace loss notice as a cumulative loss line", () => {
		const state = createCollectorState();
		linesOf(translateBpftraceLine(printf("IO\tread\t41\t42\t9000\t8000\t7\t10\t10"), state, options()));
		const [first] = linesOf(translateBpftraceLine(JSON.stringify({ data: { events: 3 }, type: "lost_events" }), state, options()));
		const [second] = linesOf(translateBpftraceLine(JSON.stringify({ data: { events: 2 }, type: "lost_events" }), state, options()));
		const one = parseTraceLine(first!);
		const two = parseTraceLine(second!);
		assert.deepEqual(one.kind === "loss" && one.loss, { count: 3, kind: "lost", nsecs: 8000 });
		assert.equal(two.kind === "loss" && two.loss.count, 5);
	});

	it("counts a loss notice whose count cannot be read as a loss, not as none", () => {
		const [line] = linesOf(translateBpftraceLine(JSON.stringify({ data: {}, type: "lost_events" }), createCollectorState(), options()));
		const parsed = parseTraceLine(line!);
		assert.equal(parsed.kind === "loss" && parsed.loss.count, 1);
	});

	it("signals readiness only when bpftrace says the probes attached", () => {
		assert.deepEqual(translateBpftraceLine(JSON.stringify({ data: { probes: 10 }, type: "attached_probes" }), createCollectorState(), options()), { kind: "ready", probes: 10 });
	});

	it("surfaces an output shape it does not know instead of dropping it", () => {
		assert.equal(translateBpftraceLine("Attaching 10 probes...", createCollectorState(), options()).kind, "diagnostic");
		assert.equal(translateBpftraceLine(JSON.stringify({ data: "x", type: "time" }), createCollectorState(), options()).kind, "diagnostic");
		assert.equal(translateBpftraceLine(printf("IO\twrite\tnot-a-pid\t42\t9000\t1\t7\t1\t1"), createCollectorState(), options()).kind, "diagnostic");
	});

	it("pairs a return value that arrived before its entry, as per-CPU draining allows", () => {
		const state = createCollectorState();
		assert.deepEqual(linesOf(translateBpftraceLine(printf("RET\t4100\t7\t9"), state, options())), []);
		const [line] = linesOf(translateBpftraceLine(printf(`OPEN\topenat\t41\t42\t9000\t1\t${AT_FDCWD}\t4100\t7\t/srv/store/x`), state, options()));
		const parsed = parseTraceLine(line!);
		assert.equal(parsed.kind === "record" && parsed.record.ret, 9);
		assert.equal(unpairedCalls(state), 0);
	});

	it("keeps halves with different sequence numbers apart and counts the ones left unpaired", () => {
		const state = createCollectorState();
		linesOf(translateBpftraceLine(printf(`OPEN\topenat\t41\t42\t9000\t1\t${AT_FDCWD}\t4100\t1\t/srv/a`), state, options()));
		linesOf(translateBpftraceLine(printf(`OPEN\topenat\t41\t42\t9000\t2\t${AT_FDCWD}\t4100\t2\t/srv/b`), state, options()));
		const [second] = linesOf(translateBpftraceLine(printf("RET\t4100\t2\t11"), state, options()));
		const parsed = parseTraceLine(second!);
		assert.equal(parsed.kind === "record" && parsed.record.syscall === "openat" && parsed.record.path, "/srv/b");
		assert.equal(unpairedCalls(state), 1);
	});

	it("turns the collector's own marker into one observing line, however many times it fires", () => {
		const state = createCollectorState();
		const [line] = linesOf(translateBpftraceLine(printf("OBSERVING\t777"), state, options()));
		const parsed = parseTraceLine(line!);
		assert.deepEqual(parsed, { kind: "observing", nsecs: 777 });
		assert.deepEqual(linesOf(translateBpftraceLine(printf("OBSERVING\t900"), state, options())), []);
		assert.equal(state.observingSince, 777);
	});
});
