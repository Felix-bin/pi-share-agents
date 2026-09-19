import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	childMayWrite,
	registerSynapseChildTools,
	resolveSynapseChildContract,
	type ResolveChildContractInput,
	type SynapseChildContract,
} from "../../src/synapse/child-contract.ts";
import { rehydrateLaunchContract, serialiseLaunchContract } from "../../src/synapse/lifecycle.ts";
import { deriveNamespaceId } from "../../src/synapse/namespace.ts";
import type { CanonicalValue } from "../../src/synapse/canonical-json.ts";
import type { SynapseToolHost } from "../../src/synapse/register-tools.ts";

type Details = Record<string, CanonicalValue>;

function detailsOf(result: { details: CanonicalValue }): Details {
	// SAFETY: every SYNAPSE tool returns a JSON object as its details.
	return result.details as Details;
}

let home = "";
let agentDir = "";
let worktree = "";

function input(overrides: Partial<ResolveChildContractInput> = {}): ResolveChildContractInput {
	return {
		agentName: overrides.agentName ?? "retriever",
		childTools: overrides.childTools ?? ["read", "grep"],
		cwd: overrides.cwd ?? worktree,
		extensionConfig: overrides.extensionConfig === undefined ? { mode: "synapse" } : overrides.extensionConfig,
		agentDir: overrides.agentDir ?? agentDir,
		runId: overrides.runId ?? "run-1",
		sessionId: overrides.sessionId ?? "sess-child",
	};
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-child-home-"));
	agentDir = path.join(home, ".pi", "agent");
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-child-wt-"));
});

afterEach(() => {
	fs.rmSync(home, { force: true, recursive: true });
	fs.rmSync(worktree, { force: true, recursive: true });
});

describe("child contract resolution", () => {
	it("produces no contract at all while the extension is off", () => {
		assert.equal(resolveSynapseChildContract({ ...input(), extensionConfig: undefined }), null);
		assert.equal(resolveSynapseChildContract(input({ extensionConfig: { mode: "text" } })), null);
	});

	it("carries the pinned corpus snapshot id, or the unset placeholder without one", () => {
		assert.equal(resolveSynapseChildContract(input())?.contract.corpusSnapshotId, "unset");
		const pinned = "a".repeat(64);
		assert.equal(resolveSynapseChildContract(input({ extensionConfig: { corpusSnapshotId: pinned, mode: "synapse" } }))?.contract.corpusSnapshotId, pinned);
	});

	it("round-trips a pinned corpus snapshot through child tool registration", () => {
		const pinned = "c".repeat(64);
		const contract = resolveSynapseChildContract(input({ extensionConfig: { corpusSnapshotId: pinned, mode: "synapse" } }));
		assert.ok(contract);
		const registered = registerSynapseChildTools({ registerTool: () => undefined }, contract, worktree);
		assert.equal(registered.registered, true);
	});

	it("names the child's own agent, run and session for provenance", () => {
		const contract = resolveSynapseChildContract(input({ agentName: "executor" }));
		assert.equal(contract?.agent, "executor");
		assert.equal(contract?.runId, "run-1");
		assert.equal(contract?.sessionId, "sess-child");
	});

	it("points the child at this worktree's store", () => {
		const contract = resolveSynapseChildContract(input());
		assert.equal(contract?.contract.namespaceId, deriveNamespaceId(worktree));
		assert.equal(contract?.contract.storageRoot, path.join(agentDir, "synapse", deriveNamespaceId(worktree)));
	});

	it("honours an experiment's isolated store", () => {
		const isolated = path.join(home, "runs", "seq-01");
		const contract = resolveSynapseChildContract(input({ extensionConfig: { mode: "synapse", storageRoot: isolated } }));
		assert.equal(contract?.contract.storageRoot, isolated);
	});

	it("gives a read-only child read-only memory", () => {
		// Shared memory projects the authorisation the child already holds; a child
		// with no mutating tool must not gain one by way of the memory store.
		assert.equal(resolveSynapseChildContract(input({ childTools: ["read", "grep"] }))?.contract.scope.write, false);
		assert.equal(resolveSynapseChildContract(input({ childTools: ["read", "write"] }))?.contract.scope.write, true);
		assert.equal(childMayWrite(["read", "bash"]), true);
		assert.equal(childMayWrite(["read", "find"]), false);
	});

	it("substitutes a placeholder when the launch has no session or run id", async () => {
		// A record written with a blank identity passes the write but fails its own
		// schema on the way back, turning a stored observation into an integrity
		// error long after the run that produced it.
		const contract = resolveSynapseChildContract(input({ runId: "", sessionId: "" }));
		assert.equal(contract?.runId, "unattributed-run");
		assert.equal(contract?.sessionId, "unattributed-session");
		assert.ok(contract);
		const registration = registerSynapseChildTools({ registerTool: () => {} }, { ...contract, contract: { ...contract.contract, scope: { pathPrefixes: [""], write: true } } }, worktree);
		assert.ok(registration.registered);
		if (!registration.registered) return;
		const written = await registration.write({ action: "remember", content: "无归属的观察", summary: "无归属观察摘要", topic: "t" });
		const memoryId = String(detailsOf(written).memoryId);
		// The record must be readable again, which is what a blank identity broke.
		const page = await registration.read({ action: "get", memoryId });
		assert.equal(detailsOf(page).text, "无归属的观察");
	});

	it("gives foreground and background children the same contract for one launch", () => {
		const foreground = resolveSynapseChildContract(input());
		const background = resolveSynapseChildContract(input());
		assert.deepEqual(foreground, background);
	});

	it("survives the trip to a separate process", () => {
		const contract = resolveSynapseChildContract(input());
		assert.ok(contract);
		const rehydrated = rehydrateLaunchContract(serialiseLaunchContract(contract.contract), {
			currentNamespaceId: contract.contract.namespaceId,
			currentScope: contract.contract.scope,
			memoryExists: () => true,
		});
		assert.equal(rehydrated.status, "ready");
	});

	it("carries nothing that cannot be serialised", () => {
		const contract = resolveSynapseChildContract(input());
		assert.deepEqual(JSON.parse(JSON.stringify(contract)), contract);
	});
});

