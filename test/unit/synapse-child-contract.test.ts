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
		placedOnAnotherMachine: overrides.placedOnAnotherMachine ?? false,
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

	it("carries the worktree it resolved the store for, so the child need not trust its own cwd", () => {
		// A host that runs pi in its own process (pi-web) starts children whose cwd
		// is the host's directory; a child that used it wrote a namespace marker
		// claiming the project's store for the host and then refused the store.
		const contract = resolveSynapseChildContract(input());
		assert.ok(contract);
		assert.equal(contract.worktreePath, input().cwd);
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

	it("carries the configured delivery gear into the contract both sides read", () => {
		// The gear has to travel in the contract, not be re-resolved from config on
		// each side: the parent's send address and the child's bind address are
		// derived from this one field. A resolver that hardcoded "file" here would
		// leave `synapse.deliveryGear: "uds"` configurable and unreachable — which
		// is the exact gap Task 3a closes — while passing every other assertion.
		assert.equal(resolveSynapseChildContract(input())?.contract.deliveryGear, "file");
		assert.equal(resolveSynapseChildContract(input({ extensionConfig: { deliveryGear: "uds", mode: "synapse" } }))?.contract.deliveryGear, "uds");
		assert.equal(resolveSynapseChildContract(input({ extensionConfig: { deliveryGear: "file", mode: "synapse" } }))?.contract.deliveryGear, "file");
	});

	it("degrades uds to file for a child placed on another machine, and says so", () => {
		// An AF_UNIX endpoint is a path in one kernel's filesystem. Carried across a
		// machine boundary unchanged, every delivery fails as a `persistence` error
		// and every child waits out its whole receive deadline before running
		// anyway — with nothing naming the cause.
		const remote = resolveSynapseChildContract(input({ extensionConfig: { deliveryGear: "uds", mode: "synapse" }, placedOnAnotherMachine: true }));
		assert.equal(remote?.contract.deliveryGear, "file");
		assert.match(String(remote?.deliveryGearNote), /uds.*degraded to "file"/);
	});

	it("leaves a local child's gear alone, and never notes a substitution that did not happen", () => {
		const local = resolveSynapseChildContract(input({ extensionConfig: { deliveryGear: "uds", mode: "synapse" }, placedOnAnotherMachine: false }));
		assert.equal(local?.contract.deliveryGear, "uds");
		assert.equal(local?.deliveryGearNote, undefined);
		// `file` on a remote child is not a degradation either: it already works
		// there, so a note would name a substitution nobody made.
		const remoteFile = resolveSynapseChildContract(input({ extensionConfig: { deliveryGear: "file", mode: "synapse" }, placedOnAnotherMachine: true }));
		assert.equal(remoteFile?.contract.deliveryGear, "file");
		assert.equal(remoteFile?.deliveryGearNote, undefined);
	});

	it("gives the degraded contract the identity of the gear it will really use", () => {
		// The gear takes part in `contractId`. If the degrade had been applied only
		// at the delivery call site and not here, the contract would carry the id of
		// a `uds` launch while the run wrote files — a condition disagreeing with its
		// own manifest, which is precisely what S4 compares runs by.
		const degraded = resolveSynapseChildContract(input({ extensionConfig: { deliveryGear: "uds", mode: "synapse" }, placedOnAnotherMachine: true }));
		const honestFile = resolveSynapseChildContract(input({ extensionConfig: { deliveryGear: "file", mode: "synapse" }, placedOnAnotherMachine: true }));
		const undegradedUds = resolveSynapseChildContract(input({ extensionConfig: { deliveryGear: "uds", mode: "synapse" } }));
		assert.equal(degraded?.contract.contractId, honestFile?.contract.contractId);
		assert.notEqual(degraded?.contract.contractId, undegradedUds?.contract.contractId);
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

	it("carries the vector-cache switch, off unless the config asks for it", () => {
		// Off by default so a launch that says nothing about it keeps the frozen
		// cold-base byte behaviour: a default config must not silently start serving
		// record vectors from memory, because that would move the measured account
		// without any experiment having asked for the change.
		const off = resolveSynapseChildContract(input());
		assert.equal(off?.vectorCache, false, "a default launch must read vectors from the store");

		const on = resolveSynapseChildContract(input({ extensionConfig: { mode: "synapse", vectorCache: true } }));
		assert.equal(on?.vectorCache, true, "the switch has to reach the seam that builds the ranking service");
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
