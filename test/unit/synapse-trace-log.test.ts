import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	contributedBytes,
	parseTraceLine,
	parseTraceLog,
	SYNAPSE_TRACE_MAX_LINE_BYTES,
	SYNAPSE_TRACE_SYSCALLS,
	traceCallFailed,
	type TraceDescriptorRecord,
	type TraceLineErrorReason,
	type TracePathRecord,
	type TraceRecord,
} from "../../src/synapse/trace-log.ts";

/** A read/write line: the syscall was handed a descriptor and no path. */
function descriptorRecord(overrides: Partial<TraceDescriptorRecord> = {}): TraceDescriptorRecord {
	return { bytes: 4096, fd: 5, nsecs: 1_000_000, pid: 100, ret: 4096, startTicks: 5000, syscall: "write", tid: 100, ...overrides };
}

/** An openat/renameat2 line: the syscall names a path. */
function pathRecord(overrides: Partial<TracePathRecord> = {}): TracePathRecord {
	return { bytes: 0, fd: -100, nsecs: 1_000_000, path: "/var/synapse/objects/ab/abc.json", pid: 100, ret: 9, startTicks: 5000, syscall: "openat", tid: 100, ...overrides };
}

function lineOf(record: TraceRecord): string {
	return JSON.stringify(record);
}

function reasonOf(line: string): TraceLineErrorReason | "not-an-error" {
	const result = parseTraceLine(line);
	return result.kind === "error" ? result.reason : "not-an-error";
}

describe("synapse-trace wire contract: fixed samples", () => {
	it("parses a fixed write record sample field for field", () => {
		const line = '{"bytes":128,"fd":7,"nsecs":123456789,"pid":42,"ret":128,"startTicks":900,"syscall":"write","tid":42}';
		const result = parseTraceLine(line);
		assert.equal(result.kind, "record");
		assert.deepEqual(result.kind === "record" ? result.record : null, { bytes: 128, fd: 7, nsecs: 123456789, pid: 42, ret: 128, startTicks: 900, syscall: "write", tid: 42 });
	});

	it("parses a fixed openat record sample carrying its path", () => {
		const line = '{"bytes":0,"fd":-100,"nsecs":42,"path":"/var/synapse/envelopes/m1.json","pid":42,"ret":9,"startTicks":900,"syscall":"openat","tid":42}';
		const result = parseTraceLine(line);
		assert.equal(result.kind, "record");
		assert.deepEqual(result.kind === "record" ? result.record : null, { bytes: 0, fd: -100, nsecs: 42, path: "/var/synapse/envelopes/m1.json", pid: 42, ret: 9, startTicks: 900, syscall: "openat", tid: 42 });
	});

	it("accepts the negative AT_FDCWD directory descriptor openat is normally called with", () => {
		assert.equal(parseTraceLine(lineOf(pathRecord({ fd: -100 }))).kind, "record");
	});

	it("keeps startTicks, which is what makes pid reuse decidable", () => {
		const first = parseTraceLine(lineOf(descriptorRecord({ pid: 7, startTicks: 111 })));
		const second = parseTraceLine(lineOf(descriptorRecord({ pid: 7, startTicks: 222 })));
		assert.equal(first.kind === "record" ? first.record.startTicks : null, 111);
		assert.equal(second.kind === "record" ? second.record.startTicks : null, 222);
	});

	it("accepts exactly the syscalls SYNAPSE_TRACE_SYSCALLS names, and no others", () => {
		assert.deepEqual([...SYNAPSE_TRACE_SYSCALLS], ["read", "write", "openat", "renameat2"]);
		for (const syscall of SYNAPSE_TRACE_SYSCALLS) {
			const line = syscall === "read" || syscall === "write" ? lineOf(descriptorRecord({ ret: 1, syscall })) : lineOf(pathRecord({ syscall }));
			assert.equal(parseTraceLine(line).kind, "record", `expected ${syscall} to parse as a record`);
		}
		for (const syscall of ["unlinkat", "writev", "Write", ""]) {
			assert.equal(reasonOf(JSON.stringify({ ...descriptorRecord(), syscall })), "malformed", `expected ${syscall} to be rejected`);
		}
	});

	it("parses a multi-line ndjson sample end to end", () => {
		const raw = [lineOf(pathRecord({ pid: 1 })), lineOf(descriptorRecord({ pid: 1, ret: 60 })), lineOf(descriptorRecord({ pid: 2, ret: -1, syscall: "read" }))].join("\n");
		const log = parseTraceLog(raw);
		assert.equal(log.records.length, 3);
		assert.equal(log.errors.length, 0);
		assert.equal(log.losses.length, 0);
	});

	it("skips blank lines without treating them as errors", () => {
		const log = parseTraceLog([lineOf(descriptorRecord()), "", "   ", lineOf(descriptorRecord()), ""].join("\n"));
		assert.equal(log.records.length, 2);
		assert.equal(log.errors.length, 0);
	});
});

