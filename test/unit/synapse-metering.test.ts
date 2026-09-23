import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encodeFrame } from "../../src/synapse/envelope-framing.ts";
import { aggregateMetering, createMeteringLog, FULL_ACCOUNT_DEFINITION, HOT_BASE_NOTE, readMeteringLog, readProcessIdentity, recordProcessIdentity, recordTransportBytes, SYNAPSE_METERING_SCHEMA_VERSION, type MeteringIdentity, type MeteringLog } from "../../src/synapse/metering.ts";

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
		// A literal on purpose: bumping the metering schema is a deliberate act that
		// must change this line and the reader that documents the difference, never
		// something that slips through by comparing the constant to itself.
		assert.equal(event.schemaVersion, SYNAPSE_METERING_SCHEMA_VERSION);
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

describe("transportBytes (Task 3, design §4.1)", () => {
	it("(a) stays N/A, with every other field untouched, when the event stream carries no transport-bytes payload", () => {
		// A stream that exercises several unrelated categories at once, so a
		// regression that shifted some other field under the new case in
		// aggregateMetering's switch would show up here, not just in control.
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 40, messageId: "m1", textBytes: 100 });
		log.record(identity(), { kind: "message-received", messageId: "m1" });
		log.record(identity(), { bytes: 4096, direction: "write", kind: "object-io" });
		log.record(identity(), { kind: "model-usage", role: "parent", usage: { cacheRead: 10, cacheWrite: 20, cost: 0.5, input: 300, output: 40 } });
		log.record(identity(), { kind: "model-usage", role: "child", usage: { cacheRead: 1, cacheWrite: 2, cost: 0.25, input: 30, output: 4 } });

		const totals = aggregateMetering(readMeteringLog(logPath));

		// Field-for-field (逐字段), not a sample of it: every leaf of
		// MeteringTotals this stream can produce a non-default value for is
		// named here, so a regression anywhere in aggregateMetering's other
		// branches — not just under the new "transport-bytes" case — fails this
		// assertion instead of slipping past a hand-picked subset of fields.
		assert.deepEqual(totals, {
			capability: { probeFailures: 0, probeVerdicts: 0 },
			control: { envelopeBytes: 40, transportBytes: "N/A" },
			// No task span in this stream, so there is no parent writer to time
			// the run on: the duration is unavailable rather than inferred.
			duration: { byTask: {}, totalMs: "unavailable", unfinishedTasks: [] },
			embedding: { costUsd: 0, durationMs: 0, failed: 0, inputTokens: 0, requests: 0 },
			errors: {},
			fullAccount: {
				bytes: 40,
				components: { baseRebuildReadBytes: 0, baseSelectionReadBytes: 0, controlBytes: 40, payloadBytes: 0, resendBytes: 0 },
				definition: FULL_ACCOUNT_DEFINITION,
				embeddingCalls: { inputTokens: 0, requests: 0 },
				fallback: { hops: { fullVector: 0, resend: 0, text: 0 }, partitionConsistent: true, sendsWithRestore: 0 },
				hotBase: { bytesIfBaseResident: 40, derived: true, note: HOT_BASE_NOTE },
				notNamed: { payloadReadBytes: 0, rankingReadBytes: 0 },
			},
			memory: { crossAgentReuses: 0, distilled: 0, distilledWithoutVector: 0, hitRate: "N/A", queries: 0, reuses: 0 },
			messages: { delivered: 1, duplicateDeliveries: 0, failed: 0, received: 1 },
			model: {
				child: { cacheRead: 1, cacheWrite: 2, input: 30, output: 4 },
				complete: true,
				parent: { cacheRead: 10, cacheWrite: 20, input: 300, output: 40 },
				totalCost: 0.75,
			},
			state: {
				baseReadBytes: 0,
				baseSelectionReadBytes: 0,
				consumed: 0,
				deltaPayloadBytes: 0,
				failedSends: 0,
				prepared: 0,
				received: 0,
				receivedWithoutConsume: 0,
				restoreCount: 0,
				sent: 0,
				sentBytes: 0,
				vectorCacheHits: 0,
				vectorCacheMisses: 0,
				verificationRefusals: 0,
				verifications: 0,
			},
			storage: { readBytes: 0, writeBytes: 4096 },
			text: { handoffBytes: 100 },
		});
	});

	it("(a2) reports a genuine zero byte count as 0, not N/A — the reason the accumulator starts undefined rather than 0", () => {
		// The undefined-until-seen accumulator exists precisely to keep a
		// reported zero distinct from nothing having been reported. Every other
		// test in this file records a nonzero byte count, which an
		// `if (event.bytes) total += event.bytes` bug would also pass; only a
		// literal 0 catches that.
		recordTransportBytes(log, identity(), 0);
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.control.transportBytes, 0);
	});

	it("(b) aggregates uds-gear deliveries to the exact total frame bytes sent, header included", () => {
		// encodeFrame is the actual wire encoder envelope-uds.ts's
		// publishEnvelopeViaUds uses; its output length (4-byte header plus body)
		// is what a real UdsPublishResult.bytesWritten reports on a clean write.
		const frameA = encodeFrame(Buffer.from(JSON.stringify({ envelope: "a" }), "utf-8"));
		const frameB = encodeFrame(Buffer.from(JSON.stringify({ envelope: "much larger second body" }), "utf-8"));
		assert.notEqual(frameA.byteLength, frameB.byteLength, "the two frames must differ in size for this to be a real sum, not a coincidence");

		recordTransportBytes(log, identity(), frameA.byteLength);
		recordTransportBytes(log, identity(), frameB.byteLength);

		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.control.transportBytes, frameA.byteLength + frameB.byteLength);
	});

	it("(c) never lets transportBytes enter envelopeBytes, whatever order the two payloads arrive in", () => {
		recordTransportBytes(log, identity(), 512);
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 40, messageId: "m1", textBytes: 100 });
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 60, messageId: "m2", textBytes: 100 });
		recordTransportBytes(log, identity(), 256);

		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.control.transportBytes, 512 + 256);
		// envelopeBytes must reflect only the message-delivered events: 100, not
		// 100 + 768 (the sum a bug that folded transportBytes in would produce).
		assert.equal(totals.control.envelopeBytes, 100);
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
		for (const kind of ["state-prepare", "state-send", "state-receive"] as const) {
			log.record(identity(), { kind, ok: true, payloadBytes: 4096, representationId: "rep-1", stateId: "s1" });
		}
		// A consume is the receipt that proves retrieval happened, so it names the
		// payload, the corpus it ran against and how many chunks were ranked.
		log.record(identity(), {
			corpusSnapshotId: "c".repeat(64),
			k: 5,
			kind: "state-consume",
			ok: true,
			payloadBytes: 4096,
			payloadId: "p".repeat(64),
			representationId: "rep-1",
			stateId: "s1",
		});
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

	it("withdraws a consume the receiver's semantic check then refused", () => {
		// The ranking records its consume before the check runs. A refused state was
		// never used, so it must not count as consumed however the log is ordered.
		const consume = { corpusSnapshotId: "c".repeat(64), encoding: "delta", k: 3, kind: "state-consume", ok: true, payloadBytes: 96, payloadId: "s1", representationId: "rep-1", stateId: "s1" } as const;
		log.record(identity(), { kind: "state-receive", ok: true, payloadBytes: 96, representationId: "rep-1", stateId: "s1" });
		log.record(identity(), consume);
		log.record(identity(), { cosine: 0.4, kind: "state-verify", ok: false, stateId: "s1" });
		log.record(identity(), { kind: "state-receive", ok: true, payloadBytes: 4096, representationId: "rep-1", stateId: "s2" });
		log.record(identity(), { ...consume, payloadId: "s2", stateId: "s2" });
		log.record(identity(), { cosine: 0.99, kind: "state-verify", ok: true, stateId: "s2" });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.state.consumed, 1);
		assert.equal(totals.state.verificationRefusals, 1);
		assert.equal(totals.state.receivedWithoutConsume, 1);
	});
});

