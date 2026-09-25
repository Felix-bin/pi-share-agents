/**
 * A foreground child's auto-distill must see the child's final output.
 *
 * The foreground close ran before `result.finalOutput` was assigned, so the
 * distiller always received "" and wrote nothing (observed in synapse-bench
 * smoke3-4arm: four `memory-distill` events with `written: 0` while the same
 * rule extracted 7–12 lines from those children's saved outputs). The
 * background path reads the output from the session messages and never had
 * the gap. This drives the real `runSync` against the scripted in-process
 * child and reads the records back from the store.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createMockPi, createTempDir, makeAgentConfigs, removeTempDir } from "../support/helpers.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { readMeteringLog } from "../../src/synapse/metering.ts";

const OUTPUT = [
	"Summary of the auth flow.",
	"ESTABLISHED:",
	"- the login path checks the session cookie first",
	"- tokens are rotated every hour by src/auth/rotate.ts",
	"NOT ESTABLISHED:",
	"- whether refresh tokens are revoked on logout",
].join("\n");

describe("foreground auto-distill", () => {
	let mockPi: MockPi;
	let tempDir: string;
	let storageRoot: string;
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => mockPi.uninstall());

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
		const agentDir = path.join(tempDir, "agent");
		storageRoot = path.join(tempDir, "store");
		fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "extensions", "subagent", "config.json"),
			JSON.stringify({ synapse: { autoDistill: true, memory: "project", mode: "synapse", storageRoot } }),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		removeTempDir(tempDir);
	});

	it("distills the ESTABLISHED lines of the child's final output into shared memory", async () => {
		mockPi.onCall({ output: OUTPUT });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Explain the auth flow", { runId: "fg-distill", index: 0, waitToolEnabled: false });
		assert.equal(result.exitCode, 0);

		const memoryDir = path.join(storageRoot, "memory");
		const records = fs.existsSync(memoryDir)
			? fs.readdirSync(memoryDir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(memoryDir, name), "utf-8")))
			: [];
		const distilled = records.filter((record) => Array.isArray(record.tags) && record.tags.includes("auto-distill"));
		assert.equal(distilled.length, 2, "both ESTABLISHED lines land as records");
		assert.ok(distilled.every((record) => record.provenance.agent === "echo"));

		const meteringDir = path.join(storageRoot, "metering");
		const events = fs.readdirSync(meteringDir).flatMap((name) => readMeteringLog(path.join(meteringDir, name)));
		const distillEvents = events.filter((event) => event.kind === "memory-distill");
		assert.equal(distillEvents.length, 1);
		assert.equal((distillEvents[0] as { written: number }).written, 2);
	});
});
