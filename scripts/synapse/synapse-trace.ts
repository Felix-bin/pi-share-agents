/**
 * synapse-trace — the S3 eBPF collector (design §3.1).
 *
 * Runs bpftrace over scripts/synapse/synapse-trace.bt and writes the contract
 * lines trace-log.ts parses to --out, one per line. It is started by hand, as
 * root, for the duration of an experiment, and is not part of Pi's process
 * tree: it crashing costs the run its kernel account, never the run itself.
 *
 *   node --experimental-strip-types scripts/synapse/synapse-trace.ts \
 *     --out <storageRoot>/trace/<runId>.ndjson [--exe node] [--exclude-pid P] [--ready-file F] \
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
import { createCollectorState, translateBpftraceLine, unpairedCalls, type CollectorOptions } from "../../src/synapse/trace-collector.ts";

const STRING_LIMIT = 200;

type Args = { bpftrace: string; excludePid: number; exe: string; out: string; rbPages: number | null; readyFile: string | null };

function parseArgs(argv: readonly string[]): Args | string {
	const args: Args = { bpftrace: "bpftrace", excludePid: 0, exe: "node", out: "", rbPages: null, readyFile: null };
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (value === undefined) return `missing value for ${flag}`;
		if (flag === "--out") args.out = value;
		else if (flag === "--exe") args.exe = value;
		else if (flag === "--ready-file") args.readyFile = value;
		else if (flag === "--bpftrace") args.bpftrace = value;
		else if (flag === "--exclude-pid") {
			const pid = Number(value);
			if (!Number.isInteger(pid) || pid < 1) return `--exclude-pid must be a positive integer, got ${value}`;
			args.excludePid = pid;
		}
		else if (flag === "--rb-pages") {
			const pages = Number(value);
			if (!Number.isInteger(pages) || pages < 1) return `--rb-pages must be a positive integer, got ${value}`;
			args.rbPages = pages;
		} else return `unknown flag ${flag}`;
	}
	if (args.out.length === 0) return "--out is required";
	// The kernel half compares at most 15 characters of the executable's basename.
	if (args.exe.length === 0 || args.exe.length > 15 || args.exe.includes("/")) return "--exe must be a basename of 1-15 characters";
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
	const child = spawn(args.bpftrace, ["-f", "json", program, args.exe, String(process.pid), String(args.excludePid)], { env, stdio: ["ignore", "pipe", "pipe"] });

	const state = createCollectorState();
	const options: CollectorOptions = { nowBootNsecs, resolveDirectory, stringLimit: STRING_LIMIT };
	let ready = false;
	let announced = false;
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
			console.error(`synapse-trace: tracing exe=${args.exe} with ${step.probes} probes -> ${args.out}`);
			// The marker: one openat of our own, which the kernel half stamps. Ready
			// is announced only once that stamp comes back, so nothing a caller
			// starts after the announcement can predate the observation window.
			fs.closeSync(fs.openSync("/proc/self/stat", "r"));
			return;
		}
		if (step.kind === "diagnostic") {
			console.error(`synapse-trace: ${step.message}`);
			return;
		}
		if (step.lines.length > 0) {
			fs.writeSync(out, `${step.lines.join("\n")}\n`);
			written += step.lines.length;
		}
		if (!announced && state.observingSince !== null) {
			announced = true;
			console.error(`synapse-trace: observing since boot+${state.observingSince} ns`);
			if (args.readyFile !== null) fs.writeFileSync(args.readyFile, `${process.pid}\n`, "utf-8");
		}
	});
	// "close", not "exit": close fires only after bpftrace's stdout has been read to
	// the end, so the last lines it printed are written before the file is closed.
	child.on("close", (code, signal) => {
		fs.closeSync(out);
		console.error(`synapse-trace: stopped (${written} lines, ${state.lostTotal} events lost, ${unpairedCalls(state)} calls unfinished at stop)`);
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
