import * as path from "node:path";

/**
 * The pure half of `synapse-trace`, the eBPF collector: it turns what bpftrace
 * prints into the lines `trace-log.ts` defines, and nothing else.
 *
 * The collector is split in two on purpose. The kernel half
 * (`scripts/synapse/synapse-trace.bt`) runs only on a Linux host as root and
 * cannot be exercised in CI; it therefore does as little as possible — it
 * records raw integers and a raw path string, and never formats JSON, because
 * bpftrace's `%s` does not escape and a path holding a quote would otherwise
 * produce a line that is neither valid nor visibly broken. Every decision that
 * can be wrong lives here instead, where it is a pure function of its inputs:
 * escaping, path resolution, truncation detection, and turning bpftrace's own
 * loss notices into the contract's `lost` line.
 *
 * Honesty rules, all load-bearing for the joiner (design §3.1, §6):
 *
 *  - A path that cannot be resolved to an absolute one, or that may have been
 *    cut off by bpftrace's string limit, is never guessed at. The record is
 *    still written, without its path, so the parser rejects it into `errors`:
 *    visible missing evidence rather than a byte count filed under the wrong
 *    bucket or silently outside the storage root.
 *  - Every loss bpftrace reports becomes a cumulative `lost` line. One is enough
 *    for the joiner to call the whole run `unavailable`.
 *  - Lines this module does not recognise are surfaced as diagnostics, not
 *    dropped: an unexpected bpftrace output shape is a collector defect.
 */

/** The field separator the kernel half prints between raw values. */
const SEPARATOR = "\t";

/** Linux `AT_FDCWD`: the directory fd meaning "relative to the calling process's cwd". */
export const AT_FDCWD = -100;

/** Resolves the directory a relative path was opened against; null when that can no longer be known. */
export type DirectoryResolver = (pid: number, dirfd: number) => string | null;

export type CollectorState = {
	/** Losses reported so far; the contract's `count` is cumulative. */
	lostTotal: number;
	/** The latest boot-clock reading seen, so a loss line is stamped no earlier than the records before it. */
	lastNsecs: number;
};

export type CollectorOptions = {
	resolveDirectory: DirectoryResolver;
	/**
	 * bpftrace's string buffer size (`BPFTRACE_STRLEN`). A path that fills it
	 * may have been truncated, and a truncated storage-root path would classify
	 * into the wrong bucket without any sign of it, so such a path is refused.
	 */
	stringLimit: number;
	/** The current boot-clock time, for stamping a loss that carries no timestamp of its own. */
	nowBootNsecs: () => number;
};

export type CollectorStep =
	| { kind: "lines"; lines: string[] }
	| { kind: "ready"; probes: number }
	| { kind: "diagnostic"; message: string };

export function createCollectorState(): CollectorState {
	return { lostTotal: 0, lastNsecs: 0 };
}

const INTEGER = /^-?[0-9]+$/;

function integerOf(text: string | undefined): number | null {
	if (text === undefined || !INTEGER.test(text)) return null;
	const value = Number(text);
	return Number.isSafeInteger(value) ? value : null;
}

/** An absolute, lexically normalised path, or null when it cannot honestly be produced. */
export function resolveTracedPath(raw: string, pid: number, dirfd: number, options: Pick<CollectorOptions, "resolveDirectory" | "stringLimit">): string | null {
	if (raw.length === 0) return null;
	// bpftrace copies at most stringLimit - 1 bytes plus a terminator; a string
	// that long may be a prefix of the real path.
	if (Buffer.byteLength(raw, "utf-8") >= options.stringLimit - 1) return null;
	if (raw.startsWith("/")) return path.posix.normalize(raw);
	const base = options.resolveDirectory(pid, dirfd);
	if (base === null || !base.startsWith("/")) return null;
	return path.posix.join(base, raw);
}

/**
 * One kernel-half line (the `printf` payload, without its newline) to the
 * contract line it stands for. Null means the line is not one of ours.
 */
