import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { autoDistillOutput, distillMemoryLines } from "../../src/synapse/auto-distill.ts";
import type { SynapseChildContract } from "../../src/synapse/child-contract.ts";
import type { LaunchContract } from "../../src/synapse/lifecycle.ts";

/**
 * Host-side distillation is the deterministic path to memory reuse: models
 * rarely call the remember tool on their own (P50: zero writes in thirty
 * rounds), so the host decides by one frozen rule what a completed child's
 * output contributes. These tests pin the rule and the switch semantics —
 * off by default, on writes through the production store schema, and an
 * embedding failure degrades the record to keyword-only rather than dropping
 * the sediment.
 */

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-auto-distill-"));
after(() => fs.rmSync(tempRoot, { force: true, recursive: true }));

function contractFor(autoDistill: boolean): SynapseChildContract {
	return {
		agent: "retriever",
		autoDistill,
		contextBudgetBytes: 8192,
		contract: { storageRoot: tempRoot } as unknown as LaunchContract,
		delta: false,
		embedding: null,
		runId: "run-1",
		sessionId: "session-1",
		vectorCache: false,
	};
}

const provenance = { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "session-1" };

describe("distillMemoryLines", () => {
	it("takes the ESTABLISHED block and stops at NOT ESTABLISHED", () => {
		const lines = distillMemoryLines(
			["intro prose that is not memory", "", "- a bullet that predates the status block and is ignored once it exists", "", "ESTABLISHED: the codec lives in delta.ts with grid 127", "the wire field is transport_bytes in metering.ts", "", "NOT ESTABLISHED: the exact int8 clamp behaviour"].join("\n"),
		);
		assert.deepEqual(lines, ["the codec lives in delta.ts with grid 127", "the wire field is transport_bytes in metering.ts"]);
	});

	it("falls back to substantial bullet lines when no status block exists", () => {
		const lines = distillMemoryLines(["# Heading", "- short", "- the residual codec quantises onto grid 127 at threshold 0.99"].join("\n"));
		assert.deepEqual(lines, ["the residual codec quantises onto grid 127 at threshold 0.99"]);
	});

	it("caps line length and count", () => {
		const long = "x".repeat(500);
		const many = Array.from({ length: 20 }, (_, index) => `- fact number ${index} with enough words to clear the floor`);
		const lines = distillMemoryLines([`- ${long}`, ...many].join("\n"));
		assert.equal(lines.length, 12);
		assert.ok(lines[0]!.endsWith("…"));
		assert.equal(lines[0]!.length, 400);
	});
});

describe("autoDistillOutput", () => {
	it("writes nothing when the switch is off", async () => {
		const result = await autoDistillOutput({ contract: contractFor(false), embedder: null, provenance, taskText: "task" }, "ESTABLISHED: a fact worth keeping");
		assert.deepEqual(result, { written: 0, withoutVector: 0 });
		assert.equal(fs.existsSync(path.join(tempRoot, "memory")), false);
	});

	it("writes each distilled line as a record with the embedder's vector", async () => {
		const storeRoot = path.join(tempRoot, "with-vector");
		fs.mkdirSync(storeRoot, { recursive: true });
		const contract = { ...contractFor(true), contract: { storageRoot: storeRoot } as unknown as LaunchContract };
		const result = await autoDistillOutput(
			{ contract, embedder: { embed: async () => new Float32Array([0.5, 0.5]), representationId: "test/embed/2" }, provenance, taskText: "Find the residual codec and report the grid" },
			"ESTABLISHED: the codec lives in delta.ts with grid 127",
		);
		assert.deepEqual(result, { written: 1, withoutVector: 0 });
		const records = fs.readdirSync(path.join(storeRoot, "memory")).filter((name) => name.endsWith(".json"));
		assert.equal(records.length, 1);
		const stored = JSON.parse(fs.readFileSync(path.join(storeRoot, "memory", records[0]!), "utf-8"));
		assert.equal(stored.kind, "evidence");
		assert.equal(stored.embedding.representationId, "test/embed/2");
		assert.equal(stored.embedding.dim, 2);
		assert.equal(stored.taskTopic, "Find the residual codec and report the grid");
		assert.deepEqual(stored.tags, ["auto-distill"]);
		assert.equal(stored.provenance.agent, "retriever");
	});

	it("keeps the record keyword-only when its embedding call fails", async () => {
		const storeRoot = path.join(tempRoot, "no-vector");
		fs.mkdirSync(storeRoot, { recursive: true });
		const contract = { ...contractFor(true), contract: { storageRoot: storeRoot } as unknown as LaunchContract };
		const result = await autoDistillOutput(
			{
				contract,
				embedder: {
					embed: async () => {
						throw new Error("provider down");
					},
					representationId: "test/embed/2",
				},
				provenance,
				taskText: "task",
			},
			"ESTABLISHED: a fact whose vector cannot be computed right now",
		);
		assert.deepEqual(result, { written: 1, withoutVector: 1 });
		const records = fs.readdirSync(path.join(storeRoot, "memory")).filter((name) => name.endsWith(".json"));
		assert.equal(records.length, 1);
		const stored = JSON.parse(fs.readFileSync(path.join(storeRoot, "memory", records[0]!), "utf-8"));
		assert.equal(stored.embedding, null);
	});

	it("distills nothing from an output with no memory-worthy lines", async () => {
		const result = await autoDistillOutput({ contract: contractFor(true), embedder: null, provenance, taskText: "task" }, "just prose, no bullets and no status block");
		assert.deepEqual(result, { written: 0, withoutVector: 0 });
	});
});
