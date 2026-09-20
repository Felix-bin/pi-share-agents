import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SynapseMode } from "../../src/synapse/config.ts";
import {
	meteringLogPath,
	modelUsageFrom,
	openDelegation,
	openRetrieveDelegation,
	receiptPath,
	type DelegationIdentity,
	type OpenDelegation,
} from "../../src/synapse/delegation.ts";
import { openChildRetrieveDelegation } from "../../src/runs/shared/synapse-delegation.ts";
import type { ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import { createEmbeddingClient } from "../../src/synapse/embedding.ts";
import { createMeteringLog } from "../../src/synapse/metering.ts";
import { resolveLaunchContract, type LaunchContract } from "../../src/synapse/lifecycle.ts";
import { createMemoryService } from "../../src/synapse/memory-service.ts";
import { aggregateMetering, readMeteringLog, type MeteringEvent } from "../../src/synapse/metering.ts";
import { deriveNamespaceId } from "../../src/synapse/namespace.ts";
import { capabilityForAgent } from "../../src/synapse/roles.ts";

/**
 * The seam where a task actually leaves the parent. These tests drive it the
 * way the two execution paths do: open, send, close — and check that what the
 * meter recorded matches what the child was actually handed.
 */

let root = "";
let store = "";
let worktree = "";

const RUN_ID = "run-1";
const REQUEST_ID = "run-1-0-abcd";

async function seedMemory(summary: string, content: string, sourcePath: string): Promise<string> {
	const service = createMemoryService({
		provenance: { agent: "retriever", attempt: 1, runId: "run-0", sessionId: "sess-seed" },
		scope: { agent: "retriever", namespaceId: deriveNamespaceId(worktree), pathPrefixes: [""], write: true },
		storeRoot: store,
		worktreeRoot: worktree,
	});
	const written = await service.remember({
		content,
		kind: "evidence",
		operationId: `seed/${summary}`,
		sourcePath,
		summary,
		tags: ["auth"],
		topic: "auth flow",
	});
	return written.record.memoryId;
}

function contractFor(mode: SynapseMode, pathPrefixes: string[] = [""]): LaunchContract {
	return resolveLaunchContract({
		capabilityId: capabilityForAgent({ agent: "retriever", childTools: ["read"], representationId: "unavailable" }).capabilityId,
		memoryRefs: [],
		corpusSnapshotId: "unset",
		mode,
		namespaceId: deriveNamespaceId(worktree),
		representationId: "unavailable",
		scope: { pathPrefixes, write: true },
		stateVerify: "off",
		storageRoot: store,
	});
}

function identity(overrides: Partial<DelegationIdentity> = {}): DelegationIdentity {
	return {
		agent: overrides.agent ?? "retriever",
		attempt: overrides.attempt ?? 1,
		childIndex: overrides.childIndex ?? 0,
		childTools: overrides.childTools ?? ["read", "grep"],
		receiverSessionId: overrides.receiverSessionId ?? "sess-child",
		requestId: overrides.requestId ?? REQUEST_ID,
		runId: overrides.runId ?? RUN_ID,
		senderSessionId: overrides.senderSessionId ?? "sess-parent",
	};
}

function open(mode: SynapseMode, message: string, overrides: { budgetBytes?: number; pathPrefixes?: string[] } = {}): OpenDelegation | null {
	return openDelegation({
		budgetBytes: overrides.budgetBytes ?? 8192,
		contract: contractFor(mode, overrides.pathPrefixes),
		identity: identity(),
		message,
		worktreeRoot: worktree,
	});
}

function events(): MeteringEvent[] {
	return readMeteringLog(meteringLogPath(contractFor("synapse"), RUN_ID));
}

function kinds(): string[] {
	return events().map((event) => event.kind);
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-delegation-"));
	store = path.join(root, "store");
	worktree = path.join(root, "worktree");
	fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
	fs.mkdirSync(path.join(worktree, "docs"), { recursive: true });
	fs.writeFileSync(path.join(worktree, "src", "auth.ts"), "export const login = 1;\n", "utf-8");
	fs.writeFileSync(path.join(worktree, "docs", "auth.md"), "# auth\n", "utf-8");
});

afterEach(() => {
	fs.rmSync(root, { force: true, recursive: true });
});

