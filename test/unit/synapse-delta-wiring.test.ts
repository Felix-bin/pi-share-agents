import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createContentStore } from "../../src/synapse/content-store.ts";
import {
	meteringLogPath,
	openRetrieveDelegation,
	retrieveSenderCapability,
	type DelegationIdentity,
	type RetrieveSendResult,
} from "../../src/synapse/delegation.ts";
import type { Embedder, EmbeddingResult } from "../../src/synapse/embedding.ts";
import { resolveLaunchContract, type LaunchContract } from "../../src/synapse/lifecycle.ts";
import { createMeteringLog, readMeteringLog, type MeteringEvent } from "../../src/synapse/metering.ts";
import { deriveNamespaceId } from "../../src/synapse/namespace.ts";
import type { PredictedBase } from "../../src/synapse/predict-base.ts";
import { capabilityForAgent } from "../../src/synapse/roles.ts";
import { SYNAPSE_DELTA_MEDIA_TYPE, decodeStatePayload } from "../../src/synapse/state-payload.ts";
import { SYNAPSE_VECTOR_MEDIA_TYPE } from "../../src/synapse/embedding.ts";

/**
 * Task card P4-4, send side: the retrieve seam chooses between a full vector and
 * a residual, and what it publishes always matches the encoding it declared in
 * the envelope.
 *
 * The base seam is injected, so these tests dial the base's similarity directly
 * instead of hoping a real memory ranking lands where a branch is exercised. What
 * each test refuses to accept is the silent case: a residual whose payload does
 * not actually decode back to the query, or a full vector sent without a recorded
 * reason, would both read as "the mechanism ran" while nothing was measured.
 */

const DIM = 1024;
const REPRESENTATION_ID = `siliconflow/BAAI/bge-m3/${DIM}`;
const RUN_ID = "run-1";

let root = "";
let store = "";
let worktree = "";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-delta-wiring-"));
	store = path.join(root, "storage");
	worktree = path.join(root, "worktree");
	fs.mkdirSync(store, { recursive: true });
	fs.mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { force: true, recursive: true });
});

/** A unit vector from a deterministic walk, so a test can dial how alike two are. */
function unitVector(seed: number): Float32Array {
	const raw = new Float32Array(DIM);
	for (let index = 0; index < DIM; index += 1) raw[index] = Math.sin(seed + index * 0.7) + Math.cos(seed * 1.3 + index * 0.11);
	let norm = 0;
	for (const value of raw) norm += value * value;
	const scale = 1 / Math.sqrt(norm);
	for (let index = 0; index < DIM; index += 1) raw[index] = raw[index]! * scale;
	return raw;
}

/** A base at a chosen cosine to `vector`: 1 is identical, 0 is orthogonal. */
function baseAt(vector: Float32Array, mix: number, memoryId: string, representationId = REPRESENTATION_ID): PredictedBase {
	const orthogonal = unitVector(9_999);
	let dot = 0;
	for (let index = 0; index < DIM; index += 1) dot += orthogonal[index]! * vector[index]!;
	const residual = new Float32Array(DIM);
	for (let index = 0; index < DIM; index += 1) residual[index] = orthogonal[index]! - dot * vector[index]!;
	let norm = 0;
	for (const value of residual) norm += value * value;
	const scale = Math.sqrt(1 - mix * mix) / Math.sqrt(norm);
	const base = new Float32Array(DIM);
	for (let index = 0; index < DIM; index += 1) base[index] = mix * vector[index]! + scale * residual[index]!;
	return { memoryId, representationId, vector: base };
}

function cosine(left: Float32Array, right: Float32Array): number {
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index += 1) {
		dot += left[index]! * right[index]!;
		leftNorm += left[index]! * left[index]!;
		rightNorm += right[index]! * right[index]!;
	}
	return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

const QUERY_VECTOR = unitVector(7);

function embedderOf(vector: Float32Array): Embedder {
	const result: EmbeddingResult = { cached: false, latencyMs: 0, promptTokens: null, vector: new Float32Array(vector) };
	return {
		embedBatch: async (texts) => texts.map(() => result),
		embedQuery: async () => result,
		representationId: REPRESENTATION_ID,
	};
}

function contractFor(): LaunchContract {
	return resolveLaunchContract({
		capabilityId: capabilityForAgent({ agent: "retriever", childTools: ["read"], representationId: REPRESENTATION_ID }).capabilityId,
		memoryRefs: [],
		corpusSnapshotId: "c".repeat(64),
		mode: "synapse",
		namespaceId: deriveNamespaceId(worktree),
		representationId: REPRESENTATION_ID,
		scope: { pathPrefixes: [""], write: true },
		stateVerify: "off",
		storageRoot: store,
	});
}

function identity(): DelegationIdentity {
	return {
		agent: "retriever",
		attempt: 1,
		childIndex: 0,
		childTools: ["read", "synapse_read"],
		receiverSessionId: "sess-child",
		requestId: "run-1-0-abcd",
		runId: RUN_ID,
		senderSessionId: "sess-parent",
	};
}

/**
 * The log's events of one kind, narrowed by a lookup keyed on the union's own
 * discriminant: a hand-written shape at the assertion site could drift from the
 * metering schema without anything failing.
 */
function eventsOf<K extends MeteringEvent["kind"]>(events: readonly MeteringEvent[], kind: K): (MeteringEvent & { kind: K })[] {
	return events.filter((event): event is MeteringEvent & { kind: K } => event.kind === kind);
}

