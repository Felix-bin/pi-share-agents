import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildCorpus } from "../../src/synapse/corpus.ts";
import { createContentStore } from "../../src/synapse/content-store.ts";
import { createSiliconFlowEmbedder, type Embedder } from "../../src/synapse/embedding.ts";
import { resolveLaunchContract, type LaunchContract } from "../../src/synapse/lifecycle.ts";
import {
	consumeRetrieveState,
	openRetrieveDelegation,
	type ConsumeDeps,
	type ConsumeIdentity,
	type OpenRetrieveInput,
	type RetrieveSendResult,
	type SendDeps,
	type SendIdentity,
} from "../../src/synapse/delegation.ts";
import { createMeteringLog, aggregateMetering, readMeteringLog, type MeteringEvent, type MeteringLog } from "../../src/synapse/metering.ts";
import { createMemoryService, SYNAPSE_MAX_SEARCH_K } from "../../src/synapse/memory-service.ts";
import { startEmbeddingStub, type StubEmbeddingServer } from "../support/embedding-stub-server.ts";

/**
 * Task card P3-5: a retrieve delegation crosses the state plane end to end.
 * Two instances — a sender that embeds and publishes, a receiver that consumes
 * — share one CAS and one corpus snapshot, and the metering log must be able
 * to prove the vector that ranked the corpus is the vector that was sent
 * (AC-04), that a different vector changes the ranking (AC-05), and that no
 * corrupted payload is ever consumed (AC-11).
 */

const DIM = 8;
const K = 3;
const SOURCE_COMMIT = "f".repeat(40);

/** Orthonormal fixture vectors so cosine ordering is exact by construction. */
function basis(axis: number): number[] {
	const values = Array.from({ length: DIM }, () => 0);
	values[axis] = 1;
	return values;
}

let storageRoot = "";
let corpusRoot = "";
let worktree = "";
let logPath = "";
let log: MeteringLog = createMeteringLog("");
let stub: StubEmbeddingServer;
let embedder: Embedder;
let corpusSnapshotId = "";
type ContractPair = { child: LaunchContract; parent: LaunchContract };
let contracts: ContractPair;

function contractFor(agentScope: { write: boolean }): LaunchContract {
	return resolveLaunchContract({
		capabilityId: "a".repeat(64),
		memoryRefs: [],
		corpusSnapshotId,
		mode: "synapse",
		namespaceId: "0123456789abcdef",
		representationId: embedder.representationId,
		scope: { pathPrefixes: [""], write: agentScope.write },
		storageRoot,
	});
}

function sendIdentity(childTools: readonly string[]): SendIdentity {
	return {
		agent: "retriever",
		attempt: 1,
		childIndex: 0,
		childTools,
		receiverSessionId: "sess-child",
		requestId: "req-1",
		runId: "run-1",
		senderSessionId: "sess-parent",
	};
}

function consumeIdentity(runId = "run-1", sessionId = "sess-child"): ConsumeIdentity {
	return { agent: "retriever", attempt: 1, childIndex: 0, runId, sessionId };
}

function sendDeps(): SendDeps {
	return { log };
}

/** Opens a retrieve delegation and narrows it to the state branch, or fails. */
async function sendState(input: OpenRetrieveInput): Promise<Extract<RetrieveSendResult, { kind: "state" }>> {
	const result = await openRetrieveDelegation(input);
	assert.ok(result !== null, "the retrieve delegation must open");
	assert.equal(result.kind, "state", `negotiation must select the vector path, got ${result.kind}`);
	// SAFETY: the assertions above proved null-free and state-kind; the cast only
	// picks the union branch that already holds.
	return result as Extract<RetrieveSendResult, { kind: "state" }>;
}

/** Opens a retrieve delegation and narrows it to the text branch, or fails. */
async function sendText(input: OpenRetrieveInput): Promise<Extract<RetrieveSendResult, { kind: "text" }>> {
	const result = await openRetrieveDelegation(input);
	assert.ok(result !== null, "the retrieve delegation must open");
	assert.equal(result.kind, "text", `this negotiation must fall back to text, got ${result.kind}`);
	// SAFETY: same proof, text branch.
	return result as Extract<RetrieveSendResult, { kind: "text" }>;
}

function consumeDeps(overrides: Partial<ConsumeDeps> = {}): ConsumeDeps {
	return { log, ...overrides };
}

