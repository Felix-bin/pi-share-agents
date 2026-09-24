import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	aggregateRuns,
	listExperiments,
	listMemories,
	listRuns,
	memoryReuseGraph,
	readAcceptance,
	readExperiment,
	readRun,
	readRunProtocol,
	readStatePayload,
	resolveDashboardContext,
	searchMemories,
	writeSynapseConfig,
} from "../../src/api/dashboard.ts";
import { createContentStore } from "../../src/synapse/content-store.ts";
import { SYNAPSE_VECTOR_MEDIA_TYPE } from "../../src/synapse/embedding.ts";
import { createMeteringLog, type MeteringIdentity } from "../../src/synapse/metering.ts";
import { createMemoryStore } from "../../src/synapse/memory-store.ts";

let agentDir = "";
let worktree = "";

function identity(agent: string, runId: string): MeteringIdentity {
	return { agent, attempt: 1, mode: "synapse", nodeId: `${runId}/0`, runId, sessionId: "sess-1", snapshotId: null };
}

/** Every file under a directory, so a test can prove a read left the store as it found it. */
function snapshot(dir: string): string[] {
	const files: string[] = [];
	const walk = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else files.push(`${path.relative(dir, full)}:${fs.statSync(full).size}`);
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return files.sort();
}

function seedStore(storageRoot: string): { payloadId: string } {
	let clock = Date.UTC(2026, 8, 20);
	const now = () => new Date((clock += 1000));
	const first = createMeteringLog(path.join(storageRoot, "metering", "run-a.jsonl"), { now });
	first.record(identity("retriever", "run-a"), { kind: "task-span", phase: "start", taskId: "t-a" });
	first.record(identity("retriever", "run-a"), { authorisedValidHits: 0, kind: "memory-query", queryId: "q1" });
	first.record(identity("retriever", "run-a"), { envelopeBytes: 300, kind: "message-delivered", messageId: "m1", textBytes: 4000 });
	first.record(identity("retriever", "run-a"), { kind: "task-span", phase: "end", taskId: "t-a" });
	const second = createMeteringLog(path.join(storageRoot, "metering", "run-b.jsonl"), { now });
	second.record(identity("executor", "run-b"), { authorisedValidHits: 2, kind: "memory-query", queryId: "q2" });
	second.record(identity("executor", "run-b"), { kind: "memory-reuse", memoryId: "mem-1", sourceAgent: "retriever" });
	second.record(identity("executor", "run-b"), { envelopeBytes: 280, kind: "message-delivered", messageId: "m2", textBytes: 3600 });

	const content = createContentStore(storageRoot);
	const vector = new Float32Array([0.6, -0.8, 0, 0]);
	const payloadId = content.put(new Uint8Array(vector.buffer), SYNAPSE_VECTOR_MEDIA_TYPE);
	const text = content.put(new TextEncoder().encode("iSulad shares an IPC namespace through an anchor container."), "text/plain");
	createMemoryStore(storageRoot, { contentStore: content, now }).publish({
		assurance: "observation",
		contentId: text,
		kind: "evidence",
		operationId: "op-1",
		provenance: { agent: "retriever", attempt: 1, runId: "run-a", sessionId: "sess-1" },
		summary: "iSulad --ipc container:<anchor> shares /dev/shm between agents",
		tags: ["openeuler", "isulad"],
		taskTopic: "openEuler container IPC",
	});

	const envelopeDir = path.join(storageRoot, "envelopes", "run-a");
	fs.mkdirSync(envelopeDir, { recursive: true });
	fs.writeFileSync(path.join(envelopeDir, "0.json"), "{\"not\":\"an envelope\"}");
	const receipts = path.join(storageRoot, "receipts");
	fs.mkdirSync(receipts, { recursive: true });
	fs.writeFileSync(path.join(receipts, "run-a-0-abcd1234.json"), JSON.stringify({ accepted: true, outcome: "completed", summary: "ok" }));
	fs.writeFileSync(path.join(receipts, "run-b-0-abcd1234.json"), JSON.stringify({ accepted: true }));
	return { payloadId };
}

