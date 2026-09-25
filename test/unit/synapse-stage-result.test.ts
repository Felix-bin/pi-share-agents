import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { SynapseChildContract } from "../../src/synapse/child-contract.ts";
import { createContentStore } from "../../src/synapse/content-store.ts";
import type { LaunchContract } from "../../src/synapse/lifecycle.ts";
import { createMemoryStore } from "../../src/synapse/memory-store.ts";
import {
	STAGE_OUTPUT_TAG,
	STAGE_RESULT_MAX_BYTES,
	publishStageOutput,
	renderStageResult,
	stageOutcomeFor,
	stageResultApplies,
} from "../../src/synapse/stage-result.ts";

/**
 * A pipeline stage hands its successor a result block and a handle, not its
 * whole output: the text travels once, into the store, and the block carries
 * what the stage established. These tests pin the block's shape and bounds,
 * which agents it applies to, and that the handle reads the full text back.
 */

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-stage-result-"));
after(() => fs.rmSync(tempRoot, { force: true, recursive: true }));

const MEMORY_ID = "a".repeat(64);
const provenance = { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "session-1" };

function contractIn(storeRoot: string, agent = "retriever"): SynapseChildContract {
	return {
		agent,
		autoDistill: true,
		contextBudgetBytes: 8192,
		contract: { storageRoot: storeRoot } as unknown as LaunchContract,
		delta: false,
		embedding: null,
		runId: "run-1",
		sessionId: "session-1",
		vectorCache: false,
	};
}

const LONG_OUTPUT = [
	"# Evidence",
	"",
	...Array.from({ length: 40 }, (_, index) => `- src/synapse/envelope.ts:${index + 10} carries field number ${index} of the wire form, quoted verbatim here to make the body long`),
	"",
	"ESTABLISHED:",
	"- SYNAPSE_PROTOCOL_VERSION = 2 (src/synapse/envelope.ts:20)",
	"- unknown fields are rejected: additionalProperties false",
	"NOT ESTABLISHED:",
	"- whether any caller relies on the receipt summary",
].join("\n");

describe("stageResultApplies", () => {
	it("covers the intermediate pipeline roles only", () => {
		assert.equal(stageResultApplies("planner"), true);
		assert.equal(stageResultApplies("retriever"), true);
		assert.equal(stageResultApplies("executor"), true);
		assert.equal(stageResultApplies("summarizer"), false, "the deliverable returns in full");
		assert.equal(stageResultApplies("worker"), false, "an ad-hoc delegation keeps its answer");
	});
});

describe("renderStageResult", () => {
	it("carries the handle, the byte count and the status blocks, within the bound", () => {
		const block = renderStageResult({ agent: "retriever", memoryId: MEMORY_ID, output: LONG_OUTPUT });
		const first = block.split("\n")[0]!;
		assert.equal(first, `[SYNAPSE result] agent=retriever status=completed handle=${MEMORY_ID} bytes=${Buffer.byteLength(LONG_OUTPUT)}`);
		assert.match(block, /^ESTABLISHED:\n- SYNAPSE_PROTOCOL_VERSION = 2 \(src\/synapse\/envelope\.ts:20\)\n- unknown fields are rejected: additionalProperties false$/m);
		assert.match(block, /^NOT ESTABLISHED:\n- whether any caller relies on the receipt summary$/m);
		assert.ok(block.endsWith(`Full text: synapse_read {"action":"get","memoryId":"${MEMORY_ID}"}`));
		assert.ok(Buffer.byteLength(block) <= STAGE_RESULT_MAX_BYTES);
		assert.ok(!block.includes("field number 3 of the wire form"), "the body stays in the store");
	});

	it("returns a small output whole, with the handle", () => {
		const output = "ESTABLISHED: the plan has three steps";
		const block = renderStageResult({ agent: "planner", memoryId: MEMORY_ID, output });
		assert.equal(block, `[SYNAPSE result] agent=planner status=completed handle=${MEMORY_ID} bytes=${Buffer.byteLength(output)} (full text inline)\n${output}`);
	});

	it("falls back to the substantial bullet lines when there is no status block", () => {
		const output = ["# Plan", ...Array.from({ length: 30 }, (_, index) => `- step ${index}: read the file that defines part ${index} of the protocol and report it`)].join("\n");
		const block = renderStageResult({ agent: "planner", memoryId: MEMORY_ID, output });
		assert.match(block, /^ESTABLISHED:\n- step 0: read the file/m);
		assert.ok(!block.includes("NOT ESTABLISHED:"));
		assert.ok(Buffer.byteLength(block) <= STAGE_RESULT_MAX_BYTES);
	});

	it("keeps twelve lines of at most two hundred characters", () => {
		const output = ["ESTABLISHED:", ...Array.from({ length: 20 }, (_, index) => `- fact ${index} ${"y".repeat(300)}`)].join("\n");
		const block = renderStageResult({ agent: "retriever", memoryId: MEMORY_ID, output });
		const lines = block.split("\n").filter((line) => line.startsWith("- "));
		assert.ok(lines.length <= 12);
		assert.ok(lines.every((line) => line.length <= 202), "two hundred characters plus the bullet");
		assert.ok(Buffer.byteLength(block) <= STAGE_RESULT_MAX_BYTES);
	});

	it("says it truncated when the output has no lines to extract", () => {
		const output = "plain prose ".repeat(400);
		const block = renderStageResult({ agent: "executor", memoryId: MEMORY_ID, output });
		assert.match(block, /^\(no ESTABLISHED lines; first 1024 bytes follow, the rest is behind the handle\)$/m);
		assert.ok(Buffer.byteLength(block) <= STAGE_RESULT_MAX_BYTES);
	});

	it("stops NOT ESTABLISHED at a fence, so appended bookkeeping never becomes a line", () => {
		const output = `${LONG_OUTPUT}\n\`\`\`acceptance-report\n{"criteriaSatisfied":[]}\n\`\`\``;
		const block = renderStageResult({ agent: "retriever", memoryId: MEMORY_ID, output });
		assert.ok(!block.includes("acceptance-report"));
		assert.ok(!block.includes("criteriaSatisfied"));
	});

	it("never splits a multi-byte character when it truncates", () => {
		const output = "中文证据".repeat(400);
		const block = renderStageResult({ agent: "executor", memoryId: MEMORY_ID, output });
		assert.ok(!block.includes("�"));
		assert.ok(Buffer.byteLength(block) <= STAGE_RESULT_MAX_BYTES);
	});
});