describe("synapse-trace wire contract: path is carried only by calls that have one", () => {
	it("requires the path openat names rather than defaulting it away", () => {
		const { path: _omitted, ...pathless } = pathRecord();
		const result = parseTraceLine(JSON.stringify(pathless));
		assert.equal(result.kind, "error");
		assert.equal(result.kind === "error" ? result.reason : undefined, "malformed");
		assert.match(result.kind === "error" ? result.detail : "", /path/);
	});

	it("requires the path renameat2 names", () => {
		const { path: _omitted, ...pathless } = pathRecord({ syscall: "renameat2" });
		assert.equal(reasonOf(JSON.stringify(pathless)), "malformed");
	});

	it("rejects an empty path rather than accepting it as a resolved one", () => {
		assert.equal(reasonOf(lineOf(pathRecord({ path: "" }))), "malformed");
	});

	it("rejects a write that claims a path the syscall never carried", () => {
		assert.equal(reasonOf(JSON.stringify({ ...descriptorRecord(), path: "/var/synapse/objects/ab/abc.json" })), "malformed");
	});

	it("rejects a read that claims a path", () => {
		assert.equal(reasonOf(JSON.stringify({ ...descriptorRecord({ ret: 8, syscall: "read" }), path: "/tmp/x" })), "malformed");
	});

	it("exposes path only after narrowing on the syscall that carries it", () => {
		const result = parseTraceLine(lineOf(pathRecord({ path: "/var/synapse/objects/cd/x.tmp", syscall: "renameat2" })));
		assert.equal(result.kind, "record");
		const record = result.kind === "record" ? result.record : null;
		assert.equal(record !== null && (record.syscall === "openat" || record.syscall === "renameat2") ? record.path : null, "/var/synapse/objects/cd/x.tmp");
	});
});

