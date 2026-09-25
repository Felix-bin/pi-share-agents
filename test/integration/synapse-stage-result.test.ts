/**
 * The orchestrator receives a stage's result block, not its whole output.
 *
 * Driven through the real `runSync` against the scripted in-process child, so
 * the seam under test is the one production uses: the close publishes the
 * stage output and the attempt hands the orchestrator the block, while the
 * text arm — the pure-text baseline — must see exactly what it saw before.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createMockPi, createTempDir, makeAgentConfigs, removeTempDir } from "../support/helpers.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { runSingleStepInner } from "../../src/runs/background/subagent-runner.ts";
import createRunnerChildSessionFactory from "../support/runner-child-session-factory.ts";
import { createContentStore } from "../../src/synapse/content-store.ts";
import { createMemoryStore } from "../../src/synapse/memory-store.ts";
import { aggregateMetering, readMeteringLog, type MeteringEvent } from "../../src/synapse/metering.ts";
import { STAGE_RESULT_MAX_BYTES } from "../../src/synapse/stage-result.ts";

const OUTPUT = [
	"# Evidence",
	...Array.from({ length: 40 }, (_, index) => `- src/synapse/envelope.ts:${index + 10} carries wire field number ${index}, quoted here so the body is long`),
	"",
	"ESTABLISHED:",
	"- SYNAPSE_PROTOCOL_VERSION = 2 (src/synapse/envelope.ts:20)",
	"NOT ESTABLISHED:",
	"- whether any caller relies on the receipt summary",
].join("\n");

describe("stage result hand-over", () => {
	let mockPi: MockPi;
	let tempDir: string;
	let storageRoot: string;
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => mockPi.uninstall());

	function configure(mode: "synapse" | "text"): void {
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify({ synapse: { memory: "project", mode, storageRoot } }));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	}

	function meteringEvents(): Array<Record<string, unknown>> {
		const dir = path.join(storageRoot, "metering");
		return fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((name) => readMeteringLog(path.join(dir, name))) as unknown as Array<Record<string, unknown>> : [];
	}

	beforeEach(() => {
		tempDir = createTempDir();
		storageRoot = path.join(tempDir, "store");
		mockPi.reset();
	});

	afterEach(() => {
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		removeTempDir(tempDir);
	});

	it("hands the orchestrator a bounded block whose handle reads the whole output back", async () => {
		configure("synapse");
		mockPi.onCall({ output: OUTPUT });
		const result = await runSync(tempDir, makeAgentConfigs(["retriever"]), "retriever", "Analyse the envelope", { runId: "stage-syn", index: 0, waitToolEnabled: false });
		assert.equal(result.exitCode, 0);
		const block = result.finalOutput ?? "";
		const handle = /handle=([0-9a-f]{64})/.exec(block)?.[1];
		assert.ok(handle, `a handle in: ${block.slice(0, 200)}`);
		assert.ok(Buffer.byteLength(block) <= STAGE_RESULT_MAX_BYTES);
		assert.match(block, /^- SYNAPSE_PROTOCOL_VERSION = 2/m);
		assert.ok(!block.includes("wire field number 7"), "the body stays in the store");

		const contentStore = createContentStore(storageRoot);
		const record = createMemoryStore(storageRoot, { contentStore }).get(handle);
		assert.equal(record.kind, "evidence");
		assert.equal(new TextDecoder().decode(contentStore.read(record.contentId)).trim(), OUTPUT.trim());

		const stage = meteringEvents().filter((event) => event.kind === "stage-result");
		assert.equal(stage.length, 1);
		assert.equal(stage[0]!.memoryId, handle);
		assert.equal(stage[0]!.renderedBytes, Buffer.byteLength(block));
		const totals = aggregateMetering(meteringEvents() as unknown as MeteringEvent[]);
		assert.deepEqual(totals.stageResults, { count: 1, fallbacks: 0, fullBytes: Buffer.byteLength(OUTPUT.trim()), renderedBytes: Buffer.byteLength(block) });

		const receipts = fs.readdirSync(path.join(storageRoot, "receipts"));
		const receipt = JSON.parse(fs.readFileSync(path.join(storageRoot, "receipts", receipts[0]!), "utf-8"));
		assert.equal(receipt.result.memoryId, handle);
		assert.equal(receipt.outputRef.contentId, record.contentId);
		assert.equal(receipt.persistence, "stored");
	});

	it("leaves the text arm's hand-over exactly as it was", async () => {
		configure("text");
		mockPi.onCall({ output: OUTPUT });
		const result = await runSync(tempDir, makeAgentConfigs(["retriever"]), "retriever", "Analyse the envelope", { runId: "stage-txt", index: 0, waitToolEnabled: false });
		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput?.trim(), OUTPUT.trim());
		assert.equal(meteringEvents().filter((event) => event.kind === "stage-result").length, 0);
	});

	it("hands the background runner's summary the same block", async () => {
		configure("synapse");
		mockPi.onCall({ output: OUTPUT });
		const agent = makeAgentConfigs(["retriever"])[0]!;
		const result = await runSingleStepInner(
			{ ...agent, agent: agent.name, task: "Analyse the envelope", context: "fresh", modelCandidates: [], waitToolEnabled: false } as unknown as Parameters<typeof runSingleStepInner>[0],
			{ cwd: tempDir, id: "stage-bg", flatIndex: 0, flatStepCount: 1, previousOutput: "", placeholder: "{previous}", outputFile: path.join(tempDir, "output.log"), sessionEnabled: false, childSessions: createRunnerChildSessionFactory() } as unknown as Parameters<typeof runSingleStepInner>[1],
		);
		assert.equal(result.exitCode, 0, result.error);
		assert.match(result.output ?? "", /^\[SYNAPSE result\] agent=retriever status=completed handle=[0-9a-f]{64}/);
		assert.ok(!(result.output ?? "").includes("wire field number 7"));
	});

	it("returns the deliverable whole", async () => {
		configure("synapse");
		mockPi.onCall({ output: OUTPUT });
		const result = await runSync(tempDir, makeAgentConfigs(["summarizer"]), "summarizer", "Answer the task", { runId: "stage-sum", index: 0, waitToolEnabled: false });
		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput?.trim(), OUTPUT.trim());
	});

	it("hands a failed stage's output over whole and publishes nothing", async () => {
		configure("synapse");
		mockPi.onCall({ exitCode: 1, output: OUTPUT });
		const result = await runSync(tempDir, makeAgentConfigs(["retriever"]), "retriever", "Analyse the envelope", { runId: "stage-fail", index: 0, waitToolEnabled: false });
		assert.notEqual(result.exitCode, 0);
		assert.ok(!(result.finalOutput ?? "").startsWith("[SYNAPSE result]"));
		assert.equal(meteringEvents().filter((event) => event.kind === "stage-result").length, 0);
	});
});
