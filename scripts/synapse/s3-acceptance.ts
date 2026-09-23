/**
 * S3 real-machine acceptance collection (design §7.3; plan Tasks 1 and 8).
 *
 * Runs as root on a Linux host with bpftrace. Records facts and prints one JSON
 * report; judges nothing — `judge-s3-report.ts` does, over
 * `src/runs/shared/s3-acceptance-report.ts`, which CI tests without a kernel.
 *
 *   sudo "$(command -v node)" --experimental-strip-types scripts/synapse/s3-acceptance.ts \
 *     [--base /tmp/s3acc] [--runs 3] [--report <file>] [--bpftrace /usr/bin/bpftrace]
 *
 * Each ordinary run: start the collector, wait until its probes are attached,
 * run one two-process delegation (s3-probe.ts), stop the collector, then join
 * the trace with the run's metering log through `aggregateWithKernelIo` — the
 * same function an experiment would use. The honesty run repeats that with a
 * one-page ring buffer while a noisy Node process floods the collector, so that
 * events are lost on purpose.
 *
 * The storage root is kept short (/tmp/s3acc/…): the collector refuses any path
 * that fills bpftrace's 200-byte string buffer, and a long root would turn every
 * object path into a refused line.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateWithKernelIo } from "../../src/synapse/metering-kernel-io.ts";
import { readMeteringLog } from "../../src/synapse/metering.ts";
import { parseTraceLog } from "../../src/synapse/trace-log.ts";
import { S3_ACCEPTANCE_SCHEMA_VERSION, type S3AcceptanceReport, type S3KernelAccount, type S3RunFacts } from "../../src/runs/shared/s3-acceptance-report.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

type Args = { base: string; bpftrace: string; report: string | null; runs: number };

function parseArgs(argv: readonly string[]): Args {
	const args: Args = { base: `/tmp/s3acc-${process.pid}`, bpftrace: "bpftrace", report: null, runs: 3 };
	for (let index = 0; index < argv.length; index += 2) {
		const [flag, value] = [argv[index], argv[index + 1]];
		if (value === undefined) throw new Error(`missing value for ${flag}`);
		if (flag === "--base") args.base = value;
		else if (flag === "--bpftrace") args.bpftrace = value;
		else if (flag === "--report") args.report = value;
		else if (flag === "--runs") args.runs = Number(value);
		else throw new Error(`unknown flag ${flag}`);
	}
	return args;
}

function firstLine(command: string, commandArgs: string[]): string {
	const result = spawnSync(command, commandArgs, { encoding: "utf-8" });
	return result.error === undefined ? `${result.stdout}${result.stderr}`.trim().split("\n")[0] ?? "" : "unavailable";
}

function osRelease(): string {
	for (const file of ["/etc/openEuler-release", "/etc/os-release"]) {
		try {
			const text = fs.readFileSync(file, "utf-8");
			const pretty = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(text);
			return pretty?.[1] ?? text.trim().split("\n")[0] ?? "unknown";
		} catch {
			// try the next file
		}
	}
	return "unknown";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Collector = { child: ChildProcess; stderr: () => string; stop: () => Promise<number | null> };

/** Starts the collector and resolves once its probes are attached, or with the reason they are not. */
async function startCollector(args: Args, out: string, rbPages: number | null): Promise<Collector | string> {
	const ready = `${out}.ready`;
	fs.rmSync(ready, { force: true });
	const collectorArgs = ["--experimental-strip-types", path.join(HERE, "synapse-trace.ts"), "--out", out, "--ready-file", ready, "--bpftrace", args.bpftrace];
	if (rbPages !== null) collectorArgs.push("--rb-pages", String(rbPages));
	const child = spawn(NODE, collectorArgs, { stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr!.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf-8");
	});
	let exited = false;
	const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => ((exited = true), resolve(code))));
	for (let waited = 0; waited < 30_000; waited += 100) {
		if (fs.existsSync(ready)) {
			// Attached is not yet draining: give the first perf reads a moment.
			await sleep(300);
			return {
				child,
				stderr: () => stderr,
				stop: async () => {
					await sleep(500);
					child.kill("SIGINT");
					return exit;
				},
			};
		}
		if (exited) return stderr.trim().split("\n").slice(-3).join(" | ") || "the collector exited before attaching";
		await sleep(100);
	}
	child.kill("SIGKILL");
	return "the collector did not attach within 30 s";
}

