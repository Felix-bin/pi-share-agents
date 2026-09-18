import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	reconcileRuns,
	rehydrateLaunchContract,
	resolveLaunchContract,
	serialiseLaunchContract,
	shouldRetry,
	SYNAPSE_MAX_ATTEMPTS,
	type LaunchContractInput,
	type RehydrationChecks,
	type RunRecord,
} from "../../src/synapse/lifecycle.ts";

function contractInput(overrides: Partial<LaunchContractInput> = {}): LaunchContractInput {
	return {
		capabilityId: overrides.capabilityId ?? "c".repeat(64),
		memoryRefs: overrides.memoryRefs ?? ["a".repeat(64)],
		corpusSnapshotId: overrides.corpusSnapshotId ?? "corpus-1",
		mode: overrides.mode ?? "synapse",
		namespaceId: overrides.namespaceId ?? "0123456789abcdef",
		representationId: overrides.representationId ?? "siliconflow/BAAI/bge-m3/1024/l2/f32le",
		scope: overrides.scope ?? { pathPrefixes: ["src"], write: false },
		storageRoot: overrides.storageRoot ?? "/store/0123456789abcdef",
	};
}

function checks(overrides: Partial<RehydrationChecks> = {}): RehydrationChecks {
	return {
		currentNamespaceId: overrides.currentNamespaceId ?? "0123456789abcdef",
		currentScope: overrides.currentScope ?? { pathPrefixes: ["src"], write: false },
		memoryExists: overrides.memoryExists ?? (() => true),
	};
}

describe("launch contract parity (AC-10)", () => {
	it("gives foreground and background the same contract for the same input", () => {
		const foreground = resolveLaunchContract(contractInput());
		const background = resolveLaunchContract(contractInput());
		assert.deepEqual(foreground, background);
		assert.match(foreground.contractId, /^[0-9a-f]{64}$/);
	});

	it("changes identity when permission, snapshot or mode changes", () => {
		const base = resolveLaunchContract(contractInput()).contractId;
		assert.notEqual(resolveLaunchContract(contractInput({ scope: { pathPrefixes: [""], write: false } })).contractId, base);
		assert.notEqual(resolveLaunchContract(contractInput({ memoryRefs: ["b".repeat(64)] })).contractId, base);
		assert.notEqual(resolveLaunchContract(contractInput({ mode: "text" })).contractId, base);
	});

	it("does not depend on the order permissions or references were collected in", () => {
		const forward = resolveLaunchContract(contractInput({ memoryRefs: ["a".repeat(64), "b".repeat(64)], scope: { pathPrefixes: ["src", "docs"], write: false } }));
		const reversed = resolveLaunchContract(contractInput({ memoryRefs: ["b".repeat(64), "a".repeat(64)], scope: { pathPrefixes: ["docs", "src"], write: false } }));
		assert.equal(forward.contractId, reversed.contractId);
	});

	it("serialises to plain JSON, since a background process cannot receive live objects", () => {
		const contract = resolveLaunchContract(contractInput());
		const text = serialiseLaunchContract(contract);
		const parsed = JSON.parse(text);
		assert.deepEqual(parsed, contract);
		assert.equal(text.includes("function"), false);
	});
});