beforeEach(() => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-dash-agent-"));
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-dash-wt-"));
});

afterEach(() => {
	fs.rmSync(agentDir, { force: true, recursive: true });
	fs.rmSync(worktree, { force: true, recursive: true });
});

describe("dashboard context", () => {
	it("reports an off configuration and a store that does not exist yet without creating it", () => {
		const context = resolveDashboardContext({ agentDir, cwd: worktree });
		assert.equal(context.config?.mode, "off");
		assert.equal(context.configError, null);
		assert.equal(context.storeExists, false);
		assert.equal(fs.existsSync(context.storageRoot), false);
	});

	it("surfaces an invalid block as an error rather than throwing", () => {
		fs.mkdirSync(path.dirname(path.join(agentDir, "extensions", "subagent", "config.json")), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify({ synapse: { mode: "loud" } }));
		const context = resolveDashboardContext({ agentDir, cwd: worktree });
		assert.equal(context.config, null);
		assert.match(context.configError ?? "", /mode/);
	});
});

describe("dashboard reads", () => {
	it("lists runs, aggregates them, and leaves the store untouched", async () => {
		const context = resolveDashboardContext({ agentDir, cwd: worktree });
		const { payloadId } = seedStore(context.storageRoot);
		const before = snapshot(context.storageRoot);

		const runs = listRuns(context.storageRoot);
		assert.deepEqual(runs.map((run) => run.runId).sort(), ["run-a", "run-b"]);
		assert.equal(runs.find((run) => run.runId === "run-a")?.kinds["message-delivered"], 1);

		const detail = readRun(context.storageRoot, "run-a");
		assert.equal(detail.integrity, null);
		if (detail.integrity === null) {
			assert.equal(detail.totals.messages.delivered, 1);
			assert.equal(detail.totals.text.handoffBytes, 4000);
			assert.equal(detail.kernel.kind, "not-collected");
			assert.equal(detail.traceCollected, false);
		}

		const both = aggregateRuns(context.storageRoot, ["run-a", "run-b", "run-b"]);
		assert.equal(both.totals.messages.delivered, 2);
		assert.equal(both.totals.memory.queries, 2);
		assert.equal(both.totals.memory.hitRate, 0.5);

		const protocol = readRunProtocol(context.storageRoot, "run-a");
		assert.equal(protocol.envelopes.length, 1);
		assert.equal(protocol.envelopes[0]?.envelope.status, "rejected");
		assert.deepEqual(protocol.receipts.map((entry) => entry.requestId), ["run-a-0-abcd1234"]);
		assert.deepEqual(protocol.messages.map((message) => [message.textBytes, message.envelopeBytes]), [[4000, 300]]);

		const memories = listMemories(context.storageRoot);
		assert.equal(memories.error, null);
		assert.equal(memories.records.length, 1);

		const search = await searchMemories(context, { query: "isulad ipc" });
		assert.equal(search.error, null);
		assert.equal(search.ranking, "keyword-tag");
		assert.equal(search.result?.results.length, 1);
		const semantic = await searchMemories(context, { query: "isulad", semantic: true });
		assert.equal(semantic.ranking, "keyword-tag");
		assert.match(semantic.semanticReason ?? "", /no embedding provider/);

		const graph = memoryReuseGraph(context.storageRoot);
		assert.deepEqual(graph.edges.map((edge) => [edge.from, edge.to, edge.count]), [["retriever", "executor", 1]]);
		assert.deepEqual(graph.series.map((point) => point.cumulativeHitRate), [0, 0.5]);
		assert.equal(graph.authors.retriever, 1);

		const payload = readStatePayload(context.storageRoot, payloadId);
		assert.equal(payload.error, null);
		if (payload.error === null) {
			assert.equal(payload.dim, 4);
			assert.ok(Math.abs((payload.norm ?? 0) - 1) < 1e-6);
		}

		assert.deepEqual(snapshot(context.storageRoot), before);
	});

	it("reports a corrupt ledger as an integrity error", () => {
		const context = resolveDashboardContext({ agentDir, cwd: worktree });
		fs.mkdirSync(path.join(context.storageRoot, "metering"), { recursive: true });
		fs.writeFileSync(path.join(context.storageRoot, "metering", "bad.jsonl"), "{not json\n");
		assert.match(readRun(context.storageRoot, "bad").integrity ?? "", /integrity/);
		assert.equal(listRuns(context.storageRoot)[0]?.integrity, "line 1 is not valid JSON");
	});
});

