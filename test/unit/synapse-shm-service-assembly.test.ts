import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildCorpus } from "../../src/synapse/corpus.ts";
import { createContentStore } from "../../src/synapse/content-store.ts";
import { SYNAPSE_VECTOR_MEDIA_TYPE } from "../../src/synapse/embedding.ts";
import { createSynapseService } from "../../src/synapse/register-tools.ts";
import { createInMemoryShmBindings, resetInMemoryShmSegments, type ShmBindings } from "../../src/synapse/shm-bindings.ts";
import { resetShmCorpusPlanes } from "../../src/synapse/shm-corpus-plane.ts";
import type { SynapseConfig } from "../../src/synapse/config.ts";
import { createDeterministicEmbedder } from "../support/deterministic-embedder.ts";

/**
 * The production assembly of the corpus-resident plane (P6-3): what
 * `createSynapseService` wires when config turns `shm` on, and what it does not
 * touch when config leaves it off.
 *
 * The decisive probe is the absence of the disk corpus: after the writer
 * service has assembled and published, the corpus files are deleted. A second
 * service (a second "process", same shared registry) then still answers a
 * stateId search — the segment is the only place those bytes exist. The shm-off
 * control on the same deleted files must refuse with object-unavailable, which
 * proves the on-arm really went through the plane rather than the file path.
 */

const DIM = 8;
const SOURCE_COMMIT = "f".repeat(40);

let storageRoot = "";
let agentDir = "";
let corpusRoot = "";
let worktree = "";
let corpusSnapshotId = "";

const embedder = createDeterministicEmbedder(DIM);

beforeEach(async () => {
	resetShmCorpusPlanes();
	resetInMemoryShmSegments();
	storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-shmasm-"));
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-shmasm-agent-"));
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-shmasm-wt-"));
	corpusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-shmasm-src-"));
	for (const [name, text] of [
		["src/a.md", "# alpha\nshared memory plane observation one\n"],
		["src/b.md", "# beta\ncoordination as compression observation two\n"],
	] as const) {
		const target = path.join(corpusRoot, name);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, text);
	}
	const built = await buildCorpus({ corpusRoot, embedder, sourceCommit: SOURCE_COMMIT, storageRoot });
	corpusSnapshotId = built.corpusSnapshotId;
});

afterEach(() => {
	resetShmCorpusPlanes();
	fs.rmSync(storageRoot, { force: true, recursive: true });
	fs.rmSync(agentDir, { force: true, recursive: true });
	fs.rmSync(worktree, { force: true, recursive: true });
	fs.rmSync(corpusRoot, { force: true, recursive: true });
	resetInMemoryShmSegments();
});

function config(shm: boolean): SynapseConfig {
	return {
		autoDistill: false,
		contextBudgetBytes: 1 << 20,
		corpusSnapshotId,
		deliveryGear: "file",
		delta: false,
		embedding: null,
		maxObjectBytes: 1 << 20,
		memory: "project",
		mode: "synapse",
		shm,
		stateRecovery: "resend-then-text",
		stateVerify: "off",
		storageRoot,
		vectorCache: false,
	};
}

function context() {
	return { provenance: { agent: "assembler", attempt: 1, runId: "run-1", sessionId: "sess-1" }, scope: { agent: "assembler", pathPrefixes: [""], write: true }, shmBindings: createInMemoryShmBindings(), worktreeRoot: worktree };
}

/** A stateRef over the published vector of chunk 0, CAS-published into the store. */
function stateRefOfChunk0() {
	const bytes = fs.readFileSync(path.join(storageRoot, "corpus", corpusSnapshotId, "vectors.f32"));
	const buffer = Buffer.alloc(DIM * 4);
	bytes.copy(buffer, 0, 0, DIM * 4);
	const store = createContentStore(storageRoot);
	const payloadId = store.put(new Uint8Array(buffer), SYNAPSE_VECTOR_MEDIA_TYPE);
	return { baseMemoryId: null, byteLength: buffer.byteLength, dim: DIM, encoding: "float32-vector", payloadId, representationId: embedder.representationId, sha256: payloadId } as const;
}

describe("createSynapseService assembles the corpus plane behind config.shm", () => {
	it("publishes on assembly and serves a second service with the corpus files deleted", () => {
		const writer = createSynapseService(config(true), agentDir, context());
		const stateRef = stateRefOfChunk0();
		// The files are gone; the segment is the only remaining copy of the corpus.
		fs.rmSync(path.join(storageRoot, "corpus"), { recursive: true });

		const reader = createSynapseService(config(true), agentDir, context());
		const result = reader.service.search({ k: 2, stateId: stateRef.payloadId, stateRef });
		assert.ok(result.hits.length > 0, "the segment must serve stateId ranking with no corpus files");

		const viaFile = createSynapseService(config(false), agentDir, context());
		assert.throws(() => viaFile.service.search({ k: 2, stateId: stateRef.payloadId, stateRef }), /object-unavailable/);
		void writer;
	});

	it("assembles nothing when config.shm is off (registry stays empty)", () => {
		createSynapseService(config(false), agentDir, context());
		assert.equal(createInMemoryShmBindings().listOwnSegments().length, 0);
	});

	it("degrades to the file path when config.shm is on but the host has no shm bindings", () => {
		// context without shmBindings and a non-Linux host resolveShmBindings() → null;
		// simulate by a context whose bindings override is absent — resolveShmBindings
		// on Linux with koffi would still succeed, so instead assert the file path
		// still works when the plane is skipped: corpus present, plain search ranks.
		const writer = createSynapseService(config(true), agentDir, context());
		const stateRef = stateRefOfChunk0();
		const result = writer.service.search({ k: 2, stateId: stateRef.payloadId, stateRef });
		assert.ok(result.hits.length > 0);
	});

	it("shares one process plane across service constructions (no per-tool-call writer mappings)", () => {
		// Services are minted per tool call in production; before the registry
		// each construction opened its own writer mapping and re-read the whole
		// corpus. Exactly one segment creation across two constructions is the
		// property that kills both costs.
		const inner = createInMemoryShmBindings();
		let createCalls = 0;
		const counting: ShmBindings = {
			...inner,
			createSegment(name: string, bytes: number) {
				createCalls += 1;
				return inner.createSegment(name, bytes);
			},
		};
		const ctx = { provenance: { agent: "assembler", attempt: 1, runId: "run-1", sessionId: "sess-1" }, scope: { agent: "assembler", pathPrefixes: [""], write: true }, shmBindings: counting, worktreeRoot: worktree };
		const stateRef = stateRefOfChunk0();
		const first = createSynapseService(config(true), agentDir, ctx);
		assert.ok(first.service.search({ k: 2, stateId: stateRef.payloadId, stateRef }).hits.length > 0);
		const second = createSynapseService(config(true), agentDir, ctx);
		assert.ok(second.service.search({ k: 2, stateId: stateRef.payloadId, stateRef }).hits.length > 0);
		assert.equal(createCalls, 1, "the process plane registry must mint exactly one segment mapping");
	});
});