function eventsOf(kind: string): MeteringEvent[] {
	return readMeteringLog(logPath).filter((event) => event.kind === kind);
}

beforeEach(async () => {
	storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p35-"));
	corpusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p35c-"));
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p35w-"));
	logPath = path.join(storageRoot, "metering", "run-1.jsonl");
	log = createMeteringLog(logPath);
	stub = await startEmbeddingStub();
	// Keys are the chunk texts buildCorpus produces (no trailing newline); a
	// query that still carries its trailing newline hits through the trim fallback.
	const vectorByText = new Map<string, readonly number[]>([
		["# alpha\nshared memory plane observation one", basis(0)],
		["# beta\ncoordination as compression observation two", basis(1)],
		["# gamma\nresidual quantisation observation three", basis(2)],
	]);
	stub.respondWithVectorForInput((input) => vectorByText.get(input) ?? vectorByText.get(input.trim()) ?? basis(3));
	embedder = createSiliconFlowEmbedder(
		{ dim: DIM, endpoint: `http://127.0.0.1:${stub.port}/v1/embeddings`, keyEnv: "SYNAPSE_TEST_KEY", model: "BAAI/bge-m3", provider: "siliconflow" },
		{
			identity: { agent: "parent", attempt: 1, mode: "synapse", nodeId: "run-1/0", runId: "run-1", sessionId: "sess-parent", snapshotId: null },
			key: "stub-key",
			// Embedding calls must show up in the same log the state events do, so
			// a text fallback is provably metered rather than asserted to be.
			metering: log,
		},
	);
	fs.mkdirSync(path.join(corpusRoot, "src"), { recursive: true });
	fs.writeFileSync(path.join(corpusRoot, "src", "a.md"), "# alpha\nshared memory plane observation one\n");
	fs.writeFileSync(path.join(corpusRoot, "src", "b.md"), "# beta\ncoordination as compression observation two\n");
	fs.writeFileSync(path.join(corpusRoot, "src", "c.md"), "# gamma\nresidual quantisation observation three\n");
	const built = await buildCorpus({ corpusRoot, embedder, sourceCommit: SOURCE_COMMIT, storageRoot });
	corpusSnapshotId = built.corpusSnapshotId;
	contracts = { child: contractFor({ write: false }), parent: contractFor({ write: false }) };
});

afterEach(async () => {
	await stub.close();
	fs.rmSync(storageRoot, { force: true, recursive: true });
	fs.rmSync(corpusRoot, { force: true, recursive: true });
	fs.rmSync(worktree, { force: true, recursive: true });
});

it("refuses a k the receiver would refuse, before spending the embedding call", async () => {
	// The receiver bounds k with SYNAPSE_MAX_SEARCH_K; a sender that accepted a
	// larger one would publish an envelope that is metered and never consumable.
	await assert.rejects(
		openRetrieveDelegation({
			contract: contracts.parent,
			deps: sendDeps(),
			embedder,
			identity: sendIdentity(["read", "synapse_read"]),
			k: SYNAPSE_MAX_SEARCH_K + 1,
			// The k check runs before the embedding call, so the query text never reaches the provider here.
			query: "unused by this assertion",
			worktreeRoot: worktree,
		}),
		/k-out-of-range/,
	);
});