async function send(predictedBase?: (query: { text: string }) => Promise<PredictedBase | null>): Promise<{ events: MeteringEvent[]; result: RetrieveSendResult }> {
	const contract = contractFor();
	const result = await openRetrieveDelegation({
		contract,
		deps: { log: createMeteringLog(meteringLogPath(contract, RUN_ID)), predictedBase },
		embedder: embedderOf(QUERY_VECTOR),
		identity: identity(),
		k: 3,
		query: "what does the auth flow do",
		worktreeRoot: worktree,
	});
	assert.ok(result, "a retriever that declares the consuming tool must reach the state plane");
	return { events: readMeteringLog(meteringLogPath(contract, RUN_ID)), result };
}

describe("synapse retrieve send side: encoding choice", () => {
	it("declares delta as a supported encoding", () => {
		// Asserted separately because negotiation never requires it: dropping delta
		// here would leave every behavioural test green while the advertised
		// capability narrowed.
		assert.deepEqual([...retrieveSenderCapability(REPRESENTATION_ID).encodings], ["text", "float32-vector", "delta"]);
	});

	it("sends a residual when a base exists, and the bytes decode back to the query", async () => {
		const base = baseAt(QUERY_VECTOR, 0.99, "a".repeat(64));
		const { events, result } = await send(async () => base);
		assert.equal(result.kind, "state");
		assert.ok(result.kind === "state");
		// The envelope names the base and the encoding; a residual without either
		// cannot be rebuilt on arrival.
		assert.equal(result.stateRef.encoding, "delta");
		assert.equal(result.stateRef.baseMemoryId, base.memoryId);
		assert.equal(result.stateRef.dim, DIM);
		assert.ok(result.stateRef.byteLength < DIM * 4, "a residual must not be longer than the vector it replaces");
		assert.equal(result.envelope.wire.stateRef?.encoding, "delta");
		// The published object is a residual, in its own media type: a reader that
		// sniffed it as float32 would decode plausible garbage.
		const objects = createContentStore(store);
		assert.equal(objects.mediaTypeOf(result.stateRef.payloadId), SYNAPSE_DELTA_MEDIA_TYPE);
		const decoded = decodeStatePayload({
			base: base.vector,
			dim: DIM,
			payload: objects.read(result.stateRef.payloadId),
			representationId: REPRESENTATION_ID,
			requiredRepresentationId: REPRESENTATION_ID,
		});
		// The whole point of the path: what arrives still points the way the query did.
		assert.ok(cosine(decoded, QUERY_VECTOR) >= 0.99, `decoded cosine ${cosine(decoded, QUERY_VECTOR)}`);
		// The meter and the envelope agree on the size of what crossed.
		const sent = eventsOf(events, "state-send");
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.payloadBytes, result.stateRef.byteLength);
		assert.equal(sent[0]?.encoding, "delta");
		const written = eventsOf(events, "object-io");
		assert.equal(written[0]?.bytes, result.stateRef.byteLength);
	});

	it("sends a full vector on a cold start and records why", async () => {
		const { events, result } = await send(async () => null);
		assert.ok(result.kind === "state");
		assert.equal(result.stateRef.encoding, "float32-vector");
		assert.equal(result.stateRef.baseMemoryId, null);
		assert.equal(result.stateRef.byteLength, DIM * 4);
		assert.equal(createContentStore(store).mediaTypeOf(result.stateRef.payloadId), SYNAPSE_VECTOR_MEDIA_TYPE);
		const prepare = eventsOf(events, "state-prepare")[0];
		// Without the reason, "no base existed" and "a base existed but lost" are the
		// same log line, and the trigger rate cannot be reported.
		assert.equal(prepare?.fallbackReason, "no-base");
	});

	it("sends a full vector when the base is too weak for a residual to be worth it", async () => {
		const base = baseAt(QUERY_VECTOR, 0.2, "b".repeat(64));
		const { events, result } = await send(async () => base);
		assert.ok(result.kind === "state");
		assert.equal(result.stateRef.encoding, "float32-vector");
		assert.equal(result.stateRef.baseMemoryId, null);
		assert.equal(result.stateRef.byteLength, DIM * 4);
		const prepare = eventsOf(events, "state-prepare")[0];
		assert.equal(prepare?.fallbackReason, "delta-too-large-a-share-of-the-vector");
	});

	it("sends a full vector when the base lives in another space", async () => {
		const base = baseAt(QUERY_VECTOR, 0.999, "d".repeat(64), "other/BAAI/bge-m3/1024");
		const { events, result } = await send(async () => base);
		assert.ok(result.kind === "state");
		assert.equal(result.stateRef.encoding, "float32-vector");
		const prepare = eventsOf(events, "state-prepare")[0];
		assert.equal(prepare?.fallbackReason, "base-space-mismatch");
	});

	it("lets an embedding failure surface instead of quietly degrading to a full vector", async () => {
		// P4-3's contract: calibration validity depends on the base coming from the
		// ranking the retrieval path reports, so a broken embedder must not be
		// absorbed into a working full-vector send.
		const failing: Embedder = {
			embedBatch: async () => {
				throw new Error("embedding provider unreachable");
			},
			embedQuery: async () => {
				throw new Error("embedding provider unreachable");
			},
			representationId: REPRESENTATION_ID,
		};
		await assert.rejects(
			openRetrieveDelegation({
				contract: contractFor(),
				deps: { log: createMeteringLog(meteringLogPath(contractFor(), RUN_ID)), predictedBase: async () => null },
				embedder: failing,
				identity: identity(),
				k: 3,
				query: "q",
				worktreeRoot: worktree,
			}),
			/embedding provider unreachable/,
		);
	});

	it("does not ask for a base when no seam is injected", async () => {
		const { events, result } = await send(undefined);
		assert.ok(result.kind === "state");
		assert.equal(result.stateRef.encoding, "float32-vector");
		const prepare = eventsOf(events, "state-prepare")[0];
		assert.equal(prepare?.fallbackReason, "no-base");
	});
});
