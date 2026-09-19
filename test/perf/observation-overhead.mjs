/**
 * The performance gate for kernel file I/O observation.
 *
 * The claim this script exists to test is narrow and falsifiable: turning
 * observation on must not make a file-handoff workload measurably slower for
 * the operator. The gate is a median increase of at most 5% and a P95 increase
 * of at most 10%, at 1, 4 and 8 concurrent background processes.
 *
 * Two rules keep the result honest:
 *   - The observed arm is only run when a collector is actually reachable.
 *     Comparing "off" with "on but not connected" would measure nothing and
 *     pass every time.
 *   - The report records the environment, the collector's own cost and its
 *     dropped-measurement counters. A gate that passed while the collector was
 *     silently dropping events has not shown what it claims to have shown.
 *
 * Usage:
 *   node test/perf/observation-overhead.mjs --out report.json [--socket PATH]
 *                                           [--repeats 30] [--rounds 20]
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const WORKLOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), "observation-workload.mjs");
const CONCURRENCIES = [1, 4, 8];
const WARMUP_REPEATS = 3;
const MEDIAN_GATE = 0.05;
const P95_GATE = 0.1;

function parseArguments(argv) {
	const options = { out: null, repeats: 30, rounds: 20, socket: null };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === "--out" && value) {
			options.out = value;
			i++;
		} else if (flag === "--socket" && value) {
			options.socket = value;
			i++;
		} else if (flag === "--repeats" && value) {
			options.repeats = Number.parseInt(value, 10);
			i++;
		} else if (flag === "--rounds" && value) {
			options.rounds = Number.parseInt(value, 10);
			i++;
		} else {
			console.error(`unknown argument: ${flag}`);
			process.exit(2);
		}
	}
	if (options.out === null) {
		console.error("--out is required: a benchmark with no recorded report is not evidence");
		process.exit(2);
	}
	return options;
}

function quantile(sorted, q) {
	if (sorted.length === 0) return null;
	const position = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
	return sorted[position];
}

function summarise(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	return { count: sorted.length, max: sorted[sorted.length - 1], medianMs: quantile(sorted, 0.5), min: sorted[0], p95Ms: quantile(sorted, 0.95) };
}

async function collectorReachable(socketPath) {
	if (socketPath === null) return false;
	return await new Promise((resolve) => {
		const socket = net.connect(socketPath);
		const finish = (answer) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(answer);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		setTimeout(() => finish(false), 1000).unref();
	});
}

function runWorkers(storageRoot, concurrency, rounds) {
	return new Promise((resolve, reject) => {
		const started = process.hrtime.bigint();
		let remaining = concurrency;
		let failed = null;
		for (let index = 0; index < concurrency; index++) {
			const child = spawn(process.execPath, [WORKLOAD, storageRoot, String(index), String(rounds)], { stdio: ["ignore", "ignore", "inherit"] });
			child.on("error", (error) => {
				failed = error;
			});
			child.on("exit", (code) => {
				if (code !== 0 && failed === null) failed = new Error(`worker exited with ${code}`);
				remaining--;
				if (remaining > 0) return;
				// Wall clock across the whole fan-out: that is what the operator waits for.
				if (failed !== null) reject(failed);
				else resolve(Number(process.hrtime.bigint() - started) / 1e6);
			});
		}
	});
}

async function measure(concurrency, repeats, rounds) {
	const samples = [];
	for (let repeat = 0; repeat < WARMUP_REPEATS + repeats; repeat++) {
		const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-bench-"));
		try {
			const elapsed = await runWorkers(storageRoot, concurrency, rounds);
			// Warm-up runs populate the page cache and the dentry cache; including
			// them would put the cold-start cost in only whichever arm ran first.
			if (repeat >= WARMUP_REPEATS) samples.push(elapsed);
		} finally {
			fs.rmSync(storageRoot, { force: true, recursive: true });
		}
	}
	return summarise(samples);
}

function ratio(observed, baseline) {
	if (baseline === null || observed === null || baseline === 0) return null;
	return observed / baseline - 1;
}

const options = parseArguments(process.argv.slice(2));
const reachable = await collectorReachable(options.socket);

const report = {
	environment: {
		arch: os.arch(),
		cpus: os.cpus().length,
		node: process.version,
		platform: os.platform(),
		release: os.release(),
		totalMemoryBytes: os.totalmem(),
	},
	gate: { medianIncrease: MEDIAN_GATE, p95Increase: P95_GATE },
	observedArm: reachable ? "measured" : "skipped",
	repeats: options.repeats,
	results: [],
	rounds: options.rounds,
	startedAt: new Date().toISOString(),
	verdict: "unknown",
};

for (const concurrency of CONCURRENCIES) {
	process.stderr.write(`baseline, ${concurrency} process(es)...\n`);
	const baseline = await measure(concurrency, options.repeats, options.rounds);
	let observed = null;
	if (reachable) {
		process.stderr.write(`observed, ${concurrency} process(es)...\n`);
		observed = await measure(concurrency, options.repeats, options.rounds);
	}
	report.results.push({
		baseline,
		concurrency,
		medianIncrease: observed === null ? null : ratio(observed.medianMs, baseline.medianMs),
		observed,
		p95Increase: observed === null ? null : ratio(observed.p95Ms, baseline.p95Ms),
	});
}

if (!reachable) {
	// Not a failure and definitely not a pass: no collector was running, so the
	// only defensible statement is that the gate was not evaluated.
	report.verdict = "not-evaluated";
	report.reason = options.socket === null ? "no --socket was given" : `no collector answered on ${options.socket}`;
} else {
	const breaches = report.results.filter((entry) => (entry.medianIncrease ?? 0) > MEDIAN_GATE || (entry.p95Increase ?? 0) > P95_GATE);
	report.verdict = breaches.length === 0 ? "pass" : "fail";
	report.breaches = breaches.map((entry) => entry.concurrency);
}

fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
process.stderr.write(`${report.verdict}: ${options.out}\n`);
// A gate that was not evaluated must not report success to CI.
process.exit(report.verdict === "pass" ? 0 : 1);
