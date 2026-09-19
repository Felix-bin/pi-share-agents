/**
 * One participant in the file-handoff benchmark.
 *
 * It does what a background subagent does to the filesystem and nothing else:
 * write an envelope, read the envelopes its peers wrote, write a content
 * object, read it back. No model calls, no network, no sleeping — the only
 * thing being compared between the observed and unobserved arms is file I/O
 * cost, so anything else in here would be noise hiding the signal.
 *
 * Usage: node observation-workload.mjs <storage-root> <index> <rounds>
 * Prints one JSON line with its own elapsed time.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const [storageRoot, indexArgument, roundsArgument] = process.argv.slice(2);
if (!storageRoot || indexArgument === undefined || roundsArgument === undefined) {
	console.error("usage: observation-workload.mjs <storage-root> <index> <rounds>");
	process.exit(2);
}

const index = Number.parseInt(indexArgument, 10);
const rounds = Number.parseInt(roundsArgument, 10);
const envelopesDir = path.join(storageRoot, "envelopes", "bench");
const objectsDir = path.join(storageRoot, "objects");
fs.mkdirSync(envelopesDir, { recursive: true });
fs.mkdirSync(objectsDir, { recursive: true });

const envelope = JSON.stringify({ body: "x".repeat(8 * 1024), from: index, kind: "handoff" });
const payload = Buffer.alloc(256 * 1024, index % 256);

const started = process.hrtime.bigint();
for (let round = 0; round < rounds; round++) {
	const envelopePath = path.join(envelopesDir, `child-${index}-${round}.json`);
	// Atomic write, exactly as the envelope inbox does it.
	const temporary = `${envelopePath}.tmp`;
	fs.writeFileSync(temporary, envelope, "utf-8");
	fs.renameSync(temporary, envelopePath);

	for (const entry of fs.readdirSync(envelopesDir)) {
		if (!entry.endsWith(".json")) continue;
		try {
			fs.readFileSync(path.join(envelopesDir, entry), "utf-8");
		} catch {
			// A peer may be mid-rename; a missed read is the peer's file, not an error.
		}
	}

	const objectPath = path.join(objectsDir, `blob-${index}-${round}.bin`);
	fs.writeFileSync(objectPath, payload);
	fs.readFileSync(objectPath);
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

process.stdout.write(`${JSON.stringify({ elapsedMs, index, pid: process.pid, type: "worker-done" })}\n`);