function runProbe(store: string, worktree: string, runId: string): { envelopeBytes: number; envelopeFileBytes: number; receiptStatus: string } {
	const result = spawnSync(NODE, ["--experimental-strip-types", path.join(HERE, "s3-probe.ts"), "--store", store, "--worktree", worktree, "--run", runId], { encoding: "utf-8" });
	try {
		return JSON.parse(result.stdout.trim().split("\n").pop() ?? "") as ReturnType<typeof runProbe>;
	} catch {
		return { envelopeBytes: 0, envelopeFileBytes: 0, receiptStatus: `probe-failed: ${result.stderr.slice(0, 200)}` };
	}
}

function flatten(account: ReturnType<typeof aggregateWithKernelIo>["kernel"]): S3KernelAccount {
	if (account.kind === "not-collected") return { kind: "not-collected" };
	if (account.kind === "refused") return { kind: "refused", losses: account.traceLines.losses, reasons: [...account.reasons] };
	const report = account.kind === "reported-no-gap-found" ? account.noGapFound : account.withKnownGaps;
	return {
		byCategory: {
			content: { ...report.bytes.byCategory.content },
			envelope: { ...report.bytes.byCategory.envelope },
			"memory-index": { ...report.bytes.byCategory["memory-index"] },
		},
		kind: account.kind,
		losses: 0,
		pathlessBytes: report.bytes.pathlessBytes,
		unclassified: { ...report.bytes.unclassified },
	};
}

/** One observed delegation: collector up, probe, collector down, join. */
async function observedRun(args: Args, runId: string, rbPages: number | null, noisy: boolean): Promise<S3RunFacts | string> {
	const store = path.join(args.base, runId);
	const worktree = path.join(args.base, `${runId}-wt`);
	const tracePath = path.join(store, "trace", `${runId}.ndjson`);
	fs.mkdirSync(path.dirname(tracePath), { recursive: true });
	const collector = await startCollector(args, tracePath, rbPages);
	if (typeof collector === "string") return collector;
	// The noise is a traced Node process doing tiny writes as fast as it can, so
	// a one-page buffer cannot keep up and bpftrace has to drop.
	const noise = noisy
		? spawn(NODE, ["-e", `const fs=require("fs");const fd=fs.openSync(${JSON.stringify(path.join(store, "noise.bin"))},"w");const end=Date.now()+4000;while(Date.now()<end)fs.writeSync(fd,"x");`], { stdio: "ignore" })
		: null;
	const probe = runProbe(store, worktree, runId);
	if (noise !== null) await new Promise((resolve) => noise.on("exit", resolve));
	await collector.stop();

	const events = readMeteringLog(path.join(store, "metering", `${runId}.jsonl`));
	const trace = parseTraceLog(fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf-8") : "");
	const account = aggregateWithKernelIo(events, { collection: { kind: "collected", trace }, storageRoot: store });
	const identities = events.flatMap((event) => (event.kind === "process-identity" ? [{ pid: event.pid, startTicks: event.startTicks }] : []));
	const traceStartTicks: Record<string, number[]> = {};
	for (const identity of identities) {
		traceStartTicks[String(identity.pid)] = [...new Set(trace.records.filter((record) => record.pid === identity.pid).map((record) => record.startTicks))];
	}
	return { ...probe, identities, kernel: flatten(account.kernel), runId, traceStartTicks };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const report: S3AcceptanceReport = {
		collectorStartError: null,
		environment: {
			bpftraceVersion: firstLine(args.bpftrace, ["--version"]),
			btf: fs.existsSync("/sys/kernel/btf/vmlinux"),
			kernel: `${os.type()} ${os.release()}`,
			nodeVersion: process.version,
			osRelease: osRelease(),
			root: process.getuid?.() === 0,
		},
		honesty: null,
		runs: [],
		schemaVersion: S3_ACCEPTANCE_SCHEMA_VERSION,
	};
	if (report.environment.root && report.environment.btf) {
		fs.mkdirSync(args.base, { recursive: true });
		for (let index = 1; index <= args.runs; index += 1) {
			const run = await observedRun(args, `s3-${index}`, null, false);
			if (typeof run === "string") {
				report.collectorStartError = run;
				break;
			}
			report.runs.push(run);
		}
		if (report.collectorStartError === null) {
			const pages = 1;
			const run = await observedRun(args, "s3-overflow", pages, true);
			if (typeof run !== "string") report.honesty = { ...run, ringBufferPages: pages };
		}
	}
	const text = `${JSON.stringify(report, null, 2)}\n`;
	if (args.report !== null) fs.writeFileSync(args.report, text, "utf-8");
	process.stdout.write(text);
}

await main();
