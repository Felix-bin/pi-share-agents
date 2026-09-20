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
		const cache = createMemoryVectorCache();
		// Both calls share one cache, so the second is served entirely from memory: the
		// claim under test is about the hit path, and a fresh cache per call would only
		// ever exercise the miss path.
		const firstSelection = await serviceWith(cache).predictBase({ text: "alpha one" });
		const hitSelection = await serviceWith(cache).predictBase({ text: "alpha two" });
		assert.ok(warm, "the uncached path must select a base for this fixture to say anything");
		assert.equal(firstSelection?.memoryId, warm.memoryId, "the cache changes where the bytes come from, not which record wins");
		assert.ok(hitSelection, "the hit path must still select a base");
		assert.ok(cache.hits > 0, "the second ranking must actually be served from the cache");
		// The hit path is compared against the same query ranked with no cache at all.
		const coldSameQuery = await serviceWith(undefined).predictBase({ text: "alpha two" });
		assert.equal(hitSelection.memoryId, coldSameQuery?.memoryId, "a served-from-memory vector must rank exactly as the stored one does");
	});

	it("keeps serving a vector it verified, even if the stored bytes are replaced", async () => {
		// Declared semantics, not an accident: a hit trusts the first verified read, so a
		// store whose bytes changed under a cached id splits the two arms' behaviour. This
		// test is what makes that split a decision on record rather than something found
		// later in a report.
		const seedService = serviceWith(undefined);
		await seed(seedService, "alpha one", "op-1");
		const cache = createMemoryVectorCache();
		const before = await serviceWith(cache).predictBase({ text: "alpha one" });
		assert.ok(before, "the fixture needs a base to begin with");
		const readsAfterFill = baseSelectionReads().length;

		// Overwrite every stored object with bytes that are not the vector it was
		// published as. The cold path re-verifies and refuses these; a hit cannot see
		// them, which is the split this test puts on record.
		const objectFiles: string[] = [];
		for (const shard of fs.readdirSync(path.join(storeRoot, "objects"))) {
			const shardDir = path.join(storeRoot, "objects", shard);
			if (!fs.statSync(shardDir).isDirectory()) continue;
			for (const file of fs.readdirSync(shardDir)) objectFiles.push(path.join(shardDir, file));
		}
		assert.ok(objectFiles.length >= 2, "the fixture must have stored vector objects to corrupt");
		for (const file of objectFiles) fs.writeFileSync(file, Buffer.alloc(DIM * 4, 7));

		const warm = await serviceWith(cache).predictBase({ text: "alpha one" });
		assert.equal(warm?.memoryId, before.memoryId, "the cached entry is served without consulting the store");
		assert.equal(baseSelectionReads().length, readsAfterFill, "and serving it performs no read");

		// The cold path, against the same corrupted store, refuses rather than returning
		// a vector it cannot trust — the difference the cache makes visible.
		await assert.rejects(async () => serviceWith(undefined).predictBase({ text: "alpha one" }));
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

	it("records what it served from memory, so fewer reads cannot be confused with fewer records", async () => {
		await seed(serviceWith(undefined), "alpha one", "op-1");
		const cache = createMemoryVectorCache();
		const warm = serviceWith(cache);
		await warm.predictBase({ text: "alpha one" });
		await warm.predictBase({ text: "alpha one" });
		const events = readMeteringLog(logPath).filter(
			(event): event is Extract<MeteringEvent, { kind: "vector-cache" }> => event.kind === "vector-cache",
		);
		assert.equal(events.length, 2, "one event per ranking that used the cache");
		assert.deepEqual(
			events.map((event) => ({ hits: event.hits, misses: event.misses })),
			[
				{ hits: 0, misses: 1 },
				{ hits: 1, misses: 0 },
			],
		);
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
		assert.equal(after.entryCount, 0);
		assert.notEqual(after, before);
	});

	it("treats two spellings of one directory as one cache", () => {
		const plain = memoryVectorCacheFor(storeRoot, createDeterministicEmbedder(DIM));
		// A trailing separator resolves away; on Windows the same directory reached with
		// different case must not become a second cache that silently never hits.
		assert.equal(memoryVectorCacheFor(`${storeRoot}${path.sep}`, createDeterministicEmbedder(DIM)), plain);
		if (process.platform === "win32") {
			assert.equal(memoryVectorCacheFor(storeRoot.toUpperCase(), createDeterministicEmbedder(DIM)), plain);
		}
	});

	it("does not hold every store a long-lived process ever touches", () => {
		const roots = [storeRoot];
		for (let index = 0; index < 10; index += 1) roots.push(fs.mkdtempSync(path.join(os.tmpdir(), `synapse-vcache-cap-${index}-`)));
		try {
			const first = memoryVectorCacheFor(roots[0]!, createDeterministicEmbedder(DIM));
			for (const root of roots.slice(1)) memoryVectorCacheFor(root, createDeterministicEmbedder(DIM));
			// The oldest store is evicted rather than kept forever: an unbounded map of
			// whole vector sets is a memory leak wearing a cache's name.
			assert.notEqual(memoryVectorCacheFor(roots[0]!, createDeterministicEmbedder(DIM)), first);
		} finally {
			for (const root of roots.slice(1)) fs.rmSync(root, { force: true, recursive: true });
		}
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