describe("acceptance and experiments", () => {
	it("judges the newest S1 report with the extension's own judge", () => {
		const dir = path.join(agentDir, "synapse", "acceptance");
		fs.mkdirSync(dir, { recursive: true });
		const fixture = fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", "s1", "no-engine-report.json"), "utf-8");
		fs.writeFileSync(path.join(dir, "s1-2026-09-24T00-00-00Z.json"), fixture);
		fs.writeFileSync(path.join(dir, "s3-2026-09-24T00-00-00Z.json"), "{\"schemaVersion\":99}");
		const overview = readAcceptance(dir);
		assert.equal(overview.s1?.error, null);
		assert.equal(overview.s1?.verdict?.verdict, "incomplete");
		assert.match(overview.s3?.error ?? "", /schema/);
		assert.equal(overview.s2, null);
	});

	it("lists experiments and tolerates a torn last line", () => {
		const dir = path.join(agentDir, "synapse", "experiments");
		const expDir = path.join(dir, "synbench-1");
		fs.mkdirSync(expDir, { recursive: true });
		fs.writeFileSync(path.join(expDir, "manifest.json"), JSON.stringify({ experimentId: "synbench-1" }));
		fs.writeFileSync(path.join(expDir, "rounds.jsonl"), `${JSON.stringify({ arm: "SYN", round: 1 })}\n{"arm":`);
		fs.writeFileSync(path.join(expDir, "progress.ndjson"), `${JSON.stringify({ type: "round-end" })}\n`);
		const list = listExperiments(dir);
		assert.equal(list.length, 1);
		assert.equal(list[0]?.rounds, 1);
		assert.equal(list[0]?.hasSummary, false);
		const detail = readExperiment(dir, "synbench-1");
		assert.equal(detail.error, null);
		assert.equal(readExperiment(dir, "../etc").error, "invalid experiment id");
	});
});

describe("config writes", () => {
	it("validates before writing and keeps the other keys", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ other: 1, synapse: { memory: "project", mode: "synapse" } }));
		const off = writeSynapseConfig(agentDir, { mode: "off" });
		assert.equal(off.error, null);
		assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf-8")), { other: 1, synapse: { mode: "off" } });
		const refused = writeSynapseConfig(agentDir, { memory: "project" });
		assert.match(refused.error ?? "", /memory must be off/);
		assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf-8")).synapse, { mode: "off" });
		const text = writeSynapseConfig(agentDir, { memory: "project", mode: "text" });
		assert.equal(text.error, null);
		if (text.error === null) assert.equal(text.config.memory, "project");
	});
});

describe("import graph", () => {
	it("never reaches pi itself or the extension's host-only modules", () => {
		const seen = new Set<string>();
		const bare = new Set<string>();
		const pattern = /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm;
		const walk = (file: string): void => {
			if (seen.has(file)) return;
			seen.add(file);
			const source = fs.readFileSync(file, "utf-8");
			for (const match of source.matchAll(pattern)) {
				const specifier = match[1]!;
				if (specifier.startsWith(".")) walk(path.resolve(path.dirname(file), specifier));
				else bare.add(specifier);
			}
		};
		const root = path.resolve(import.meta.dirname, "..", "..");
		walk(path.join(root, "src", "api", "dashboard.ts"));
		const reached = [...bare].filter((specifier) => specifier.startsWith("@earendil-works/"));
		assert.deepEqual(reached, []);
		const extensionFiles = [...seen].filter((file) => file.startsWith(path.join(root, "src", "extension") + path.sep));
		assert.deepEqual(extensionFiles, []);
	});
});
