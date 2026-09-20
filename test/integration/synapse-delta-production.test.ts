import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CanonicalValue } from "../../src/synapse/canonical-json.ts";
import { resolveSynapseChildContract, type SynapseChildContract } from "../../src/synapse/child-contract.ts";
import { buildCorpus } from "../../src/synapse/corpus.ts";
import { SYNAPSE_STATE_VERIFY_MIN_COSINE } from "../../src/synapse/config.ts";
import { consumeRetrieveState } from "../../src/synapse/delegation.ts";
import { createEmbeddingClient, type Embedder } from "../../src/synapse/embedding.ts";
import { readDeliveredEnvelope, stateEnvelopePath } from "../../src/synapse/envelope-inbox.ts";
import { createMemoryService, type MemoryService } from "../../src/synapse/memory-service.ts";
import { aggregateMetering, createMeteringLog, readMeteringLog, type MeteringEvent } from "../../src/synapse/metering.ts";
import { deriveNamespaceId } from "../../src/synapse/namespace.ts";
import type { ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import { openChildDelegationWithState } from "../../src/runs/shared/synapse-delegation.ts";
import { memoryVectorCacheFor, resetMemoryVectorCaches } from "../../src/synapse/vector-cache.ts";
import { startEmbeddingStub, type StubEmbeddingServer } from "../support/embedding-stub-server.ts";

/**
 * Task card P4-4b-β: the residual path, reachable from a real launch.
 *
 * α made the state plane reachable and left the residual behind a switch that did
 * not exist yet, so every launch sent a full vector. This file drives the seam the
 * two execution paths call with the switch on, which is the only configuration in
 * which the acceptance run's R1 arm produces anything but bytes identical to the
 * control arm's.
 *
 * What this file deliberately does not do is report a saving. It pins reachability
 * and control — that the switch decides, that the base comes from the sender's own
 * store under the receiver's scope, that a provider failure degrades to a full
 * vector instead of costing the run. Whether the residual path is a net win once
 * the base read is on its side of the ledger is the AC-17 question, answered by
 * measurement (see docs/experiments/AC-17-acceptance-preregistration-20260919.md).
 */

const DIM = 8;
const K = 3;
const RUN_ID = "run-delta";
const SOURCE_COMMIT = "d".repeat(40);
const QUERY = "# beta\ncoordination as compression observation two\n";
/** A query the receiver holds but the sender never encoded, to tell the two apart. */
const OTHER_QUERY = "# gamma\nresidual quantisation observation three\n";

/**
 * The record's stored vector: the query's own axis, plus a fifth of a unit on the
 * third. Small enough that the residual is a handful of components — the payload
 * has to stay under half the vector or the sender is right to refuse it — and
 * non-zero, so the test cannot pass on an empty payload alone.
 */
const QUERY_VECTOR = [0, 1, 0, 0, 0, 0, 0, 0];
const BASE_VECTOR = [0, 1, 0.2, 0, 0, 0, 0, 0];
const BASE_TOPIC = "residual calibration";
const BASE_SUMMARY = "a base the residual can be measured against";

/** `remember` embeds this exact text, so the stub can key the stored vector off it. */
const BASE_EMBED_TEXT = `${BASE_TOPIC}\n${BASE_SUMMARY}`;

let storageRoot = "";
let corpusRoot = "";
let worktree = "";
let stub: StubEmbeddingServer;
/** When set, the provider answers this vector for the query text instead of the stored one. */
let reembedOverride: readonly number[] | null = null;
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

function extensionConfig(delta: boolean, vectorCache = false, stateVerify: "off" | "reembed" = "off"): Record<string, CanonicalValue> {
	return {
		corpusSnapshotId,
		delta,
		embedding: { dim: DIM, endpoint: `http://127.0.0.1:${stub.port}/v1/embeddings`, keyEnv: "SYNAPSE_TEST_KEY", model: "BAAI/bge-m3", provider: "siliconflow" },
		memory: "project",
		mode: "synapse",
		stateVerify,
		storageRoot,
		vectorCache,
	};
}

function synapseContract(
	delta: boolean,
	childTools: readonly string[] = ["read", "synapse_read"],
	vectorCache = false,
	stateVerify: "off" | "reembed" = "off",
): SynapseChildContract {
	const synapse = resolveSynapseChildContract({
		agentDir: storageRoot,
		agentName: "retriever",
		childTools,
		cwd: worktree,
		extensionConfig: extensionConfig(delta, vectorCache, stateVerify),
		extensionTools: ["synapse_read", "synapse_write"],
		runId: RUN_ID,
		sessionId: "sess-parent",
	});
	assert.ok(synapse !== null, "the launch seam must yield a contract for a synapse-mode launch");
	return synapse;
}

/**
 * A launch whose configuration never mentions residuals, which is what every
 * configuration written before this card says. The optional argument is dropped
 * rather than set to false so the resolved default is what gets tested.
 */
function defaultedContract(): SynapseChildContract {
	const config = extensionConfig(false);
	delete config.delta;
	const synapse = resolveSynapseChildContract({
		agentDir: storageRoot,
		agentName: "retriever",
		childTools: ["read", "synapse_read"],
		cwd: worktree,
		extensionConfig: config,
		extensionTools: ["synapse_read", "synapse_write"],
		runId: RUN_ID,
		sessionId: "sess-parent",
	});
	assert.ok(synapse !== null, "the launch seam must yield a contract for a synapse-mode launch");
	return synapse;
}

function logPath(): string {
	return path.join(storageRoot, "metering", `${RUN_ID}.jsonl`);
}

type ObjectIoEvent = Extract<MeteringEvent, { kind: "object-io" }>;

/** The residual path's own reads: the records it ranks to pick a base, and nothing else. */
function baseSelections(): ObjectIoEvent[] {
	return readMeteringLog(logPath()).filter(
		(event): event is ObjectIoEvent => event.kind === "object-io" && event.purpose === "base-selection",
	);
}

/** The base the delivered envelope names: the selection this launch actually made. */
function baseOf(envelopePath: string): string | null {
	const delivered = readDeliveredEnvelope(envelopePath);
	assert.equal(delivered.status, "ready", `the state envelope must be delivered: ${envelopePath}`);
	if (delivered.status !== "ready") return null;
	return delivered.wire.stateRef?.baseMemoryId ?? null;
}

function trigger(synapse: SynapseChildContract) {
	return openChildDelegationWithState({ cwd: worktree, message: QUERY, receiverSessionId: "sess-child", runtime: runtimeFor(synapse) });
}

/** The decoded state is a unit vector on the second axis, so this answer has cosine c with it. */
function atCosine(c: number): readonly number[] {
	return [Math.sqrt(1 - c * c), c, 0, 0, 0, 0, 0, 0];
}

/** The same launch with the receiver's check switched on. */
function strictVerify(synapse: SynapseChildContract) {
	return { ...synapse.contract, stateVerify: "reembed" as const };
}

/** The most recent cosine the receiver's check recorded. */
function lastVerifyCosine(): number {
	const events = readMeteringLog(logPath()).filter(
		(event): event is Extract<MeteringEvent, { kind: "state-verify" }> => event.kind === "state-verify",
	);
	const last = events[events.length - 1];
	assert.ok(last, "a check must have been recorded");
	return last.cosine;
}

function consumeStrict(
	synapse: ReturnType<typeof strictVerify>,
	delivered: Extract<ReturnType<typeof readDeliveredEnvelope>, { status: "ready" }>,
	fallbackQuery: string,
) {
	return consumeRetrieveState({
		contract: synapse,
		deps: { embedder, log: createMeteringLog(logPath()) },
		envelope: delivered.wire,
		expectedSenderSessionId: "sess-parent",
		fallbackQuery,
		identity: { agent: "retriever", attempt: 1, childIndex: 0, runId: RUN_ID, sessionId: "sess-child" },
		k: K,
		stateRecovery: "resend-then-text",
		worktreeRoot: worktree,
	});
}

/** The receiver's half, through the same call the child runtime makes. */
function consume(
	synapse: SynapseChildContract,
	wire: Parameters<typeof consumeRetrieveState>[0]["envelope"],
	/** Passed by the tests that need the receiver to re-embed: without it there is no
	 * embedder to check a decoded state against, and no text fallback either. */
	deps: { embedder?: Embedder; stateRecovery?: "resend" | "resend-then-text" } = {},
) {
	return consumeRetrieveState({
		contract: synapse.contract,
		deps: { embedder: deps.embedder, log: createMeteringLog(logPath()) },
		stateRecovery: deps.stateRecovery ?? "resend",
		envelope: wire,
		expectedSenderSessionId: synapse.sessionId,
		fallbackQuery: QUERY,
		identity: { agent: "retriever", attempt: 1, childIndex: 0, runId: RUN_ID, sessionId: "sess-child" },
		k: K,
		worktreeRoot: worktree,
	});
}

/**
 * Writes one memory into the store the launch reads, with its vector, through the
 * product's own service rather than by hand-editing records: the base has to be a
 * record the real selector would pick, and a hand-built one could carry a vector
 * no `remember` would have produced.
 */
async function rememberBase(): Promise<{ objectId: string; service: MemoryService }> {
	const service = createMemoryService({
		corpusSnapshotId: null,
		embedder,
		provenance: { agent: "retriever", attempt: 1, runId: RUN_ID, sessionId: "sess-parent" },
		scope: { agent: "retriever", namespaceId: deriveNamespaceId(worktree), pathPrefixes: [""], write: true },
		storeRoot: storageRoot,
		worktreeRoot: worktree,
	});
	const written = await service.remember({
		content: "the base this residual is measured against",
		kind: "evidence",
		operationId: "op-base-1",
		summary: BASE_SUMMARY,
		tags: ["base"],
		topic: BASE_TOPIC,
	});
	const embedding = written.record.embedding;
	assert.ok(embedding !== null, "a remember with an embedder configured must store a vector");
	return { objectId: embedding.objectId, service };
}

beforeEach(async () => {
	// The record-vector cache lives in the process, and this file's tests share one
	// process: without this reset, a test could inherit entries another test filled.
	resetMemoryVectorCaches();
	storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p44bb-"));
	corpusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p44bbc-"));
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-p44bbw-"));
	process.env.SYNAPSE_TEST_KEY = "stub-key";
	stub = await startEmbeddingStub();
	const vectorByText = new Map<string, readonly number[]>([
		["# alpha\nshared memory plane observation one", [1, 0, 0, 0, 0, 0, 0, 0]],
		["# beta\ncoordination as compression observation two", QUERY_VECTOR],
		["# gamma\nresidual quantisation observation three", [0, 0, 1, 0, 0, 0, 0, 0]],
		[BASE_EMBED_TEXT, BASE_VECTOR],
	]);
	reembedOverride = null;
	stub.respondWithVectorForInput((input) => {
		// The verification test re-embeds the same query the sender embedded, so the
		// only way to make the two disagree is to change what the provider answers.
		if (reembedOverride !== null && input.trim() === QUERY.trim()) return reembedOverride;
		return vectorByText.get(input) ?? vectorByText.get(input.trim()) ?? [0, 0, 0, 1, 0, 0, 0, 0];
	});
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

describe("synapse residual path in production", () => {
	it("sends a residual the receiver can rebuild, and ranks what the full vector would have ranked", async () => {
		await rememberBase();
		const synapse = synapseContract(true);
		const opened = await trigger(synapse);

		assert.equal(opened.state?.kind, "state", "a switch that cannot reach the wire is not a switch");
		if (opened.state?.kind !== "state") return;
		assert.equal(opened.state.stateRef.encoding, "delta");
		assert.ok(opened.state.stateRef.baseMemoryId !== null, "a residual without a base id is one the receiver cannot rebuild");
		assert.ok(
			opened.state.stateRef.byteLength < DIM * 4,
			`the residual must be smaller than the ${DIM * 4}-byte vector it replaces, got ${opened.state.stateRef.byteLength}`,
		);

		const delivered = readDeliveredEnvelope(stateEnvelopePath(storageRoot, RUN_ID, 0));
		assert.equal(delivered.status, "ready");
		if (delivered.status !== "ready") return;
		const outcome = await consume(synapse, delivered.wire);
		assert.equal(outcome.kind, "consumed", `the residual must decode on the far side, got ${outcome.kind}`);
		if (outcome.kind !== "consumed") return;
		assert.equal(outcome.result.hits[0]?.path, "src/b.md", "the rebuilt vector must rank the same chunk the full vector would");
	});

	it("reads the base out of the sender's own store and says so in the ledger", async () => {
		// The base read is the cost that decides whether the residual path can pay
		// at all, so it has to be attributable to the arm that incurs it.
		await rememberBase();
		const opened = await trigger(synapseContract(true));
		assert.equal(opened.state?.kind, "state");

		const selections = baseSelections();
		assert.ok(selections.length > 0, "ranking the sender's records is the residual path's own cost and must be visible");
		// The same identity the send is metered under, so a reader can attribute the
		// cost to the node rather than to the run as a whole.
		assert.ok(selections.every((event) => event.nodeId === `${RUN_ID}/0`));
		assert.ok(selections.every((event) => event.direction === "read"));
	});

	it("sends the full vector when the store holds no usable base", async () => {
		const opened = await trigger(synapseContract(true));
		assert.equal(opened.state?.kind, "state");
		assert.equal(opened.state?.kind === "state" ? opened.state.stateRef.encoding : null, "float32-vector");
		const prepare = readMeteringLog(logPath()).find((event) => event.kind === "state-prepare");
		assert.equal(prepare?.kind === "state-prepare" ? prepare.fallbackReason : null, "no-base");
	});

	it("sends the full vector from a configuration that never mentions residuals", async () => {
		// The product default, with a base sitting right there in the store: the one
		// arrangement in which an inverted default changes the bytes on the wire
		// rather than landing on the same `no-base` answer.
		await rememberBase();
		const opened = await trigger(defaultedContract());
		assert.equal(opened.state?.kind, "state");
		assert.equal(opened.state?.kind === "state" ? opened.state.stateRef.encoding : null, "float32-vector");
		assert.equal(baseSelections().length, 0, "a configuration that says nothing about residuals must not pay for one");
	});

	it("costs the run nothing when base selection fails, and does not report the failure as a missing base", async () => {
		const { objectId } = await rememberBase();
		// A vector object that cannot be read is how a real provider-adjacent failure
		// arrives: the record is there, the bytes are not. predictBase refuses to
		// degrade to a quieter base, and that refusal must stop at the seam.
		fs.writeFileSync(path.join(storageRoot, "objects", objectId.slice(0, 2), `${objectId}.bin`), "not a vector");
		const synapse = synapseContract(true);
		const opened = await trigger(synapse);

		assert.ok(opened.delegation, "a base-selection failure must not cost the user their run");
		assert.equal(opened.state?.kind, "state", "the full vector still goes out");
		assert.equal(opened.state?.kind === "state" ? opened.state.stateRef.encoding : null, "float32-vector");

		const events = readMeteringLog(logPath());
		assert.ok(
			events.some((event) => event.kind === "error" && event.detail.startsWith("base-selection failed")),
			"a base that could not be looked up and a base that does not exist produce the same envelope, so the log must tell them apart",
		);
		assert.ok(fs.existsSync(stateEnvelopePath(storageRoot, RUN_ID, 0)), "the launch still delivers state, just a full vector");
	});

	it("with the switch off, never reads a base at all", async () => {
		// The control arm must not pay the residual path's cost. Asserting only the
		// encoding would pass even if the sender ranked every record first.
		await rememberBase();
		const opened = await trigger(synapseContract(false));
		assert.equal(opened.state?.kind, "state");
		assert.equal(baseSelections().length, 0, "the control arm must not read a base");
	});

	it("reads each record's vector once per process when the cache is on, and every time when it is off", async () => {
		await rememberBase();
		// A second record so a ranking has more than one vector to fetch: with a single
		// record, a cache that never worked would look exactly like one that did.
		const second = createMemoryService({
			corpusSnapshotId: null,
			embedder,
			provenance: { agent: "retriever", attempt: 1, runId: RUN_ID, sessionId: "sess-parent" },
			scope: { agent: "retriever", namespaceId: deriveNamespaceId(worktree), pathPrefixes: [""], write: true },
			storeRoot: storageRoot,
			worktreeRoot: worktree,
		});
		await second.remember({ content: "unrelated", kind: "evidence", operationId: "op-base-2", summary: "an unrelated observation", tags: ["base"], topic: "unrelated topic" });

		const warm = synapseContract(true, ["read", "synapse_read"], true);
		await trigger(warm);
		// The first send pays for both records: it is the ranking that fills the cache.
		assert.equal(baseSelections().length, 2, "the first ranking reads every record it ranks");
		const firstBase = baseOf(stateEnvelopePath(storageRoot, RUN_ID, 0));

		const again = await trigger(warm);
		assert.ok(again.delegation, "the second send must really run, or this test proves nothing");
		const sends = readMeteringLog(logPath()).filter((event) => event.kind === "state-send" && event.ok);
		assert.equal(sends.length, 2, "two sends crossed, and the second one ranked the same records");
		assert.equal(baseSelections().length, 2, "the second ranking must be served from memory, not from the store");
		// The claim is about the hit path, so the selection it produces is compared with
		// the one the cold path produces for the same store and query.
		assert.equal(baseOf(stateEnvelopePath(storageRoot, RUN_ID, 0)), firstBase, "a served-from-memory vector must select the base the stored one selects");

		// The registry is the seam's own cache, not a second one the test built: without
		// this the cold assertion below would hold even if the sender ignored the switch.
		const registry = memoryVectorCacheFor(storageRoot, embedder);
		assert.ok(registry.hits > 0, "the warm sends must have been served by the cache this key names");

		// The cold configuration, on the same store in the same process, still pays for
		// every ranking and never touches the cache.
		const hitsBeforeCold = registry.hits;
		await trigger(synapseContract(true));
		assert.equal(baseSelections().length, 4, "with the cache off each ranking reads each record again");
		assert.equal(registry.hits, hitsBeforeCold, "off means the cache is not consulted, not that it is consulted and not written");
		assert.equal(baseOf(stateEnvelopePath(storageRoot, RUN_ID, 0)), firstBase, "and it selects the same base");
	});

	it("accepts a decoded residual when the receiver's own embedding agrees with it", async () => {
		// With verification on, the same query is embedded twice — once by the sender and
		// once by the receiver — and the two must agree, or the state is refused. The
		// stub answers the same vector both times here, so this is the accepting half.
		await rememberBase();
		const synapse = synapseContract(true, ["read", "synapse_read"], false, "reembed");
		const opened = await trigger(synapse);
		assert.equal(opened.state?.kind, "state");
		const delivered = readDeliveredEnvelope(stateEnvelopePath(storageRoot, RUN_ID, 0));
		assert.equal(delivered.status, "ready");
		if (delivered.status !== "ready") return;
		const outcome = await consume(synapse, delivered.wire, { embedder });
		assert.equal(outcome.kind, "consumed", `a residual the receiver can reproduce must be accepted, got ${outcome.kind}`);
	});

	it("refuses a state whose decoded vector no longer means the query, and recovers", async () => {
		// The residual is lossy and nothing else checks it per message: this is the check
		// that does. The provider is made to answer a different vector for the query, so
		// the decoded state and the receiver's own embedding disagree completely.
		await rememberBase();
		const synapse = synapseContract(true, ["read", "synapse_read"], false, "reembed");
		const opened = await trigger(synapse);
		assert.equal(opened.state?.kind, "state");
		const delivered = readDeliveredEnvelope(stateEnvelopePath(storageRoot, RUN_ID, 0));
		assert.equal(delivered.status, "ready");
		if (delivered.status !== "ready") return;

		reembedOverride = [0, 0, 1, 0, 0, 0, 0, 0];
		const callsBefore = readMeteringLog(logPath()).filter((event) => event.kind === "embedding-call").length;
		const outcome = await consume(synapse, delivered.wire, { embedder, stateRecovery: "resend-then-text" });
		// The check's failure is a recovery input, not a launch failure: the chain runs
		// and the text path answers.
		assert.equal(outcome.kind, "text-fallback", `a mismatched state must not be consumed, got ${outcome.kind}`);
		const events = readMeteringLog(logPath());
		// The hop says a recovery happened; the cause says what it was for. Without it a
		// run that recovered would leave no trace of the refusal at all.
		const textHop = events.find((event) => event.kind === "state-restore" && event.hop === "text");
		assert.equal(textHop?.kind === "state-restore" ? textHop.cause : null, "state-verify", "the hop must say the state was refused by verification");
		const totals = aggregateMetering(events);
		assert.equal(totals.state.verifications, 1, "one check ran, and it is recorded with its cosine");
		assert.equal(totals.state.verificationRefusals, 1, "the refusal is counted where it happened, not only where it was recovered from");
		const verifyEvent = events.find((event) => event.kind === "state-verify");
		assert.ok(verifyEvent?.kind === "state-verify" && verifyEvent.cosine < SYNAPSE_STATE_VERIFY_MIN_COSINE, "the measured cosine is in the log, so the threshold's margin is a measurement");
		// A semantic refusal skips the re-send: the bytes were intact, so repeating them
		// could only reproduce the refusal one round trip later.
		assert.equal(totals.state.restoreCount, 1, "the text hop is the only hop a semantic refusal takes");
		assert.equal(totals.fullAccount.fallback.hops.resend, 0, "and no re-send was attempted");
		// And it is metered, exactly once: the receiver's re-embedding is a real provider
		// call, and a verification that ran unmetered would be a cost the account denies.
		const embeddingCalls = events.filter((event) => event.kind === "embedding-call").length;
		assert.equal(embeddingCalls, callsBefore + 1, "the verification's embedding call must be counted, and not more than once");
	});

	it("fails the consume with the refusal's own category when recovery cannot run", async () => {
		// The receiver can re-embed, but the launch allows only a re-send — which a semantic
		// refusal never takes — so the refusal surfaces as the terminal failure, carrying the
		// prefix that says the digests all matched and the meaning did not.
		await rememberBase();
		const synapse = synapseContract(true);
		const opened = await trigger(synapse);
		const delivered = readDeliveredEnvelope(stateEnvelopePath(storageRoot, RUN_ID, 0));
		if (delivered.status !== "ready") assert.fail("the state envelope must be delivered");

		reembedOverride = [0, 0, 1, 0, 0, 0, 0, 0];
		const strict = { ...synapse.contract, stateVerify: "reembed" as const };
		const outcome = await consumeRetrieveState({
			contract: strict,
			deps: { embedder, log: createMeteringLog(logPath()) },
			envelope: delivered.wire,
			expectedSenderSessionId: synapse.sessionId,
			fallbackQuery: QUERY,
			identity: { agent: "retriever", attempt: 1, childIndex: 0, runId: RUN_ID, sessionId: "sess-child" },
			k: K,
			stateRecovery: "resend",
			worktreeRoot: worktree,
		});
		assert.equal(outcome.kind, "failed", `a refused state with no recovery must fail, got ${outcome.kind}`);
		const events = readMeteringLog(logPath());
		assert.ok(
			events.some((event) => event.kind === "error" && event.category === "integrity" && event.detail.startsWith("state-verify:")),
			"the terminal failure must be recorded under its own prefix, distinguishable from corruption",
		);
		// A refusal that ends the consume is counted exactly like one a fallback rescued:
		// counting only the recovered ones would understate the refusal rate.
		const totals = aggregateMetering(events);
		assert.equal(totals.state.verifications, 1);
		assert.equal(totals.state.verificationRefusals, 1);
	});

	it("refuses to consume unverified when the launch asked for verification and cannot perform it", async () => {
		// The setting is a promise about this side's behaviour. A receiver that cannot
		// re-embed must say so rather than accept the payload and make the promise empty.
		await rememberBase();
		const synapse = synapseContract(true);
		const opened = await trigger(synapse);
		const delivered = readDeliveredEnvelope(stateEnvelopePath(storageRoot, RUN_ID, 0));
		if (delivered.status !== "ready") assert.fail("the state envelope must be delivered");

		const strict = { ...synapse.contract, stateVerify: "reembed" as const };
		const outcome = await consumeRetrieveState({
			contract: strict,
			// No embedder on this side: the check cannot run.
			deps: { log: createMeteringLog(logPath()) },
			envelope: delivered.wire,
			expectedSenderSessionId: synapse.sessionId,
			fallbackQuery: QUERY,
			identity: { agent: "retriever", attempt: 1, childIndex: 0, runId: RUN_ID, sessionId: "sess-child" },
			k: K,
			worktreeRoot: worktree,
		});
		assert.equal(outcome.kind, "refused", `a check that cannot run must refuse rather than pass silently, got ${outcome.kind}`);
		assert.equal(outcome.kind === "refused" ? outcome.category : null, "configuration");
	});

	it("checks the query the sender encoded, not the text this side happens to hold", async () => {
		// The state is a claim about the sender's query. A receiver whose local copy has
		// drifted must not be told the state is wrong: the state is right about the sender's
		// query, and the comparison has to use that one.
		await rememberBase();
		const synapse = synapseContract(true);
		const opened = await trigger(synapse);
		const delivered = readDeliveredEnvelope(stateEnvelopePath(storageRoot, RUN_ID, 0));
		if (delivered.status !== "ready") assert.fail("the state envelope must be delivered");

		const strict = { ...synapse.contract, stateVerify: "reembed" as const };
		const outcome = await consumeRetrieveState({
			contract: strict,
			deps: { embedder, log: createMeteringLog(logPath()) },
			envelope: delivered.wire,
			expectedSenderSessionId: synapse.sessionId,
			// A different local query: had the check used this, the cosine would be 0.
			fallbackQuery: OTHER_QUERY,
			identity: { agent: "retriever", attempt: 1, childIndex: 0, runId: RUN_ID, sessionId: "sess-child" },
			k: K,
			stateRecovery: "resend-then-text",
			worktreeRoot: worktree,
		});
		assert.equal(outcome.kind, "consumed", `the sender's own query must decide, got ${outcome.kind}`);
	});

	it("accepts a decoded state just above the frozen threshold", async () => {
		// The threshold is a number with a meaning only if its neighbourhood is pinned. The
		// decoded state is a unit vector on the second axis, so an answer whose first two
		// components are (sqrt(1-c^2), c) has cosine exactly c with it.
		await rememberBase();
		const synapse = synapseContract(true);
		const opened = await trigger(synapse);
		const delivered = readDeliveredEnvelope(stateEnvelopePath(storageRoot, RUN_ID, 0));
		if (delivered.status !== "ready") assert.fail("the state envelope must be delivered");

		reembedOverride = atCosine(SYNAPSE_STATE_VERIFY_MIN_COSINE + 0.005);
		const strict = strictVerify(synapse);
		const outcome = await consumeStrict(strict, delivered, QUERY);
		const measured = lastVerifyCosine();
		assert.equal(outcome.kind, "consumed", `${SYNAPSE_STATE_VERIFY_MIN_COSINE + 0.005} is above the frozen ${SYNAPSE_STATE_VERIFY_MIN_COSINE} (measured ${measured})`);
		assert.ok(Math.abs(measured - (SYNAPSE_STATE_VERIFY_MIN_COSINE + 0.005)) < 0.02, `the check must measure what the provider produced, got ${measured}`);
	});

	it("refuses just below the frozen threshold", async () => {
		await rememberBase();
		const synapse = synapseContract(true);
		const opened = await trigger(synapse);
		const delivered = readDeliveredEnvelope(stateEnvelopePath(storageRoot, RUN_ID, 0));
		if (delivered.status !== "ready") assert.fail("the state envelope must be delivered");

		reembedOverride = atCosine(SYNAPSE_STATE_VERIFY_MIN_COSINE - 0.005);
		const strict = strictVerify(synapse);
		const outcome = await consumeStrict(strict, delivered, QUERY);
		const measured = lastVerifyCosine();
		assert.equal(outcome.kind, "text-fallback", `${SYNAPSE_STATE_VERIFY_MIN_COSINE - 0.005} is below the frozen ${SYNAPSE_STATE_VERIFY_MIN_COSINE} (measured ${measured})`);
		assert.ok(Math.abs(measured - (SYNAPSE_STATE_VERIFY_MIN_COSINE - 0.005)) < 0.02, `the check must measure what the provider produced, got ${measured}`);
	});

	it("does not re-embed the query when the launch did not ask for verification", async () => {
		await rememberBase();
		const synapse = synapseContract(true);
		const opened = await trigger(synapse);
		const delivered = readDeliveredEnvelope(stateEnvelopePath(storageRoot, RUN_ID, 0));
		if (delivered.status !== "ready") assert.fail("the state envelope must be delivered");
		const before = readMeteringLog(logPath()).filter((event) => event.kind === "embedding-call").length;
		reembedOverride = [0, 0, 1, 0, 0, 0, 0, 0];
		const outcome = await consume(synapse, delivered.wire);
		assert.equal(outcome.kind, "consumed", "with verification off a mismatch is not looked for");
		assert.equal(
			readMeteringLog(logPath()).filter((event) => event.kind === "embedding-call").length,
			before,
			"the default path must not pay for a second embedding",
		);
	});

	it("does not spend a re-send on a refusal the bytes cannot fix", async () => {
		await rememberBase();
		const synapse = synapseContract(true);
		const opened = await trigger(synapse);
		const delivered = readDeliveredEnvelope(stateEnvelopePath(storageRoot, RUN_ID, 0));
		if (delivered.status !== "ready") assert.fail("the state envelope must be delivered");

		reembedOverride = atCosine(0.5);
		let resendAttempts = 0;
		const strict = strictVerify(synapse);
		const outcome = await consumeRetrieveState({
			contract: strict,
			deps: {
				embedder,
				// The point is that the attempt must not happen: whether this would have
				// produced usable bytes is beside the question, because the bytes were never
				// what was wrong with the state.
				resend: () => {
					resendAttempts += 1;
					return null;
				},
				log: createMeteringLog(logPath()),
			},
			envelope: delivered.wire,
			expectedSenderSessionId: synapse.sessionId,
			fallbackQuery: QUERY,
			identity: { agent: "retriever", attempt: 1, childIndex: 0, runId: RUN_ID, sessionId: "sess-child" },
			k: K,
			stateRecovery: "resend-then-text",
			worktreeRoot: worktree,
		});
		assert.equal(outcome.kind, "text-fallback");
		assert.equal(resendAttempts, 0, "a semantic refusal must not spend a re-send");
		const totals = aggregateMetering(readMeteringLog(logPath()));
		assert.equal(totals.fullAccount.fallback.hops.resend, 0);
		assert.equal(totals.state.restoreCount, 1, "the text hop is the only hop a refusal takes");
	});

	it("keeps the receiver's contract check satisfied for a residual, not just for a vector", async () => {
		// A residual changes the payload's size and media type, which is exactly the
		// kind of change that can slip past an envelope check written for float32.
		await rememberBase();
		const synapse = synapseContract(true);
		const opened = await trigger(synapse);
		assert.equal(opened.state?.kind, "state");
		const delivered = readDeliveredEnvelope(stateEnvelopePath(storageRoot, RUN_ID, 0));
		assert.equal(delivered.status, "ready");
		if (delivered.status !== "ready") return;
		const outcome = await consume(synapse, delivered.wire);
		assert.notEqual(outcome.kind, "refused", `a residual envelope must survive every admission check, got ${outcome.kind}`);
		if (outcome.kind === "failed" || outcome.kind === "refused") assert.fail(outcome.reason);
	});
});
