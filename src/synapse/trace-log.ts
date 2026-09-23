import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import type { CanonicalValue } from "./canonical-json.ts";

/**
 * Wire contract for `synapse-trace`, the eBPF collector's line-delimited JSON
 * output, and the pure parser that reads it.
 *
 * The collector does not exist yet — it will run on openEuler, outside this
 * repository's CI — so this file IS the contract it has to satisfy: every
 * shape and rule here is load-bearing for code nobody has written. Nothing
 * below touches a filesystem, a kernel, or `process.platform`; every function
 * is a pure transform from a string to a structured result, provable on any
 * platform the tests happen to run on.
 *
 * Three kinds of line are recognised, and they are deliberately kept apart
 * rather than collapsed into one "parse failed" bucket, because downstream
 * they mean three different things (design §4.4, §6):
 *
 *  - a `record` — a resolved syscall event, the collector's normal output;
 *  - a `loss`   — the collector's own admission that it dropped events, e.g.
 *                 a ring-buffer overflow. This is the most important shape
 *                 here: it is what lets the joiner report `unavailable`
 *                 instead of a byte count that is quietly too small. A run
 *                 that lost events is not a run that measured less;
 *  - an `error` — the line was rejected, with a reason separating "too big to
 *                 be a real record" (`too-long`), "cut off mid-write, i.e. a
 *                 prefix of a valid record" (`truncated`, the signature of a
 *                 collector killed mid-line), and "complete but the wrong
 *                 shape or types" (`malformed`, the signature of a collector
 *                 bug or of something else writing to the file).
 *
 * A rejected line contributes nothing: no field is ever defaulted, coerced or
 * guessed to paper over what the line was missing. The counting rules in
 * `metering.ts` apply here too — a quantity that was not reported is absent
 * evidence, never a zero.
 */

/** Syscalls whose record carries only a file descriptor: the call has no path argument to report. */
const DESCRIPTOR_SYSCALLS = ["read", "write"] as const;
/** Syscalls whose record carries the path the call names. */
const PATH_SYSCALLS = ["openat", "renameat2"] as const;

/** The four syscalls `synapse-trace` hooks. Entry/exit pairs are resolved by the collector; every line here is already one whole call. */
export const SYNAPSE_TRACE_SYSCALLS = [...DESCRIPTOR_SYSCALLS, ...PATH_SYSCALLS] as const;
export type TraceSyscall = (typeof SYNAPSE_TRACE_SYSCALLS)[number];

/**
 * Maximum size, in UTF-8 bytes, of one trace line — bytes rather than UTF-16
 * code units, because the collector writes bytes and a path of non-ASCII
 * characters costs two to four bytes each. A resolved syscall record is a
 * handful of integers plus at most one path (`PATH_MAX` is 4096 on Linux, and
 * JSON-escaping can inflate it), so this bound is generous for anything
 * legitimate. An over-long line is rejected before `JSON.parse` ever sees it,
 * so an oversized or adversarial line cannot be partially parsed.
 */
export const SYNAPSE_TRACE_MAX_LINE_BYTES = 16384;

const traceRecordFields = {
	/**
	 * The syscall's requested byte count — the `count` argument to read/write —
	 * independent of how much actually completed. It is carried alongside `ret`
	 * precisely so a short write is detectable: compare the two, never
	 * substitute one for the other. `openat` and `renameat2` move no data and
	 * report 0.
	 */
	bytes: Type.Integer({ minimum: 0 }),
	/**
	 * The file descriptor the call was given: the target fd for read/write, the
	 * directory fd for openat/renameat2 (which may be the negative `AT_FDCWD`).
	 * For `openat` the newly allocated descriptor is `ret`, not this field.
	 */
	fd: Type.Integer(),
	/** Boot-based monotonic clock reading, in nanoseconds. Not comparable to `MeteringEvent.monotonicMs`, which is per-process; design §4.3. */
	nsecs: Type.Integer({ minimum: 0 }),
	pid: Type.Integer({ minimum: 0 }),
	/** The syscall's actual return value: bytes transferred for read/write, the new descriptor for openat, a status for renameat2, or a negative errno on failure. */
	ret: Type.Integer(),
	/**
	 * Field 22 of `/proc/<pid>/stat` for this process: its start time in clock
	 * ticks since boot. Stays in the contract because it is what makes PID
	 * reuse decidable — the same pid at two start times is two processes, a
	 * deterministic fact rather than a time-window guess (design §4.1).
	 */
	startTicks: Type.Integer({ minimum: 0 }),
	tid: Type.Integer({ minimum: 0 }),
};