describe("synapse-trace wire contract: loss report recognition", () => {
	it("recognises a loss report as its own fact, not as a record and not as an error", () => {
		const result = parseTraceLine('{"count":37,"kind":"lost","nsecs":555}');
		assert.equal(result.kind, "loss");
		assert.deepEqual(result.kind === "loss" ? result.loss : null, { count: 37, kind: "lost", nsecs: 555 });
	});

	it("never reports a record as a loss, whatever its field values look like", () => {
		// `nsecs` is the one field both shapes share; a record whose numbers
		// resemble a loss report's is still unambiguously a record.
		const result = parseTraceLine(lineOf(descriptorRecord({ bytes: 37, nsecs: 555, ret: 37 })));
		assert.equal(result.kind, "record");
	});

	it("rejects a record that also claims to be a loss report instead of counting it as either", () => {
		// The discriminator cannot be spoofed in either direction: neither record
		// schema declares `kind`, and both reject unknown properties.
		const spoof = JSON.stringify({ ...descriptorRecord(), count: 3, kind: "lost" });
		const result = parseTraceLine(spoof);
		assert.equal(result.kind, "error");
		assert.equal(result.kind === "error" ? result.reason : undefined, "malformed");
	});

	it("rejects a loss report that smuggles record fields alongside its own", () => {
		assert.equal(reasonOf(JSON.stringify({ count: 3, kind: "lost", nsecs: 1, pid: 100, syscall: "write" })), "malformed");
	});

	it("does not infer a loss report from resemblance: a count without the kind marker is not one", () => {
		const result = parseTraceLine('{"count":9,"nsecs":1}');
		assert.equal(result.kind, "error");
		assert.equal(result.kind === "error" ? result.reason : undefined, "malformed");
	});

	it("does not accept a different kind marker as loss", () => {
		assert.equal(reasonOf('{"count":9,"kind":"dropped","nsecs":1}'), "malformed");
	});

	it("rejects a loss report with a non-positive count rather than recording zero loss as a loss", () => {
		assert.equal(reasonOf('{"count":0,"kind":"lost","nsecs":1}'), "malformed");
		assert.equal(reasonOf('{"count":-1,"kind":"lost","nsecs":1}'), "malformed");
	});

	it("rejects a loss report with a missing or mistyped count rather than assuming some loss happened", () => {
		assert.equal(reasonOf('{"kind":"lost","nsecs":1}'), "malformed");
		assert.equal(reasonOf('{"count":"many","kind":"lost","nsecs":1}'), "malformed");
	});

	it("names the loss report in its rejection detail, so a malformed one is not mistaken for a bad record", () => {
		const result = parseTraceLine('{"count":0,"kind":"lost","nsecs":1}');
		assert.match(result.kind === "error" ? result.detail : "", /loss report/);
	});

	it("carries loss reports through a full log parse in their own bucket, never merged", () => {
		const raw = [lineOf(descriptorRecord()), '{"count":12,"kind":"lost","nsecs":999}', lineOf(descriptorRecord()), '{"count":30,"kind":"lost","nsecs":1999}'].join("\n");
		const log = parseTraceLog(raw);
		assert.equal(log.records.length, 2);
		assert.equal(log.errors.length, 0);
		assert.deepEqual(
			log.losses.map((loss) => loss.count),
			[12, 30],
		);
	});
});

describe("synapse-trace wire contract: rejection, not partial parsing", () => {
	it("rejects a line missing a required field rather than defaulting it", () => {
		const { ret: _omitted, ...missing } = descriptorRecord();
		const result = parseTraceLine(JSON.stringify(missing));
		assert.equal(result.kind, "error");
		assert.equal(result.kind === "error" ? result.reason : undefined, "malformed");
		assert.match(result.kind === "error" ? result.detail : "", /ret/);
	});

	it("rejects every single-field omission, one field at a time", () => {
		for (const field of ["bytes", "fd", "nsecs", "pid", "ret", "startTicks", "syscall", "tid"]) {
			const withoutField = Object.fromEntries(Object.entries(descriptorRecord()).filter(([key]) => key !== field));
			assert.equal(reasonOf(JSON.stringify(withoutField)), "malformed", `expected a line without ${field} to be rejected`);
		}
	});

	it("rejects a field with the wrong type rather than coercing it", () => {
		assert.equal(reasonOf(JSON.stringify({ ...descriptorRecord(), pid: "42" })), "malformed");
		assert.equal(reasonOf(JSON.stringify({ ...descriptorRecord(), ret: "128" })), "malformed");
		assert.equal(reasonOf(JSON.stringify({ ...descriptorRecord(), bytes: null })), "malformed");
		assert.equal(reasonOf(JSON.stringify({ ...pathRecord(), path: 7 })), "malformed");
	});

	it("rejects a non-integer number rather than rounding it", () => {
		assert.equal(reasonOf(JSON.stringify({ ...descriptorRecord(), ret: 12.5 })), "malformed");
		assert.equal(reasonOf(JSON.stringify({ ...descriptorRecord(), nsecs: 1.5 })), "malformed");
	});

	it("rejects a negative pid, tid, nsecs or startTicks", () => {
		for (const field of ["pid", "tid", "nsecs", "startTicks"]) {
			assert.equal(reasonOf(JSON.stringify({ ...descriptorRecord(), [field]: -1 })), "malformed", `expected a negative ${field} to be rejected`);
		}
	});

	it("rejects an unknown extra field rather than ignoring it", () => {
		assert.equal(reasonOf(JSON.stringify({ ...descriptorRecord(), comm: "node" })), "malformed");
	});

	it("rejects a JSON value that is not an object at all", () => {
		for (const line of ["null", "5", '"write"', "[]", "[{}]", "true"]) {
			assert.equal(reasonOf(line), "malformed", `expected ${line} to be rejected`);
		}
	});

	it("rejects a read or write claiming it moved more than it was asked to", () => {
		const result = parseTraceLine(lineOf(descriptorRecord({ bytes: 4096, ret: 8192 })));
		assert.equal(result.kind, "error");
		assert.equal(result.kind === "error" ? result.reason : undefined, "malformed");
		assert.equal(parseTraceLine(lineOf(descriptorRecord({ bytes: 4096, ret: 4096 }))).kind, "record");
	});
});