describe("duration on a log written before the writer field", () => {
	it("reads a writerless log the old way, as one writer's log", () => {
		const rows = [10, 50].map((monotonicMs, index) => JSON.stringify({ ...identity(), eventId: `e${index}`, kind: "message-received", messageId: "m1", monotonicMs, schemaVersion: 4, ts: new Date(clock).toISOString() }));
		fs.writeFileSync(logPath, `${rows.join("\n")}\n`, "utf-8");
		assert.equal(aggregateMetering(readMeteringLog(logPath)).duration.totalMs, 40);
	});
});

describe("full account (frozen definition)", () => {
	// One run's worth of events, so each test below can change exactly one thing.
	function recordRun(target: MeteringLog, overrides: { payloadRead?: boolean } = {}): void {
		target.record(identity(), { envelopeBytes: 80, kind: "message-delivered", messageId: "m1", textBytes: 100 });
		target.record(identity(), { kind: "state-send", ok: true, payloadBytes: 4096, representationId: "rep-1", stateId: "s1" });
		// A recovery hop: the same path paying for the bytes a second time.
		target.record(identity({ attempt: 2 }), { kind: "state-send", ok: true, payloadBytes: 1024, representationId: "rep-1", restore: "resend", stateId: "s2" });
		// The hop itself, recorded the way the recovery chain records it: the send
		// above declares the marker, this event counts the hop.
		target.record(identity({ attempt: 2 }), { hop: "resend", kind: "state-restore", ok: true });
		target.record(identity({ attempt: 2 }), { bytes: 1024, direction: "write", kind: "object-io" });
		target.record(identity(), { bytes: 4096, direction: "read", kind: "object-io", purpose: "base-rebuild" });
		target.record(identity(), { bytes: 512, direction: "read", kind: "object-io", purpose: "base-selection" });
		target.record(identity(), { bytes: 2048, direction: "read", kind: "object-io", purpose: "ranking" });
		if (overrides.payloadRead !== false) {
			target.record(identity(), { bytes: 4096, direction: "read", kind: "object-io", purpose: "payload-read" });
		}
		target.record(identity(), { costUsd: 0.0001, durationMs: 30, inputTokens: 12, kind: "embedding-call", ok: true, requests: 1 });
	}

	it("sums the frozen components and partitions the sent bytes without overlap", () => {
		recordRun(log);
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.deepEqual(totals.fullAccount.components, {
			baseRebuildReadBytes: 4096,
			baseSelectionReadBytes: 512,
			// Hand-counted from the events recorded above rather than compared with the
			// control field, which the same aggregation line produces: comparing the two
			// would restate the assignment instead of checking the rule.
			controlBytes: 80,
			payloadBytes: 4096,
			resendBytes: 1024,
		});
		// 4096 first transmission + 1024 recovery + 80 control + 4096 base rebuild + 512 selection.
		assert.equal(totals.fullAccount.bytes, 9808);
		// The two payload components partition the state plane's sent bytes rather than
		// restating the total, so a recovery hop can never be counted twice.
		assert.equal(totals.fullAccount.components.payloadBytes + totals.fullAccount.components.resendBytes, totals.state.sentBytes);
	});

	it("keeps the receiver's payload read out of the frozen sum but still reports it", () => {
		// Two separate logs, not two runs appended to one: appending would double every
		// component and the comparison would be between one run and two.
		const withoutReadPath = path.join(root, "without-payload-read.jsonl");
		const withoutReadLog = createMeteringLog(withoutReadPath, { monotonicMs: () => (elapsed += 10), now: () => new Date(clock) });
		recordRun(withoutReadLog, { payloadRead: false });
		recordRun(log);
		const withoutRead = aggregateMetering(readMeteringLog(withoutReadPath));
		const withRead = aggregateMetering(readMeteringLog(logPath));
		// Both arms read their payload back, so the figure the arms are compared on
		// must not move when that read appears.
		assert.equal(withRead.fullAccount.bytes, withoutRead.fullAccount.bytes);
		assert.equal(withoutRead.fullAccount.notNamed.payloadReadBytes, 0);
		assert.equal(withRead.fullAccount.notNamed.payloadReadBytes, 4096);
	});

	it("reports the corpus ranking reads separately from the transfer account", () => {
		recordRun(log);
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.fullAccount.notNamed.rankingReadBytes, 2048);
		// Ranking is the retrieval the state is used for, not the transfer itself.
		assert.equal(totals.fullAccount.bytes, 9808);
	});

	it("labels the hot-base row as derived and computes it as the cold figure minus base reads", () => {
		recordRun(log);
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.fullAccount.hotBase.bytesIfBaseResident, 9808 - 4096 - 512);
		assert.equal(totals.fullAccount.hotBase.derived, true);
		assert.match(totals.fullAccount.hotBase.note, /derived|arithmetic/i);
		// The conditional has to survive a consumer that serialises the object and
		// keeps only the number, so it is in the field name as well as the flag.
		assert.match(JSON.stringify(totals.fullAccount.hotBase), /IfBaseResident/);
	});

	it("counts the recovery hops by kind and checks the hop marker against them", () => {
		recordRun(log);
		log.record(identity({ attempt: 3 }), { hop: "text", kind: "state-restore", ok: true });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.deepEqual(totals.fullAccount.fallback.hops, { fullVector: 0, resend: 1, text: 1 });
		// One recorded hop carries the marker on its send; the text hop does not send
		// at all, so it must not be demanded from the sends.
		assert.equal(totals.fullAccount.fallback.sendsWithRestore, 1);
		assert.equal(totals.fullAccount.fallback.partitionConsistent, true);
		// The hop count is metric ④, arrived at independently of the hops breakdown.
		assert.equal(totals.state.restoreCount, 2);
	});

	it("flags a recovery send that never declared itself a hop", () => {
		recordRun(log);
		// A second recovery hop whose send forgot its marker: the bytes move from the
		// resend component to the first-transmission one, so the breakdown is wrong
		// while ② (which holds both) is not.
		log.record(identity({ attempt: 3 }), { kind: "state-send", ok: true, payloadBytes: 700, representationId: "rep-1", stateId: "s3" });
		log.record(identity({ attempt: 3 }), { hop: "resend", kind: "state-restore", ok: true });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.fullAccount.fallback.partitionConsistent, false);
		assert.equal(totals.fullAccount.fallback.sendsWithRestore, 1);
		assert.equal(totals.fullAccount.fallback.hops.resend, 2);
	});

	it("carries the definition with the number and counts embedding calls as calls, not bytes", () => {
		recordRun(log);
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.match(totals.fullAccount.definition, /payload/i);
		assert.match(totals.fullAccount.definition, /base-selection/i);
		assert.deepEqual(totals.fullAccount.embeddingCalls, { inputTokens: 12, requests: 1 });
	});

	it("reports cache hits and misses as counts of their own", () => {
		// Without these, "fewer reads" and "fewer records" are indistinguishable, and a
		// reader cannot tell whether a cache-on run is comparable to a cache-off one.
		recordRun(log);
		log.record(identity(), { hits: 1, kind: "vector-cache", misses: 1 });
		log.record(identity(), { hits: 2, kind: "vector-cache", misses: 0 });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.state.vectorCacheHits, 3);
		assert.equal(totals.state.vectorCacheMisses, 1);
		// They are counts, not bytes: the frozen account must not move because a read was
		// served from memory instead of from the store.
		assert.equal(totals.fullAccount.bytes, 9808);
	});

	it("counts the receiver's semantic checks and its refusals separately", () => {
		// Counted where the refusal happens, so a refusal that a fallback rescued and one
		// that ended the consume are both in the same column.
		log.record(identity(), { cosine: 0.999, kind: "state-verify", ok: true });
		log.record(identity(), { cosine: 0.4, kind: "state-verify", ok: false });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.state.verifications, 2);
		assert.equal(totals.state.verificationRefusals, 1);
		// A check is not a transfer: the frozen byte account must not move because one ran.
		assert.equal(totals.fullAccount.bytes, 0);
	});

	it("leaves an unattributed read out of every component", () => {
		log.record(identity(), { bytes: 700, direction: "read", kind: "object-io" });
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.fullAccount.bytes, 0);
		assert.deepEqual(totals.fullAccount.notNamed, { payloadReadBytes: 0, rankingReadBytes: 0 });
		// It is still storage traffic; it simply belongs to no arm.
		assert.equal(totals.storage.readBytes, 700);
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

	it("takes the run's span from the parent's own clock, not from a second writer's", () => {
		log.record(identity(), { kind: "task-span", phase: "start", taskId: "t1" });
		log.record(identity(), { kind: "task-span", phase: "end", taskId: "t1" });
		const parent = readMeteringLog(logPath);
		// A background child is a separate process appending to this same file, and
		// its monotonic clock restarts at its own log instance. Written as a raw line
		// because that is what the second writer actually produces: this process's
		// log cannot mint a reading from another process's origin.
		const childRow = { ...parent[0]!, eventId: "9".repeat(64), kind: "message-received", messageId: "m-child", monotonicMs: 1_000_000, writer: 987_654 };
		fs.appendFileSync(logPath, `${JSON.stringify(childRow)}\n`, "utf-8");

		const totals = aggregateMetering(readMeteringLog(logPath));
		// The parent's own span. Without the writer scope this would be the child's
		// million-millisecond reading minus the parent's origin.
		assert.equal(totals.duration.totalMs, parent[1]!.monotonicMs - parent[0]!.monotonicMs);
		// The child's row is not discarded from what it is a count of.
		assert.equal(totals.messages.received, 1);
	});

	it("reports an unfinished span rather than inventing an end time", () => {		log.record(identity(), { kind: "task-span", phase: "start", taskId: "t1" });
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

describe("process identity binding", () => {
	// A fixture stat line whose comm field is parenthesised and itself contains
	// spaces and a nested paren, the case that breaks naive whitespace-splitting.
	function statLine(startTicks: number): string {
		return `12345 (my (weird) prog) S 1 12345 12345 34816 12345 4194304 100 0 5 0 20 5 0 0 20 0 4 0 ${startTicks} 10000000 500 18446744073709551615\n`;
	}

	it("parses startTicks from field 22 past the last close-paren of a tricky comm", () => {
		const snapshot = readProcessIdentity({
			pid: 4242,
			readFile: (filePath) => {
				if (filePath === "/proc/self/stat") return statLine(67890);
				if (filePath === "/proc/uptime") return "12345.67 54321.89\n";
				throw new Error(`unexpected path: ${filePath}`);
			},
			// Explicit, so the snapshot does not depend on whatever the machine
			// running the suite happens to have exported.
			env: {},
		});
		assert.deepEqual(snapshot, { cgroupPath: null, pid: 4242, startTicks: 67890, topology: "process", uptimeAtRecordSeconds: 12345.67 });
	});

	it("returns null rather than throwing when /proc does not exist", () => {
		const snapshot = readProcessIdentity({
			readFile: () => {
				throw new Error("ENOENT: no such file or directory, open '/proc/self/stat'");
			},
		});
		assert.equal(snapshot, null);
	});

	it("returns null when a field cannot be parsed as a number", () => {
		const snapshot = readProcessIdentity({ readFile: (filePath) => (filePath === "/proc/self/stat" ? "not a stat line" : "12345.67 0\n") });
		assert.equal(snapshot, null);
	});

	it("records a process-identity event when the OS identity is available", () => {
		recordProcessIdentity(log, identity(), { pid: 4242, readFile: (filePath) => (filePath === "/proc/self/stat" ? statLine(67890) : "12345.67 0\n") });
		const [event] = readMeteringLog(logPath);
		assert.ok(event);
		assert.equal(event.kind, "process-identity");
		assert.equal(event.kind === "process-identity" && event.pid, 4242);
		assert.equal(event.kind === "process-identity" && event.startTicks, 67890);
		assert.equal(event.kind === "process-identity" && event.uptimeAtRecordSeconds, 12345.67);
	});

	it("records the launch topology so a container run and a process run are told apart", () => {
		recordProcessIdentity(log, identity(), {
			pid: 7,
			readFile: (filePath) => (filePath === "/proc/self/stat" ? statLine(1) : filePath === "/proc/uptime" ? "1.0 0\n" : "0::/system.slice/pi-agent-a.scope\n"),
			env: { PI_SUBAGENT_LAUNCH_TOPOLOGY: "container" },
		});
		const [event] = readMeteringLog(logPath);
		assert.ok(event);
		assert.equal(event.kind === "process-identity" && event.topology, "container");
		assert.equal(event.kind === "process-identity" && event.degradedReason, undefined);
	});

	it("records the reason a run fell back, so a degraded run is not read as a process run by choice", () => {
		recordProcessIdentity(log, identity(), {
			pid: 7,
			readFile: (filePath) => (filePath === "/proc/self/stat" ? statLine(1) : filePath === "/proc/uptime" ? "1.0 0\n" : "0::/\n"),
			env: {
				PI_SUBAGENT_LAUNCH_TOPOLOGY: "process",
				PI_SUBAGENT_LAUNCH_DEGRADED_REASON: "No container engine is usable: isula (not found on PATH).",
			},
		});
		const [event] = readMeteringLog(logPath);
		assert.ok(event);
		assert.equal(event.kind === "process-identity" && event.topology, "process");
		assert.match(event.kind === "process-identity" ? (event.degradedReason ?? "") : "", /not found on PATH/);
	});

	it("carries the cgroup id S3 will key attribution on once the swap happens", () => {
		recordProcessIdentity(log, identity(), {
			pid: 7,
			readFile: (filePath) => (filePath === "/proc/self/stat" ? statLine(1) : filePath === "/proc/uptime" ? "1.0 0\n" : "0::/system.slice/pi-agent-a.scope\n"),
			env: { PI_SUBAGENT_LAUNCH_TOPOLOGY: "container" },
		});
		const [event] = readMeteringLog(logPath);
		assert.equal(event?.kind === "process-identity" && event.cgroupPath, "/system.slice/pi-agent-a.scope");
	});

	it("reports an unreadable cgroup as absent rather than as an empty id", () => {
		recordProcessIdentity(log, identity(), {
			pid: 7,
			readFile: (filePath) => {
				if (filePath === "/proc/self/stat") return statLine(1);
				if (filePath === "/proc/uptime") return "1.0 0\n";
				throw new Error("ENOENT");
			},
			env: { PI_SUBAGENT_LAUNCH_TOPOLOGY: "process" },
		});
		const [event] = readMeteringLog(logPath);
		assert.ok(event);
		assert.equal(event.kind === "process-identity" && event.cgroupPath, null);
	});

	it("defaults to the process topology when nothing told the child otherwise", () => {
		recordProcessIdentity(log, identity(), {
			pid: 7,
			readFile: (filePath) => (filePath === "/proc/self/stat" ? statLine(1) : filePath === "/proc/uptime" ? "1.0 0\n" : "0::/\n"),
			env: {},
		});
		const [event] = readMeteringLog(logPath);
		assert.equal(event?.kind === "process-identity" && event.topology, "process");
	});

	it("prefers the unified cgroup line over an arbitrary v1 controller", () => {
		recordProcessIdentity(log, identity(), {
			pid: 7,
			readFile: (filePath) =>
				filePath === "/proc/self/stat" ? statLine(1)
				: filePath === "/proc/uptime" ? "1.0 0\n"
				: "12:pids:/user.slice/session-3.scope\n11:blkio:/user.slice\n0::/system.slice/pi-agent-a.scope\n",
			env: { PI_SUBAGENT_LAUNCH_TOPOLOGY: "container" },
		});
		const [event] = readMeteringLog(logPath);
		// The v1 controller lines disagree with each other and with the unified one;
		// picking whichever came first would key attribution on a different hierarchy
		// than the I/O collector reads.
		assert.equal(event?.kind === "process-identity" && event.cgroupPath, "/system.slice/pi-agent-a.scope");
	});

	it("falls back to a v1 controller line when there is no unified line", () => {
		recordProcessIdentity(log, identity(), {
			pid: 7,
			readFile: (filePath) =>
				filePath === "/proc/self/stat" ? statLine(1)
				: filePath === "/proc/uptime" ? "1.0 0\n"
				: "12:blkio:/user.slice/session-3.scope\n",
			env: {},
		});
		const [event] = readMeteringLog(logPath);
		assert.equal(event?.kind === "process-identity" && event.cgroupPath, "/user.slice/session-3.scope");
	});

	it("records the storage root the launch declared, so a wrong declaration is auditable", () => {
		recordProcessIdentity(log, identity(), {
			pid: 7,
			readFile: (filePath) => (filePath === "/proc/self/stat" ? statLine(1) : filePath === "/proc/uptime" ? "1.0 0\n" : "0::/\n"),
			env: { PI_SUBAGENT_LAUNCH_TOPOLOGY: "container", PI_SUBAGENT_LAUNCH_STORAGE_ROOT: "/srv/pi/synapse" },
		});
		const [event] = readMeteringLog(logPath);
		assert.equal(event?.kind === "process-identity" && event.declaredStorageRoot, "/srv/pi/synapse");
	});

	it("records nothing and does not throw when the OS identity is unavailable", () => {
		const result = recordProcessIdentity(log, identity(), {
			readFile: () => {
				throw new Error("ENOENT");
			},
		});
		assert.equal(result, null);
		assert.deepEqual(readMeteringLog(logPath), []);
	});

	it("does not shift the duration span: aggregateMetering is identical with or without it", () => {
		log.record(identity(), { kind: "task-span", phase: "start", taskId: "t1" });
		log.record(identity(), { kind: "message-delivered", envelopeBytes: 10, messageId: "m1", textBytes: 100 });
		log.record(identity(), { kind: "task-span", phase: "end", taskId: "t1" });
		const withoutIdentity = aggregateMetering(readMeteringLog(logPath));

		recordProcessIdentity(log, identity(), { pid: 1, readFile: (filePath) => (filePath === "/proc/self/stat" ? statLine(1) : "0.5 0\n") });
		const withIdentity = aggregateMetering(readMeteringLog(logPath));

		assert.deepEqual(withIdentity, withoutIdentity);
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
