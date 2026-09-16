import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createContentStore, type ContentStore } from "../../src/synapse/content-store.ts";
import { createMemoryStore, type MemoryPublishInput, type MemoryStore } from "../../src/synapse/memory-store.ts";

let root = "";
let content: ContentStore;
let store: MemoryStore;
let clock = 0;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-mem-"));
	content = createContentStore(root);
	clock = Date.UTC(2026, 8, 16, 0, 0, 0);
	store = createMemoryStore(root, { contentStore: content, now: () => new Date(clock) });
});

afterEach(() => {
	fs.rmSync(root, { force: true, recursive: true });
});

function bodyId(text: string): string {
	return content.put(new TextEncoder().encode(text), "text/plain");
}

function input(overrides: Partial<MemoryPublishInput> = {}): MemoryPublishInput {
	return {
		assurance: overrides.assurance ?? "observation",
		contentId: overrides.contentId ?? bodyId("默认证据正文"),
		kind: overrides.kind ?? "evidence",
		operationId: overrides.operationId ?? "run-1/step-2",
		provenance: overrides.provenance ?? { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "sess-1" },
		source: overrides.source,
		summary: overrides.summary ?? "检索到的段落摘要",
		tags: overrides.tags ?? ["retrieval"],
		taskTopic: overrides.taskTopic ?? "topic-a",
	};
}

describe("synapse memory publication", () => {
	it("keeps every required field so another process can use the record", () => {
		const record = store.publish(input());
		assert.match(record.memoryId, /^[0-9a-f]{64}$/);
		assert.equal(record.createdAt, new Date(clock).toISOString());
		assert.equal(record.provenance.agent, "retriever");
		assert.equal(record.taskTopic, "topic-a");
		assert.equal(record.kind, "evidence");
		assert.equal(record.recordStatus, "active");
		assert.equal(record.assurance, "observation");
		assert.deepEqual(store.get(record.memoryId), record);
	});

	it("is readable by a store rebuilt from disk", () => {
		const record = store.publish(input());
		const reopened = createMemoryStore(root, { contentStore: createContentStore(root), now: () => new Date(clock) });
		assert.deepEqual(reopened.get(record.memoryId), record);
	});

	it("refuses to publish a record whose body is not in the object store", () => {
		assert.throws(() => store.publish(input({ contentId: "0".repeat(64) })), /object-unavailable/);
		assert.equal(store.list().length, 0);
	});

	it("reuses the id and creation time when the same operation is retried", () => {
		const first = store.publish(input());
		clock += 60_000;
		const retried = store.publish(input());
		assert.equal(retried.memoryId, first.memoryId);
		assert.equal(retried.createdAt, first.createdAt);
		assert.equal(store.list().length, 1);
	});

	it("keeps two agents' independent observations apart even when the body is identical", () => {
		const shared = bodyId("同一段正文");
		const a = store.publish(input({ contentId: shared, provenance: { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "s" } }));
		const b = store.publish(input({ contentId: shared, provenance: { agent: "executor", attempt: 1, runId: "run-2", sessionId: "s" } }));
		assert.notEqual(a.memoryId, b.memoryId);
		assert.equal(a.contentId, b.contentId);
		assert.equal(store.list().length, 2);
	});

	it("rejects a conflicting republication of the same id as corruption", () => {
		const record = store.publish(input());
		const recordPath = store.recordPath(record.memoryId);
		const tampered = { ...JSON.parse(fs.readFileSync(recordPath, "utf-8")), summary: "另一个进程写入的不同摘要" };
		fs.writeFileSync(recordPath, JSON.stringify(tampered));
		assert.throws(() => store.publish(input()), /integrity/);
	});

	it("rejects an unknown kind instead of storing an uninterpretable record", () => {
		// SAFETY: deliberately smuggling an invalid kind past the compiler is the
		// only way to exercise the runtime guard a JSON tool payload would hit.
		const invalidKind = "guess" as MemoryPublishInput["kind"];
		assert.throws(() => store.publish(input({ kind: invalidKind })), /kind/);
	});
});