export function translateRawRecord(raw: string, state: CollectorState, options: CollectorOptions): string | null | { diagnostic: string } {
	const fields = raw.split(SEPARATOR);
	const tag = fields[0];
	if (tag === "IO") {
		const [, syscall, pidText, tidText, startText, nsecsText, fdText, bytesText, retText] = fields;
		if (fields.length !== 9 || (syscall !== "read" && syscall !== "write")) return { diagnostic: `unrecognised IO line: ${JSON.stringify(raw)}` };
		const values = [pidText, tidText, startText, nsecsText, fdText, bytesText, retText].map(integerOf);
		if (values.some((value) => value === null)) return { diagnostic: `non-integer field in IO line: ${JSON.stringify(raw)}` };
		const [pid, tid, startTicks, nsecs, fd, bytes, ret] = values as number[];
		state.lastNsecs = Math.max(state.lastNsecs, nsecs!);
		return JSON.stringify({ bytes, fd, nsecs, pid, ret, startTicks, syscall, tid });
	}
	if (tag === "PATH") {
		// The path is the last field and may itself contain the separator.
		const [, syscall, pidText, tidText, startText, nsecsText, fdText, retText] = fields;
		if (fields.length < 9 || (syscall !== "openat" && syscall !== "renameat2")) return { diagnostic: `unrecognised PATH line: ${JSON.stringify(raw)}` };
		const values = [pidText, tidText, startText, nsecsText, fdText, retText].map(integerOf);
		if (values.some((value) => value === null)) return { diagnostic: `non-integer field in PATH line: ${JSON.stringify(raw)}` };
		const [pid, tid, startTicks, nsecs, fd, ret] = values as number[];
		state.lastNsecs = Math.max(state.lastNsecs, nsecs!);
		const resolved = resolveTracedPath(fields.slice(8).join(SEPARATOR), pid!, fd!, options);
		// Without a trustworthy path the record is written pathless on purpose:
		// the parser rejects it, and the run shows a counted gap instead of a
		// quietly misfiled one.
		const record = { bytes: 0, fd, nsecs, pid, ret, startTicks, syscall, tid };
		return JSON.stringify(resolved === null ? record : { ...record, path: resolved });
	}
	return null;
}

function lossLine(state: CollectorState, count: number, options: CollectorOptions): string {
	state.lostTotal += count;
	const nsecs = Math.max(state.lastNsecs, Math.floor(options.nowBootNsecs()));
	return JSON.stringify({ count: state.lostTotal, kind: "lost", nsecs });
}

/**
 * One line of `bpftrace -f json` output to what the collector should do with
 * it. The shapes are bpftrace's own: `printf` carries a kernel-half line,
 * `lost_events` a perf-buffer overflow, `attached_probes` the moment tracing
 * actually started.
 */
export function translateBpftraceLine(line: string, state: CollectorState, options: CollectorOptions): CollectorStep {
	if (line.trim().length === 0) return { kind: "lines", lines: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { kind: "diagnostic", message: `bpftrace printed a non-JSON line: ${line.slice(0, 200)}` };
	}
	const event = parsed as { data?: unknown; type?: unknown };
	switch (event.type) {
		case "attached_probes": {
			const probes = (event.data as { probes?: unknown } | undefined)?.probes;
			return { kind: "ready", probes: typeof probes === "number" ? probes : 0 };
		}
		case "lost_events": {
			const count = (event.data as { events?: unknown } | undefined)?.events;
			// A notice whose count cannot be read is still a loss: undercounting it
			// as zero is exactly the failure this line exists to prevent.
			const lost = typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 1;
			return { kind: "lines", lines: [lossLine(state, lost, options)] };
		}
		case "printf": {
			if (typeof event.data !== "string") return { kind: "diagnostic", message: `printf event without a string payload: ${line.slice(0, 200)}` };
			const lines: string[] = [];
			for (const raw of event.data.split("\n")) {
				if (raw.length === 0) continue;
				const translated = translateRawRecord(raw, state, options);
				if (translated === null) return { kind: "diagnostic", message: `unrecognised collector line: ${JSON.stringify(raw)}` };
				if (typeof translated === "object") return { kind: "diagnostic", message: translated.diagnostic };
				lines.push(translated);
			}
			return { kind: "lines", lines };
		}
		default:
			return { kind: "diagnostic", message: `unexpected bpftrace output: ${line.slice(0, 200)}` };
	}
}
