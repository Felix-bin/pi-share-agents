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
import { SYNAPSE_STATE_VERIFY_MIN_COSINE } from "../../src/synapse/config.ts";
import { SYNAPSE_DELTA_MEDIA_TYPE, chooseStatePayload, decodeStatePayload } from "../../src/synapse/state-payload.ts";
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
		receiverProbe: () => true,
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

	it("clears the verification threshold for every residual the frozen encoder emits (dim 1024)", () => {
		// The regression K3 caught on 2026-09-20: the encoder's stop condition holds on
		// the quantised grid, the receiver's check measures floats, and quantising the
		// target itself costs ≈ dim/(24·grid²) ≈ 0.0027 of cosine at the frozen point.
		// A threshold set at the encoder's own 0.99 in the float domain therefore
		// refused every legitimate residual. This pins the fix: whatever base quality
		// the sender finds, what arrives must clear SYNAPSE_STATE_VERIFY_MIN_COSINE
		// against the query's own embedding — the exact quantity verifyDecoded measures.
		// 0.2 is deliberately absent: at that base quality the residual exceeds the
		// frozen half-vector share and the sender correctly falls back to float32 —
		// there is no residual to verify. The four mixes below are the ones that emit.
		for (const mix of [0.5, 0.8, 0.95, 0.99]) {
			const base = baseAt(QUERY_VECTOR, mix, "b".repeat(64));
			const choice = chooseStatePayload({ base, fullVector: QUERY_VECTOR, representationId: REPRESENTATION_ID });
			assert.equal(choice.encoding, "delta", `mix=${mix}: the frozen point must emit a residual for the band to be measurable`);
			const decoded = decodeStatePayload({ base: base.vector, dim: DIM, payload: choice.payload, representationId: REPRESENTATION_ID });
			const measured = cosine(decoded, QUERY_VECTOR);
			assert.ok(
				measured >= SYNAPSE_STATE_VERIFY_MIN_COSINE,
				`mix=${mix}: decoded cosine ${measured} is below the verification threshold ${SYNAPSE_STATE_VERIFY_MIN_COSINE} — the threshold has drifted from the legitimate band again`,
			);
		}
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
				receiverProbe: () => true,
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

describe("synapse retrieve send side: the runtime probe gate", () => {
	it("falls back to text with an explicit reason when the receiver's probe fails, spending no embedding call", async () => {
		const contract = contractFor();
		const log = createMeteringLog(meteringLogPath(contract, RUN_ID));
		const embedder = embedderOf(QUERY_VECTOR);
		let embedded = 0;
		const counting = { ...embedder, embedQuery: async (text: string) => {
			embedded += 1;
			return embedder.embedQuery(text);
		} };
		const result = await openRetrieveDelegation({
			contract,
			deps: { log },
			embedder: counting,
			identity: identity(),
			k: 3,
			query: "what does the auth flow do",
			receiverProbe: () => false,
			worktreeRoot: worktree,
		});
		assert.ok(result, "the delegation opens: an unverified promise degrades to text, it does not refuse the task");
		assert.equal(result.kind, "text");
		assert.ok(result.kind === "text");
		assert.equal(result.reason, "probe-unverified");
		// The point of asking before spending: a payload nobody could rank must
		// not cost the embedding call that would have produced it.
		assert.equal(embedded, 0);
		// And nothing state-shaped crossed, so no state events may exist.
		assert.equal(eventsOf(readMeteringLog(meteringLogPath(contract, RUN_ID)), "state-send").length, 0);
	});

	it("trusts an unwired probe no further than the text path: a declared claim without a verdict is not verified", async () => {
		const contract = contractFor();
		const result = await openRetrieveDelegation({
			contract,
			deps: { log: createMeteringLog(meteringLogPath(contract, RUN_ID)) },
			embedder: embedderOf(QUERY_VECTOR),
			identity: identity(),
			k: 3,
			query: "what does the auth flow do",
			worktreeRoot: worktree,
		});
		assert.ok(result);
		assert.equal(result.kind, "text");
		assert.ok(result.kind === "text");
		assert.equal(result.reason, "probe-unverified");
	});
});

describe("synapse retrieve send side: probe gate traces", () => {
	it("records a capability-probe metering event for the verdict, pass or fail", async () => {
		const contract = contractFor();
		for (const verdict of [true, false]) {
			fs.rmSync(meteringLogPath(contract, RUN_ID), { force: true });
			await openRetrieveDelegation({
				contract,
				deps: { log: createMeteringLog(meteringLogPath(contract, RUN_ID)) },
				embedder: embedderOf(QUERY_VECTOR),
				identity: identity(),
				k: 3,
				query: "what does the auth flow do",
				receiverProbe: () => verdict,
				worktreeRoot: worktree,
			});
			const probeEvents = eventsOf(readMeteringLog(meteringLogPath(contract, RUN_ID)), "capability-probe");
			assert.equal(probeEvents.length, 1, `exactly one capability-probe event for verdict=${verdict}`);
			assert.equal(probeEvents[0]?.ok, verdict);
			// `wired` is what lets an auditor tell a probe that ran and failed from a
			// receiver whose probe items no caller ever wired (K3 P2-2): both negotiate
			// to text, only one is an environment failure.
			assert.equal(probeEvents[0]?.wired, true, "a supplied probe is wired");
			assert.ok(typeof probeEvents[0]?.durationMs === "number", "the consultation is timed so the budget question is answerable from the ledger");
		}
	});

	it("times the probe itself, not the moment before it (§16: durationMs read 0 for 60/60 real events)", async () => {
		const contract = contractFor();
		fs.rmSync(meteringLogPath(contract, RUN_ID), { force: true });
		await openRetrieveDelegation({
			contract,
			deps: { log: createMeteringLog(meteringLogPath(contract, RUN_ID)) },
			embedder: embedderOf(QUERY_VECTOR),
			identity: identity(),
			k: 3,
			query: "what does the auth flow do",
			receiverProbe: () => {
				// ~30ms of measurable work: an order of magnitude above clock
				// granularity and below anything flaky on a loaded machine.
				const deadline = Date.now() + 30;
				while (Date.now() < deadline) {}
				return true;
			},
			worktreeRoot: worktree,
		});
		const probeEvents = eventsOf(readMeteringLog(meteringLogPath(contract, RUN_ID)), "capability-probe");
		assert.equal(probeEvents.length, 1);
		assert.ok((probeEvents[0]?.durationMs ?? 0) >= 10, `a probe that ran 30ms of work must report its cost, got ${probeEvents[0]?.durationMs}`);
	});

	it("records an unwired probe as not wired, distinguishing it from a failed one", async () => {
		// The receiver's role declares probe items (retriever with synapse_read does),
		// so a caller that supplies no probe negotiates to text with a FAILED verdict —
		// the ledger must not call that an environment failure.
		const contract = contractFor();
		const result = await openRetrieveDelegation({
			contract,
			deps: { log: createMeteringLog(meteringLogPath(contract, RUN_ID)) },
			embedder: embedderOf(QUERY_VECTOR),
			identity: identity(),
			k: 3,
			query: "what does the auth flow do",
			worktreeRoot: worktree,
		});
		assert.ok(result);
		assert.equal(result.kind, "text");
		assert.ok(result.kind === "text");
		assert.equal(result.reason, "probe-unverified");
		const probeEvents = eventsOf(readMeteringLog(meteringLogPath(contract, RUN_ID)), "capability-probe");
		assert.equal(probeEvents.length, 1);
		assert.equal(probeEvents[0]?.ok, false);
		assert.equal(probeEvents[0]?.wired, false, "nothing was wired; this is not a probe that ran and failed");
	});

	it("treats a throwing probe as unverified rather than letting it pierce the seam", async () => {
		const contract = contractFor();
		const result = await openRetrieveDelegation({
			contract,
			deps: { log: createMeteringLog(meteringLogPath(contract, RUN_ID)) },
			embedder: embedderOf(QUERY_VECTOR),
			identity: identity(),
			k: 3,
			query: "what does the auth flow do",
			receiverProbe: () => {
				throw new Error("probe blew up");
			},
			worktreeRoot: worktree,
		});
		assert.ok(result);
		assert.equal(result.kind, "text");
		assert.ok(result.kind === "text");
		assert.equal(result.reason, "probe-unverified");
	});

	it("lets the same peers negotiate differently as the probe verdict flips — verification state, not contract state", async () => {
		const contract = contractFor();
		const run = async (verdict: boolean) => openRetrieveDelegation({
			contract,
			deps: { log: createMeteringLog(meteringLogPath(contract, RUN_ID)) },
			embedder: embedderOf(QUERY_VECTOR),
			identity: identity(),
			k: 3,
			query: "what does the auth flow do",
			receiverProbe: () => verdict,
			worktreeRoot: worktree,
		});
		const failed = await run(false);
		assert.equal(failed?.kind, "text");
		const passed = await run(true);
		assert.equal(passed?.kind, "state");
	});
});