/**
 * `read` / `write`. The syscall is handed a descriptor and no path, so the
 * record carries none and one here is rejected rather than trusted: the
 * joiner resolves the path from its `(pid, fd)` table, built from `openat`
 * (design §4.2). A path appearing on a write line would be the collector
 * inventing evidence the kernel never gave it.
 */
const DescriptorCallSchema = Type.Object(
	{
		...traceRecordFields,
		syscall: Type.Union([Type.Literal("read"), Type.Literal("write")]),
	},
	{ additionalProperties: false },
);

/**
 * `openat` / `renameat2`. Both name a path, so the path is required, not
 * optional: a collector that could not read the path string must emit a line
 * this parser rejects — landing it in `errors` as visible missing evidence —
 * rather than a pathless record that silently punches a hole in the fd table.
 *
 * For `renameat2` this is the destination path: the name the bytes end up
 * published under, and the name the storage-root prefix test (design §4.2)
 * classifies. The source path is deliberately not invented into this field.
 * Both SYNAPSE writers rename within the same directory — `content-store.ts`
 * writes `<objects>/<shard>/.<id>.<pid>.<ms>.tmp` and renames it in place —
 * so the temporary name already classifies to the right bucket and coarse
 * attribution does not need the source. Following a rename by name (per-file
 * attribution) does, and would need a second path field; that belongs to the
 * joiner's contract, not to this one, and must be an explicit extension
 * rather than a reinterpretation of this field.
 */
const PathCallSchema = Type.Object(
	{
		...traceRecordFields,
		path: Type.String({ minLength: 1 }),
		syscall: Type.Union([Type.Literal("openat"), Type.Literal("renameat2")]),
	},
	{ additionalProperties: false },
);

export type TraceDescriptorRecord = Static<typeof DescriptorCallSchema>;
export type TracePathRecord = Static<typeof PathCallSchema>;
/** One resolved syscall, discriminated by `syscall`: narrowing on it is what gives a caller access to `path`. */
export type TraceRecord = TraceDescriptorRecord | TracePathRecord;

/**
 * The collector's admission that it dropped events, e.g. because a
 * fixed-capacity ring buffer overflowed while nothing drained it fast enough.
 * `count` is cumulative since the collector started, so a consumer needs only
 * the fact that any loss occurred: design §4.4 turns any loss report into an
 * `unavailable` result for the whole run, never a partial-but-usable number.
 *
 * It is told apart from a record structurally, not by convention. `kind` is
 * the discriminator, and no record may carry it: both record schemas set
 * `additionalProperties: false` and neither declares a `kind` property, so a
 * line claiming to be a loss report can never also validate as a record, and
 * a record that happens to carry similar fields (`nsecs`, a numeric `count`)
 * can never be mistaken for a loss report. The two languages are disjoint.
 */
