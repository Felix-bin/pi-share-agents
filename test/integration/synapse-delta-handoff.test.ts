import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildCorpus } from "../../src/synapse/corpus.ts";
import { createContentStore } from "../../src/synapse/content-store.ts";
import { type Embedder, createEmbeddingClient } from "../../src/synapse/embedding.ts";
import {
	consumeRetrieveState,
	openRetrieveDelegation,
	type ConsumeDeps,
	type ConsumeIdentity,
	type OpenRetrieveInput,
	type ResendReplacement,
	type RetrieveSendResult,
	type SendDeps,
	type SendIdentity,
} from "../../src/synapse/delegation.ts";
import { publishEnvelope, readDeliveredEnvelope } from "../../src/synapse/envelope-inbox.ts";
import { resolveLaunchContract, type LaunchContract } from "../../src/synapse/lifecycle.ts";
import { createMemoryService, type MemoryService } from "../../src/synapse/memory-service.ts";
import { aggregateMetering, createMeteringLog, readMeteringLog, type MeteringEvent, type MeteringLog } from "../../src/synapse/metering.ts";
import { startEmbeddingStub, type StubEmbeddingServer } from "../support/embedding-stub-server.ts";

/**
 * Task card P4-4, receive side and full-account metering: a residual crosses the
 * seam, and every way it can fail still ends in a recorded outcome.
 *
 * The base is the whole point of this card, so it is never faked here: the sender
 * picks it by ranking its own memory (`MemoryService.predictBase`), the receiver
 * rebuilds it from its own records through the same verified read the semantic
 * ranking uses, and the "base is gone" case deletes the real object. A test that
 * injected the base would prove the decoder works while leaving the mechanism's
 * actual dependency — a record both sides can independently rebuild — untested.
 */

const DIM = 8;
const K = 3;
const SOURCE_COMMIT = "f".repeat(40);
const BETA_TEXT = "# beta\ncoordination as compression observation two";

/** Orthonormal fixture vectors so cosine ordering is exact by construction. */
function basis(axis: number): number[] {
	const values = Array.from({ length: DIM }, () => 0);
	values[axis] = 1;
	return values;
}

/**
 * A base close to, but below, the frozen stop condition: after quantisation its
 * cosine to the query is about 0.95, under the 0.99 threshold, so the encoder has
 * to add components and the residual carries real bytes.
 *
 * That threshold is why a base cannot just be "similar": a base at 0.995 needs no
 * correction at all, the encoder emits an empty payload, and a test expecting bytes
 * would either tamper with nothing or assert about a message the mechanism
 * legitimately decided not to send.
 */
function baseUnderThreshold(): number[] {
	const values = Array.from({ length: DIM }, () => 0);
	values[1] = 0.95;
	values[2] = 0.3123;
	let norm = 0;
	for (const value of values) norm += value * value;
	const scale = 1 / Math.sqrt(norm);
	return values.map((value) => value * scale);
}

let storageRoot = "";
let corpusRoot = "";
let worktree = "";
let logPath = "";
let log: MeteringLog = createMeteringLog("");
let stub: StubEmbeddingServer;
let embedder: Embedder;
let corpusSnapshotId = "";
let contract: LaunchContract;

function contractFor(): LaunchContract {
	return resolveLaunchContract({
		capabilityId: "a".repeat(64),
		memoryRefs: [],
		corpusSnapshotId,
		mode: "synapse",
		namespaceId: "0123456789abcdef",
		representationId: embedder.representationId,
		scope: { pathPrefixes: [""], write: true },
		storageRoot,
	});
}

function sendIdentity(): SendIdentity {
	return {
		agent: "retriever",
		attempt: 1,
		childIndex: 0,
		childTools: ["read", "synapse_read"],
		receiverSessionId: "sess-child",
		requestId: "req-1",
		runId: "run-1",
		senderSessionId: "sess-parent",
	};
}

