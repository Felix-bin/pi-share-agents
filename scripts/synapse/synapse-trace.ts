/**
 * synapse-trace — the S3 eBPF collector (design §3.1).
 *
 * Runs bpftrace over scripts/synapse/synapse-trace.bt and writes the contract
 * lines trace-log.ts parses to --out, one per line. It is started by hand, as
 * root, for the duration of an experiment, and is not part of Pi's process
 * tree: it crashing costs the run its kernel account, never the run itself.
 *
 *   node --experimental-strip-types scripts/synapse/synapse-trace.ts \
 *     --out <storageRoot>/trace/<runId>.ndjson [--comm node] [--ready-file F] \
 *     [--rb-pages N] [--bpftrace /usr/bin/bpftrace]
 *
 * Exit codes: 0 stopped by a signal after tracing; 2 bpftrace could not start
 * tracing (missing BTF, a probe that would not attach, no privilege) — the
 * reason is printed, and nothing is degraded silently; 3 bad arguments.
 *
 * --rb-pages sets bpftrace's perf ring buffer size. Its only use besides the
 * default is the honesty check (design §7.3 point 3): a buffer small enough to
 * overflow must produce `lost` lines, and the run must then read `unavailable`.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createCollectorState, translateBpftraceLine, type CollectorOptions } from "../../src/synapse/trace-collector.ts";

const STRING_LIMIT = 200;

type Args = { bpftrace: string; comm: string; out: string; rbPages: number | null; readyFile: string | null };

function parseArgs(argv: readonly string[]): Args | string {
	const args: Args = { bpftrace: "bpftrace", comm: "node", out: "", rbPages: null, readyFile: null };
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (value === undefined) return `missing value for ${flag}`;
		if (flag === "--out") args.out = value;
		else if (flag === "--comm") args.comm = value;
		else if (flag === "--ready-file") args.readyFile = value;
		else if (flag === "--bpftrace") args.bpftrace = value;
		else if (flag === "--rb-pages") {
			const pages = Number(value);
			if (!Number.isInteger(pages) || pages < 1) return `--rb-pages must be a positive integer, got ${value}`;
			args.rbPages = pages;
		} else return `unknown flag ${flag}`;
	}
	if (args.out.length === 0) return "--out is required";
	// The kernel compares against a 16-byte comm, 15 characters plus terminator.
	if (args.comm.length === 0 || args.comm.length > 15) return "--comm must be 1-15 characters";
	return args;
}

/** The directory a relative path was resolved against, read while the process is still alive. */
function resolveDirectory(pid: number, dirfd: number): string | null {
	try {
		return fs.readlinkSync(dirfd === -100 ? `/proc/${pid}/cwd` : `/proc/${pid}/fd/${dirfd}`);
	} catch {
		return null;
	}
}

/** Boot-clock nanoseconds, from /proc/uptime (10 ms resolution, enough to stamp a loss). */
function nowBootNsecs(): number {
	try {
		return Math.floor(Number(fs.readFileSync("/proc/uptime", "utf-8").split(" ")[0]) * 1e9);
	} catch {
		return 0;
	}
}

function main(): void {
	const parsed = parseArgs(process.argv.slice(2));
	if (typeof parsed === "string") {
		console.error(`synapse-trace: ${parsed}`);
		process.exit(3);
	}
	const args = parsed;
	if (process.platform !== "linux") {
		console.error("synapse-trace: eBPF collection needs a Linux kernel");
		process.exit(2);
	}
	if (!fs.existsSync("/sys/kernel/btf/vmlinux")) {
		console.error("synapse-trace: /sys/kernel/btf/vmlinux is missing; this kernel has no BTF, so curtask fields cannot be read");
		process.exit(2);
	}
	fs.mkdirSync(path.dirname(args.out), { recursive: true });
	const out = fs.openSync(args.out, "a");
	const program = path.join(path.dirname(fileURLToPath(import.meta.url)), "synapse-trace.bt");
	const env: NodeJS.ProcessEnv = { ...process.env, BPFTRACE_STRLEN: String(STRING_LIMIT) };
	if (args.rbPages !== null) env.BPFTRACE_PERF_RB_PAGES = String(args.rbPages);
	const child = spawn(args.bpftrace, ["-f", "json", program, args.comm], { env, stdio: ["ignore", "pipe", "pipe"] });

	const state = createCollectorState();
	const options: CollectorOptions = { nowBootNsecs, resolveDirectory, stringLimit: STRING_LIMIT };
	let ready = false;
	let written = 0;
	let stopping = false;

	child.on("error", (error) => {
		console.error(`synapse-trace: could not run ${args.bpftrace}: ${error.message}`);
		process.exit(2);
	});
	child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`synapse-trace[bpftrace]: ${chunk.toString("utf-8")}`));
	readline.createInterface({ input: child.stdout }).on("line", (line) => {
		const step = translateBpftraceLine(line, state, options);
		if (step.kind === "ready") {
			ready = true;
			console.error(`synapse-trace: tracing comm=${args.comm} with ${step.probes} probes -> ${args.out}`);
			if (args.readyFile !== null) fs.writeFileSync(args.readyFile, `${process.pid}\n`, "utf-8");
			return;
		}
		if (step.kind === "diagnostic") {
			console.error(`synapse-trace: ${step.message}`);
			return;
		}
		if (step.lines.length === 0) return;
		fs.writeSync(out, `${step.lines.join("\n")}\n`);
		written += step.lines.length;
	});
	child.on("exit", (code, signal) => {
		fs.closeSync(out);
		console.error(`synapse-trace: stopped (${written} lines, ${state.lostTotal} events lost)`);
		if (!ready) {
			console.error(`synapse-trace: bpftrace exited before tracing started (code ${code ?? "none"}, signal ${signal ?? "none"}); see its message above`);
			process.exit(2);
		}
		process.exit(stopping ? 0 : code === 0 ? 0 : 2);
	});
	const stop = (): void => {
		stopping = true;
		child.kill("SIGINT");
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

main();
