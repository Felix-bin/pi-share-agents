import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	classifyTraceIo,
	classifyTracePath,
	SYNAPSE_IO_CATEGORIES,
	type SynapseIoCategory,
	type TraceIoBucket,
	type TraceProcessIo,
} from "../../src/synapse/trace-classify.ts";
import type { TraceDescriptorRecord, TracePathRecord, TraceRecord } from "../../src/synapse/trace-log.ts";

const ROOT = "/var/synapse";

/** A read/write line: the syscall was handed a descriptor and no path. */
function rw(overrides: Partial<TraceDescriptorRecord> = {}): TraceDescriptorRecord {
	return { bytes: 100, fd: 7, nsecs: 1_000, pid: 42, ret: 100, startTicks: 900, syscall: "write", tid: 42, ...overrides };
}

/** An openat line. `fd` is the directory descriptor (AT_FDCWD); `ret` is the descriptor the call allocated. */
function open(path: string, overrides: Partial<TracePathRecord> = {}): TracePathRecord {
	return { bytes: 0, fd: -100, nsecs: 1_000, path, pid: 42, ret: 7, startTicks: 900, syscall: "openat", tid: 42, ...overrides };
}

function rename(path: string, overrides: Partial<TracePathRecord> = {}): TracePathRecord {
	return { bytes: 0, fd: -100, nsecs: 1_000, path, pid: 42, ret: 0, startTicks: 900, syscall: "renameat2", tid: 42, ...overrides };
}

function onlyProcess(records: readonly TraceRecord[]): TraceProcessIo {
	const { processes } = classifyTraceIo(records, ROOT);
	assert.equal(processes.length, 1, "expected exactly one observed process");
	const [first] = processes;
	assert.ok(first !== undefined);
	return first;
}

function categoryOf(path: string): SynapseIoCategory | "excluded" | "unclassified" | "outside-root" {
	const classification = classifyTracePath(ROOT, path);
	return classification.kind === "category" ? classification.category : classification.kind;
}

const EMPTY: TraceIoBucket = { failedPathCalls: 0, failedReads: 0, failedWrites: 0, readBytes: 0, writeBytes: 0 };

function bucket(overrides: Partial<TraceIoBucket> = {}): TraceIoBucket {
	return { ...EMPTY, ...overrides };
}

describe("synapse trace path classification: storage-root layout", () => {
	it("maps each layout entry to the category that owns it", () => {
		assert.equal(categoryOf(`${ROOT}/envelopes/m1.json`), "envelope");
		assert.equal(categoryOf(`${ROOT}/objects/ab/abcdef.bin`), "content");
		assert.equal(categoryOf(`${ROOT}/memory/mem-1.json`), "memory-index");
		assert.equal(categoryOf(`${ROOT}/supersessions/ev-1.json`), "memory-index");
		assert.equal(categoryOf(`${ROOT}/namespace.json`), "memory-index");
	});

	it("excludes the measurement's own storage so observation does not observe itself", () => {
		assert.equal(categoryOf(`${ROOT}/metering/run-1.ndjson`), "excluded");
		assert.equal(categoryOf(`${ROOT}/trace/run-1.ndjson`), "excluded");
	});

	it("reports an unknown entry under the root as unclassified rather than guessing a category", () => {
		assert.equal(categoryOf(`${ROOT}/whatever/x.json`), "unclassified");
		assert.equal(categoryOf(`${ROOT}/config.json`), "unclassified");
		// The root directory itself is inside the root but names no layout entry.
		assert.equal(categoryOf(ROOT), "unclassified");
	});

	it("keeps paths outside the storage root distinct from unclassified ones", () => {
		assert.equal(categoryOf("/etc/passwd"), "outside-root");
		assert.equal(categoryOf("/home/user/envelopes/m1.json"), "outside-root");
		// A sibling directory whose name merely starts with the root's: not a textual prefix test.
		assert.equal(categoryOf("/var/synapse-backup/envelopes/m1.json"), "outside-root");
		// A relative path cannot be placed against an absolute root, and is reported unplaced.
		assert.equal(categoryOf("envelopes/m1.json"), "outside-root");
	});

	it("resolves `..` so a path cannot climb out of the root and back into an excluded directory", () => {
		assert.equal(categoryOf(`${ROOT}/envelopes/../metering/run-1.ndjson`), "excluded");
		assert.equal(categoryOf(`${ROOT}/../elsewhere/envelopes/m1.json`), "outside-root");
		assert.equal(categoryOf(`${ROOT}/./envelopes//m1.json`), "envelope");
	});

	it("classifies the same way whatever the host platform's path separator is", () => {
		// Kernel paths are POSIX. A Windows-shaped path is not a SYNAPSE path.
		assert.equal(categoryOf("C:\\var\\synapse\\envelopes\\m1.json"), "outside-root");
		assert.equal(classifyTracePath("/var/synapse/", `${ROOT}/envelopes/m1.json`).kind, "category");
	});
});

