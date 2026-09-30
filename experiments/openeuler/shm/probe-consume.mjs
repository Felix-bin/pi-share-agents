// E0b 的一个"任务进程"：全新 node 进程，attach 段（或走文件路径），消费
// 5 个查询，写自己的账本，stdout 返回 hits 与账本计数。由 run.mjs 派发。
//
// 用法：node --experimental-strip-types probe-consume.mjs --arm file|shm --storage-root <dir> --queries <json> --ledger <jsonl> --namespace <16hex>

import * as fs from "node:fs";
import * as path from "node:path";

const args = parseArgs(process.argv.slice(2));
const arm = args.arm;
if (arm !== "file" && arm !== "shm") fail("--arm must be file|shm");
const storageRoot = path.resolve(args["storage-root"] ?? "");
const queriesSpec = JSON.parse(fs.readFileSync(path.resolve(args.queries), "utf-8"));
const ledgerPath = path.resolve(args.ledger);
const namespaceId = args.namespace ?? "";

const { createContentStore } = await import("../../../src/synapse/content-store.ts");
const { createMeteringLog, readMeteringLog } = await import("../../../src/synapse/metering.ts");
const { retrieveWithState } = await import("../../../src/synapse/state-retrieval.ts");

const identity = { agent: "e0b-probe", attempt: 1, mode: "synapse", nodeId: `probe-${arm}`, runId: `e0b-${process.pid}`, sessionId: `e0b-${arm}`, snapshotId: null };
const log = createMeteringLog(ledgerPath);
const contentStore = createContentStore(storageRoot);

let loadCorpus;
if (arm === "shm") {
	const { createPosixShmBindings } = await import("../../../src/synapse/shm-bindings.ts");
	const { createShmCorpusPlane } = await import("../../../src/synapse/shm-corpus-plane.ts");
	const bindings = createPosixShmBindings();
	if (bindings === null) fail("shm arm needs POSIX shm bindings");
	const plane = createShmCorpusPlane({ bindings, metering: { identity, log }, namespaceId16: namespaceId });
	// A reader only: no publish here — the run's single writer published in round 0.
	loadCorpus = (snapshot, dim, rep) => plane.loadCorpusVectors(snapshot, dim, rep);
}

const hits = [];
const started = Date.now();
for (const queryB64 of queriesSpec.queries) {
	const vector = Buffer.from(queryB64, "base64");
	const payloadId = contentStore.put(new Uint8Array(vector), "application/x-float32-vector");
	const stateRef = { baseMemoryId: null, byteLength: vector.byteLength, dim: queriesSpec.dim, encoding: "float32-vector", payloadId, representationId: queriesSpec.representation, sha256: payloadId };
	const result = retrieveWithState(
		{ contentStore, loadCorpus, metering: { identity, log }, storageRoot },
		{ corpusSnapshotId: queriesSpec.snapshot, k: queriesSpec.k, stateRef },
	);
	hits.push(result.hits.map((hit) => hit.chunkId));
}
const wallMs = Date.now() - started;

const events = readMeteringLog(ledgerPath);
const output = {
	corpusLoads: events.filter((event) => event.kind === "corpus-load").length,
	hits,
	shmAttaches: events.filter((event) => event.kind === "shm-attach").length,
	shmHits: events.filter((event) => event.kind === "shm-hit").length,
	wallMs,
};
console.log(JSON.stringify(output));

function fail(message) {
	console.error(String(message));
	process.exit(1);
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, "")] = argv[i + 1];
	return out;
}