describe("AC-04: two instances hand a float32 state across the delegation seam", () => {
	it("records prepare, send, receive and consume, and the consumed vector is byte-identical to the sent one", async () => {
		const sent = await sendState({
			contract: contracts.parent,
			deps: sendDeps(),
			embedder,
			identity: sendIdentity(["read", "synapse_read"]),
			k: K,
			query: "# beta\ncoordination as compression observation two\n",
			worktreeRoot: worktree,
		});
		assert.ok(sent.stateRef, "a state delegation carries a stateRef");

		const consumed = await consumeRetrieveState({
			contract: contracts.child,
			deps: consumeDeps(),
			envelope: sent.envelope,
			identity: consumeIdentity(),
			worktreeRoot: worktree,
			k: K,
		});
		assert.equal(consumed.kind, "consumed");
		assert.equal(consumed.result.hits[0]?.path, "src/b.md");

		for (const kind of ["state-prepare", "state-send", "state-receive", "state-consume"]) {
			assert.equal(eventsOf(kind).length, 1, `${kind} must be recorded exactly once`);
		}
		// The log is the primary record: the totals must be recomputable from it,
		// with the stateId≡payloadId contract tying receive to consume.
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.deepEqual(
			{ consumed: totals.state.consumed, prepared: totals.state.prepared, received: totals.state.received, receivedWithoutConsume: totals.state.receivedWithoutConsume, sent: totals.state.sent },
			{ consumed: 1, prepared: 1, received: 1, receivedWithoutConsume: 0, sent: 1 },
		);
		assert.ok(totals.control.envelopeBytes > 0, "the retrieve envelope's control bytes must be metered");
		// The payload the receiver decoded is the payload the sender published:
		// same CAS object, same digest, byte for byte.
		const payload = createContentStore(storageRoot).read(sent.stateRef.payloadId);
		const expected = Buffer.alloc(DIM * 4);
		for (let element = 0; element < DIM; element += 1) expected.writeFloatLE(element === 1 ? 1 : 0, element * 4);
		assert.ok(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).equals(expected), "the CAS object must be the unit vector e2 the stub returned");
		assert.equal(sent.stateRef.sha256, sent.stateRef.payloadId);
		assert.equal(sent.stateRef.byteLength, DIM * 4);
		assert.equal(sent.envelope.wire.action, "retrieve");
		assert.equal(sent.envelope.wire.stateRef?.payloadId, sent.stateRef.payloadId);
	});

	it("binds the envelope to the run and session it names (P3-4 handover item 1)", async () => {
		const sent = await sendState({
			contract: contracts.parent,
			deps: sendDeps(),
			embedder,
			identity: sendIdentity(["read", "synapse_read"]),
			k: K,
			query: "# beta\ncoordination as compression observation two\n",
			worktreeRoot: worktree,
		});
		const refused = await consumeRetrieveState({
			contract: contracts.child,
			deps: consumeDeps(),
			envelope: sent.envelope,
			identity: consumeIdentity("run-other", "sess-other"),
			worktreeRoot: worktree,
			k: K,
		});
		assert.equal(refused.kind, "refused");
		assert.equal(refused.category, "permission");
		assert.equal(eventsOf("state-consume").length, 0, "a refused envelope must not be consumed");
	});

	it("refuses an envelope whose corpus snapshot is not the pinned one (P3-4 handover item 2)", async () => {
		const sent = await sendState({
			contract: contracts.parent,
			deps: sendDeps(),
			embedder,
			identity: sendIdentity(["read", "synapse_read"]),
			k: K,
			query: "# beta\ncoordination as compression observation two\n",
			worktreeRoot: worktree,
		});
		const drifted = { ...contracts.child, corpusSnapshotId: "9".repeat(64) };
		const outcome = await consumeRetrieveState({
			contract: drifted,
			deps: consumeDeps(),
			envelope: sent.envelope,
			identity: consumeIdentity(),
			worktreeRoot: worktree,
			k: K,
		});
		assert.equal(outcome.kind, "refused");
		assert.equal(outcome.category, "configuration");
	});

	it("refuses to publish a state when the contract has no pinned corpus, before any embedding spend", async () => {
		const unpinned = { ...contracts.parent, corpusSnapshotId: "unset" };
		await assert.rejects(
			sendState({
				contract: unpinned,
				deps: sendDeps(),
				embedder,
				identity: sendIdentity(["read", "synapse_read"]),
				k: K,
				query: "# beta\ncoordination as compression observation two\n",
				worktreeRoot: worktree,
			}),
			/synapse\.corpusSnapshotId/,
		);
		assert.equal(eventsOf("state-prepare").length, 0, "no embedding may be spent on an unrankable state");
	});

	it("refuses a stateRef whose representation is not the contract's own", async () => {
		const sent = await sendState({
			contract: contracts.parent,
			deps: sendDeps(),
			embedder,
			identity: sendIdentity(["read", "synapse_read"]),
			k: K,
			query: "# beta\ncoordination as compression observation two\n",
			worktreeRoot: worktree,
		});
		const forged = { ...sent.stateRef, representationId: "siliconflow/other-model/8" };
		const outcome = await consumeRetrieveState({
			contract: contracts.child,
			deps: consumeDeps(),
			envelope: { ...sent.envelope.wire, stateRef: forged },
			identity: consumeIdentity(),
			worktreeRoot: worktree,
			k: K,
		});
		assert.equal(outcome.kind, "refused");
		assert.equal(outcome.category, "representation");
		assert.equal(eventsOf("state-consume").length, 0);
	});

	it("refuses a stateRef naming a malformed id instead of throwing out of the store", async () => {
		const sent = await sendState({
			contract: contracts.parent,
			deps: sendDeps(),
			embedder,
			identity: sendIdentity(["read", "synapse_read"]),
			k: K,
			query: "# beta\ncoordination as compression observation two\n",
			worktreeRoot: worktree,
		});
		const malformed = { ...sent.stateRef, payloadId: "../../escape", sha256: "0".repeat(64) };
		const outcome = await consumeRetrieveState({
			contract: contracts.child,
			deps: consumeDeps(),
			envelope: { ...sent.envelope.wire, stateRef: malformed },
			identity: consumeIdentity(),
			worktreeRoot: worktree,
			k: K,
		});
		assert.equal(outcome.kind, "refused");
		assert.equal(outcome.category, "integrity");
	});
});

