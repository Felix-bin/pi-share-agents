import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SynapseChildContract } from "../../src/synapse/child-contract.ts";
import { meteringLogPath } from "../../src/synapse/delegation.ts";
import { resolveLaunchContract } from "../../src/synapse/lifecycle.ts";
import { createMemoryService } from "../../src/synapse/memory-service.ts";
import { aggregateMetering, readMeteringLog } from "../../src/synapse/metering.ts";
import { deriveNamespaceId } from "../../src/synapse/namespace.ts";
import { capabilityForAgent } from "../../src/synapse/roles.ts";
import type { ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import { closeChildDelegation, openChildDelegation, openChildDelegationWithState } from "../../src/runs/shared/synapse-delegation.ts";
import { SYNAPSE_KEY_ENV } from "../../src/synapse/credentials.ts";
import { SYNAPSE_STATE_CONSUMING_TOOLS } from "../../src/synapse/roles.ts";

/**
 * The functions both execution paths call. Foreground and background differ in
 * everything except this pair, so a difference in what they record would have
 * to start here.
 */

let root = "";
let store = "";
let worktree = "";

const USAGE = { cacheRead: 0, cacheWrite: 0, cost: 0.1, input: 10, output: 5, turns: 1 };

function childContract(): SynapseChildContract {
	return {
		agent: "retriever",
		contextBudgetBytes: 8192,
		contract: resolveLaunchContract({
			capabilityId: capabilityForAgent({ agent: "retriever", childTools: ["read"], representationId: "unavailable" }).capabilityId,
			memoryRefs: [],
			corpusSnapshotId: "unset",
			deliveryGear: "file",
			mode: "synapse",
			namespaceId: deriveNamespaceId(worktree),
			representationId: "unavailable",
			scope: { pathPrefixes: [""], write: true },
			stateVerify: "off",
			storageRoot: store,
		}),
		capabilityTools: ["read", "grep"],
		delta: false,
		embedding: null,
		runId: "run-7",
		sessionId: "sess-parent",
		vectorCache: false,
	};
}

function runtime(synapse: SynapseChildContract | undefined): ChildRuntimeConfig {
	const config: ChildRuntimeConfig = {
		agent: "retriever",
		childIndex: 0,
		depth: 1,
		fanoutChild: false,
		fast: false,
		inheritGlobalContext: true,
		inheritProjectContext: true,
		inheritSkills: false,
		maxDepth: 2,
		waitTool: { enabled: true },
	};
	if (synapse !== undefined) config.synapse = synapse;
	return config;
}

function openFor(synapse: SynapseChildContract | undefined, message: string) {
	return openChildDelegation({
		cwd: worktree,
		message,
		receiverSessionId: "sess-child",
		runtime: runtime(synapse),
	});
}

function totals() {
	return aggregateMetering(readMeteringLog(meteringLogPath(childContract().contract, "run-7")));
}

beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-bridge-"));
	store = path.join(root, "store");
	worktree = path.join(root, "worktree");
	fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
	fs.writeFileSync(path.join(worktree, "src", "auth.ts"), "export const login = 1;\n", "utf-8");
	await createMemoryService({
		provenance: { agent: "retriever", attempt: 1, runId: "run-0", sessionId: "sess-seed" },
		scope: { agent: "retriever", namespaceId: deriveNamespaceId(worktree), pathPrefixes: [""], write: true },
		storeRoot: store,
		worktreeRoot: worktree,
	}).remember({
		content: "the login path checks the session cookie first",
		kind: "evidence",
		operationId: "seed/1",
		sourcePath: "src/auth.ts",
		summary: "login is verified in src/auth.ts",
		tags: ["auth"],
		topic: "auth flow",
	});
});

afterEach(() => {
	fs.rmSync(root, { force: true, recursive: true });
});