describe("synapse trace classification: temporary files classify by prefix, without following renames", () => {
	it("counts a write to writeAtomicJson's temporary name in the target's category", () => {
		// `.${basename}.${pid}.${nowMs}.${randomId}.tmp`, created in the target's own
		// directory (`src/shared/atomic-json.ts:35-37, 59-61`).
		const temp = `${ROOT}/envelopes/.m1.json.4242.1758240000000.a1b2c3.tmp`;
		const io = onlyProcess([open(temp), rw({ ret: 512 }), rename(`${ROOT}/envelopes/m1.json`)]);
		assert.deepEqual(io.categories.envelope, bucket({ writeBytes: 512 }));
		assert.deepEqual(io.unclassified, EMPTY);
	});

	it("counts a write to content-store's temporary name in the content category", () => {
		// `.${contentId}.${pid}.${Date.now()}.tmp` inside the shard dir (`content-store.ts:180`).
		const temp = `${ROOT}/objects/ab/.abcdef0123.4242.1758240000000.tmp`;
		const io = onlyProcess([open(temp), rw({ ret: 4096 })]);
		assert.deepEqual(io.categories.content, bucket({ writeBytes: 4096 }));
	});

	it("does not need the rename to land the bytes: the same totals with and without it", () => {
		const temp = `${ROOT}/objects/ab/.abcdef0123.4242.1758240000000.tmp`;
		const withoutRename = onlyProcess([open(temp), rw({ ret: 4096 })]);
		const withRename = onlyProcess([open(temp), rw({ ret: 4096 }), rename(`${ROOT}/objects/ab/abcdef0123`)]);
		assert.deepEqual(withRename.categories, withoutRename.categories);
	});

	it("puts a temporary file written outside the storage layout in unclassified, visibly, rather than in a category", () => {
		const io = onlyProcess([open("/tmp/.m1.json.4242.1758240000000.a1b2c3.tmp"), rw({ ret: 512 })]);
		for (const category of SYNAPSE_IO_CATEGORIES) assert.deepEqual(io.categories[category], EMPTY);
		assert.deepEqual(classifyTraceIo([open("/tmp/x.tmp"), rw({ ret: 512 })], ROOT).ignored.outsideRoot, bucket({ writeBytes: 512 }));
	});
});

