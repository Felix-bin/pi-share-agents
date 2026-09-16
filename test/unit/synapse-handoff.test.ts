import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReceipt, prepareHandoffContext, type HandoffCandidate, type ReceiptInput } from "../../src/synapse/handoff.ts";

function candidate(overrides: Partial<HandoffCandidate> = {}): HandoffCandidate {
	return {
		contentId: overrides.contentId ?? "a".repeat(64),
		memoryId: overrides.memoryId ?? "b".repeat(64),
		score: overrides.score ?? 0.9,
		sourceAgent: overrides.sourceAgent ?? "retriever",
		sourcePath: overrides.sourcePath === undefined ? "src/a.ts" : overrides.sourcePath,
		summary: overrides.summary ?? "编码器返回常量",
		validity: overrides.validity ?? "current",
	};
}

const bodies = new Map<string, string>([["b".repeat(64), "完整的证据正文，比摘要长很多，重复出现会明显增加交接成本。"]]);

function readBody(memoryId: string): string {
	return bodies.get(memoryId) ?? `正文 ${memoryId.slice(0, 6)}`;
}

describe("context preparation", () => {
	it("passes references and summaries in synapse mode, not bodies", () => {
		const prepared = prepareHandoffContext({ budgetBytes: 4096, candidates: [candidate()], mode: "synapse", readBody });
		assert.equal(prepared.refs.length, 1);
		assert.match(prepared.text, /编码器返回常量/);
		assert.equal(prepared.text.includes("完整的证据正文"), false);
		assert.equal(prepared.carriedBodies, false);
	});

	it("carries the body text in text mode, because the receiver has no way to fetch it", () => {
		const prepared = prepareHandoffContext({ budgetBytes: 4096, candidates: [candidate()], mode: "text", readBody });
		assert.match(prepared.text, /完整的证据正文/);
		assert.equal(prepared.carriedBodies, true);
		// The reference is still recorded so the run log can attribute the material.
		assert.deepEqual(prepared.refs, ["b".repeat(64)]);
	});

	it("costs more in text mode than in synapse mode for the same memories", () => {
		const shared = [candidate()];
		const asText = prepareHandoffContext({ budgetBytes: 4096, candidates: shared, mode: "text", readBody });
		const asSynapse = prepareHandoffContext({ budgetBytes: 4096, candidates: shared, mode: "synapse", readBody });
		assert.ok(asText.bytes > asSynapse.bytes);
		assert.equal(asText.bytes, Buffer.byteLength(asText.text, "utf-8"));
	});

	it("prepares nothing at all when the extension is off", () => {
		const prepared = prepareHandoffContext({ budgetBytes: 4096, candidates: [candidate()], mode: "off", readBody });
		assert.equal(prepared.text, "");
		assert.deepEqual(prepared.refs, []);
		assert.equal(prepared.bytes, 0);
	});

	it("keeps the highest ranked memories when the budget runs out", () => {
		const candidates = [
			candidate({ memoryId: "1".repeat(64), score: 0.9, summary: "第一条摘要内容" }),
			candidate({ memoryId: "2".repeat(64), score: 0.5, summary: "第二条摘要内容" }),
			candidate({ memoryId: "3".repeat(64), score: 0.1, summary: "第三条摘要内容" }),
		];
		const full = prepareHandoffContext({ budgetBytes: 4096, candidates, mode: "synapse", readBody });
		const tight = prepareHandoffContext({ budgetBytes: Math.floor(full.bytes / 2), candidates, mode: "synapse", readBody });
		assert.ok(tight.refs.length < full.refs.length);
		assert.equal(tight.refs[0], "1".repeat(64));
		assert.ok(tight.bytes <= Math.floor(full.bytes / 2));
	});

	it("drops whole entries rather than cutting one in half", () => {
		const candidates = [candidate({ memoryId: "1".repeat(64), summary: "第一条" }), candidate({ memoryId: "2".repeat(64), summary: "第二条" })];
		const prepared = prepareHandoffContext({ budgetBytes: 60, candidates, mode: "synapse", readBody });
		for (const ref of prepared.refs) assert.ok(prepared.text.includes(ref.slice(0, 12)));
		assert.equal(prepared.text.includes("第二条…"), false);
	});

	it("returns an empty section rather than a fragment when nothing fits", () => {
		const prepared = prepareHandoffContext({ budgetBytes: 5, candidates: [candidate()], mode: "synapse", readBody });
		assert.equal(prepared.text, "");
		assert.deepEqual(prepared.refs, []);
		assert.equal(prepared.omitted, 1);
	});

	it("reports how many candidates were left out so the omission is visible", () => {
		const candidates = [candidate({ memoryId: "1".repeat(64) }), candidate({ memoryId: "2".repeat(64) }), candidate({ memoryId: "3".repeat(64) })];
		const prepared = prepareHandoffContext({ budgetBytes: 150, candidates, mode: "synapse", readBody });
		assert.equal(prepared.refs.length + prepared.omitted, 3);
	});

	it("never presents a stale or unavailable memory as current evidence", () => {
		const candidates = [
			candidate({ memoryId: "1".repeat(64), validity: "stale" }),
			candidate({ memoryId: "2".repeat(64), validity: "unavailable" }),
			candidate({ memoryId: "3".repeat(64), validity: "current" }),
		];
		const prepared = prepareHandoffContext({ budgetBytes: 4096, candidates, mode: "synapse", readBody });
		assert.deepEqual(prepared.refs, ["3".repeat(64)]);
		assert.equal(prepared.excludedByValidity, 2);
	});

	it("attributes each entry to the agent that recorded it", () => {
		const prepared = prepareHandoffContext({
			budgetBytes: 4096,
			candidates: [candidate({ sourceAgent: "executor" })],
			mode: "synapse",
			readBody,
		});
		assert.match(prepared.text, /executor/);
		assert.match(prepared.text, /src\/a\.ts/);
	});
});