describe("synapse-trace wire contract: truncated is decided, not guessed", () => {
	it("calls a line cut off mid-record truncated, at every cut point", () => {
		const whole = lineOf(pathRecord());
		for (let cut = 1; cut < whole.length; cut += 1) {
			assert.equal(reasonOf(whole.slice(0, cut)), "truncated", `expected a ${cut}-character prefix to read as truncated`);
		}
		assert.equal(parseTraceLine(whole).kind, "record");
	});

	it("calls every prefix of an escaped or non-ASCII record truncated, at every cut point", () => {
		const documents = [
			lineOf(pathRecord({ path: '/var/synapse/objects/"quoted"\\odd\tname' })),
			lineOf(pathRecord({ path: "/var/synapse/objects/中文/π.json", syscall: "renameat2" })),
			lineOf(descriptorRecord({ bytes: 0, ret: 0 })),
			'{"count":12,"kind":"lost","nsecs":999}',
		];
		for (const document of documents) {
			// Every proper prefix of a JSON object is incomplete: it opened a brace
			// it has not closed, so none of them can be a whole document.
			for (let cut = 1; cut < document.length; cut += 1) {
				assert.equal(reasonOf(document.slice(0, cut)), "truncated", `expected ${JSON.stringify(document.slice(0, cut))} to read as truncated`);
			}
			assert.notEqual(parseTraceLine(document).kind, "error");
		}
	});

	it("calls a line cut inside a path string truncated, not malformed", () => {
		assert.equal(reasonOf('{"bytes":0,"fd":-100,"nsecs":42,"path":"/var/synapse/env'), "truncated");
	});

	it("calls a line cut before a literal or number finished truncated", () => {
		for (const line of ['{"pid":', '{"pid":n', '{"pid":-', '{"pid":1.', '{"pid":1e+', '{"ok":tru', "[1,2"]) {
			assert.equal(reasonOf(line), "truncated", `expected ${line} to read as truncated`);
		}
	});

	it("calls text that no continuation could rescue malformed, not truncated", () => {
		// Each of these is broken where it stands: appending characters can never
		// make it a valid record, so blaming a cut-off writer would be a guess.
		for (const line of ["{ not json", '{"pid" 1}', "}{", '{"pid":nope}', '{"pid":01}', '{"pid":1}trailing', '{"pid":1,,"tid":2', '{"path":"\\q', "{'pid':1}"]) {
			assert.equal(reasonOf(line), "malformed", `expected ${line} to read as malformed`);
		}
	});

	it("keeps a trailing truncated line distinct while the whole lines before it still parse", () => {
		// The shape of a collector killed mid-write: design §6.
		const raw = [lineOf(descriptorRecord()), lineOf(descriptorRecord()), lineOf(descriptorRecord()).slice(0, 30)].join("\n");
		const log = parseTraceLog(raw);
		assert.equal(log.records.length, 2);
		assert.deepEqual(
			log.errors.map((error) => ({ line: error.line, reason: error.reason })),
			[{ line: 3, reason: "truncated" }],
		);
	});
});