const TraceLossSchema = Type.Object(
	{
		count: Type.Integer({ minimum: 1 }),
		kind: Type.Literal("lost"),
		nsecs: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export type TraceLossReport = Static<typeof TraceLossSchema>;

/** Routes a line to the schema it claims to be, so the rejection message names the real problem instead of every branch's. */
const LossClaimSchema = Type.Object({ kind: Type.Literal("lost") }, { additionalProperties: true });
const PathCallClaimSchema = Type.Object({ syscall: Type.Union([Type.Literal("openat"), Type.Literal("renameat2")]) }, { additionalProperties: true });

const lossClaim = Compile(LossClaimSchema);
const pathCallClaim = Compile(PathCallClaimSchema);
const lossValidator = Compile(TraceLossSchema);
const descriptorValidator = Compile(DescriptorCallSchema);
const pathValidator = Compile(PathCallSchema);

export type TraceLineErrorReason = "too-long" | "truncated" | "malformed";

export type TraceLineResult =
	| { kind: "record"; record: TraceRecord }
	| { kind: "loss"; loss: TraceLossReport }
	| { detail: string; kind: "error"; reason: TraceLineErrorReason };

export type TraceParseOptions = {
	maxLineBytes?: number;
};

function firstSchemaError(errors: readonly { instancePath: string; message: string }[]): string {
	const [first] = errors;
	if (first === undefined) return "does not match the schema";
	return first.instancePath.length === 0 ? first.message : `${first.instancePath} ${first.message}`;
}

/** A whole JSON document, a proper prefix of one, or neither. */
type JsonTextScan = "complete" | "incomplete" | "invalid";

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const JSON_LITERALS = ["true", "false", "null"] as const;
/** The longest JSON number at the head of the text. */
const WHOLE_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
/** Text that is a number cut off before it could be finished: `-`, `1.`, `1e`, `1e+`. */
const PARTIAL_NUMBER = /^(?:-|-?(?:0|[1-9][0-9]*)\.|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?[eE][+-]?)$/;
const UNICODE_ESCAPE_PREFIX = /^[0-9a-fA-F]*$/;
const SIMPLE_ESCAPES = '"\\/bfnrt';

type StringScan = { end: number; kind: "closed" } | { kind: "incomplete" } | { kind: "invalid" };

function scanJsonString(text: string, start: number): StringScan {
	let index = start + 1;
	while (index < text.length) {
		const char = text.charAt(index);
		if (char === '"') return { end: index + 1, kind: "closed" };
		if (char === "\\") {
			if (index + 1 >= text.length) return { kind: "incomplete" };
			const escape = text.charAt(index + 1);
			if (escape === "u") {
				const digits = text.slice(index + 2, index + 6);
				if (!UNICODE_ESCAPE_PREFIX.test(digits)) return { kind: "invalid" };
				if (digits.length < 4) return { kind: "incomplete" };
				index += 6;
				continue;
			}
			if (!SIMPLE_ESCAPES.includes(escape)) return { kind: "invalid" };
			index += 2;
			continue;
		}
		// Raw control characters are not legal inside a JSON string, and no
		// amount of further text would make them legal.
		if (char < " ") return { kind: "invalid" };
		index += 1;
	}
	return { kind: "incomplete" };
}

type ScanExpectation = "value" | "value-or-end" | "key" | "key-or-end" | "colon" | "separator" | "done";

/**
 * Decides whether text is a whole JSON document, a proper prefix of one, or
 * something no continuation could rescue.
 *
 * This is what makes `truncated` a decided fact rather than a guess. The naive
 * version — "`JSON.parse` threw, so the writer must have been cut off" — calls
 * outright garbage truncated, which would have the joiner blame a crashed
 * collector for a line that some other writer put in the file, and would hide
 * a collector emitting wrong JSON behind a story about a crash. A line is
 * truncated only when everything present is valid and the text simply stops
 * before the document closes: an unterminated string, an unclosed object, a
 * missing value, a half-written literal or number.
 */
function scanJsonText(text: string): JsonTextScan {
	const stack: ("array" | "object")[] = [];
	let expect: ScanExpectation = "value";
	let index = 0;

	const afterValue = (): ScanExpectation => (stack.length === 0 ? "done" : "separator");

	const readScalar = (): "incomplete" | "invalid" | number => {
		const rest = text.slice(index);
		// Checked before the whole-number match, and anchored to the end of the
		// text, so `1.` reads as a number cut off rather than as the number 1
		// followed by a stray dot.
		if (PARTIAL_NUMBER.test(rest)) return "incomplete";
		const [wholeNumber] = WHOLE_NUMBER.exec(rest) ?? [];
		if (wholeNumber !== undefined) return index + wholeNumber.length;
		for (const literal of JSON_LITERALS) {
			if (rest.startsWith(literal)) return index + literal.length;
			if (literal.startsWith(rest)) return "incomplete";
		}
		return "invalid";
	};

	for (;;) {
		while (index < text.length && JSON_WHITESPACE.has(text.charAt(index))) index += 1;
		if (index >= text.length) return expect === "done" ? "complete" : "incomplete";
		const char = text.charAt(index);

		if (expect === "done") return "invalid";

		if (expect === "colon") {
			if (char !== ":") return "invalid";
			index += 1;
			expect = "value";
			continue;
		}

		if (expect === "separator") {
			const container = stack[stack.length - 1];
			if (container === undefined) return "invalid";
			if (char === ",") {
				index += 1;
				expect = container === "object" ? "key" : "value";
				continue;
			}
			if (char !== (container === "object" ? "}" : "]")) return "invalid";
			stack.pop();
			index += 1;
			expect = afterValue();
			continue;
		}

		if (expect === "key" || expect === "key-or-end") {
			if (expect === "key-or-end" && char === "}") {
				stack.pop();
				index += 1;
				expect = afterValue();
				continue;
			}
			if (char !== '"') return "invalid";
			const scanned = scanJsonString(text, index);
			if (scanned.kind !== "closed") return scanned.kind;
			index = scanned.end;
			expect = "colon";
			continue;
		}

		if (expect === "value-or-end" && char === "]") {
			stack.pop();
			index += 1;
			expect = afterValue();
			continue;
		}
		if (char === "{") {
			stack.push("object");
			index += 1;
			expect = "key-or-end";
			continue;
		}
		if (char === "[") {
			stack.push("array");
			index += 1;
			expect = "value-or-end";
			continue;
		}
		if (char === '"') {
			const scanned = scanJsonString(text, index);
			if (scanned.kind !== "closed") return scanned.kind;
			index = scanned.end;
			expect = afterValue();
			continue;
		}
		const scalarEnd = readScalar();
		if (scalarEnd === "incomplete" || scalarEnd === "invalid") return scalarEnd;
		index = scalarEnd;
		expect = afterValue();
	}
}

/**
 * Parses one line of `synapse-trace` output. Never throws: every outcome,
 * rejection included, is a value the caller can inspect, count and test.
 */
export function parseTraceLine(line: string, options: TraceParseOptions = {}): TraceLineResult {
	const maxLineBytes = options.maxLineBytes ?? SYNAPSE_TRACE_MAX_LINE_BYTES;
	const lineBytes = Buffer.byteLength(line, "utf-8");
	if (lineBytes > maxLineBytes) {
		return { detail: `line is ${lineBytes} bytes, over the ${maxLineBytes} byte limit`, kind: "error", reason: "too-long" };
	}

	let decoded: CanonicalValue;
	try {
		decoded = JSON.parse(line);
	} catch {
		// Distinguish a writer cut off mid-line from a line that is simply not a
		// record. `JSON.parse` failing alone cannot tell them apart.
		const scanned = scanJsonText(line);
		const reason = scanned === "incomplete" ? "truncated" : "malformed";
		const detail = scanned === "incomplete" ? "line ends before the JSON document closes" : "line is not valid JSON";
		return { detail, kind: "error", reason };
	}

	if (lossClaim.Check(decoded)) {
		if (lossValidator.Check(decoded)) return { kind: "loss", loss: decoded };
		return { detail: `loss report ${firstSchemaError(lossValidator.Errors(decoded))}`, kind: "error", reason: "malformed" };
	}

	if (pathCallClaim.Check(decoded)) {
		if (!pathValidator.Check(decoded)) return { detail: firstSchemaError(pathValidator.Errors(decoded)), kind: "error", reason: "malformed" };
		return { kind: "record", record: decoded };
	}

	if (!descriptorValidator.Check(decoded)) return { detail: firstSchemaError(descriptorValidator.Errors(decoded)), kind: "error", reason: "malformed" };
	// A read or write cannot return more than it was asked to move. A line that
	// claims it did is a collector bug, and accepting it would inflate the one
	// quantity this whole contract exists to measure honestly.
	if (decoded.ret > decoded.bytes) {
		return { detail: `/ret ${decoded.ret} exceeds the requested ${decoded.bytes} bytes`, kind: "error", reason: "malformed" };
	}
	return { kind: "record", record: decoded };
}

export type TraceLineError = { detail: string; line: number; reason: TraceLineErrorReason };

export type TraceLog = {
	errors: TraceLineError[];
	losses: TraceLossReport[];
	records: TraceRecord[];
};

/**
 * Parses a whole `synapse-trace` output file. Blank lines are skipped, as in
 * `readMeteringLog`; every other line is classified as a record, a loss report
 * or an error, and a rejected line is kept with its 1-based line number and
 * reason rather than dropped — the joiner, or an offline audit, can see
 * exactly what was unreadable and why.
 *
 * This function never throws and never decides coverage: whether a loss report
 * or a run of errors makes the kernel-side result `unavailable` is the
 * joiner's judgement (design §4.4), not the parser's. The parser's only job is
 * to keep the three facts apart.
 */
export function parseTraceLog(raw: string, options: TraceParseOptions = {}): TraceLog {
	const records: TraceRecord[] = [];
	const losses: TraceLossReport[] = [];
	const errors: TraceLineError[] = [];
	for (const [index, line] of raw.split("\n").entries()) {
		if (line.trim().length === 0) continue;
		const result = parseTraceLine(line, options);
		if (result.kind === "record") records.push(result.record);
		else if (result.kind === "loss") losses.push(result.loss);
		else errors.push({ detail: result.detail, line: index + 1, reason: result.reason });
	}
	return { errors, losses, records };
}

/** True when the syscall failed. Uniform across all four hooks: a negative return value is `-errno` whichever call produced it. */
export function traceCallFailed(record: TraceRecord): boolean {
	return record.ret < 0;
}

/**
 * Bytes this record actually moved, by the counting rule of design §3.1: a
 * successful `read`/`write` contributes exactly what it returned — a short
 * write counts only what really moved, never the requested `bytes` — and a
 * failed call contributes nothing but is still counted as a failure.
 *
 * `openat` and `renameat2` never contribute bytes even when they succeed:
 * their `ret` is a descriptor or a status, and counting it as volume would
 * invent data out of a file descriptor number.
 */
export function contributedBytes(record: TraceRecord): number {
	if (record.syscall !== "read" && record.syscall !== "write") return 0;
	return record.ret > 0 ? record.ret : 0;
}