describe("compact receipt", () => {
	function receiptInput(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
		return {
			memoryRefs: overrides.memoryRefs ?? ["b".repeat(64)],
			meteringRef: overrides.meteringRef ?? "events.jsonl#12",
			outcome: overrides.outcome ?? "completed",
			outputRef: overrides.outputRef === undefined ? { bytes: 2048, contentId: "c".repeat(64), verified: true } : overrides.outputRef,
			persistence: overrides.persistence ?? "stored",
			snapshotId: overrides.snapshotId ?? "d".repeat(64),
			summary: overrides.summary ?? "已完成检索并给出结论",
		};
	}

	it("carries the snapshot, references and a metering pointer", () => {
		const receipt = buildReceipt(receiptInput());
		assert.equal(receipt.snapshotId, "d".repeat(64));
		assert.deepEqual(receipt.memoryRefs, ["b".repeat(64)]);
		assert.equal(receipt.meteringRef, "events.jsonl#12");
		assert.equal(receipt.outputRef?.contentId, "c".repeat(64));
	});

	it("does not publish an output reference that was never verified", () => {
		const receipt = buildReceipt(receiptInput({ outputRef: { bytes: 2048, contentId: "c".repeat(64), verified: false } }));
		assert.equal(receipt.outputRef, null);
		assert.equal(receipt.persistence, "failed");
	});

	it("keeps a failed task failed no matter what the summary claims", () => {
		const receipt = buildReceipt(receiptInput({ outcome: "failed", summary: "一切顺利，任务已完成" }));
		assert.equal(receipt.outcome, "failed");
		assert.equal(receipt.accepted, false);
	});

	it("does not treat a stored memory as acceptance of the task", () => {
		const receipt = buildReceipt(receiptInput({ outcome: "failed", persistence: "stored" }));
		assert.equal(receipt.accepted, false);
		// The observation is still recorded: a failed task may have produced real evidence.
		assert.deepEqual(receipt.memoryRefs, ["b".repeat(64)]);
	});

	it("keeps the task outcome when storage fails, and says so", () => {
		const receipt = buildReceipt(receiptInput({ persistence: "failed" }));
		assert.equal(receipt.outcome, "completed");
		assert.equal(receipt.persistence, "failed");
		assert.equal(receipt.accepted, true);
	});

	it("refuses to report a cancelled task as accepted", () => {
		assert.equal(buildReceipt(receiptInput({ outcome: "cancelled" })).accepted, false);
	});

	it("trims an over-long summary rather than shipping an unbounded receipt", () => {
		const receipt = buildReceipt(receiptInput({ summary: "很".repeat(4000) }));
		assert.ok(Buffer.byteLength(receipt.summary, "utf-8") <= 2048);
		assert.equal(receipt.summaryTruncated, true);
	});

	it("is stable: the same inputs produce the same receipt", () => {
		assert.deepEqual(buildReceipt(receiptInput()), buildReceipt(receiptInput()));
	});
});
