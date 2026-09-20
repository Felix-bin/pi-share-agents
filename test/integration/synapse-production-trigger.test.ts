import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveSynapseChildContract, type SynapseChildContract } from "../../src/synapse/child-contract.ts";
import type { CanonicalValue } from "../../src/synapse/canonical-json.ts";
import { buildCorpus } from "../../src/synapse/corpus.ts";
import { consumeRetrieveState } from "../../src/synapse/delegation.ts";
import { createSiliconFlowEmbedder, type Embedder } from "../../src/synapse/embedding.ts";
import { envelopeInboxPath, readDeliveredEnvelope, stateEnvelopePath, verifyEnvelopeAgainstContract } from "../../src/synapse/envelope-inbox.ts";
import { createMeteringLog, readMeteringLog, type MeteringEvent } from "../../src/synapse/metering.ts";
import type { ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import { openChildDelegationWithState } from "../../src/runs/shared/synapse-delegation.ts";
import { startEmbeddingStub, type StubEmbeddingServer } from "../support/embedding-stub-server.ts";

/**
 * Task card P4-4b: the production trigger.
 *
 * P4-4 landed the state plane and left it unreachable — nothing in `src/runs/`
 * ever published a state envelope, so every state assertion held only inside a
 * test that passed objects in process. This file drives the seam the two
 * execution paths actually call, over the real files and the real metering log,
 * and then consumes the delivery the way the child does. What it cannot cover
 * is documented instead of assumed: the child's own process, its session
 * manager, and the steer channel are not exercised here.
 */

const DIM = 8;
const K = 3;
const RUN_ID = "run-trigger";
const SOURCE_COMMIT = "e".repeat(40);
const QUERY = "# beta\ncoordination as compression observation two\n";
const CONSUMING_TOOLS = ["read", "synapse_read"];

/** Orthonormal fixture vectors so cosine ordering is exact by construction. */
function basis(axis: number): number[] {
	const values = Array.from({ length: DIM }, () => 0);
	values[axis] = 1;
	return values;
}

let storageRoot = "";
let corpusRoot = "";
let worktree = "";
let stub: StubEmbeddingServer;
let embedder: Embedder;
let corpusSnapshotId = "";

function runtimeFor(synapse: SynapseChildContract | undefined): ChildRuntimeConfig {
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

/** The extension configuration a real launch resolves its child contract from. */
function extensionConfig(): Record<string, CanonicalValue> {
	return {
		corpusSnapshotId,
		// The endpoint is the stub, so the sender's embedding call is real and local.
		embedding: { dim: DIM, endpoint: `http://127.0.0.1:${stub.port}/v1/embeddings`, keyEnv: "SYNAPSE_TEST_KEY", model: "BAAI/bge-m3", provider: "siliconflow" },
		memory: "project",
		mode: "synapse",
		storageRoot,
	};
}

/**
 * Builds the child contract through the launch seam rather than by hand.
 *
 * The sender derives the receiver's capability the same way this seam does, so
 * a hand-written capability id would make the envelope's negotiation disagree
 * with the contract the child holds — the two-sided property this seam exists
 * to guarantee, and one this file must therefore exercise instead of assume.
 */
function synapseContract(childTools: readonly string[] = CONSUMING_TOOLS, config: Record<string, CanonicalValue> = extensionConfig()): SynapseChildContract {
	const synapse = resolveSynapseChildContract({
		agentDir: storageRoot,
		agentName: "retriever",
		childTools,
		cwd: worktree,
		extensionConfig: config,
		runId: RUN_ID,
		sessionId: "sess-parent",
	});
	assert.ok(synapse !== null, "the launch seam must yield a contract for a synapse-mode launch");
	return synapse;
}

function stateInbox(): string {
	return stateEnvelopePath(storageRoot, RUN_ID, 0);
}

function delegationInbox(): string {
	return envelopeInboxPath(storageRoot, RUN_ID, 0);
}

function logPath(): string {
	return path.join(storageRoot, "metering", `${RUN_ID}.jsonl`);
}

function trigger(synapse: SynapseChildContract | undefined, childTools: readonly string[] = CONSUMING_TOOLS) {
	return openChildDelegationWithState({
		childTools,
		cwd: worktree,
		message: QUERY,
		receiverSessionId: "sess-child",
		runtime: runtimeFor(synapse),
	});
}

beforeEach(async () => {
	storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p44b-"));
	corpusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p44bc-"));
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p44bw-"));
	process.env.SYNAPSE_TEST_KEY = "stub-key";
	stub = await startEmbeddingStub();
	const vectorByText = new Map<string, readonly number[]>([
		["# alpha\nshared memory plane observation one", basis(0)],
		["# beta\ncoordination as compression observation two", basis(1)],
		["# gamma\nresidual quantisation observation three", basis(2)],
	]);
	stub.respondWithVectorForInput((input) => vectorByText.get(input) ?? vectorByText.get(input.trim()) ?? basis(3));
	embedder = createSiliconFlowEmbedder(
		{ dim: DIM, endpoint: `http://127.0.0.1:${stub.port}/v1/embeddings`, keyEnv: "SYNAPSE_TEST_KEY", model: "BAAI/bge-m3", provider: "siliconflow" },
		{ key: "stub-key" },
	);
	fs.mkdirSync(path.join(corpusRoot, "src"), { recursive: true });
	fs.writeFileSync(path.join(corpusRoot, "src", "a.md"), "# alpha\nshared memory plane observation one\n");
	fs.writeFileSync(path.join(corpusRoot, "src", "b.md"), "# beta\ncoordination as compression observation two\n");
	fs.writeFileSync(path.join(corpusRoot, "src", "c.md"), "# gamma\nresidual quantisation observation three\n");
	const built = await buildCorpus({ corpusRoot, embedder, sourceCommit: SOURCE_COMMIT, storageRoot });
	corpusSnapshotId = built.corpusSnapshotId;
});

afterEach(() => {
	if (stub) void stub.close();
	delete process.env.SYNAPSE_TEST_KEY;
	fs.rmSync(storageRoot, { force: true, recursive: true });
	fs.rmSync(corpusRoot, { force: true, recursive: true });
	fs.rmSync(worktree, { force: true, recursive: true });
});

describe("synapse production trigger", () => {
	it("delivers on both planes and the receiver consumes what the sender published", async () => {
		const synapse = synapseContract();
		const opened = await trigger(synapse);

		assert.ok(opened.delegation, "the task plane is attempted whether or not the state plane is");
		assert.ok(opened.state, "an eligible child must get a state delivery");
		assert.equal(opened.state.kind, "state", "the stub embedder and pinned corpus negotiate to the vector path");
		// Both planes hold a file, and they are different files: the delegation
		// inbox still carries the delivery it always did, byte for byte.
		const delegated = readDeliveredEnvelope(delegationInbox());
		assert.equal(delegated.status, "ready");
		assert.equal(delegated.status === "ready" ? delegated.wire.action : null, "delegate");
		const delivered = readDeliveredEnvelope(stateInbox());
		assert.equal(delivered.status, "ready", "the state envelope must have been published to its own path");
		if (delivered.status !== "ready") return;
		assert.equal(delivered.wire.action, "retrieve");
		assert.equal(verifyEnvelopeAgainstContract({ contract: synapse.contract, wire: delivered.wire }), null);

		// The receiver's half, through the same call the child runtime makes.
		const outcome = await consumeRetrieveState({
			contract: synapse.contract,
			deps: { log: createMeteringLog(logPath()) },
			envelope: delivered.wire,
			expectedSenderSessionId: synapse.sessionId,
			fallbackQuery: QUERY,
			identity: { agent: "retriever", attempt: 1, childIndex: 0, runId: RUN_ID, sessionId: "sess-child" },
			k: K,
			worktreeRoot: worktree,
		});
		assert.equal(outcome.kind, "consumed", `the delivered payload must be consumable, got ${outcome.kind}`);
		if (outcome.kind !== "consumed") return;
		assert.equal(outcome.result.hits[0]?.path, "src/b.md", "the ranking must follow the vector the sender embedded");

		const kinds = readMeteringLog(logPath()).map((event) => event.kind);
		const expected: MeteringEvent["kind"][] = ["state-prepare", "state-send", "state-receive", "state-consume", "embedding-call"];
		for (const kind of expected) {
			assert.ok(kinds.includes(kind), `${kind} must be recorded on the shared per-run log`);
		}
		// The sender's query embedding is a real provider call on the launch path;
		// the run's embedder is built from configuration and carries no identity, so
		// without the wrapper around it this cost would be silently absent — the one
		// failure the pre-registration calls out as a silent bias between arms.
	});

	it("leaves the run byte-identical when a child cannot consume state", async () => {
		const opened = await trigger(synapseContract(["read", "grep"]), ["read", "grep"]);

		assert.ok(opened.delegation, "the task plane is unaffected");
		assert.equal(opened.state, null, "a child without a state-consuming tool must not be offered state");
		assert.ok(fs.existsSync(delegationInbox()), "the delegation delivery still happens");
		assert.ok(!fs.existsSync(stateInbox()), "and no state envelope is written");
	});

	it("stays off outside synapse mode and without a pinned corpus", async () => {
		const textMode = await trigger(synapseContract(CONSUMING_TOOLS, { ...extensionConfig(), mode: "text" }));
		assert.equal(textMode.state, null, "text mode must not send state");
		assert.ok(!fs.existsSync(stateInbox()));

		const unpinnedConfig = extensionConfig();
		delete unpinnedConfig.corpusSnapshotId;
		const unpinned = await trigger(synapseContract(CONSUMING_TOOLS, unpinnedConfig));
		assert.equal(unpinned.state, null, "a contract with no pinned corpus must not send state");
		assert.ok(!fs.existsSync(stateInbox()));
	});

	it("sends no state when the provider key is absent, without failing the run", async () => {
		delete process.env.SYNAPSE_TEST_KEY;
		const opened = await trigger(synapseContract());

		assert.ok(opened.delegation, "a missing key must not cost the user their run");
		assert.equal(opened.state, null);
		assert.ok(!fs.existsSync(stateInbox()));
	});

	it("binds admission to the node and the sender, not to the session string the sender recorded", async () => {
		const synapse = synapseContract();
		const opened = await trigger(synapse);
		assert.equal(opened.state?.kind, "state");
		const delivered = readDeliveredEnvelope(stateInbox());
		assert.equal(delivered.status, "ready");
		if (delivered.status !== "ready") return;
		const log = createMeteringLog(logPath());
		const consume = (wire: typeof delivered.wire, expectedSenderSessionId: string | undefined, childIndex = 0, runId = RUN_ID) =>
			consumeRetrieveState({
				contract: synapse.contract,
				deps: { log },
				envelope: wire,
				...(expectedSenderSessionId === undefined ? {} : { expectedSenderSessionId }),
				fallbackQuery: QUERY,
				identity: { agent: "retriever", attempt: 1, childIndex, runId, sessionId: "sess-whatever-this-child-resolves" },
				k: K,
				worktreeRoot: worktree,
			});

		// The string the sender recorded for the receiver is not one this side can
		// reproduce, so it must not gate admission — refusing here is exactly the
		// bug P4-4b exists to remove.
		const unknownReceiver = await consume({ ...delivered.wire, receiverSessionId: "sess-not-what-this-side-resolves" }, synapse.sessionId);
		assert.equal(unknownReceiver.kind, "consumed", "a receiver string this side cannot derive must not refuse a correct delivery");

		// What does gate it: the node the envelope was addressed to, and the sender
		// identity this launch was created under.
		const otherNode = await consume(delivered.wire, synapse.sessionId, 7);
		assert.equal(otherNode.kind, "refused");
		assert.equal(otherNode.kind === "refused" ? otherNode.category : null, "permission");
		const otherRun = await consume(delivered.wire, synapse.sessionId, 0, "run-elsewhere");
		assert.equal(otherRun.kind, "refused");
		const otherSender = await consume(delivered.wire, "sess-not-our-parent");
		assert.equal(otherSender.kind, "refused");
		assert.equal(otherSender.kind === "refused" ? otherSender.category : null, "permission");
	});

	it("does not fail the launch when a stale state envelope cannot be removed", async () => {
		const synapse = synapseContract();
		// A directory sits where a stale envelope would be, so removing it fails with
		// something other than the ENOENT that `force` covers. The clear is
		// housekeeping: the launch must survive not being able to do it.
		fs.mkdirSync(stateInbox(), { recursive: true });
		try {
			const opened = await trigger(synapse, ["read", "grep"]);
			assert.equal(opened.state, null, "no state is sent, and the clear's failure is not the caller's problem");
			assert.notEqual(opened.delegation, null, "the task plane is untouched by a state-plane housekeeping failure");
		} finally {
			fs.rmSync(stateInbox(), { force: true, recursive: true });
		}
	});

	it("does not claim a delivery it could not publish", async () => {
		const synapse = synapseContract();
		// A file where the run's envelope directory belongs: creating the parent
		// fails, the way a full or read-only store would.
		fs.mkdirSync(path.join(storageRoot, "envelopes"), { recursive: true });
		fs.writeFileSync(path.join(storageRoot, "envelopes", RUN_ID), "not a directory");
		const opened = await trigger(synapse);
		assert.equal(opened.state?.kind, "state", "the payload is still prepared and the task still runs");

		const events = readMeteringLog(logPath());
		const sends = events.filter((event) => event.kind === "state-send");
		assert.equal(sends.length, 1);
		const send = sends[0];
		assert.equal(send?.kind === "state-send" ? send.ok : null, false, "a send that never landed is not a successful send");
		assert.equal(send?.kind === "state-send" ? send.payloadBytes : null, 0, "bytes are what crossed the wire, and none did");
		assert.equal(events.filter((event) => event.kind === "message-delivered").length, 1, "only the task plane delivered anything");
		assert.ok(events.some((event) => event.kind === "error"), "the failed publish is recorded as an error");
	});

	it("leaves a launch with no synapse contract exactly as upstream would have sent it", async () => {
		// The shape almost every production launch takes: the extension is off, so
		// the child has no contract. The state half must not touch it at all — this
		// is the path a guard deletion would break for every delegation, and it had
		// no test.
		const opened = await trigger(undefined, ["read", "grep"]);

		assert.equal(opened.delegation, null, "no contract means no delegation seam either");
		assert.equal(opened.state, null);
		assert.ok(!fs.existsSync(`${storageRoot}/envelopes`), "no contract means no inbox is created");
		assert.ok(!fs.existsSync(`${storageRoot}/metering`), "and nothing is metered");
	});

	it("records no state events when a gate keeps the state plane off", async () => {
		const textMode = await trigger(synapseContract(CONSUMING_TOOLS, { ...extensionConfig(), mode: "text" }));
		assert.equal(textMode.state, null);
		// The delivery is refused further down as well, so "no state envelope" alone
		// cannot tell a working gate from a negotiation that fell through. The
		// ledger can: nothing may have been prepared or sent.
		const kinds = readMeteringLog(logPath()).map((event) => event.kind);
		assert.ok(!kinds.includes("state-prepare"), "a gated-off pass must not prepare state");
		assert.ok(!kinds.includes("state-send"), "a gated-off pass must not send state");
		assert.ok(!fs.existsSync(stateInbox()));
	});

	it("consumes under an unattributed parent session, the sender binding degrading to a constant", async () => {
		// `resolveSynapseChildContract` substitutes a placeholder when the launch has
		// no parent session id, so both sides compare that placeholder and the
		// conjunct proves nothing. The run id and the recomputed node id still bind
		// the envelope, which is what this pins: the degradation is survivable, and
		// it is a fact rather than an accident.
		const synapse = synapseContract(CONSUMING_TOOLS, { ...extensionConfig() });
		const unattributed = { ...synapse, sessionId: "unattributed-session" };
		const opened = await trigger(unattributed);
		assert.equal(opened.state?.kind, "state");
		const delivered = readDeliveredEnvelope(stateInbox());
		assert.equal(delivered.status, "ready");
		if (delivered.status !== "ready") return;
		assert.equal(delivered.wire.senderSessionId, "unattributed-session");

		const outcome = await consumeRetrieveState({
			contract: unattributed.contract,
			deps: { log: createMeteringLog(logPath()) },
			envelope: delivered.wire,
			expectedSenderSessionId: unattributed.sessionId,
			fallbackQuery: QUERY,
			identity: { agent: "retriever", attempt: 1, childIndex: 0, runId: RUN_ID, sessionId: "sess-child" },
			k: K,
			worktreeRoot: worktree,
		});
		assert.equal(outcome.kind, "consumed", "an unattributed parent must not refuse a correct delivery");
	});

	it("clears a previous delivery's state envelope when this one cannot send state", async () => {
		const synapse = synapseContract();
		const first = await trigger(synapse);
		assert.equal(first.state?.kind, "state");
		assert.ok(fs.existsSync(stateInbox()));

		// The second pass cannot embed, so it sends nothing — and must not leave
		// the first pass's payload where the child would read it by name.
		delete process.env.SYNAPSE_TEST_KEY;
		const second = await trigger(synapse);
		assert.equal(second.state, null);
		assert.ok(!fs.existsSync(stateInbox()), "a pass that publishes nothing must leave nothing behind");
	});
});