describe("synapse delegation", () => {
	it("hands the child what it may read and meters exactly what was sent", async () => {
		const memoryId = await seedMemory("login is verified in src/auth.ts", "the login path checks the session cookie first", "src/auth.ts");
		const delegation = open("synapse", "Task: explain the auth flow");
		assert.ok(delegation, "an authorised delegation must open");

		assert.ok(delegation.prompt.startsWith("Task: explain the auth flow"), "the task is never rewritten");
		assert.match(delegation.prompt, /login is verified in src\/auth\.ts/);
		assert.deepEqual(delegation.handoff.refs, [memoryId]);
		assert.equal(delegation.handoff.carriedBodies, false, "synapse mode hands over references, not bodies");
		assert.deepEqual(delegation.envelope.memoryRefs, [memoryId]);
		assert.equal(delegation.envelope.action, "delegate");
		assert.equal(delegation.envelope.snapshotId.length, 64);

		const delivered = events().find((event) => event.kind === "message-delivered");
		assert.ok(delivered, "a delivery must be recorded");
		assert.equal(delivered.kind === "message-delivered" && delivered.textBytes, Buffer.byteLength(delegation.prompt, "utf-8"));
		assert.equal(delivered.kind === "message-delivered" && delivered.envelopeBytes, delegation.envelope.envelopeBytes);
		assert.equal(delivered.snapshotId, delegation.envelope.snapshotId);
		assert.deepEqual(kinds(), ["task-span", "memory-query", "memory-reuse", "message-delivered"]);
	});

	it("records the negotiated path as text, never as a vector success", async () => {
		const delegation = open("synapse", "Task: explain the auth flow");
		assert.ok(delegation);
		assert.equal(delegation.negotiation.outcome, "text");
		assert.equal(delegation.negotiation.outcome === "text" && delegation.negotiation.reason, "action-needs-no-state");
		const totals = aggregateMetering(events());
		assert.equal(totals.state.sent, 0);
		assert.equal(totals.state.sentBytes, 0);
	});

	it("carries bodies in text mode and references in synapse mode, from the same memory", async () => {
		await seedMemory("login is verified in src/auth.ts", "the login path checks the session cookie first", "src/auth.ts");
		const asText = open("text", "Task: explain the auth flow");
		fs.rmSync(path.join(store, "metering"), { force: true, recursive: true });
		const asSynapse = open("synapse", "Task: explain the auth flow");
		assert.ok(asText && asSynapse);

		assert.equal(asText.handoff.carriedBodies, true);
		assert.match(asText.prompt, /checks the session cookie first/);
		assert.doesNotMatch(asSynapse.prompt, /checks the session cookie first/);
		// The baseline is more expensive on the live path, which is the comparison
		// the two modes exist to make measurable.
		assert.ok(Buffer.byteLength(asText.prompt, "utf-8") > Buffer.byteLength(asSynapse.prompt, "utf-8"));
	});

	it("never recalls a memory the child is not authorised to read", async () => {
		await seedMemory("login is verified in src/auth.ts", "the login path checks the session cookie first", "src/auth.ts");
		const delegation = open("synapse", "Task: explain the auth flow", { pathPrefixes: ["docs"] });
		assert.ok(delegation);
		assert.deepEqual(delegation.handoff.refs, []);
		assert.equal(delegation.prompt, "Task: explain the auth flow");
		assert.doesNotMatch(delegation.prompt, /login is verified/);
		const query = events().find((event) => event.kind === "memory-query");
		assert.equal(query?.kind === "memory-query" && query.authorisedValidHits, 0);
	});

	it("refuses rather than delegating unmetered when the receiver may read nothing", async () => {
		assert.equal(open("synapse", "Task: anything", { pathPrefixes: [] }), null);
		assert.equal(fs.existsSync(meteringLogPath(contractFor("synapse"), RUN_ID)), false, "a refusal writes nothing");
	});

	it("drops whole entries under a tight budget and still sends the task in full", async () => {
		await seedMemory("login is verified in src/auth.ts", "the login path checks the session cookie first", "src/auth.ts");
		const delegation = open("synapse", "Task: explain the auth flow", { budgetBytes: 8 });
		assert.ok(delegation);
		assert.deepEqual(delegation.handoff.refs, []);
		assert.equal(delegation.handoff.omitted, 1);
		assert.equal(delegation.prompt, "Task: explain the auth flow");
	});

	it("closes a completed run with a receipt that follows the run's own outcome", async () => {
		const memoryId = await seedMemory("login is verified in src/auth.ts", "the login path checks the session cookie first", "src/auth.ts");
		const delegation = open("synapse", "Task: explain the auth flow");
		assert.ok(delegation);
		const receipt = delegation.close({
			outcome: "completed",
			summary: "the login path checks the cookie",
			usage: { cacheRead: 1, cacheWrite: 2, cost: 0.5, input: 100, output: 20 },
		});

		assert.equal(receipt.accepted, true);
		assert.deepEqual(receipt.memoryRefs, [memoryId]);
		assert.equal(receipt.outputRef, null, "this build publishes no output object");
		assert.equal(receipt.persistence, "skipped");
		const stored = JSON.parse(fs.readFileSync(receiptPath(contractFor("synapse"), REQUEST_ID), "utf-8"));
		assert.equal(stored.snapshotId, delegation.envelope.snapshotId);

		const totals = aggregateMetering(events());
		assert.equal(totals.messages.delivered, 1);
		assert.equal(totals.messages.received, 1);
		assert.equal(totals.messages.failed, 0);
		assert.equal(totals.messages.duplicateDeliveries, 0);
		assert.deepEqual(totals.model.child, { cacheRead: 1, cacheWrite: 2, input: 100, output: 20 });
		assert.equal(totals.memory.reuses, 1);
		assert.equal(totals.memory.hitRate, 1);
		assert.notEqual(totals.duration.byTask[REQUEST_ID], "unavailable");
	});

	it("classifies a failure and refuses to call it accepted", async () => {
		const delegation = open("synapse", "Task: explain the auth flow");
		assert.ok(delegation);
		const receipt = delegation.close({
			cause: new Error("not-authorised: retriever may not read that"),
			outcome: "failed",
			summary: "the child could not read the file",
			usage: null,
		});

		assert.equal(receipt.accepted, false);
		assert.equal(receipt.outcome, "failed");
		const totals = aggregateMetering(events());
		assert.equal(totals.messages.failed, 1);
		assert.equal(totals.errors.permission, 1);
		// A child that reported no usage is unavailable, never zero.
		assert.equal(totals.model.child.input, "unavailable");
		assert.equal(totals.model.complete, false);
	});

	it("keeps an unreported usage distinct from a reported zero", async () => {
		assert.equal(modelUsageFrom({ cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, output: 0, turns: 0 }), null);
		assert.deepEqual(modelUsageFrom({ cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, output: 0, turns: 1 }), {
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			input: 0,
			output: 0,
		});
	});

	it("meters a cancelled run as cancelled rather than as a failure it never was", async () => {
		const delegation = open("synapse", "Task: explain the auth flow");
		assert.ok(delegation);
		const receipt = delegation.close({ cause: new Error("cancelled: the user stopped the run"), outcome: "cancelled", summary: "stopped", usage: null });
		assert.equal(receipt.accepted, false);
		assert.equal(receipt.outcome, "cancelled");
		assert.equal(aggregateMetering(events()).errors.cancelled, 1);
	});
});