describe("synapse trace classification: the descriptor table", () => {
	it("gives a reused fd number to the file the latest openat put there", () => {
		const records: TraceRecord[] = [
			open(`${ROOT}/envelopes/m1.json`, { ret: 7 }),
			rw({ fd: 7, ret: 100 }),
			rw({ fd: 7, ret: 200 }),
			// No `close` exists on the wire; the kernel could only hand fd 7 back out
			// because it was closed, so this openat is the reuse point.
			open(`${ROOT}/objects/ab/abc.bin`, { ret: 7 }),
			rw({ fd: 7, ret: 3000 }),
			rw({ fd: 7, ret: 4000 }),
		];
		const io = onlyProcess(records);
		assert.deepEqual(io.categories.envelope, bucket({ writeBytes: 300 }));
		assert.deepEqual(io.categories.content, bucket({ writeBytes: 7000 }));
		assert.deepEqual(io.unknownDescriptor, EMPTY);
	});

	it("keys the table by (pid, fd), so two processes on the same fd number do not collide", () => {
		const records: TraceRecord[] = [
			open(`${ROOT}/envelopes/m1.json`, { pid: 100, ret: 7, tid: 100 }),
			open(`${ROOT}/objects/ab/abc.bin`, { pid: 200, ret: 7, tid: 200 }),
			rw({ fd: 7, pid: 100, ret: 111, tid: 100 }),
			rw({ fd: 7, pid: 200, ret: 222, tid: 200 }),
		];
		const { processes } = classifyTraceIo(records, ROOT);
		assert.deepEqual(
			processes.map((entry) => entry.pid),
			[100, 200],
		);
		const [first, second] = processes;
		assert.deepEqual(first?.categories.envelope, bucket({ writeBytes: 111 }));
		assert.deepEqual(first?.categories.content, EMPTY);
		assert.deepEqual(second?.categories.content, bucket({ writeBytes: 222 }));
		assert.deepEqual(second?.categories.envelope, EMPTY);
	});

	it("does not let a reused pid inherit the dead process's descriptor table", () => {
		const records: TraceRecord[] = [
			open(`${ROOT}/envelopes/m1.json`, { ret: 7, startTicks: 900 }),
			rw({ fd: 7, ret: 100, startTicks: 900 }),
			// Same pid, a later start time: a different process, with an empty fd table.
			rw({ fd: 7, ret: 500, startTicks: 5000 }),
		];
		const { processes } = classifyTraceIo(records, ROOT);
		assert.deepEqual(
			processes.map((entry) => entry.startTicks),
			[900, 5000],
		);
		const [older, newer] = processes;
		assert.deepEqual(older?.categories.envelope, bucket({ writeBytes: 100 }));
		assert.deepEqual(newer?.categories.envelope, EMPTY);
		assert.deepEqual(newer?.unknownDescriptor, bucket({ writeBytes: 500 }));
	});

	it("maps the descriptor openat allocated (ret), not the directory descriptor it was relative to (fd)", () => {
		// AT_FDCWD is -100; a table keyed on `fd` would key every open to that constant.
		const io = onlyProcess([open(`${ROOT}/envelopes/m1.json`, { fd: -100, ret: 9 }), rw({ fd: 9, ret: 64 })]);
		assert.deepEqual(io.categories.envelope, bucket({ writeBytes: 64 }));
	});

	it("never turns a renameat2 status into a descriptor", () => {
		// `ret` is 0 here, which is also a perfectly good fd number.
		const io = onlyProcess([rename(`${ROOT}/envelopes/m1.json`, { ret: 0 }), rw({ fd: 0, ret: 80 })]);
		assert.deepEqual(io.categories.envelope, EMPTY);
		assert.deepEqual(io.unknownDescriptor, bucket({ writeBytes: 80 }));
	});

	it("does not create, or overwrite, a mapping from a failed openat", () => {
		const records: TraceRecord[] = [
			open(`${ROOT}/envelopes/m1.json`, { ret: 7 }),
			// -ENOENT: no descriptor was allocated, so fd 7 still names the envelope.
			open(`${ROOT}/objects/ab/abc.bin`, { ret: -2 }),
			rw({ fd: 7, ret: 100 }),
		];
		const io = onlyProcess(records);
		assert.deepEqual(io.categories.envelope, bucket({ writeBytes: 100 }));
		assert.deepEqual(io.categories.content, bucket({ failedPathCalls: 1 }));
	});
});

