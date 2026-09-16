import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { aggregateMetering, createMeteringLog, readMeteringLog, type MeteringIdentity, type MeteringLog } from "../../src/synapse/metering.ts";

let root = "";
let logPath = "";
let clock = 0;
let elapsed = 0;
let log: MeteringLog;

function identity(overrides: Partial<MeteringIdentity> = {}): MeteringIdentity {
	return {
		agent: overrides.agent ?? "planner",
		attempt: overrides.attempt ?? 1,
		mode: overrides.mode ?? "synapse",
		nodeId: overrides.nodeId ?? "node-1",
		runId: overrides.runId ?? "run-1",
		sessionId: overrides.sessionId ?? "sess-1",
		snapshotId: overrides.snapshotId ?? "snap-1",
	};
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-meter-"));
	logPath = path.join(root, "events.jsonl");
	clock = Date.UTC(2026, 8, 16, 0, 0, 0);
	elapsed = 0;
	log = createMeteringLog(logPath, { monotonicMs: () => (elapsed += 10), now: () => new Date(clock) });
});

afterEach(() => {
	fs.rmSync(root, { force: true, recursive: true });
});

describe("metering log durability", () => {
	it("appends one JSON line per event and never rewrites an earlier one", () => {
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 10, messageId: "m1", textBytes: 100 });
		const afterFirst = fs.readFileSync(logPath, "utf-8");
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 10, messageId: "m2", textBytes: 200 });
		const afterSecond = fs.readFileSync(logPath, "utf-8");
		assert.ok(afterSecond.startsWith(afterFirst), "an existing line must not change");
		assert.equal(afterSecond.trimEnd().split("\n").length, 2);
	});

	it("continues an existing log when the process restarts", () => {
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 10, messageId: "m1", textBytes: 100 });
		const reopened = createMeteringLog(logPath, { monotonicMs: () => 99, now: () => new Date(clock) });
		reopened.record(identity(), { kind: "message-delivered", envelopeBytes: 10, messageId: "m2", textBytes: 100 });
		assert.equal(readMeteringLog(logPath).length, 2);
	});

	it("stamps every event with identity, UTC time and monotonic elapsed time", () => {
		log.record(identity({ agent: "retriever" }), { kind: "message-delivered", envelopeBytes: 1, messageId: "m1", textBytes: 1 });
		const [event] = readMeteringLog(logPath);
		assert.ok(event);
		assert.equal(event.schemaVersion, 1);
		assert.equal(event.agent, "retriever");
		assert.equal(event.runId, "run-1");
		assert.equal(event.attempt, 1);
		assert.equal(event.mode, "synapse");
		assert.equal(event.snapshotId, "snap-1");
		assert.equal(event.ts, new Date(clock).toISOString());
		assert.equal(event.monotonicMs, 10);
		assert.match(event.eventId, /^[0-9a-f]{64}$/);
	});

	it("gives two otherwise identical events distinct ids", () => {
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 1, messageId: "m1", textBytes: 1 });
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 1, messageId: "m1", textBytes: 1 });
		const [first, second] = readMeteringLog(logPath);
		assert.notEqual(first?.eventId, second?.eventId);
	});

	it("rejects a malformed line rather than silently dropping it from the totals", () => {
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 1, messageId: "m1", textBytes: 1 });
		fs.appendFileSync(logPath, "{ not json\n");
		assert.throws(() => readMeteringLog(logPath), /integrity/);
	});
});