describe("synapse-trace wire contract: line length is measured in bytes", () => {
	it("rejects an over-long line before it is parsed as JSON", () => {
		const line = lineOf(pathRecord({ path: `/var/synapse/${"a".repeat(SYNAPSE_TRACE_MAX_LINE_BYTES)}` }));
		assert.equal(reasonOf(line), "too-long");
	});

	it("accepts a line exactly at the configured limit and rejects one byte over it", () => {
		const base = lineOf(descriptorRecord());
		const limit = Buffer.byteLength(base, "utf-8");
		assert.equal(parseTraceLine(base, { maxLineBytes: limit }).kind, "record");
		const overByOne = parseTraceLine(`${base} `, { maxLineBytes: limit });
		assert.equal(overByOne.kind === "error" ? overByOne.reason : undefined, "too-long");
		// The same line under the default limit is a perfectly good record.
		assert.equal(reasonOf(`${base} `), "not-an-error");
	});

	it("counts UTF-8 bytes, not UTF-16 code units, so a multi-byte path cannot slip past the limit", () => {
		const line = lineOf(pathRecord({ path: `/var/synapse/${"文".repeat(200)}` }));
		const limit = 400;
		// The line is short in code units and long in bytes; the limit must see the bytes.
		assert.ok(line.length < limit, "expected the sample to be under the limit in UTF-16 code units");
		assert.ok(Buffer.byteLength(line, "utf-8") > limit, "expected the sample to be over the limit in UTF-8 bytes");
		const result = parseTraceLine(line, { maxLineBytes: limit });
		assert.equal(result.kind === "error" ? result.reason : undefined, "too-long");
	});

	it("accepts a multi-byte path that fits the byte limit", () => {
		const line = lineOf(pathRecord({ path: "/var/synapse/objects/中文路径.json" }));
		assert.equal(parseTraceLine(line).kind, "record");
	});

	it("uses a default limit with room for a maximum-length Linux path", () => {
		// PATH_MAX is 4096 bytes, and JSON escaping can inflate it further; a
		// limit at PATH_MAX would reject legitimate records outright.
		assert.ok(SYNAPSE_TRACE_MAX_LINE_BYTES > 4096 * 2);
		assert.equal(parseTraceLine(lineOf(pathRecord({ path: `/${"p".repeat(4094)}` }))).kind, "record");
	});
});

describe("synapse-trace wire contract: the three facts stay apart", () => {
	it("keeps record, loss, malformed, truncated and too-long lines in distinct buckets across one log", () => {
		const raw = [
			lineOf(descriptorRecord()),
			'{"count":3,"kind":"lost","nsecs":1}',
			JSON.stringify({ ...descriptorRecord(), pid: "not-a-number" }),
			lineOf(descriptorRecord()).slice(0, 10),
			lineOf(pathRecord({ path: `/${"a".repeat(SYNAPSE_TRACE_MAX_LINE_BYTES)}` })),
		].join("\n");
		const log = parseTraceLog(raw);
		assert.equal(log.records.length, 1);
		assert.equal(log.losses.length, 1);
		assert.deepEqual(
			log.errors.map((error) => [error.line, error.reason]),
			[
				[3, "malformed"],
				[4, "truncated"],
				[5, "too-long"],
			],
		);
	});

	it("reports the 1-based line number of every rejected line", () => {
		const log = parseTraceLog(["", lineOf(descriptorRecord()), "{ not json", "", '{"pid":1'].join("\n"));
		assert.deepEqual(
			log.errors.map((error) => error.line),
			[3, 5],
		);
	});

	it("gives every rejection a non-empty detail naming what was wrong", () => {
		const log = parseTraceLog([JSON.stringify({ ...descriptorRecord(), pid: "x" }), "{ not json", '{"pid":1'].join("\n"));
		for (const error of log.errors) assert.ok(error.detail.length > 0, `expected a detail for the ${error.reason} line`);
	});

	it("passes the line-length limit through to every line of a log", () => {
		const raw = [lineOf(descriptorRecord()), lineOf(descriptorRecord())].join("\n");
		const log = parseTraceLog(raw, { maxLineBytes: 10 });
		assert.equal(log.records.length, 0);
		assert.deepEqual(
			log.errors.map((error) => error.reason),
			["too-long", "too-long"],
		);
	});

	it("returns empty buckets for empty input rather than inventing a zero measurement", () => {
		assert.deepEqual(parseTraceLog(""), { errors: [], losses: [], records: [] });
	});
});

