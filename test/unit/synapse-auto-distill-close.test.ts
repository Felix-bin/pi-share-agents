import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SynapseChildContract } from "../../src/synapse/child-contract.ts";
import { meteringLogPath } from "../../src/synapse/delegation.ts";
import { resolveLaunchContract } from "../../src/synapse/lifecycle.ts";
import { aggregateMetering, readMeteringLog } from "../../src/synapse/metering.ts";
import { deriveNamespaceId } from "../../src/synapse/namespace.ts";
import { capabilityForAgent } from "../../src/synapse/roles.ts";
import type { ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import { closeChildDelegation, openChildDelegation } from "../../src/runs/shared/synapse-delegation.ts";
import { startEmbeddingStub, type StubEmbeddingServer } from "../support/embedding-stub-server.ts";

/**
 * A completed child's distill must have landed by the time its close settles.
 *
 * The background runner exits the moment a run resolves, so a distill that was
 * only started — its first embedding call still in flight — never writes a
 * record. The stub answers slowly on purpose: a close that does not wait for
 * the distiller returns before any record exists.
 */

const KEY_ENV = "SYNAPSE_TEST_DISTILL_KEY";
const USAGE = { cacheRead: 0, cacheWrite: 0, cost: 0, input: 1, output: 1, turns: 1 };
const OUTPUT = [
	"Summary of the auth flow.",
	"ESTABLISHED:",
	"- the login path checks the session cookie first",
	"- tokens are rotated every hour by src/auth/rotate.ts",
	"NOT ESTABLISHED:",
	"- whether refresh tokens are revoked on logout",
].join("\n");

let root = "";
let store = "";
let worktree = "";
let server: StubEmbeddingServer;

function childContract(): SynapseChildContract {
	return {
		agent: "retriever",
		autoDistill: true,
		capabilityTools: ["read"],
		contextBudgetBytes: 8192,
		contract: resolveLaunchContract({
			capabilityId: capabilityForAgent({ agent: "retriever", childTools: ["read"], representationId: "unavailable" }).capabilityId,
			corpusSnapshotId: "unset",
			deliveryGear: "file",
			memoryRefs: [],
			mode: "synapse",
			namespaceId: deriveNamespaceId(worktree),
			representationId: "unavailable",
			scope: { pathPrefixes: [""], write: false },
			storageRoot: store,
		}),
		delta: false,
		embedding: { dim: 2, endpoint: `http://127.0.0.1:${server.port}/v1/embeddings`, keyEnv: KEY_ENV, model: "BAAI/bge-m3", provider: "siliconflow" },
		runId: "run-distill",
		sessionId: "sess-parent",
		vectorCache: false,
	};
}

function runtime(synapse: SynapseChildContract): ChildRuntimeConfig {
	return { agent: "retriever", childIndex: 0, depth: 1, fanoutChild: false, fast: false, inheritGlobalContext: true, inheritProjectContext: true, inheritSkills: false, maxDepth: 2, synapse, waitTool: { enabled: false } };
}

beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-distill-close-"));
	store = path.join(root, "store");
	worktree = path.join(root, "worktree");
	fs.mkdirSync(worktree, { recursive: true });
	server = await startEmbeddingStub();
	// The happy-path wire shape, answered late enough that an un-awaited distill
	// is still waiting on its first embedding when the close returns.
	server.setHandler((request, response) => {
		setTimeout(() => {
			const parsed = JSON.parse(request.body) as { input: string | readonly string[] };
			const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
			const vector = Buffer.alloc(8);
			vector.writeFloatLE(0.6, 0);
			vector.writeFloatLE(0.8, 4);
			response.statusCode = 200;
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ data: inputs.map((_text, index) => ({ embedding: vector.toString("base64"), index })), model: "BAAI/bge-m3", object: "list" }));
		}, 150);
	});
	process.env[KEY_ENV] = "test-key-0123456789abcdef";
});

afterEach(async () => {
	delete process.env[KEY_ENV];
	await server.close();
	fs.rmSync(root, { force: true, recursive: true });
});

describe("closing a completed delegation with autoDistill on", () => {
	it("settles only after the distilled records, and their vectors, have landed", async () => {
		const contract = childContract();
		const delegation = openChildDelegation({ cwd: worktree, message: "Task: explain the auth flow", receiverSessionId: "sess-child", runtime: runtime(contract) });
		assert.ok(delegation);
		await closeChildDelegation(delegation, { cancelled: false, finalOutput: OUTPUT, runtime: runtime(contract), taskText: "explain the auth flow", timedOut: false, usage: USAGE });

		const totals = aggregateMetering(readMeteringLog(meteringLogPath(contract.contract, contract.runId)));
		assert.equal(totals.memory.distilled, 2, "both ESTABLISHED lines are written before the close settles");
		assert.equal(totals.memory.distilledWithoutVector, 0);
		// The distiller's embedding calls are on the same ledger as every other call.
		assert.equal(totals.embedding.requests, 2);
	});

	it("distills nothing, and waits for nothing, when the run did not complete", async () => {
		const contract = childContract();
		const delegation = openChildDelegation({ cwd: worktree, message: "Task: explain the auth flow", receiverSessionId: "sess-child", runtime: runtime(contract) });
		await closeChildDelegation(delegation, { cancelled: false, cause: new Error("boom"), finalOutput: OUTPUT, runtime: runtime(contract), timedOut: false, usage: USAGE });
		const totals = aggregateMetering(readMeteringLog(meteringLogPath(contract.contract, contract.runId)));
		assert.equal(totals.memory.distilled, 0);
		assert.equal(server.requests.length, 0);
	});
});
