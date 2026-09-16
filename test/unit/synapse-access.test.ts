import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { intersectScopes, isReadable, requireWritable, type AccessScope } from "../../src/synapse/access.ts";
import type { MemoryRecord } from "../../src/synapse/memory-store.ts";

function scope(overrides: Partial<AccessScope> = {}): AccessScope {
	return {
		agent: overrides.agent ?? "retriever",
		namespaceId: overrides.namespaceId ?? "0123456789abcdef",
		pathPrefixes: overrides.pathPrefixes ?? [""],
		write: overrides.write ?? false,
	};
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	return {
		assurance: "observation",
		contentId: "a".repeat(64),
		createdAt: "2026-09-16T00:00:00.000Z",
		kind: "evidence",
		memoryId: "b".repeat(64),
		provenance: { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "s" },
		recordStatus: "active",
		source: overrides.source === undefined ? { byteLength: 1, digest: "c".repeat(64), path: "src/a.ts" } : overrides.source,
		summary: overrides.summary ?? "机密摘要",
		tags: overrides.tags ?? [],
		taskTopic: overrides.taskTopic ?? "topic-a",
	};
}

describe("synapse scope intersection", () => {
	it("keeps only what both the project and the subagent allow", () => {
		const merged = intersectScopes(scope({ pathPrefixes: ["src", "docs"] }), scope({ pathPrefixes: ["src"] }));
		assert.deepEqual(merged.pathPrefixes, ["src"]);
	});

	it("narrows a broad grant to the narrower one rather than keeping both", () => {
		const merged = intersectScopes(scope({ pathPrefixes: [""] }), scope({ pathPrefixes: ["src/synapse"] }));
		assert.deepEqual(merged.pathPrefixes, ["src/synapse"]);
	});

	it("produces an empty scope when the two grants do not overlap", () => {
		const merged = intersectScopes(scope({ pathPrefixes: ["docs"] }), scope({ pathPrefixes: ["src"] }));
		assert.deepEqual(merged.pathPrefixes, []);
	});

	it("grants write only when both sides grant it", () => {
		assert.equal(intersectScopes(scope({ write: true }), scope({ write: true })).write, true);
		assert.equal(intersectScopes(scope({ write: true }), scope({ write: false })).write, false);
		assert.equal(intersectScopes(scope({ write: false }), scope({ write: true })).write, false);
	});

	it("refuses to merge scopes from different namespaces", () => {
		assert.throws(
			() => intersectScopes(scope({ namespaceId: "0".repeat(16) }), scope({ namespaceId: "1".repeat(16) })),
			/namespace-mismatch/,
		);
	});
});

describe("synapse read authorisation", () => {
	it("allows a record whose source sits inside the granted prefix", () => {
		assert.equal(isReadable(record({ source: { byteLength: 1, digest: "c".repeat(64), path: "src/a.ts" } }), scope({ pathPrefixes: ["src"] })), true);
	});

	it("denies a record whose source sits outside every granted prefix", () => {
		assert.equal(isReadable(record({ source: { byteLength: 1, digest: "c".repeat(64), path: "secrets/keys.env" } }), scope({ pathPrefixes: ["src"] })), false);
	});

	it("does not treat a prefix as a directory boundary by string match alone", () => {
		// `src-private` must not be admitted by a grant over `src`.
		const outside = record({ source: { byteLength: 1, digest: "c".repeat(64), path: "src-private/a.ts" } });
		assert.equal(isReadable(outside, scope({ pathPrefixes: ["src"] })), false);
	});

	it("denies everything under an empty scope", () => {
		assert.equal(isReadable(record(), scope({ pathPrefixes: [] })), false);
		assert.equal(isReadable(record({ source: null }), scope({ pathPrefixes: [] })), false);
	});

	it("admits a sourceless record only when the whole worktree is granted", () => {
		// A conclusion with no file behind it cannot be projected onto a narrower
		// grant, so a partial grant must not see it.
		assert.equal(isReadable(record({ source: null }), scope({ pathPrefixes: [""] })), true);
		assert.equal(isReadable(record({ source: null }), scope({ pathPrefixes: ["src"] })), false);
	});
});

describe("synapse write authorisation", () => {
	it("rejects a write from a read-only role", () => {
		assert.throws(() => requireWritable(scope({ write: false })), /not-authorised/);
	});

	it("rejects a write from a role with no readable path at all", () => {
		assert.throws(() => requireWritable(scope({ pathPrefixes: [], write: true })), /not-authorised/);
	});

	it("allows a write when the role holds the grant", () => {
		assert.doesNotThrow(() => requireWritable(scope({ write: true })));
	});
});