describe("synapse retrieve seam", () => {
	const embeddingConfig = { dim: 8, endpoint: "http://127.0.0.1:9/v1/embeddings", keyEnv: "SYNAPSE_TEST_KEY", model: "BAAI/bge-m3", provider: "siliconflow" };

	it("keeps the state plane off when the contract has no pinned corpus", async () => {
		// The representation matches the embedder so the corpus guard is the only one left to fire.
		const embedder = createEmbeddingClient(embeddingConfig, { key: "stub" });
		const unset = { ...contractFor("synapse"), corpusSnapshotId: "unset", representationId: embedder.representationId };
		await assert.rejects(
			openRetrieveDelegation({
				contract: unset,
				deps: { log: createMeteringLog(meteringLogPath(contractFor("synapse"), RUN_ID)) },
				embedder,
				identity: identity({ childTools: ["read", "synapse_read"] }),
				k: 3,
				query: "any query",
				receiverProbe: () => true,
				worktreeRoot: worktree,
			}),
			/synapse\.corpusSnapshotId/,
		);
	});

	it("bridges through openChildRetrieveDelegation or degrades to null, never loses the run", async () => {
		// A runtime without the synapse contract returns null: upstream keeps its
		// text behaviour, the same totality the delegate seam guarantees.
		const embedder = createEmbeddingClient(embeddingConfig, { key: "stub" });
		const runtime: ChildRuntimeConfig = { childIndex: 0, depth: 1, fanoutChild: false, fast: false, waitTool: { enabled: false } };
		assert.equal(await openChildRetrieveDelegation({ childTools: ["read"], cwd: worktree, embedder, k: 3, query: "q", receiverSessionId: "sess", runtime }), null);
	});
});