describe("AC-05: the ranking follows the vector, and the text path never claims state", () => {
	it("a different query vector moves the top-k", async () => {
		const first = await sendState({
			contract: contracts.parent,
			deps: sendDeps(),
			embedder,
			identity: sendIdentity(["read", "synapse_read"]),
			k: K,
			query: "# beta\ncoordination as compression observation two\n",
			worktreeRoot: worktree,
		});
		const firstConsumed = await consumeRetrieveState({
			contract: contracts.child,
			deps: consumeDeps(),
			envelope: first.envelope,
			identity: consumeIdentity(),
			worktreeRoot: worktree,
			k: K,
		});
		assert.equal(firstConsumed.kind, "consumed");
		assert.equal(firstConsumed.result.hits[0]?.path, "src/b.md");

		const second = await sendState({
			contract: contracts.parent,
			deps: sendDeps(),
			embedder,
			identity: { ...sendIdentity(["read", "synapse_read"]), attempt: 2, requestId: "req-2" },
			k: K,
			query: "# alpha\nshared memory plane observation one\n",
			worktreeRoot: worktree,
		});
		const secondConsumed = await consumeRetrieveState({
			contract: contracts.child,
			deps: consumeDeps(),
			envelope: second.envelope,
			identity: { ...consumeIdentity(), attempt: 2 },
			worktreeRoot: worktree,
			k: K,
		});
		assert.equal(secondConsumed.kind, "consumed");
		assert.equal(secondConsumed.result.hits[0]?.path, "src/a.md");
		assert.notEqual(secondConsumed.result.hits[0]?.chunkId, firstConsumed.result.hits[0]?.chunkId);
	});

	it("falls back to text and never reports state when the receiver holds no consuming tool", async () => {
		const sent = await sendText({
			contract: contracts.parent,
			deps: sendDeps(),
			embedder,
			identity: sendIdentity(["read", "grep"]),
			k: K,
			query: "# beta\ncoordination as compression observation two\n",
			worktreeRoot: worktree,
		});
		assert.equal(sent.reason, "receiver-cannot-consume-state");
		assert.equal(sent.envelope.wire.stateRef, null);
		for (const kind of ["state-prepare", "state-send", "state-consume"]) {
			assert.equal(eventsOf(kind).length, 0, `a text fallback must not emit ${kind}`);
		}
	});
});