describe("synapse memory loading", () => {
	function publishSeries(count: number): string[] {
		const ids: string[] = [];
		for (let index = 0; index < count; index += 1) {
			clock += 1000;
			ids.push(store.publish(input({ contentId: bodyId(`正文-${index}`), operationId: `op-${index}` })).memoryId);
		}
		return ids;
	}

	it("returns newest first with the id breaking ties deterministically", () => {
		publishSeries(3);
		const listed = store.list();
		const stamps = listed.map((record) => record.createdAt);
		assert.deepEqual(stamps, [...stamps].sort().reverse());
	});

	it("caps how many records are loaded at once", () => {
		publishSeries(5);
		const bounded = createMemoryStore(root, { contentStore: content, maxLoadedRecords: 2, now: () => new Date(clock) });
		assert.equal(bounded.list().length, 2);
		// The cap bounds one load, not the archive: point reads still reach older records.
		const all = store.list();
		assert.equal(all.length, 5);
		assert.ok(bounded.get(all[4]!.memoryId));
	});

	it("fails loudly on a record whose body is gone rather than returning a dangling reference", () => {
		const record = store.publish(input());
		fs.rmSync(content.objectPath(record.contentId));
		assert.throws(() => store.list(), /orphan/);
	});

	it("ignores temp files left behind by an interrupted publication", () => {
		store.publish(input());
		fs.writeFileSync(path.join(root, "memory", ".partial.12345.tmp"), "{ not json");
		assert.equal(store.list().length, 1);
	});
});

describe("synapse supersession", () => {
	it("records supersession as its own event and leaves the old record on disk", () => {
		const oldRecord = store.publish(input({ operationId: "op-old" }));
		clock += 1000;
		const newRecord = store.publish(input({ contentId: bodyId("更新后的正文"), operationId: "op-new" }));
		const event = store.supersede({
			host: "planner",
			newId: newRecord.memoryId,
			oldId: oldRecord.memoryId,
			reason: "source-changed",
			sourceChange: { after: "b".repeat(64), before: "a".repeat(64), path: "src/a.ts" },
		});
		assert.match(event.eventId, /^[0-9a-f]{64}$/);
		// The record file is immutable; only the derived status changes.
		assert.deepEqual(JSON.parse(fs.readFileSync(store.recordPath(oldRecord.memoryId), "utf-8")), oldRecord);
		assert.equal(store.status(oldRecord.memoryId), "superseded");
		assert.equal(store.status(newRecord.memoryId), "active");
	});

	it("excludes superseded records from the default listing but keeps them reachable on request", () => {
		const oldRecord = store.publish(input({ operationId: "op-old" }));
		clock += 1000;
		const newRecord = store.publish(input({ contentId: bodyId("新证据"), operationId: "op-new" }));
		store.supersede({ host: "planner", newId: newRecord.memoryId, oldId: oldRecord.memoryId, reason: "source-changed" });
		assert.deepEqual(
			store.list().map((record) => record.memoryId),
			[newRecord.memoryId],
		);
		const historical = store.list({ includeSuperseded: true });
		assert.equal(historical.length, 2);
		assert.equal(historical.find((record) => record.memoryId === oldRecord.memoryId)?.recordStatus, "superseded");
	});

	it("marks a fork as conflict instead of picking a winner by clock", () => {
		const oldRecord = store.publish(input({ operationId: "op-old" }));
		clock += 1000;
		const branchA = store.publish(input({ contentId: bodyId("分支 A"), operationId: "op-a" }));
		clock += 1000;
		const branchB = store.publish(input({ contentId: bodyId("分支 B"), operationId: "op-b" }));
		store.supersede({ host: "agent-a", newId: branchA.memoryId, oldId: oldRecord.memoryId, reason: "source-changed" });
		store.supersede({ host: "agent-b", newId: branchB.memoryId, oldId: oldRecord.memoryId, reason: "source-changed" });
		assert.equal(store.status(oldRecord.memoryId), "conflict");
		// Both successors survive; neither is declared the truth.
		const active = store.list().map((record) => record.memoryId);
		assert.ok(active.includes(branchA.memoryId));
		assert.ok(active.includes(branchB.memoryId));
	});

	it("refuses to supersede with a record that does not exist", () => {
		const oldRecord = store.publish(input());
		assert.throws(
			() => store.supersede({ host: "planner", newId: "f".repeat(64), oldId: oldRecord.memoryId, reason: "source-changed" }),
			/unknown-memory/,
		);
	});

	it("is idempotent for the same supersession event", () => {
		const oldRecord = store.publish(input({ operationId: "op-old" }));
		clock += 1000;
		const newRecord = store.publish(input({ contentId: bodyId("新证据"), operationId: "op-new" }));
		const args = { host: "planner", newId: newRecord.memoryId, oldId: oldRecord.memoryId, reason: "source-changed" as const };
		const first = store.supersede(args);
		const second = store.supersede(args);
		assert.equal(first.eventId, second.eventId);
		assert.equal(store.status(oldRecord.memoryId), "superseded");
	});
});
