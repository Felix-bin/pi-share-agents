import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AccessScope } from "../../src/synapse/access.ts";
import { createDeterministicEmbedder } from "../support/deterministic-embedder.ts";
import { createMeteringLog, readMeteringLog, type MeteringEvent } from "../../src/synapse/metering.ts";
import { createMemoryService, type MemoryService } from "../../src/synapse/memory-service.ts";
import { createMemoryVectorCache, memoryVectorCacheFor, resetMemoryVectorCaches, type MemoryVectorCache } from "../../src/synapse/vector-cache.ts";

/**
 * The record-vector cache (task card P4-R).
 *
 * The property that matters is not "it is faster" but "it does not change what is
 * compared, and it does not hide the cost it removes": a hit is a read that did not
 * happen, so it must not be metered as one either.
 */

let storeRoot = "";
let worktree = "";
let logPath = "";
const DIM = 8;

function scope(): AccessScope {
	return { agent: "retriever", namespaceId: "0123456789abcdef", pathPrefixes: [""], write: true };
}

function serviceWith(cache: MemoryVectorCache | undefined): MemoryService {
	return createMemoryService({
		embedder: createDeterministicEmbedder(DIM),
		metering: {
			identity: { agent: "planner", attempt: 1, mode: "synapse", nodeId: "node-1", runId: "run-1", sessionId: "sess-1", snapshotId: null },
			log: createMeteringLog(logPath),
		},
		now: () => new Date(Date.UTC(2026, 8, 20, 0, 0, 0)),
		provenance: { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "sess-1" },
		scope: scope(),
		storeRoot,
		...(cache === undefined ? {} : { vectorCache: cache }),
		worktreeRoot: worktree,
	});
}

async function seed(instance: MemoryService, summary: string, operationId: string): Promise<void> {
	await instance.remember({ content: summary, kind: "evidence", operationId, summary, tags: ["seed"], topic: "alpha" });
}

function baseSelectionReads(): MeteringEvent[] {
	return readMeteringLog(logPath).filter(
		(event): event is Extract<MeteringEvent, { kind: "object-io" }> =>
			event.kind === "object-io" && event.purpose === "base-selection",
	);
}

beforeEach(() => {
	storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-vcache-"));
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-vcachewt-"));
	logPath = path.join(storeRoot, "events.jsonl");
	resetMemoryVectorCaches();
});

afterEach(() => {
	fs.rmSync(storeRoot, { force: true, recursive: true });
	fs.rmSync(worktree, { force: true, recursive: true });
});

describe("record-vector cache", () => {
	it("does not change which base is selected", async () => {
		const seedService = serviceWith(undefined);
		await seed(seedService, "alpha one", "op-1");
		await seed(seedService, "alpha two", "op-2");

		const warm = await serviceWith(undefined).predictBase({ text: "alpha one" });
		const cached = await serviceWith(createMemoryVectorCache()).predictBase({ text: "alpha one" });
		assert.ok(warm, "the uncached path must select a base for this fixture to say anything");
		assert.equal(cached?.memoryId, warm.memoryId, "the cache changes where the bytes come from, not which record wins");
	});

	it("reads each record's vector once per process instead of once per ranking", async () => {
		await seed(serviceWith(undefined), "alpha one", "op-1");
		await seed(serviceWith(undefined), "alpha two", "op-2");

		const cold = serviceWith(undefined);
		await cold.predictBase({ text: "alpha one" });
		await cold.predictBase({ text: "alpha two" });
		// Two rankings over two records, with no cache: four reads of stored vectors.
		assert.equal(baseSelectionReads().length, 4);

		const cache = createMemoryVectorCache();
		const warm = serviceWith(cache);
		await warm.predictBase({ text: "alpha one" });
		await warm.predictBase({ text: "alpha two" });
		// Four cold reads plus the two that filled the cache. The second warm ranking
		// reads nothing at all, which is what `hits` below counts.
		assert.equal(baseSelectionReads().length, 6);
		assert.equal(cache.misses, 2);
		assert.equal(cache.hits, 2);
	});

	it("serves a second service in the same process from the shared cache", async () => {
		await seed(serviceWith(undefined), "alpha one", "op-1");
		const shared = memoryVectorCacheFor(storeRoot, createDeterministicEmbedder(DIM));
		await serviceWith(shared).predictBase({ text: "alpha one" });
		const afterFirst = baseSelectionReads().length;
		// A second service stands in for the next send in the same process: it must
		// find the vectors already resident rather than reading them again.
		await serviceWith(memoryVectorCacheFor(storeRoot, createDeterministicEmbedder(DIM))).predictBase({ text: "alpha one" });
		assert.equal(baseSelectionReads().length, afterFirst);
	});

	it("keys entries by the object the bytes live under", () => {
		const cache = createMemoryVectorCache();
		const vector = new Float32Array([1, 0, 0, 0]);
		cache.put("a".repeat(64), vector);
		assert.deepEqual([...(cache.get("a".repeat(64)) ?? [])], [1, 0, 0, 0]);
		assert.equal(cache.get("b".repeat(64)), null, "a digest that was never read must not be answered");
		assert.equal(cache.hits, 1);
		assert.equal(cache.misses, 1);
	});

	it("hands out copies, so a caller cannot poison a later reader", () => {
		const cache = createMemoryVectorCache();
		cache.put("c".repeat(64), new Float32Array([1, 2, 3, 4]));
		const first = cache.get("c".repeat(64));
		assert.ok(first);
		first[0] = 99;
		assert.deepEqual([...(cache.get("c".repeat(64)) ?? [])], [1, 2, 3, 4]);
		// The other direction matters too: the sender ranks with the very array it
		// cached, so an entry that aliased the caller's array would be corrupted by
		// whatever that caller did to it next.
		const source = new Float32Array([5, 6, 7, 8]);
		cache.put("e".repeat(64), source);
		source[0] = 42;
		assert.deepEqual([...(cache.get("e".repeat(64)) ?? [])], [5, 6, 7, 8]);
	});

	it("starts empty again after a reset", () => {
		const before = memoryVectorCacheFor(storeRoot, createDeterministicEmbedder(DIM));
		before.put("d".repeat(64), new Float32Array([1]));
		resetMemoryVectorCaches();
		const after = memoryVectorCacheFor(storeRoot, createDeterministicEmbedder(DIM));
		assert.equal(after.size, 0);
		assert.notEqual(after, before);
	});

	it("keeps stores apart even when they hold the same object id", () => {
		const other = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-vcache2-"));
		try {
			const cacheA = memoryVectorCacheFor(storeRoot, createDeterministicEmbedder(DIM));
			const cacheB = memoryVectorCacheFor(other, createDeterministicEmbedder(DIM));
			assert.notEqual(cacheA, cacheB, "two storage roots must not share a process cache");
		} finally {
			fs.rmSync(other, { force: true, recursive: true });
		}
	});
});