describe("AC-11: injected corruption is never consumed and the recovery chain stays bounded", () => {
	async function sendOnce(): Promise<Extract<Awaited<ReturnType<typeof openRetrieveDelegation>>, { kind: "state" }>> {
		const sent = await sendState({
			contract: contracts.parent,
			deps: sendDeps(),
			embedder,
			identity: sendIdentity(["read", "synapse_read"]),
			k: K,
			query: "# beta\ncoordination as compression observation two\n",
			worktreeRoot: worktree,
		});
		return sent;
	}

	it("a tampered byteLength is retried from the sender's copy once, then fails (spec §8.2 line 1)", async () => {
		const sent = await sendOnce();
		const truncated = { ...sent.stateRef, byteLength: sent.stateRef.byteLength - 4 };
		let resends = 0;
		const outcome = await consumeRetrieveState({
			contract: contracts.child,
			deps: consumeDeps({ resend: () => { resends += 1; return Buffer.alloc(DIM * 4); } }),
			envelope: { ...sent.envelope.wire, stateRef: truncated },
			identity: consumeIdentity(),
			worktreeRoot: worktree,
			k: K,
		});
		assert.equal(outcome.kind, "failed");
		assert.equal(outcome.category, "integrity");
		assert.equal(resends, 1, "object problems are re-sent exactly once");
		assert.equal(eventsOf("state-consume").length, 0);
	});

	it("a rewritten sha256 stays refusable even after a resend", async () => {
		const sent = await sendOnce();
		const store = createContentStore(storageRoot);
		const original = fs.readFileSync(store.objectPath(sent.stateRef.payloadId));
		const forged = { ...sent.stateRef, sha256: "0".repeat(64) };
		let resends = 0;
		const outcome = await consumeRetrieveState({
			contract: contracts.child,
			deps: consumeDeps({ resend: () => { resends += 1; return original; } }),
			envelope: { ...sent.envelope.wire, stateRef: forged },
			identity: consumeIdentity(),
			worktreeRoot: worktree,
			k: K,
		});
		assert.equal(outcome.kind, "failed");
		assert.equal(outcome.category, "integrity");
		assert.equal(resends, 1);
		assert.equal(eventsOf("state-consume").length, 0);
	});

	it("a changed dim is a representation failure that never retries", async () => {
		const sent = await sendOnce();
		// A self-consistent 12-dim payload: the envelope and the object agree with
		// each other, so only the corpus comparison can name the mismatch. The
		// bytes are non-zero so the zero-norm guard does not fire first.
		const foreignDim = DIM + 4;
		const foreignBytes = Buffer.alloc(foreignDim * 4);
		for (let index = 0; index < foreignDim; index += 1) foreignBytes.writeFloatLE(index === 0 ? 1 : 0, index * 4);
		const store = createContentStore(storageRoot);
		const foreignId = store.put(foreignBytes, "application/octet-stream");
		const redimmed = { ...sent.stateRef, byteLength: foreignDim * 4, dim: foreignDim, payloadId: foreignId, sha256: foreignId };
		const outcome = await consumeRetrieveState({
			contract: contracts.child,
			deps: consumeDeps(),
			envelope: { ...sent.envelope.wire, stateRef: redimmed },
			identity: consumeIdentity(),
			worktreeRoot: worktree,
			k: K,
		});
		assert.equal(outcome.kind, "failed");
		assert.equal(outcome.category, "representation");
		assert.equal(eventsOf("state-consume").length, 0);
		assert.equal(eventsOf("state-send").length, 1, "a representation failure must not trigger a resend");
	});

	it("a deleted object is re-sent once, then fails without unbounded retries", async () => {
		const sent = await sendOnce();
		const store = createContentStore(storageRoot);
		fs.rmSync(store.objectPath(sent.stateRef.payloadId));
		let resends = 0;
		const outcome = await consumeRetrieveState({
			contract: contracts.child,
			deps: consumeDeps({ resend: () => { resends += 1; return null; } }),
			envelope: sent.envelope,
			identity: consumeIdentity(),
			worktreeRoot: worktree,
			k: K,
		});
		assert.equal(outcome.kind, "failed");
		assert.equal(outcome.category, "object-unavailable");
		assert.equal(resends, 1, "the recovery chain re-sends at most once");
		assert.equal(eventsOf("state-send").length, 1, "a failed resend does not emit a second send");
		assert.equal(eventsOf("state-consume").length, 0);
	});

	it("a resend that restores the object lets the chain consume it", async () => {
		const sent = await sendOnce();
		const store = createContentStore(storageRoot);
		const bytes = fs.readFileSync(store.objectPath(sent.stateRef.payloadId));
		fs.rmSync(store.objectPath(sent.stateRef.payloadId));
		let resends = 0;
		const outcome = await consumeRetrieveState({
			contract: contracts.child,
			// The seam itself re-publishes the re-sent bytes under the vector media
			// type; the callback only hands the sender's verified copy back.
			deps: consumeDeps({ resend: () => { resends += 1; return bytes; } }),
			envelope: sent.envelope,
			identity: consumeIdentity(),
			worktreeRoot: worktree,
			k: K,
		});
		assert.equal(outcome.kind, "consumed");
		assert.equal(outcome.result.hits[0]?.path, "src/b.md");
		assert.equal(resends, 1);
		assert.equal(eventsOf("state-consume").length, 1);
		// The received set is false at first receipt (the object was gone) and the
		// recovery consumes anyway: the aggregate must stay recomputable from the
		// log with received=0 and consumed=1 (group review X-9).
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.state.consumed, 1);
		assert.equal(totals.state.received, 0);
	});

	it("keeps a rejected resend inside the outcome instead of throwing through the seam", async () => {
		const sent = await sendOnce();
		fs.rmSync(createContentStore(storageRoot).objectPath(sent.stateRef.payloadId));
		// Oversized caller bytes: the store refuses them, and the refusal must
		// surface as a failed recovery, never as an exception.
		const oversized = new Uint8Array(2 * 1024 * 1024);
		let resends = 0;
		const outcome = await consumeRetrieveState({
			contract: contracts.child,
			deps: consumeDeps({ resend: () => { resends += 1; return oversized; } }),
			envelope: sent.envelope,
			identity: consumeIdentity(),
			worktreeRoot: worktree,
			k: K,
		});
		assert.equal(outcome.kind, "failed");
		assert.equal(outcome.category, "persistence");
		assert.equal(resends, 1);
		assert.equal(eventsOf("state-consume").length, 0);
	});

	it("heals a corrupted object through the resend, not only a deleted one (group review X-1)", async () => {
		const sent = await sendOnce();
		const store = createContentStore(storageRoot);
		const objectPath = store.objectPath(sent.stateRef.payloadId);
		const original = fs.readFileSync(objectPath);
		// Same file name, different bytes: the read no longer hashes to the id.
		const corrupted = Buffer.from(original);
		corrupted[0] = corrupted[0]! ^ 0xff;
		fs.writeFileSync(objectPath, corrupted);
		let resends = 0;
		const outcome = await consumeRetrieveState({
			contract: contracts.child,
			deps: consumeDeps({ resend: () => { resends += 1; return original; } }),
			envelope: sent.envelope,
			identity: consumeIdentity(),
			worktreeRoot: worktree,
			k: K,
		});
		assert.equal(outcome.kind, "consumed", "a corrupted body must be replaced by the re-sent verified copy, not stuck behind a no-op put");
		assert.equal(outcome.result.hits[0]?.path, "src/b.md");
		assert.equal(resends, 1);
		assert.equal(eventsOf("state-consume").length, 1);
	});

	it("falls back to text once when the resend fails and recovery allows it", async () => {
		const sent = await sendOnce();
		// A stored memory carrying a vector, so the fallback's semantic path
		// actually re-embeds instead of early-returning over an empty store.
		const seeding = createMemoryService({
			corpusSnapshotId,
			embedder,
			provenance: { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "sess-child" },
			scope: { agent: "retriever", namespaceId: "0123456789abcdef", pathPrefixes: [""], write: true },
			storeRoot: storageRoot,
			worktreeRoot: worktree,
		});
		await seeding.remember({
			content: "coordination as compression observation two",
			kind: "evidence",
			operationId: "op-seed",
			summary: "coordination as compression observation two",
			tags: [],
			topic: "beta",
		});
		const embedCallsBefore = eventsOf("embedding-call").length;
		const store = createContentStore(storageRoot);
		fs.rmSync(store.objectPath(sent.stateRef.payloadId));
		let resends = 0;
		const outcome = await consumeRetrieveState({
			contract: contracts.child,
			deps: consumeDeps({ embedder, resend: () => { resends += 1; return null; } }),
			envelope: sent.envelope,
			fallbackQuery: "compression observation two",
			identity: consumeIdentity(),
			worktreeRoot: worktree,
			k: K,
			stateRecovery: "resend-then-text",
		});
		assert.equal(outcome.kind, "text-fallback");
		assert.equal(resends, 1, "the fallback happens only after the one resend");
		assert.ok(outcome.result.results.length >= 1, "the fallback ranks the seeded memory like an ordinary text search");
		assert.equal(eventsOf("state-consume").length, 0, "a text fallback never counts as consumption");
		const embedDelta = eventsOf("embedding-call").length - embedCallsBefore;
		assert.ok(embedDelta >= 1, "the fallback's re-embedding must actually happen and be metered, not free");
	});
});