describe("message accounting (AC-09)", () => {
	it("counts one delivery per message id even if the same delivery is recorded twice", () => {
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 10, messageId: "m1", textBytes: 100 });
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 10, messageId: "m1", textBytes: 100 });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.messages.delivered, 1);
		assert.equal(totals.messages.duplicateDeliveries, 1);
	});

	it("counts a retry as its own attempt rather than folding it into the first", () => {
		log.record(identity({ attempt: 1 }), { kind: "message-delivered", envelopeBytes: 10, messageId: "m1", textBytes: 100 });
		log.record(identity({ attempt: 2 }), { kind: "message-delivered", envelopeBytes: 10, messageId: "m1", textBytes: 100 });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.messages.delivered, 2);
		assert.equal(totals.messages.duplicateDeliveries, 0);
		// The retry's cost is real work and must stay in the byte totals.
		assert.equal(totals.text.handoffBytes, 200);
	});

	it("does not let the receiving side add to the sent message count", () => {
		log.record(identity({ agent: "planner" }), { kind: "message-delivered", envelopeBytes: 10, messageId: "m1", textBytes: 100 });
		log.record(identity({ agent: "retriever" }), { kind: "message-received", messageId: "m1" });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.messages.delivered, 1);
		assert.equal(totals.messages.received, 1);
	});

	it("counts a failed send separately from a delivery", () => {
		log.record(identity(), { category: "timeout", kind: "message-failed", messageId: "m1" });
		log.record(identity({ attempt: 2 }), { kind: "message-delivered", envelopeBytes: 10, messageId: "m1", textBytes: 100 });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.messages.delivered, 1);
		assert.equal(totals.messages.failed, 1);
		assert.equal(totals.errors.timeout, 1);
	});

	it("counts envelope bytes apart from handoff text", () => {
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 40, messageId: "m1", textBytes: 100 });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.text.handoffBytes, 100);
		assert.equal(totals.control.envelopeBytes, 40);
	});

	it("reports transport bytes as unavailable while there is no socket", () => {
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 40, messageId: "m1", textBytes: 100 });
		assert.equal(aggregateMetering(readMeteringLog(logPath)).control.transportBytes, "N/A");
	});
});

describe("model and embedding usage (AC-09)", () => {
	it("keeps a missing usage report as unavailable rather than zero", () => {
		log.record(identity(), { kind: "model-usage", role: "child", usage: null });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.model.child.input, "unavailable");
		assert.equal(totals.model.complete, false);
	});

	it("sums usage only when every report is present", () => {
		log.record(identity(), { kind: "model-usage", role: "parent", usage: { cacheRead: 5, cacheWrite: 0, cost: 0.01, input: 100, output: 20 } });
		log.record(identity(), { kind: "model-usage", role: "child", usage: { cacheRead: 1, cacheWrite: 2, cost: 0.02, input: 50, output: 10 } });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.model.complete, true);
		assert.equal(totals.model.parent.input, 100);
		assert.equal(totals.model.child.output, 10);
		assert.equal(totals.model.totalCost, 0.03);
	});

	it("keeps cache reads out of the input total, since providers do not add them", () => {
		log.record(identity(), { kind: "model-usage", role: "parent", usage: { cacheRead: 900, cacheWrite: 0, cost: 0.01, input: 100, output: 20 } });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.model.parent.input, 100);
		assert.equal(totals.model.parent.cacheRead, 900);
	});

	it("records embedding cost even when the provider reports no price", () => {
		log.record(identity(), { costUsd: null, durationMs: 120, inputTokens: 64, kind: "embedding-call", ok: true, requests: 1 });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.embedding.requests, 1);
		assert.equal(totals.embedding.inputTokens, 64);
		assert.equal(totals.embedding.durationMs, 120);
		assert.equal(totals.embedding.costUsd, "unavailable");
	});

	it("counts a failed embedding call as a request that still cost time", () => {
		log.record(identity(), { costUsd: 0, durationMs: 300, inputTokens: null, kind: "embedding-call", ok: false, requests: 1 });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.embedding.requests, 1);
		assert.equal(totals.embedding.failed, 1);
		assert.equal(totals.embedding.durationMs, 300);
	});
});

describe("state plane accounting (AC-09)", () => {
	it("counts prepare, send, receive and consume separately", () => {
		for (const kind of ["state-prepare", "state-send", "state-receive", "state-consume"] as const) {
			log.record(identity(), { kind, ok: true, payloadBytes: 4096, representationId: "rep-1", stateId: "s1" });
		}
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.deepEqual(
			{ consumed: totals.state.consumed, prepared: totals.state.prepared, received: totals.state.received, sent: totals.state.sent },
			{ consumed: 1, prepared: 1, received: 1, sent: 1 },
		);
	});

	it("counts payload bytes once, on the send, not again on receive", () => {
		log.record(identity(), { kind: "state-send", ok: true, payloadBytes: 4096, representationId: "rep-1", stateId: "s1" });
		log.record(identity(), { kind: "state-receive", ok: true, payloadBytes: 4096, representationId: "rep-1", stateId: "s1" });
		assert.equal(aggregateMetering(readMeteringLog(logPath)).state.sentBytes, 4096);
	});

	it("keeps a failed send out of the successful totals but not out of the record", () => {
		log.record(identity(), { kind: "state-send", ok: false, payloadBytes: 4096, representationId: "rep-1", stateId: "s1" });
		log.record(identity({ attempt: 2 }), { kind: "state-send", ok: true, payloadBytes: 4096, representationId: "rep-1", stateId: "s1" });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.state.sent, 1);
		assert.equal(totals.state.failedSends, 1);
		// Both attempts crossed the wire, so both are in the byte total.
		assert.equal(totals.state.sentBytes, 8192);
	});

	it("does not count a handoff that carried only a memory id as a vector payload", () => {
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 80, messageId: "m1", textBytes: 0 });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.state.sent, 0);
		assert.equal(totals.state.sentBytes, 0);
	});

	it("reports consumption as the only proof the state was used", () => {
		log.record(identity(), { kind: "state-send", ok: true, payloadBytes: 4096, representationId: "rep-1", stateId: "s1" });
		log.record(identity(), { kind: "state-receive", ok: true, payloadBytes: 4096, representationId: "rep-1", stateId: "s1" });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.state.consumed, 0);
		assert.equal(totals.state.receivedWithoutConsume, 1);
	});
});