function consumeIdentity(): ConsumeIdentity {
	return { agent: "retriever", attempt: 1, childIndex: 0, runId: "run-1", sessionId: "sess-child" };
}

/** A memory service over the shared store; `write` distinguishes the two instances. */
function memory(write: boolean, agent = "retriever"): MemoryService {
	return createMemoryService({
		corpusSnapshotId,
		embedder,
		metering: { identity: { agent, attempt: 1, mode: "synapse", nodeId: "run-1/0", runId: "run-1", sessionId: `sess-${agent}`, snapshotId: null }, log },
		provenance: { agent, attempt: 1, runId: "run-1", sessionId: `sess-${agent}` },
		scope: { agent, namespaceId: "0123456789abcdef", pathPrefixes: [""], write },
		storeRoot: storageRoot,
		worktreeRoot: worktree,
	});
}

function sendDeps(service: MemoryService): SendDeps {
	return { log, predictedBase: (query) => service.predictBase(query) };
}

function consumeDeps(service: MemoryService, overrides: Partial<ConsumeDeps> = {}): ConsumeDeps {
	return { embedder, log, service, ...overrides };
}

/**
 * The log's events of one kind, narrowed by a lookup keyed on the union's own
 * discriminant: a hand-written shape here could drift from the metering schema
 * without anything failing.
 */
function eventsOf<K extends MeteringEvent["kind"]>(kind: K): (MeteringEvent & { kind: K })[] {
	return readMeteringLog(logPath).filter((event): event is MeteringEvent & { kind: K } => event.kind === kind);
}

async function sendState(input: OpenRetrieveInput): Promise<Extract<RetrieveSendResult, { kind: "state" }>> {
	const result = await openRetrieveDelegation(input);
	assert.ok(result !== null, "the retrieve delegation must open");
	assert.equal(result.kind, "state", `negotiation must select the state path, got ${result.kind}`);
	// SAFETY: the assertions above proved null-free and state-kind.
	return result as Extract<RetrieveSendResult, { kind: "state" }>;
}

/** Seeds the record both sides rank and rebuild: its embedding is the query's own vector. */
async function seedBase(service: MemoryService): Promise<string> {
	const written = await service.remember({
		content: "the auth flow is described in src/b.md",
		kind: "evidence",
		operationId: "seed/base",
		summary: "auth flow",
		tags: ["auth"],
		topic: "auth flow",
	});
	return written.record.memoryId;
}

beforeEach(async () => {
	storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p44-"));
	corpusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p44c-"));
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p44w-"));
	logPath = path.join(storageRoot, "metering", "run-1.jsonl");
	log = createMeteringLog(logPath);
	stub = await startEmbeddingStub();
	const vectorByText = new Map<string, readonly number[]>([
		[BETA_TEXT, basis(1)],
		["# alpha\nshared memory plane observation one", basis(0)],
		["# gamma\nresidual quantisation observation three", basis(2)],
		// The seeded record embeds to a vector below the frozen stop condition, so the
		// residual carries real bytes; basis(1) would need no correction at all and
		// the payload would be empty.
		["auth flow\nauth flow", baseUnderThreshold()],
	]);
	stub.respondWithVectorForInput((input) => vectorByText.get(input) ?? vectorByText.get(input.trim()) ?? basis(3));
	embedder = createEmbeddingClient(
		{ dim: DIM, endpoint: `http://127.0.0.1:${stub.port}/v1/embeddings`, keyEnv: "SYNAPSE_TEST_KEY", model: "BAAI/bge-m3", provider: "siliconflow" },
		{ identity: { agent: "parent", attempt: 1, mode: "synapse", nodeId: "run-1/0", runId: "run-1", sessionId: "sess-parent", snapshotId: null }, key: "stub-key", metering: log },
	);
	fs.mkdirSync(path.join(corpusRoot, "src"), { recursive: true });
	fs.writeFileSync(path.join(corpusRoot, "src", "a.md"), "# alpha\nshared memory plane observation one\n");
	fs.writeFileSync(path.join(corpusRoot, "src", "b.md"), `${BETA_TEXT}\n`);
	fs.writeFileSync(path.join(corpusRoot, "src", "c.md"), "# gamma\nresidual quantisation observation three\n");
	const built = await buildCorpus({ corpusRoot, embedder, sourceCommit: SOURCE_COMMIT, storageRoot });
	corpusSnapshotId = built.corpusSnapshotId;
	contract = contractFor();
});