describe("child tool registration", () => {
	function host() {
		const names: string[] = [];
		const pi: SynapseToolHost = { registerTool: (tool) => names.push(tool.name) };
		return { names, pi };
	}

	function contractFor(overrides: Partial<ResolveChildContractInput> = {}): SynapseChildContract {
		const contract = resolveSynapseChildContract(input(overrides));
		assert.ok(contract);
		return contract;
	}

	it("registers both tools inside the child", () => {
		const { names, pi } = host();
		assert.equal(registerSynapseChildTools(pi, contractFor(), worktree).registered, true);
		assert.deepEqual([...names].sort(), ["synapse_read", "synapse_write"]);
	});

	it("records the child as the source agent of what it writes", async () => {
		const registration = registerSynapseChildTools({ registerTool: () => {} }, contractFor({ agentName: "executor", childTools: ["read", "write"] }), worktree);
		assert.ok(registration.registered);
		if (!registration.registered) return;
		await registration.write({ action: "remember", content: "子 Agent 的观察", summary: "子 Agent 的观察摘要", topic: "t" });
		const found = await registration.read({ action: "search", query: "子 Agent 的观察摘要" });
		const results = found.details;
		assert.equal(JSON.stringify(results).includes("executor"), true);
	});

	it("refuses a write from a read-only child", async () => {
		const registration = registerSynapseChildTools({ registerTool: () => {} }, contractFor({ childTools: ["read"] }), worktree);
		assert.ok(registration.registered);
		if (!registration.registered) return;
		await assert.rejects(registration.write({ action: "remember", content: "x", summary: "观察", topic: "t" }), /not-authorised/);
	});

	it("lets a child read what the parent's session recorded in the same store", async () => {
		const writer = registerSynapseChildTools({ registerTool: () => {} }, contractFor({ agentName: "planner", childTools: ["write"] }), worktree);
		const reader = registerSynapseChildTools({ registerTool: () => {} }, contractFor({ agentName: "retriever", childTools: ["read"] }), worktree);
		assert.ok(writer.registered && reader.registered);
		if (!writer.registered || !reader.registered) return;
		await writer.write({ action: "remember", content: "计划要点", summary: "计划要点摘要", topic: "plan" });
		const found = await reader.read({ action: "search", query: "计划要点摘要" });
		assert.equal(JSON.stringify(found.details).includes("planner"), true);
	});
});