describe("synapse trace classification: descriptors with no observable origin", () => {
	it("counts a write on an fd the contract cannot explain in an explicit bucket, not as zero and not dropped", () => {
		// `dup`/`dup2` and fork-inherited fds are not on the wire (there is no `dup`
		// record and no `close`), so the only honest answer is "this process moved
		// these bytes, to a file we cannot name".
		const io = onlyProcess([rw({ fd: 3, ret: 1024 }), rw({ fd: 3, ret: 2048, syscall: "read" })]);
		assert.deepEqual(io.unknownDescriptor, bucket({ readBytes: 2048, writeBytes: 1024 }));
		for (const category of SYNAPSE_IO_CATEGORIES) assert.deepEqual(io.categories[category], EMPTY);
		assert.deepEqual(io.unclassified, EMPTY);
		assert.deepEqual(classifyTraceIo([rw({ fd: 3, ret: 1024 })], ROOT).ignored, { excluded: EMPTY, outsideRoot: EMPTY });
	});

	it("does not resolve a dup'd descriptor by guessing from the original's category", () => {
		// fd 7 is opened; fd 8 is a dup of it, invisible on the wire. The bytes on
		// fd 8 must not be quietly credited to the envelope category.
		const io = onlyProcess([open(`${ROOT}/envelopes/m1.json`, { ret: 7 }), rw({ fd: 7, ret: 10 }), rw({ fd: 8, ret: 90 })]);
		assert.deepEqual(io.categories.envelope, bucket({ writeBytes: 10 }));
		assert.deepEqual(io.unknownDescriptor, bucket({ writeBytes: 90 }));
	});

	it("keeps a failed call on an unknown descriptor as a failure, not as silence", () => {
		const io = onlyProcess([rw({ fd: 3, ret: -9 }), rw({ fd: 3, ret: -9, syscall: "read" })]);
		assert.deepEqual(io.unknownDescriptor, bucket({ failedReads: 1, failedWrites: 1 }));
	});
});

describe("synapse trace classification: byte accounting", () => {
	it("keeps read bytes and write bytes apart within a category", () => {
		const records: TraceRecord[] = [
			open(`${ROOT}/objects/ab/abc.bin`, { ret: 7 }),
			rw({ fd: 7, ret: 4096, syscall: "write" }),
			rw({ bytes: 8192, fd: 7, ret: 8192, syscall: "read" }),
		];
		assert.deepEqual(onlyProcess(records).categories.content, bucket({ readBytes: 8192, writeBytes: 4096 }));
	});

	it("counts a short write by what moved, not by what was asked for", () => {
		const io = onlyProcess([open(`${ROOT}/envelopes/m1.json`, { ret: 7 }), rw({ bytes: 4096, fd: 7, ret: 512 })]);
		assert.deepEqual(io.categories.envelope, bucket({ writeBytes: 512 }));
	});

	it("gives openat and renameat2 no bytes even when they succeed", () => {
		const io = onlyProcess([open(`${ROOT}/envelopes/m1.json`, { ret: 9 }), rename(`${ROOT}/envelopes/m1.json`, { ret: 0 })]);
		assert.deepEqual(io.categories.envelope, EMPTY);
	});

	it("carries failure counts through per category, separately from bytes", () => {
		const records: TraceRecord[] = [
			open(`${ROOT}/envelopes/m1.json`, { ret: 7 }),
			rw({ fd: 7, ret: 100 }),
			rw({ bytes: 4096, fd: 7, ret: -28 }),
			rw({ bytes: 4096, fd: 7, ret: -5, syscall: "read" }),
			rename(`${ROOT}/envelopes/m1.json`, { ret: -13 }),
		];
		assert.deepEqual(onlyProcess(records).categories.envelope, bucket({ failedPathCalls: 1, failedReads: 1, failedWrites: 1, writeBytes: 100 }));
	});

	it("reports a category that was observed and saw nothing as a real zero, on every category", () => {
		const io = onlyProcess([open(`${ROOT}/envelopes/m1.json`, { ret: 7 }), rw({ fd: 7, ret: 100 })]);
		assert.deepEqual(Object.keys(io.categories).toSorted(), [...SYNAPSE_IO_CATEGORIES].toSorted());
		assert.deepEqual(io.categories.content, EMPTY);
		assert.deepEqual(io.categories["memory-index"], EMPTY);
	});

	it("returns no processes at all for no records, rather than a shape full of zeroes", () => {
		assert.deepEqual(classifyTraceIo([], ROOT), { ignored: { excluded: EMPTY, outsideRoot: EMPTY }, processes: [] });
	});
});

