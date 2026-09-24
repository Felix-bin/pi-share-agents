#!/usr/bin/env node
/**
 * transport: what one handoff costs on each delivery path, measured through
 * the product's own modules (no LLM, no network).
 *
 *   node --experimental-strip-types scripts/synapse-exp/transport.mjs [--n 2000] [--warmup 200] [--text-bytes 11327] [--disk-root <dir>] [--tmpfs-root <dir>]
 *
 * Paths (each iteration is one complete send → receive → parse/verify):
 *   envelope-file   publishEnvelope → readDeliveredEnvelope (atomic file, parse, schema)
 *   envelope-uds    receiveDeliveredEnvelopeViaUds ∥ publishEnvelopeViaUds (AF_UNIX, 4-byte frame)
 *   payload-disk    content store put + read of a 4096 B float32 vector on ext4
 *   payload-tmpfs   the same on tmpfs (the S2 object plane)
 *   uds-persistent  REFERENCE, not a product path: the same frame bytes over one
 *                   long-lived listener (raw node:net). The product binds a fresh
 *                   listener per envelope (receiveOnce); this row isolates what
 *                   that per-message bind costs on the machine under test.
 *   text-file       write + read of --text-bytes of UTF-8 text on ext4: what a
 *                   text handoff of the retrieved evidence carries instead
 *                   (default = causal-state's mean top-5 chunk text)
 * Composite rows add the parts a state handoff actually performs:
 *   state-file  = envelope-file + payload-disk
 *   state-uds   = envelope-uds  + payload-tmpfs
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);
const { buildEnvelope, freezeSnapshot } = await imp("src/synapse/envelope.ts");
const { publishEnvelope, readDeliveredEnvelope, nodeIdFor } = await imp("src/synapse/envelope-inbox.ts");
const { publishEnvelopeViaUds, receiveDeliveredEnvelopeViaUds, udsEndpointPath } = await imp("src/synapse/envelope-uds.ts");
const { createContentStore } = await imp("src/synapse/content-store.ts");
const { SYNAPSE_VECTOR_MEDIA_TYPE } = await imp("src/synapse/embedding.ts");

const args = process.argv.slice(2);
const opt = (flag, fallback) => {
	const at = args.indexOf(flag);
	return at === -1 ? fallback : args[at + 1];
};
const N = Number(opt("--n", "2000"));
const WARMUP = Number(opt("--warmup", "200"));
const TEXT_BYTES = Number(opt("--text-bytes", "11327"));
const agentDir = path.join(os.homedir(), ".pi", "agent");
const OUT_ROOT = path.resolve(opt("--out", path.join(agentDir, "synapse", "experiments")));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const ID = opt("--id", `transport-${stamp}`);
const expDir = path.join(OUT_ROOT, ID);
fs.mkdirSync(expDir, { recursive: true });
const diskRoot = path.resolve(opt("--disk-root", path.join(expDir, "disk-store")));
// Short: an AF_UNIX endpoint path has a 107-byte budget.
const tmpfsRoot = path.resolve(opt("--tmpfs-root", fs.mkdtempSync("/dev/shm/synx-")));
const writeJson = (f, v) => fs.writeFileSync(f, `${JSON.stringify(v, null, "\t")}\n`);

function fsType(p) {
	const mounts = fs.readFileSync("/proc/mounts", "utf-8").split("\n").map((l) => l.split(" ")).filter((x) => x.length > 2);
	let best = null;
	for (const [, mnt, type] of mounts) if ((p === mnt || p.startsWith(mnt.endsWith("/") ? mnt : `${mnt}/`)) && (best === null || mnt.length > best.mnt.length)) best = { mnt, type };
	return best?.type ?? "unknown";
}

// ---------------------------------------------------------------------------
// Fixtures: a retrieve envelope carrying a float32 stateRef, as the product sends.
// ---------------------------------------------------------------------------
const vector = new Float32Array(1024);
for (let i = 0; i < vector.length; i += 1) vector[i] = Math.sin(i * 0.37) / 16;
const vectorBytes = new Uint8Array(vector.buffer);
const diskStore = createContentStore(diskRoot);
const tmpfsStore = createContentStore(tmpfsRoot);
const payloadId = diskStore.put(vectorBytes, SYNAPSE_VECTOR_MEDIA_TYPE);
const snapshot = freezeSnapshot({
	capabilityId: "c".repeat(64),
	corpusSnapshotId: "d".repeat(64),
	memoryRefs: ["a".repeat(64), "b".repeat(64)],
	namespaceId: "0123456789abcdef",
	permissionProjection: { pathPrefixes: ["src"], write: false },
	representationId: "siliconflow/BAAI/bge-m3/1024",
});
const runId = randomUUID();
function envelopeFor(i) {
	return buildEnvelope({
		action: "retrieve",
		attempt: 1,
		inputParams: { agent: "retriever", k: 5, task: "分析 src/synapse/envelope.ts 定义的 SYNAPSE 信封协议" },
		nodeId: nodeIdFor(runId, i),
		ownerRunId: runId,
		receiverSessionId: "sess-child",
		requestId: `req-${i}`,
		runId,
		senderSessionId: "sess-parent",
		snapshot,
		stateRef: { baseMemoryId: null, byteLength: vectorBytes.byteLength, dim: 1024, encoding: "float32-vector", payloadId, representationId: snapshot.representationId, sha256: payloadId },
	});
}
const sample = envelopeFor(0);
const textBody = "证据片段 evidence chunk ".repeat(Math.ceil(TEXT_BYTES / 20)).slice(0, TEXT_BYTES);
const textBuf = Buffer.from(textBody, "utf-8").subarray(0, TEXT_BYTES);

// ---------------------------------------------------------------------------
// Paths.
// ---------------------------------------------------------------------------
const paths = {
	"envelope-file": async (i) => {
		const env = envelopeFor(i % 64);
		const at = publishEnvelope(diskRoot, runId, i % 64, env);
		const got = readDeliveredEnvelope(at);
		if (got.status !== "ready") throw new Error(`file: ${got.reason ?? got.status}`);
		return { bytes: env.envelopeBytes };
	},
	"envelope-uds": async (i) => {
		const env = envelopeFor(i % 64);
		const endpoint = udsEndpointPath(tmpfsRoot, runId, i % 64);
		const receiving = receiveDeliveredEnvelopeViaUds(endpoint);
		const sent = await publishEnvelopeViaUds(endpoint, env);
		const got = await receiving;
		if (got.status !== "ready") throw new Error(`uds: ${got.reason ?? got.status}`);
		return { bytes: sent.bytesWritten };
	},
	"uds-persistent": async (i) => {
		const env = envelopeFor(i % 64);
		const frame = Buffer.alloc(4 + Buffer.byteLength(JSON.stringify(env.wire)));
		frame.writeUInt32BE(frame.byteLength - 4, 0);
		frame.write(JSON.stringify(env.wire), 4, "utf-8");
		const got = new Promise((resolve) => (persistent.onFrame = resolve));
		await new Promise((resolve) => {
			const c = net.createConnection({ path: persistent.path });
			c.once("connect", () => c.end(frame, resolve));
		});
		const body = await got;
		JSON.parse(body.subarray(4).toString("utf-8"));
		return { bytes: frame.byteLength };
	},
	"payload-disk": async () => {
		const id = diskStore.put(vectorBytes, SYNAPSE_VECTOR_MEDIA_TYPE);
		const back = diskStore.read(id);
		if (back.byteLength !== 4096) throw new Error("payload-disk short read");
		return { bytes: back.byteLength };
	},
	"payload-tmpfs": async () => {
		const id = tmpfsStore.put(vectorBytes, SYNAPSE_VECTOR_MEDIA_TYPE);
		const back = tmpfsStore.read(id);
		if (back.byteLength !== 4096) throw new Error("payload-tmpfs short read");
		return { bytes: back.byteLength };
	},
	"text-file": async (i) => {
		const f = path.join(diskRoot, "text-handoff", `${i % 64}.txt`);
		fs.mkdirSync(path.dirname(f), { recursive: true });
		const tmp = `${f}.tmp`;
		fs.writeFileSync(tmp, textBuf);
		fs.renameSync(tmp, f);
		const back = fs.readFileSync(f, "utf-8");
		return { bytes: Buffer.byteLength(back, "utf-8") };
	},
};

const persistent = { onFrame: null, path: path.join(tmpfsRoot, "persistent.sock") };
const persistentServer = net.createServer((socket) => {
	const parts = [];
	socket.on("data", (chunk) => parts.push(chunk));
	socket.on("end", () => persistent.onFrame?.(Buffer.concat(parts)));
});
await new Promise((resolve) => persistentServer.listen(persistent.path, resolve));

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const results = {};
for (const [name, fn] of Object.entries(paths)) {
	for (let i = 0; i < WARMUP; i += 1) await fn(i);
	const us = [];
	let bytes = null;
	for (let i = 0; i < N; i += 1) {
		const t = process.hrtime.bigint();
		const r = await fn(i);
		us.push(Number(process.hrtime.bigint() - t) / 1000);
		bytes = r.bytes;
	}
	us.sort((a, b) => a - b);
	results[name] = { bytesPerOp: bytes, meanUs: us.reduce((a, b) => a + b, 0) / us.length, n: N, p50Us: pct(us, 0.5), p95Us: pct(us, 0.95), p99Us: pct(us, 0.99) };
	console.log(`${name.padEnd(14)} bytes=${String(bytes).padStart(6)}  p50=${results[name].p50Us.toFixed(1)}µs  p95=${results[name].p95Us.toFixed(1)}µs  p99=${results[name].p99Us.toFixed(1)}µs`);
}
persistentServer.close();
const add = (a, b) => ({ bytesPerOp: results[a].bytesPerOp + results[b].bytesPerOp, composite: [a, b], p50Us: results[a].p50Us + results[b].p50Us, p95Us: results[a].p95Us + results[b].p95Us });
const composite = { "state-file": add("envelope-file", "payload-disk"), "state-uds": add("envelope-uds", "payload-tmpfs") };

writeJson(path.join(expDir, "manifest.json"), {
	createdAt: new Date().toISOString(),
	experimentId: ID,
	fs: { disk: { root: diskRoot, type: fsType(diskRoot) }, tmpfs: { root: tmpfsRoot, type: fsType(tmpfsRoot) } },
	kind: "transport",
	llm: "none",
	model: null,
	n: N,
	node: process.version,
	platform: `${os.type()} ${os.release()}`,
	sampleEnvelopeBytes: sample.envelopeBytes,
	textBytes: TEXT_BYTES,
	warmup: WARMUP,
});
writeJson(path.join(expDir, "summary.json"), {
	arms: Object.keys(results),
	comparison: {
		"p50Us:state-uds-vs-text-file": { diff: composite["state-uds"].p50Us - results["text-file"].p50Us, pct: (composite["state-uds"].p50Us - results["text-file"].p50Us) / results["text-file"].p50Us, syn: composite["state-uds"].p50Us, txt: results["text-file"].p50Us },
		"bytes:state-vs-text": { diff: composite["state-file"].bytesPerOp - TEXT_BYTES, pct: (composite["state-file"].bytesPerOp - TEXT_BYTES) / TEXT_BYTES, syn: composite["state-file"].bytesPerOp, txt: TEXT_BYTES },
	},
	composite,
	groups: [],
	results,
});
const lines = [`# transport — ${ID}`, "", `n=${N} per path (warmup ${WARMUP}); disk=${fsType(diskRoot)}, tmpfs=${fsType(tmpfsRoot)}; ${os.type()} ${os.release()}, node ${process.version}`, "", "| path | bytes/op | p50 µs | p95 µs | p99 µs |", "|---|---|---|---|---|"];
for (const [k, r] of Object.entries(results)) lines.push(`| ${k} | ${r.bytesPerOp} | ${r.p50Us.toFixed(1)} | ${r.p95Us.toFixed(1)} | ${r.p99Us.toFixed(1)} |`);
for (const [k, r] of Object.entries(composite)) lines.push(`| **${k}** (${r.composite.join(" + ")}) | ${r.bytesPerOp} | ${r.p50Us.toFixed(1)} | ${r.p95Us.toFixed(1)} | — |`);
fs.writeFileSync(path.join(expDir, "report.md"), `${lines.join("\n")}\n`);
fs.rmSync(tmpfsRoot, { force: true, recursive: true });
fs.rmSync(diskRoot, { force: true, recursive: true });
console.log(lines.join("\n"));