describe("synapse delegation bridge", () => {
	it("leaves a launch untouched when the extension gave the child no contract", () => {
		assert.equal(openFor(undefined, "Task: anything"), null);
		assert.equal(fs.existsSync(path.join(store, "metering")), false);
	});

	it("hands the recalled memory to the child and meters the delivery", () => {
		const delegation = openFor(childContract(), "Task: explain the auth flow");
		assert.ok(delegation);
		// The handle is handed over, the summary is not: under `synapse` the prompt
		// carries the task alone and the child redeems the body locally.
		assert.equal(delegation.prompt, "Task: explain the auth flow");
		assert.deepEqual(delegation.envelope.memoryRefs.length, 1);
		assert.equal(totals().messages.delivered, 1);
		assert.equal(totals().memory.reuses, 1);
	});

	it("closes a completed run once, with the usage the run reported", () => {
		const delegation = openFor(childContract(), "Task: explain the auth flow");
		closeChildDelegation(delegation, { cancelled: false, finalOutput: "done", timedOut: false, usage: USAGE });
		const aggregate = totals();
		assert.equal(aggregate.messages.received, 1);
		assert.equal(aggregate.messages.failed, 0);
		assert.deepEqual(aggregate.model.child, { cacheRead: 0, cacheWrite: 0, input: 10, output: 5 });
	});

	it("separates a cancelled run from a failed one", () => {
		const cancelled = openFor(childContract(), "Task: explain the auth flow");
		closeChildDelegation(cancelled, { cancelled: true, cause: new Error("Interrupted."), finalOutput: "", timedOut: false, usage: USAGE });
		assert.equal(totals().errors.cancelled, 1);
		assert.equal(totals().errors.unclassified, undefined);
	});

	it("records an unrecognised failure as unclassified rather than as a neighbour", () => {
		const failed = openFor(childContract(), "Task: explain the auth flow");
		closeChildDelegation(failed, { cancelled: false, cause: new Error("Child session failed."), finalOutput: "", timedOut: false, usage: USAGE });
		assert.equal(totals().messages.failed, 1);
		assert.equal(totals().errors.unclassified, 1);
	});

	it("gives a timeout its own cause rather than reporting a completed run", () => {
		const timedOut = openFor(childContract(), "Task: explain the auth flow");
		closeChildDelegation(timedOut, { cancelled: false, finalOutput: "", timedOut: true, usage: USAGE });
		assert.equal(totals().messages.failed, 1);
		assert.equal(totals().errors.timeout, 1);
	});

	it("does nothing, and throws nothing, when there was no delegation to close", () => {
		closeChildDelegation(null, { cancelled: false, finalOutput: "done", timedOut: false, usage: USAGE });
		assert.equal(fs.existsSync(path.join(store, "metering")), false);
	});

	it("keeps the launch when the state half throws: a corrupt credentials file costs the state, not the run", async () => {
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(path.join(agentDir, "synapse"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "synapse", "credentials.json"), "{not json", "utf-8");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousKey = process.env[SYNAPSE_KEY_ENV];
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env[SYNAPSE_KEY_ENV];
		try {
			const base = childContract();
			const synapse: SynapseChildContract = {
				...base,
				capabilityTools: ["read", ...SYNAPSE_STATE_CONSUMING_TOOLS],
				contract: resolveLaunchContract({ ...base.contract, corpusSnapshotId: "c".repeat(64) }),
				embedding: { dim: 2, endpoint: "http://127.0.0.1:1/v1/embeddings", keyEnv: SYNAPSE_KEY_ENV, model: "BAAI/bge-m3", provider: "siliconflow" },
			};
			const opened = await openChildDelegationWithState({ cwd: worktree, message: "Task: explain the auth flow", receiverSessionId: "sess-child", runtime: runtime(synapse) });
			assert.ok(opened.delegation, "the task plane still opens and its prompt still reaches the child");
			assert.equal(opened.state, null);
			assert.equal(totals().errors.unclassified, 1, "the skipped state delivery is on the ledger");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousKey !== undefined) process.env[SYNAPSE_KEY_ENV] = previousKey;
		}
	});
});