describe("synapse trace classification: what never reaches a category", () => {
	it("keeps the measurement's own I/O out of every category and in the excluded tally", () => {
		const records: TraceRecord[] = [
			open(`${ROOT}/metering/run-1.ndjson`, { ret: 7 }),
			rw({ fd: 7, ret: 300 }),
			open(`${ROOT}/trace/run-1.ndjson`, { ret: 8 }),
			rw({ bytes: 900, fd: 8, ret: 900, syscall: "read" }),
		];
		const result = classifyTraceIo(records, ROOT);
		assert.deepEqual(result.ignored.excluded, bucket({ readBytes: 900, writeBytes: 300 }));
		const [io] = result.processes;
		for (const category of SYNAPSE_IO_CATEGORIES) assert.deepEqual(io?.categories[category], EMPTY);
		assert.deepEqual(io?.unclassified, EMPTY);
		assert.deepEqual(io?.unknownDescriptor, EMPTY);
	});

	it("holds unclassified bytes per process, apart from every category and from the ignored tallies", () => {
		const io = onlyProcess([open(`${ROOT}/surprise/new.json`, { ret: 7 }), rw({ fd: 7, ret: 640 })]);
		assert.deepEqual(io.unclassified, bucket({ writeBytes: 640 }));
		for (const category of SYNAPSE_IO_CATEGORIES) assert.deepEqual(io.categories[category], EMPTY);
	});

	it("keeps unrelated I/O outside the root out of the per-process totals entirely", () => {
		const records: TraceRecord[] = [
			open("/usr/lib/locale/locale-archive", { ret: 7 }),
			rw({ bytes: 65536, fd: 7, ret: 65536, syscall: "read" }),
			open(`${ROOT}/envelopes/m1.json`, { ret: 8 }),
			rw({ fd: 8, ret: 120 }),
		];
		const result = classifyTraceIo(records, ROOT);
		assert.deepEqual(result.ignored.outsideRoot, bucket({ readBytes: 65536 }));
		const [io] = result.processes;
		assert.deepEqual(io?.categories.envelope, bucket({ writeBytes: 120 }));
		assert.deepEqual(io?.unclassified, EMPTY);
		assert.deepEqual(io?.unknownDescriptor, EMPTY);
	});

	it("tells unclassified, unknown-descriptor and outside-root apart in one run", () => {
		const records: TraceRecord[] = [
			open(`${ROOT}/envelopes/m1.json`, { ret: 7 }),
			rw({ fd: 7, ret: 10 }),
			open(`${ROOT}/surprise/new.json`, { ret: 8 }),
			rw({ fd: 8, ret: 20 }),
			open("/etc/hosts", { ret: 9 }),
			rw({ fd: 9, ret: 30 }),
			open(`${ROOT}/metering/run-1.ndjson`, { ret: 10 }),
			rw({ fd: 10, ret: 40 }),
			rw({ fd: 11, ret: 50 }),
		];
		const result = classifyTraceIo(records, ROOT);
		const [io] = result.processes;
		assert.deepEqual(io?.categories.envelope, bucket({ writeBytes: 10 }));
		assert.deepEqual(io?.unclassified, bucket({ writeBytes: 20 }));
		assert.deepEqual(result.ignored.outsideRoot, bucket({ writeBytes: 30 }));
		assert.deepEqual(result.ignored.excluded, bucket({ writeBytes: 40 }));
		assert.deepEqual(io?.unknownDescriptor, bucket({ writeBytes: 50 }));
	});
});
