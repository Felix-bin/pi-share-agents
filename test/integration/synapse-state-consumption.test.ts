import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeAtomicJson } from "../../src/shared/atomic-json.ts";
import { resolveSynapseChildContract, type SynapseChildContract } from "../../src/synapse/child-contract.ts";
import type { CanonicalValue } from "../../src/synapse/canonical-json.ts";
import { buildCorpus } from "../../src/synapse/corpus.ts";
import { createEmbeddingClient, type Embedder } from "../../src/synapse/embedding.ts";
import { readDeliveredEnvelope, stateEnvelopePath } from "../../src/synapse/envelope-inbox.ts";
import { readMeteringLog, type MeteringEvent } from "../../src/synapse/metering.ts";
import type { ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import { openChildDelegationWithState } from "../../src/runs/shared/synapse-delegation.ts";
import registerSubagentPromptRuntime from "../../src/runs/shared/subagent-prompt-runtime.ts";
import { startEmbeddingStub, type StubEmbeddingServer } from "../support/embedding-stub-server.ts";

/**
 * Task card P4-4b, receiving half: the child runtime reads the state envelope
 * addressed to it, consumes it, and steers the session with what the ranking
 * selected.
 *
 * The send half is exercised through the seam the execution paths call, so the
 * envelope here is a real delivery over the real files rather than a fixture.
 * That is deliberate: the defect this card exists to fix was a path that every
 * unit test agreed was correct and that nothing in production ever entered.
 */

const DIM = 8;
const K = 3;
const RUN_ID = "run-consumer";
const SOURCE_COMMIT = "d".repeat(40);
const QUERY = "# beta\ncoordination as compression observation two\n";
const CONSUMING_TOOLS = ["read", "synapse_read"];

function basis(axis: number): number[] {
	const values = Array.from({ length: DIM }, () => 0);
	values[axis] = 1;
	return values;
}

type RuntimeHandlers = Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>;

/** A pi stand-in that records the handlers the runtime registers and the steers it sends. */
function fakePi(steers: string[], onSteer?: (text: string) => void) {
	const handlers: RuntimeHandlers = new Map();
	return {
		handlers,
		pi: {
			on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			sendUserMessage(content: string) {
				steers.push(content);
				onSteer?.(content);
			},
		},
	};
}

function emit(handlers: RuntimeHandlers, event: string, payload?: unknown, ctx?: unknown): void {
	for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
}

type ErrorEvent = Extract<MeteringEvent, { kind: "error" }>;

/**
 * The refusals this side recorded. A refusal that leaves no trace is
 * indistinguishable from a path that never ran, which is exactly the difference
 * these tests exist to keep visible.
 */
function errorEvents(): ErrorEvent[] {
	return readMeteringLog(path.join(storageRoot, "metering", `${RUN_ID}.jsonl`)).filter((event): event is ErrorEvent => event.kind === "error");
}

let storageRoot = "";
let corpusRoot = "";
let worktree = "";
let stub: StubEmbeddingServer;
let embedder: Embedder;
let corpusSnapshotId = "";

function extensionConfig(): Record<string, CanonicalValue> {
	return {
		corpusSnapshotId,
		embedding: { dim: DIM, endpoint: `http://127.0.0.1:${stub.port}/v1/embeddings`, keyEnv: "SYNAPSE_TEST_KEY", model: "BAAI/bge-m3", provider: "siliconflow" },
		memory: "project",
		mode: "synapse",
		storageRoot,
	};
}

function synapseContract(): SynapseChildContract {
	const synapse = resolveSynapseChildContract({
		agentDir: storageRoot,
		agentName: "retriever",
		childTools: CONSUMING_TOOLS,
		cwd: worktree,
		extensionConfig: extensionConfig(),
		runId: RUN_ID,
		sessionId: "sess-parent",
	});
	assert.ok(synapse !== null);
	return synapse;
}

function childConfig(synapse: SynapseChildContract): ChildRuntimeConfig {
	return {
		agent: "retriever",
		childIndex: 0,
		depth: 1,
		fanoutChild: false,
		fast: false,
		inheritGlobalContext: true,
		inheritProjectContext: true,
		inheritSkills: false,
		maxDepth: 2,
		synapse,
		waitTool: { enabled: true },
	};
}

function sessionContext(sessionId: string | null) {
	return {
		sessionManager: {
			getSessionFile: () => "/tmp/session.jsonl",
			getSessionId: () => sessionId,
		},
	};
}

/** Publishes a real state envelope and returns the context a child would run in. */
async function deliveredState() {
	const synapse = synapseContract();
	const opened = await openChildDelegationWithState({
		cwd: worktree,
		message: QUERY,
		receiverSessionId: "sess-child",
		runtime: childConfig(synapse),
	});
	assert.equal(opened.state?.kind, "state", "the send half must publish a state envelope for this test to mean anything");
	return synapse;
}

/** Resolves once the runtime steers the session, or rejects when it does not. */
function steered(): { promise: Promise<string>; resolve: (text: string) => void } {
	let resolve!: (text: string) => void;
	const promise = new Promise<string>((settle) => { resolve = settle; });
	return { promise, resolve };
}

beforeEach(async () => {
	storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p44br-"));
	corpusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p44brc-"));
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p44brw-"));
	process.env.SYNAPSE_TEST_KEY = "stub-key";
	stub = await startEmbeddingStub();
	const vectorByText = new Map<string, readonly number[]>([
		["# alpha\nshared memory plane observation one", basis(0)],
		["# beta\ncoordination as compression observation two", basis(1)],
		["# gamma\nresidual quantisation observation three", basis(2)],
	]);
	stub.respondWithVectorForInput((input) => vectorByText.get(input) ?? vectorByText.get(input.trim()) ?? basis(3));
	embedder = createEmbeddingClient(
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

describe("synapse child state consumption", () => {
	it("consumes the delivered envelope and steers the session with the ranking", async () => {
		const synapse = await deliveredState();
		const steers: string[] = [];
		const signal = steered();
		const { pi, handlers } = fakePi(steers, () => signal.resolve(steers[0] ?? ""));

		registerSubagentPromptRuntime(pi as never, childConfig(synapse));
		emit(handlers, "session_start", {}, sessionContext("sess-child"));
		emit(handlers, "agent_start", {});

		const message = await Promise.race([
			signal.promise,
			new Promise<string>((settle) => setTimeout(() => settle(""), 5_000)),
		]);
		assert.notEqual(message, "", "the runtime must steer the session with the selected chunks");
		assert.match(message, /src\/b\.md/, "the chunk the sent vector ranks first must be named");
		// Order, not mere presence: with the three fixture vectors, any legal ranking
		// contains b.md, so presence alone would pass even if the order were reversed.
		assert.ok(message.indexOf("src/b.md") < message.indexOf("src/a.md"), "the ranking order must survive into the message");
		// The consume is metered on the shared per-run log, not a log of its own.
		const kinds = readMeteringLog(path.join(storageRoot, "metering", `${RUN_ID}.jsonl`)).map((event) => event.kind);
		assert.ok(kinds.includes("state-consume"), "the consumption must be recorded where the sender's events are");
	});

	it("steers once even when the child starts more than one turn", async () => {
		const synapse = await deliveredState();
		const steers: string[] = [];
		const signal = steered();
		const { pi, handlers } = fakePi(steers, () => signal.resolve(steers[0] ?? ""));

		registerSubagentPromptRuntime(pi as never, childConfig(synapse));
		emit(handlers, "session_start", {}, sessionContext("sess-child"));
		emit(handlers, "agent_start", {});
		await Promise.race([signal.promise, new Promise<string>((settle) => setTimeout(() => settle(""), 5_000))]);
		emit(handlers, "agent_start", {});
		emit(handlers, "agent_start", {});
		await new Promise((settle) => setTimeout(settle, 50));

		assert.equal(steers.length, 1, "a second turn must not consume or steer again");
	});

	it("consumes whether or not the session manager can name this session", async () => {
		const synapse = await deliveredState();
		const steers: string[] = [];
		const signal = steered();
		const { pi, handlers } = fakePi(steers, () => signal.resolve(steers[0] ?? ""));

		registerSubagentPromptRuntime(pi as never, childConfig(synapse));
		// No session id: it labels the meter entry and nothing else, so it must not
		// be able to stop a delivery the node and sender bindings already admitted.
		emit(handlers, "session_start", {}, sessionContext(null));
		emit(handlers, "agent_start", {});

		const message = await Promise.race([
			signal.promise,
			new Promise<string>((settle) => setTimeout(() => settle(""), 5_000)),
		]);
		assert.match(message, /src\/b\.md/);
	});

	it("leaves the session alone when the delivered parameters are not a retrieve query", async () => {
		const synapse = await deliveredState();
		const inbox = stateEnvelopePath(storageRoot, RUN_ID, 0);
		const delivered = readDeliveredEnvelope(inbox);
		assert.equal(delivered.status, "ready");
		if (delivered.status !== "ready") return;
		// A wire the schema accepts but whose parameters the receiver cannot use:
		// the shape is the sender's choice, so this side must refuse rather than
		// recover with a default the sender never chose.
		writeAtomicJson(inbox, { ...delivered.wire, inputParamsJson: "{\"k\":1}" });

		const steers: string[] = [];
		const { pi, handlers } = fakePi(steers);
		registerSubagentPromptRuntime(pi as never, childConfig(synapse));
		emit(handlers, "session_start", {}, sessionContext("sess-child"));
		emit(handlers, "agent_start", {});
		await new Promise((settle) => setTimeout(settle, 200));

		assert.deepEqual(steers, [], "an unusable parameter set must not steer the session");
		assert.equal(errorEvents().length, 1, "the refusal must be auditable, not silent");
	});

	it("leaves the session alone when no state envelope was delivered", async () => {
		const synapse = synapseContract();
		const steers: string[] = [];
		const { pi, handlers } = fakePi(steers);
		registerSubagentPromptRuntime(pi as never, childConfig(synapse));
		emit(handlers, "session_start", {}, sessionContext("sess-child"));
		emit(handlers, "agent_start", {});
		await new Promise((settle) => setTimeout(settle, 200));

		assert.deepEqual(steers, [], "a child whose delegation sent no state must run untouched");
	});

	it("leaves the session alone when the envelope names a sender this launch was not created by", async () => {
		const synapse = await deliveredState();
		const inbox = stateEnvelopePath(storageRoot, RUN_ID, 0);
		const delivered = readDeliveredEnvelope(inbox);
		assert.equal(delivered.status, "ready");
		if (delivered.status !== "ready") return;
		// The sender binding is one the child holds for itself — the contract it
		// was launched with — so an envelope from another identity is refused even
		// though it verifies against this contract everywhere else.
		writeAtomicJson(inbox, { ...delivered.wire, senderSessionId: "sess-some-other-parent" });

		const steers: string[] = [];
		const { pi, handlers } = fakePi(steers);
		registerSubagentPromptRuntime(pi as never, childConfig(synapse));
		emit(handlers, "session_start", {}, sessionContext("sess-child"));
		emit(handlers, "agent_start", {});
		await new Promise((settle) => setTimeout(settle, 200));

		assert.deepEqual(steers, [], "an envelope from another sender must not be consumed");
		const refusals = errorEvents();
		assert.equal(refusals.length, 1, "the consumer's own refusal is what the ledger must show");
		assert.equal(refusals[0]?.category, "permission");
	});

	it("leaves the session alone when the envelope belongs to another namespace", async () => {
		const synapse = await deliveredState();
		const inbox = stateEnvelopePath(storageRoot, RUN_ID, 0);
		const delivered = readDeliveredEnvelope(inbox);
		assert.equal(delivered.status, "ready");
		if (delivered.status !== "ready") return;
		// The consumer itself never re-derives the namespace or the snapshot; that
		// check lives here, before the payload is offered to it.
		writeAtomicJson(inbox, { ...delivered.wire, namespaceId: "f".repeat(16) });

		const steers: string[] = [];
		const { pi, handlers } = fakePi(steers);
		registerSubagentPromptRuntime(pi as never, childConfig(synapse));
		emit(handlers, "session_start", {}, sessionContext("sess-child"));
		emit(handlers, "agent_start", {});
		await new Promise((settle) => setTimeout(settle, 200));

		assert.deepEqual(steers, [], "an envelope frozen against another namespace must not be consumed");
		assert.equal(errorEvents().length, 1, "the rejection must be recorded here, not only on stderr");
	});

	it("keeps the consumption metered when the steer channel throws", async () => {
		const synapse = await deliveredState();
		const log = readMeteringLog(path.join(storageRoot, "metering", `${RUN_ID}.jsonl`));
		const before = log.filter((event) => event.kind === "state-consume").length;
		const { pi, handlers } = fakePi([], () => {
			throw new Error("the host refused the steering input");
		});

		registerSubagentPromptRuntime(pi as never, childConfig(synapse));
		emit(handlers, "session_start", {}, sessionContext("sess-child"));
		emit(handlers, "agent_start", {});
		await new Promise((settle) => setTimeout(settle, 200));

		// The payload was consumed whether or not the child could be told about it,
		// and the delivery of that fact must not take the session down with it.
		const after = readMeteringLog(path.join(storageRoot, "metering", `${RUN_ID}.jsonl`)).filter((event) => event.kind === "state-consume").length;
		assert.equal(after, before + 1, "the consume is recorded before the steer is attempted");
	});

	it("refuses an unreadable state envelope instead of treating it as absent", async () => {
		const synapse = await deliveredState();
		const inbox = stateEnvelopePath(storageRoot, RUN_ID, 0);
		fs.rmSync(inbox, { force: true });
		// A directory where the envelope should be: reading it fails with something
		// other than ENOENT, which is a broken store rather than a delivery that
		// never happened.
		fs.mkdirSync(inbox);

		const steers: string[] = [];
		const { pi, handlers } = fakePi(steers);
		registerSubagentPromptRuntime(pi as never, childConfig(synapse));
		emit(handlers, "session_start", {}, sessionContext("sess-child"));
		emit(handlers, "agent_start", {});
		await new Promise((settle) => setTimeout(settle, 200));

		assert.deepEqual(steers, []);
		assert.equal(errorEvents().length, 1, "an unreadable envelope is a store problem, and it is recorded");
		fs.rmSync(inbox, { force: true, recursive: true });
	});

	it("does not consume a payload the consumer would not have admitted as a retrieve", async () => {
		const synapse = await deliveredState();
		const inbox = stateEnvelopePath(storageRoot, RUN_ID, 0);
		const delivered = readDeliveredEnvelope(inbox);
		assert.equal(delivered.status, "ready");
		if (delivered.status !== "ready") return;
		// A delegate action that somehow carried a stateRef: the consumer checks
		// the payload, not the action, so the action is checked here or not at all.
		writeAtomicJson(inbox, { ...delivered.wire, action: "delegate" });

		const steers: string[] = [];
		const { pi, handlers } = fakePi(steers);
		registerSubagentPromptRuntime(pi as never, childConfig(synapse));
		emit(handlers, "session_start", {}, sessionContext("sess-child"));
		emit(handlers, "agent_start", {});
		await new Promise((settle) => setTimeout(settle, 200));

		assert.deepEqual(steers, [], "only a retrieve delivery carries state on this path");
		assert.equal(errorEvents().length, 1, "a state inbox holding something else is a divergence worth a row");
	});
});

describe("AC-probe: the state seam's verifiable promise", () => {
	it("degrades to text with a recorded verdict when the pinned corpus is missing from the store", async () => {
		// A real 64-hex snapshot id that was never published passes the seam's
		// cheap gates (it is not "unset") — the probe is what catches it, before
		// an embedding call is spent on a payload no consume could rank.
		const missing = resolveSynapseChildContract({
			agentDir: storageRoot,
			agentName: "retriever",
			childTools: CONSUMING_TOOLS,
			cwd: worktree,
			extensionConfig: { ...extensionConfig(), corpusSnapshotId: "b".repeat(64) },
			runId: RUN_ID,
			sessionId: "sess-parent",
		});
		assert.ok(missing !== null);
		const opened = await openChildDelegationWithState({
			cwd: worktree,
			message: QUERY,
			receiverSessionId: "sess-child",
			runtime: childConfig(missing),
		});
		assert.ok(opened.state !== null, "the delegation opens: an unverified promise degrades, it does not vanish");
		assert.equal(opened.state.kind, "text");
		if (opened.state.kind !== "text") return;
		assert.equal(opened.state.reason, "probe-unverified");
		const probeEvents = readMeteringLog(path.join(storageRoot, "metering", `${RUN_ID}.jsonl`)).filter((event) => event.kind === "capability-probe");
		assert.equal(probeEvents.length, 1, "the failing verdict is answerable from the ledger");
		assert.equal(probeEvents[0] && "ok" in probeEvents[0] ? probeEvents[0].ok : undefined, false);
		// And the store the next delegation runs against has the real corpus, so
		// the verdict flips back without any code path in between.
		const healed = await openChildDelegationWithState({
			cwd: worktree,
			message: QUERY,
			receiverSessionId: "sess-child",
			runtime: childConfig(synapseContract()),
		});
		assert.equal(healed.state?.kind, "state", "a different key (real snapshot) is probed on its own and passes");
	});
});