describe("memory and duration accounting (AC-09)", () => {
	it("reports hit rate over queries that returned an authorised, valid candidate", () => {
		log.record(identity(), { authorisedValidHits: 2, kind: "memory-query", queryId: "q1" });
		log.record(identity(), { authorisedValidHits: 0, kind: "memory-query", queryId: "q2" });
		log.record(identity(), { authorisedValidHits: 1, kind: "memory-query", queryId: "q3" });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.memory.queries, 3);
		assert.equal(totals.memory.hitRate, 2 / 3);
	});

	it("reports hit rate as not applicable when nothing was ever queried", () => {
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 1, messageId: "m1", textBytes: 1 });
		assert.equal(aggregateMetering(readMeteringLog(logPath)).memory.hitRate, "N/A");
	});

	it("counts reuse of another agent's memory apart from a plain read", () => {
		log.record(identity({ agent: "executor" }), { kind: "memory-reuse", memoryId: "a".repeat(64), sourceAgent: "retriever" });
		log.record(identity({ agent: "retriever" }), { kind: "memory-reuse", memoryId: "b".repeat(64), sourceAgent: "retriever" });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.memory.reuses, 2);
		assert.equal(totals.memory.crossAgentReuses, 1);
	});

	it("measures task duration as elapsed wall clock, not the sum of nested work", () => {
		log.record(identity(), { kind: "task-span", phase: "start", taskId: "t1" });
		// Two children run concurrently inside the same window.
		log.record(identity({ agent: "retriever" }), { kind: "task-span", phase: "start", taskId: "t1.a" });
		log.record(identity({ agent: "executor" }), { kind: "task-span", phase: "start", taskId: "t1.b" });
		log.record(identity({ agent: "retriever" }), { kind: "task-span", phase: "end", taskId: "t1.a" });
		log.record(identity({ agent: "executor" }), { kind: "task-span", phase: "end", taskId: "t1.b" });
		log.record(identity(), { kind: "task-span", phase: "end", taskId: "t1" });
		const totals = aggregateMetering(readMeteringLog(logPath));
		// Spans are 10ms apart; t1 covers the whole window rather than a1+b1.
		assert.equal(totals.duration.byTask["t1"], 50);
		assert.equal(totals.duration.totalMs, 50);
	});

	it("reports an unfinished span rather than inventing an end time", () => {
		log.record(identity(), { kind: "task-span", phase: "start", taskId: "t1" });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.duration.byTask["t1"], "unavailable");
		assert.deepEqual(totals.duration.unfinishedTasks, ["t1"]);
	});

	it("keeps object read and write bytes apart", () => {
		log.record(identity(), { bytes: 500, direction: "write", kind: "object-io" });
		log.record(identity(), { bytes: 120, direction: "read", kind: "object-io" });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.storage.writeBytes, 500);
		assert.equal(totals.storage.readBytes, 120);
	});
});

describe("aggregation is recomputable", () => {
	it("produces the same totals from the same raw log", () => {
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 10, messageId: "m1", textBytes: 100 });
		log.record(identity(), { authorisedValidHits: 1, kind: "memory-query", queryId: "q1" });
		const first = aggregateMetering(readMeteringLog(logPath));
		const second = aggregateMetering(readMeteringLog(logPath));
		assert.deepEqual(first, second);
	});

	it("records an unclassified error without absorbing it into a known category", () => {
		log.record(identity(), { category: "unclassified", kind: "error", detail: "TypeError: x is not a function" });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.errors.unclassified, 1);
	});
});