describe("publishStageOutput", () => {
	it("files the whole output under the role's kind, tagged, without a vector, and reads it back", () => {
		const storeRoot = path.join(tempRoot, "publish");
		fs.mkdirSync(storeRoot, { recursive: true });
		const published = publishStageOutput({ agent: "retriever", contract: contractIn(storeRoot), output: LONG_OUTPUT, provenance, taskText: "Analyse the envelope protocol" });
		assert.equal(published.bytes, Buffer.byteLength(LONG_OUTPUT));
		const contentStore = createContentStore(storeRoot);
		const store = createMemoryStore(storeRoot, { contentStore });
		const record = store.get(published.memoryId);
		assert.ok(record);
		assert.equal(record.kind, "evidence");
		assert.deepEqual(record.tags, [STAGE_OUTPUT_TAG, "retriever"]);
		assert.equal(record.embedding, null);
		assert.equal(record.summary, "SYNAPSE_PROTOCOL_VERSION = 2 (src/synapse/envelope.ts:20)");
		assert.equal(new TextDecoder().decode(contentStore.read(record.contentId)), LONG_OUTPUT);
	});
});

describe("stageOutcomeFor", () => {
	it("publishes and renders for an intermediate role", () => {
		const storeRoot = path.join(tempRoot, "outcome");
		fs.mkdirSync(storeRoot, { recursive: true });
		const outcome = stageOutcomeFor({ agent: "retriever", contract: contractIn(storeRoot), output: LONG_OUTPUT, provenance, taskText: "task" });
		assert.ok(outcome);
		assert.equal(outcome.fullBytes, Buffer.byteLength(LONG_OUTPUT));
		assert.equal(outcome.renderedBytes, Buffer.byteLength(outcome.rendered));
		assert.ok(outcome.rendered.includes(`handle=${outcome.memoryId}`));
	});

	it("returns null for the deliverable, an ad-hoc agent and an empty output", () => {
		const storeRoot = path.join(tempRoot, "outcome-null");
		fs.mkdirSync(storeRoot, { recursive: true });
		assert.equal(stageOutcomeFor({ agent: "summarizer", contract: contractIn(storeRoot, "summarizer"), output: LONG_OUTPUT, provenance, taskText: "t" }), null);
		assert.equal(stageOutcomeFor({ agent: "worker", contract: contractIn(storeRoot, "worker"), output: LONG_OUTPUT, provenance, taskText: "t" }), null);
		assert.equal(stageOutcomeFor({ agent: "retriever", contract: contractIn(storeRoot), output: "   ", provenance, taskText: "t" }), null);
		assert.equal(fs.existsSync(path.join(storeRoot, "memory")), false, "nothing was published");
	});
});