afterEach(async () => {
	await stub.close();
	fs.rmSync(storageRoot, { force: true, recursive: true });
	fs.rmSync(corpusRoot, { force: true, recursive: true });
	fs.rmSync(worktree, { force: true, recursive: true });
});

describe("AC-17: a residual crosses the delegation seam", () => {
	it("sends a residual, ranks the corpus from it, and meters the full account", async () => {
		const sender = memory(true);
		const memoryId = await seedBase(sender);
		const sent = await sendState({
			contract,
			deps: sendDeps(sender),
			embedder,
			identity: sendIdentity(),
			k: K,
			query: `${BETA_TEXT}\n`,
			worktreeRoot: worktree,
		});
		assert.equal(sent.stateRef.encoding, "delta");
		assert.equal(sent.stateRef.baseMemoryId, memoryId);
		assert.ok(sent.stateRef.byteLength < DIM * 4, "the residual must be smaller than the vector it replaces");
		// A fixture guard, not a mechanism claim: with a byte count of zero every
		// assertion below would hold trivially, so an encoder that stopped emitting
		// components would pass this test while the mechanism silently died.
		assert.ok(sent.stateRef.byteLength >= 3, `the 0.95 fixture must emit at least one residual component, got ${sent.stateRef.byteLength}`);

		const receiver = memory(false);
		const consumed = await consumeRetrieveState({
			contract,
			deps: consumeDeps(receiver),
			envelope: sent.envelope,
			identity: consumeIdentity(),
			k: K,
			worktreeRoot: worktree,
		});
		assert.equal(consumed.kind, "consumed");
		assert.ok(consumed.kind === "consumed");
		// The query vector was e2 and the residual was computed against a base that is
		// also e2, so a correct rebuild still ranks src/b.md first — the ranking, not
		// the byte count, is what proves the residual was decodable.
		assert.equal(consumed.result.hits[0]?.path, "src/b.md");

		// The full account: the residual's payload is counted apart from a full
		// vector's, and both reads the residual path needs are visible — the
		// receiver's base rebuild and the sender's base selection.
		const totals = aggregateMetering(readMeteringLog(logPath));
		// The sending side's figure, once: receive and consume observe the same message
		// again, and adding those would report one message as three.
		assert.equal(totals.state.deltaPayloadBytes, sent.stateRef.byteLength);
		assert.equal(totals.state.baseReadBytes, DIM * 4, "the receiver read one base vector");
		assert.ok(totals.state.baseSelectionReadBytes >= DIM * 4, "the sender ranked its records to choose the base");
		assert.equal(totals.state.restoreCount, 0, "a first-attempt consume is not a recovery hop");
		assert.equal(totals.state.consumed, 1);
	});

	it("falls back to a full vector when the base object is gone, and records the hop", async () => {
		const sender = memory(true);
		const memoryId = await seedBase(sender);
		const sent = await sendState({ contract, deps: sendDeps(sender), embedder, identity: sendIdentity(), k: K, query: `${BETA_TEXT}\n`, worktreeRoot: worktree });
		assert.equal(sent.stateRef.encoding, "delta");

		const receiver = memory(false);
		const record = receiver.get({ memoryId });
		assert.ok(record, "the base record must exist before it is deleted");
		// Delete the record's vector object: the residual still verifies byte for byte,
		// but the base it names can no longer be rebuilt.
		const base = createContentStore(storageRoot);
		const baseObjectId = readBaseObjectId(receiver, memoryId);
		fs.rmSync(base.objectPath(baseObjectId), { force: true });

		// A replacement names its encoding, space and base; the ids are the recovery's
		// to fill in, because it is the party that stores the bytes.
		const replacement: ResendReplacement = {
			bytes: fullVectorBytes(basis(1)),
			stateRef: { baseMemoryId: null, byteLength: DIM * 4, dim: DIM, encoding: "float32-vector", representationId: embedder.representationId },
		};

		const consumed = await consumeRetrieveState({
			contract,
			deps: consumeDeps(receiver, { resend: () => replacement }),
			envelope: sent.envelope,
			identity: consumeIdentity(),
			k: K,
			worktreeRoot: worktree,
		});
		assert.equal(consumed.kind, "consumed", "the recovery chain must end in a consumed state, not a failure");
		assert.ok(consumed.kind === "consumed");
		assert.equal(consumed.result.hits[0]?.path, "src/b.md");

		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.state.restoreCount, 1, "exactly one recovery hop");
		const hops = eventsOf("state-send").filter((event) => event.restore !== undefined);
		assert.equal(hops.length, 1);
		assert.equal(hops[0]?.restore, "full-vector");
		assert.equal(hops[0]?.encoding, "float32-vector");
		// The object the recovery stored must be readable as what it claims: nothing
		// else in the build checks the stored media type, so a replacement written under
		// the residual's type would sit in the CAS mislabelled and undetected.
		const stored = eventsOf("state-restore")[0];
		assert.equal(stored?.hop, "full-vector");
		assert.ok(hops[0] !== undefined);
		assert.equal(createContentStore(storageRoot).mediaTypeOf(hops[0].stateId), "application/x-float32-vector");
		// The residual was never consumed: only the replacement was.
		const deltaConsumes = eventsOf("state-consume").filter((event) => event.encoding === "delta");
		assert.equal(deltaConsumes.length, 0);
	});

	it("does not consume a residual whose bytes were tampered with", async () => {
		const sender = memory(true);
		await seedBase(sender);
		const sent = await sendState({ contract, deps: sendDeps(sender), embedder, identity: sendIdentity(), k: K, query: `${BETA_TEXT}\n`, worktreeRoot: worktree });
		assert.equal(sent.stateRef.encoding, "delta");

		const store = createContentStore(storageRoot);
		const payloadPath = store.objectPath(sent.stateRef.payloadId);
		const bytes = fs.readFileSync(payloadPath);
		// An empty payload cannot be corrupted, so the test must prove it is testing
		// what it claims to: a residual with no bytes would pass this test by never
		// being tampered with at all.
		assert.ok(bytes.byteLength > 0, "the fixture must produce a residual with bytes");
		bytes[0] = bytes[0]! ^ 0xff;
		fs.writeFileSync(payloadPath, bytes);

		const receiver = memory(false);
		const consumed = await consumeRetrieveState({
			contract,
			deps: consumeDeps(receiver),
			envelope: sent.envelope,
			identity: consumeIdentity(),
			k: K,
			worktreeRoot: worktree,
		});
		// Without a re-send seam the chain is terminal and recorded, and the tampered
		// residual is never ranked.
		assert.equal(consumed.kind, "failed");
		assert.equal(consumed.category, "integrity");
		assert.equal(eventsOf("state-consume").length, 0);
		assert.equal(aggregateMetering(readMeteringLog(logPath)).state.consumed, 0);
	});

	it("sends an empty residual when the base already is the query, and still ranks correctly", async () => {
		// The boundary the encoder's stop condition creates: a base at or above the
		// frozen 0.99 needs no correction, so the residual is zero components and the
		// payload is zero bytes. Worth pinning because it is both the cheapest case the
		// mechanism can produce and the one where a decoder that misread "no
		// components" as "no message" would silently fall back.
		const sender = memory(true);
		// The responder is replaced BEFORE the record is written: the seeded vector is
		// what the base will be, so a substitution after the write would leave the
		// fixture describing the previous handler.
		// Matching on a prefix keeps the literal newline the memory path puts between
		// topic and summary out of the test's source.
		stub.respondWithVectorForInput((input) => (input.startsWith("auth flow") || input.trim() === BETA_TEXT ? basis(1) : basis(2)));
		const written = await sender.remember({
			content: "an exact prior conclusion",
			kind: "evidence",
			operationId: "seed/exact",
			summary: "auth flow",
			tags: ["auth"],
			topic: "auth flow",
		});
		const sent = await sendState({ contract, deps: sendDeps(sender), embedder, identity: sendIdentity(), k: K, query: `${BETA_TEXT}\n`, worktreeRoot: worktree });
		assert.equal(sent.stateRef.encoding, "delta");
		assert.equal(sent.stateRef.baseMemoryId, written.record.memoryId);
		assert.equal(sent.stateRef.byteLength, 0, "a base at the stop condition needs no correction bytes");

		// The empty payload must survive the actual delivery path, not just the
		// in-process shortcut: a schema with a positive lower bound on byteLength would
		// let the sender produce this message and make every receiver refuse to parse
		// it, so the best case of the mechanism would fail exactly on the wire.
		const inbox = publishEnvelope(storageRoot, "run-1", 0, sent.envelope);
		const delivered = readDeliveredEnvelope(inbox);
		assert.equal(delivered.status, "ready", `the wire must accept a zero-byte residual: ${JSON.stringify(delivered)}`);

		const consumed = await consumeRetrieveState({ contract, deps: consumeDeps(memory(false)), envelope: sent.envelope, identity: consumeIdentity(), k: K, worktreeRoot: worktree });
		assert.equal(consumed.kind, "consumed");
		assert.ok(consumed.kind === "consumed");
		// Zero bytes must decode back to the base and rank exactly as the query would.
		assert.equal(consumed.result.hits[0]?.path, "src/b.md");
		const totals = aggregateMetering(readMeteringLog(logPath));
		assert.equal(totals.state.deltaPayloadBytes, 0);
		assert.equal(totals.state.consumed, 1);
	});

	it("keeps a residual cheaper than the vector it replaces, so the path is worth measuring", async () => {
		// Guards the card's own rate-distortion rule from the other side: if a future
		// layout change made residuals larger than full vectors, this test — not a
		// silent regression — would be the first thing to fail.
		const sender = memory(true);
		await seedBase(sender);
		const sent = await sendState({ contract, deps: sendDeps(sender), embedder, identity: sendIdentity(), k: K, query: `${BETA_TEXT}\n`, worktreeRoot: worktree });
		assert.ok(sent.stateRef.byteLength <= DIM * 3, `a residual may not exceed the int8 layout's ${DIM * 3}-byte ceiling, got ${sent.stateRef.byteLength}`);
		assert.ok(sent.stateRef.byteLength < sent.stateRef.dim * 4);
	});
});

/**
 * The CAS object a memory record's vector lives in. The vector ref is not part of
 * the public read result, so the record file itself is the source — one JSON file
 * per record, which is the store's actual on-disk layout.
 */
function readBaseObjectId(service: MemoryService, memoryId: string): string {
	// Prove the record is reachable through the service too, so a test cannot pass
	// by reading a file the service itself would refuse.
	assert.ok(service.get({ memoryId }));
	// SAFETY: the record file is written by the memory store's own publish path, whose
	// schema fixes this shape; a reshaped field fails the assertion below rather than
	// being read as a valid id.
	const record = JSON.parse(fs.readFileSync(path.join(storageRoot, "memory", `${memoryId}.json`), "utf-8")) as { embedding?: { objectId?: string } };
	assert.ok(record.embedding?.objectId, `memory ${memoryId} must hold a vector object`);
	return record.embedding.objectId;
}

function fullVectorBytes(values: readonly number[]): Uint8Array {
	const buffer = Buffer.alloc(DIM * 4);
	for (let element = 0; element < DIM; element += 1) buffer.writeFloatLE(values[element] ?? 0, element * 4);
	return new Uint8Array(buffer);
}