describe("rehydration after reload or resume (AC-14)", () => {
	it("is ready when namespace, permissions and objects all still hold", () => {
		const contract = resolveLaunchContract(contractInput());
		const result = rehydrateLaunchContract(serialiseLaunchContract(contract), checks());
		assert.equal(result.status, "ready");
		if (result.status !== "ready") return;
		assert.equal(result.contract.contractId, contract.contractId);
	});

	it("refuses when a referenced object is gone rather than continuing without it", () => {
		const contract = resolveLaunchContract(contractInput());
		const result = rehydrateLaunchContract(serialiseLaunchContract(contract), checks({ memoryExists: () => false }));
		assert.equal(result.status, "refused");
		if (result.status !== "refused") return;
		assert.equal(result.category, "object-unavailable");
	});

	it("refuses when the caller's permissions have narrowed since the snapshot was frozen", () => {
		const contract = resolveLaunchContract(contractInput({ scope: { pathPrefixes: ["src"], write: true } }));
		const result = rehydrateLaunchContract(serialiseLaunchContract(contract), checks({ currentScope: { pathPrefixes: ["src"], write: false } }));
		assert.equal(result.status, "refused");
		if (result.status !== "refused") return;
		assert.equal(result.category, "permission");
	});

	it("keeps the frozen scope when current permissions are wider, instead of widening", () => {
		const contract = resolveLaunchContract(contractInput({ scope: { pathPrefixes: ["src"], write: false } }));
		const result = rehydrateLaunchContract(serialiseLaunchContract(contract), checks({ currentScope: { pathPrefixes: [""], write: true } }));
		assert.equal(result.status, "ready");
		if (result.status !== "ready") return;
		assert.deepEqual(result.contract.scope, { pathPrefixes: ["src"], write: false });
	});

	it("refuses a contract that belongs to another namespace", () => {
		const contract = resolveLaunchContract(contractInput());
		const result = rehydrateLaunchContract(serialiseLaunchContract(contract), checks({ currentNamespaceId: "f".repeat(16) }));
		assert.equal(result.status, "refused");
		if (result.status !== "refused") return;
		assert.equal(result.category, "configuration");
	});

	it("refuses a contract whose identity no longer matches its own content", () => {
		const contract = resolveLaunchContract(contractInput());
		const tampered = JSON.stringify({ ...contract, scope: { pathPrefixes: [""], write: true } });
		const result = rehydrateLaunchContract(tampered, checks({ currentScope: { pathPrefixes: [""], write: true } }));
		assert.equal(result.status, "refused");
		if (result.status !== "refused") return;
		assert.equal(result.category, "integrity");
	});

	it("refuses unreadable persisted state instead of starting from defaults", () => {
		const result = rehydrateLaunchContract("{ not json", checks());
		assert.equal(result.status, "refused");
		if (result.status !== "refused") return;
		assert.equal(result.category, "integrity");
	});

	it("never produces a success outcome from a refusal", () => {
		const result = rehydrateLaunchContract("{ not json", checks());
		assert.equal("contract" in result, false);
	});
});

describe("run reconciliation (AC-10, AC-14)", () => {
	function record(overrides: Partial<RunRecord> = {}): RunRecord {
		return {
			attempt: overrides.attempt ?? 1,
			deliveredReceipts: overrides.deliveredReceipts ?? 1,
			nodeId: overrides.nodeId ?? "node-1",
			runId: overrides.runId ?? "run-1",
			terminalState: overrides.terminalState === undefined ? "completed" : overrides.terminalState,
		};
	}

	it("reports a run that started but never reached a terminal state as abandoned", () => {
		// Measured on this machine: a background run whose parent exits first stops
		// advancing. Counting it as started-and-delivered would credit work that
		// never happened.
		const summary = reconcileRuns([record({ deliveredReceipts: 0, terminalState: null })]);
		assert.deepEqual(summary.abandoned, ["run-1/node-1/1"]);
		assert.equal(summary.delivered, 0);
	});

	it("does not count a run as delivered just because it finished", () => {
		const summary = reconcileRuns([record({ deliveredReceipts: 0, terminalState: "completed" })]);
		assert.equal(summary.delivered, 0);
		assert.deepEqual(summary.undelivered, ["run-1/node-1/1"]);
	});

	it("counts a repeated receipt for the same attempt once", () => {
		const summary = reconcileRuns([record({ deliveredReceipts: 3 })]);
		assert.equal(summary.delivered, 1);
		assert.equal(summary.duplicateDeliveries, 2);
	});

	it("treats a retry as its own attempt rather than a duplicate", () => {
		const summary = reconcileRuns([record({ attempt: 1, terminalState: "failed" }), record({ attempt: 2, terminalState: "completed" })]);
		assert.equal(summary.delivered, 2);
		assert.equal(summary.duplicateDeliveries, 0);
	});

	it("counts cancellation separately from failure", () => {
		const summary = reconcileRuns([record({ terminalState: "cancelled" }), record({ nodeId: "node-2", terminalState: "failed" })]);
		assert.equal(summary.cancelled, 1);
		assert.equal(summary.failed, 1);
	});
});

describe("retry bounds (AC-14)", () => {
	it("allows a retry while attempts remain", () => {
		assert.equal(shouldRetry({ attempt: 1, terminalState: "failed" }), true);
	});

	it("stops at the attempt ceiling rather than retrying forever", () => {
		assert.equal(shouldRetry({ attempt: SYNAPSE_MAX_ATTEMPTS, terminalState: "failed" }), false);
	});

	it("never retries a cancelled run: the user already decided", () => {
		assert.equal(shouldRetry({ attempt: 1, terminalState: "cancelled" }), false);
	});

	it("never retries a completed run", () => {
		assert.equal(shouldRetry({ attempt: 1, terminalState: "completed" }), false);
	});

	it("retries a run that never reached a terminal state, within the ceiling", () => {
		assert.equal(shouldRetry({ attempt: 1, terminalState: null }), true);
		assert.equal(shouldRetry({ attempt: SYNAPSE_MAX_ATTEMPTS, terminalState: null }), false);
	});
});