describe("synapse-trace wire contract: byte and failure accounting", () => {
	it("counts a successful write's actual returned bytes, not the requested count", () => {
		const short = descriptorRecord({ bytes: 4096, ret: 60, syscall: "write" });
		assert.equal(contributedBytes(short), 60);
		assert.equal(traceCallFailed(short), false);
	});

	it("counts a successful read the same way as a write", () => {
		assert.equal(contributedBytes(descriptorRecord({ bytes: 4096, ret: 2048, syscall: "read" })), 2048);
	});

	it("contributes zero bytes for a failed call and counts it as a failure", () => {
		const failed = descriptorRecord({ bytes: 4096, ret: -1, syscall: "write" });
		assert.equal(contributedBytes(failed), 0);
		assert.equal(traceCallFailed(failed), true);
	});

	it("counts a failure for every negative errno, not just -1", () => {
		for (const ret of [-1, -2, -9, -28, -4095]) {
			assert.equal(traceCallFailed(descriptorRecord({ ret })), true, `expected ret ${ret} to count as a failure`);
			assert.equal(contributedBytes(descriptorRecord({ ret })), 0);
		}
	});

	it("treats ret === 0 as contributing no bytes and as no failure", () => {
		const eof = descriptorRecord({ bytes: 4096, ret: 0, syscall: "read" });
		assert.equal(contributedBytes(eof), 0);
		assert.equal(traceCallFailed(eof), false);
	});

	it("never counts openat's returned file descriptor as bytes moved", () => {
		const opened = pathRecord({ bytes: 0, ret: 11, syscall: "openat" });
		assert.equal(contributedBytes(opened), 0);
		assert.equal(traceCallFailed(opened), false);
	});

	it("never counts renameat2's status code as bytes moved", () => {
		assert.equal(contributedBytes(pathRecord({ bytes: 0, ret: 0, syscall: "renameat2" })), 0);
	});

	it("counts a failed openat as a failure with zero bytes", () => {
		const failedOpen = pathRecord({ ret: -2, syscall: "openat" });
		assert.equal(traceCallFailed(failedOpen), true);
		assert.equal(contributedBytes(failedOpen), 0);
	});

	it("sums a parsed log by what the calls really moved", () => {
		const raw = [
			lineOf(pathRecord({ ret: 9 })),
			lineOf(descriptorRecord({ bytes: 4096, ret: 60 })),
			lineOf(descriptorRecord({ bytes: 4096, ret: -28 })),
			lineOf(descriptorRecord({ bytes: 4096, ret: 4096, syscall: "read" })),
		].join("\n");
		const log = parseTraceLog(raw);
		assert.equal(log.records.reduce((total, record) => total + contributedBytes(record), 0), 4156);
		assert.equal(log.records.filter((record) => traceCallFailed(record)).length, 1);
	});

	it("reads the collector's observing marker and keeps the earliest one", () => {
		assert.deepEqual(parseTraceLine('{"kind":"observing","nsecs":12}'), { kind: "observing", nsecs: 12 });
		assert.equal(parseTraceLine('{"kind":"observing","nsecs":-1}').kind, "error");
		assert.equal(parseTraceLine('{"kind":"observing","nsecs":12,"pid":1}').kind, "error");
		const log = parseTraceLog('{"kind":"observing","nsecs":30}\n{"kind":"observing","nsecs":20}\n');
		assert.equal(log.observingSince, 20);
		assert.equal(parseTraceLog("").observingSince, undefined);
	});
});
