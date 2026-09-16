import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CanonicalValue } from "../../src/synapse/canonical-json.ts";
import { resolveSynapseConfig, type UnvalidatedJson } from "../../src/synapse/config.ts";
import {
	registerSynapseTools,
	SYNAPSE_READ_TOOL,
	SYNAPSE_WRITE_TOOL,
	type SynapseReadInput,
	type SynapseToolContext,
	type SynapseToolHost,
	type SynapseToolsRegistration,
	type SynapseWriteInput,
} from "../../src/synapse/register-tools.ts";

/**
 * Drives AC-06/07/12/13 through the registered tools the way a model reaches
 * them: one agent writes, another agent's session finds and reads, an edit to
 * the source retires the record, and an unauthorised caller sees nothing.
 */

type Details = Record<string, CanonicalValue>;

let home = "";
let agentDir = "";
let worktree = "";
let registeredNames: string[] = [];
let active: SynapseToolsRegistration = { registered: false };
let operations = 0;

const recordingHost: SynapseToolHost = {
	registerTool: (tool) => {
		registeredNames.push(tool.name);
	},
};

function detailsOf(result: AgentToolResult<CanonicalValue>): Details {
	// SAFETY: every SYNAPSE tool returns a JSON object as its details.
	return result.details as Details;
}

async function read(params: SynapseReadInput): Promise<Details> {
	assert.ok(active.registered, "synapse tools are not registered");
	return detailsOf(await active.read(params));
}

async function write(params: SynapseWriteInput): Promise<Details> {
	assert.ok(active.registered, "synapse tools are not registered");
	return detailsOf(await active.write(params));
}

function hitsOf(result: Details): Details[] {
	const results = result.results;
	assert.ok(Array.isArray(results), "search must return a results array");
	// SAFETY: the array checked above holds the hit objects search builds.
	return results as Details[];
}

function register(config: UnvalidatedJson, context: Partial<SynapseToolContext> = {}): void {
	registeredNames = [];
	active = registerSynapseTools(recordingHost, {
		config: resolveSynapseConfig(config, home),
		agentDir: agentDir,
		nextOperationId: () => `op-${(operations += 1)}`,
		resolveContext: () => ({
			provenance: context.provenance ?? { agent: "retriever", attempt: 1, runId: "run-1", sessionId: "sess-1" },
			scope: context.scope ?? { agent: "retriever", pathPrefixes: [""], write: true },
			worktreeRoot: worktree,
		}),
	});
}

function writeSource(relPath: string, text: string): void {
	const target = path.join(worktree, relPath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, text);
}

function memoryIdOf(written: Details): string {
	const memoryId = String(written.memoryId);
	assert.match(memoryId, /^[0-9a-f]{64}$/, "a write must return a memory id");
	return memoryId;
}

function namespaceDir(): string {
	const root = path.join(agentDir, "synapse");
	const entries = fs.readdirSync(root);
	assert.equal(entries.length, 1, "expected exactly one namespace");
	return path.join(root, entries[0] ?? "");
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-int-home-"));
	agentDir = path.join(home, ".pi", "agent");
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-int-wt-"));
	operations = 0;
	registeredNames = [];
	active = { registered: false };
});

afterEach(() => {
	fs.rmSync(home, { force: true, recursive: true });
	fs.rmSync(worktree, { force: true, recursive: true });
});

describe("synapse tool registration", () => {
	it("registers nothing and creates no store while the extension is off", () => {
		register(undefined);
		assert.deepEqual(registeredNames, []);
		assert.equal(active.registered, false);
		assert.equal(fs.existsSync(path.join(agentDir, "synapse")), false);
	});

	it("registers nothing when the text baseline runs without memory", () => {
		register({ mode: "text" });
		assert.deepEqual(registeredNames, []);
	});

	it("registers both tools in synapse mode", () => {
		register({ mode: "synapse" });
		assert.deepEqual([...registeredNames].sort(), [SYNAPSE_READ_TOOL, SYNAPSE_WRITE_TOOL]);
	});

	it("keeps the store under the namespace of this worktree", async () => {
		register({ mode: "synapse" });
		await write({ action: "remember", content: "x", summary: "观察", topic: "t" });
		const marker = JSON.parse(fs.readFileSync(path.join(namespaceDir(), "namespace.json"), "utf-8"));
		assert.equal(marker.worktreePath, path.resolve(worktree).split(path.sep).join("/"));
	});
});

describe("cross-agent reuse through the tools (AC-06)", () => {
	it("lets a second agent find, rank and read what the first one recorded", async () => {
		writeSource("src/encoder.ts", "export function encode() { return 1; }\n");
		register({ mode: "synapse" });
		const written = await write({
			action: "remember",
			content: "encode() returns a constant and never consults the store",
			kind: "evidence",
			sourcePath: "src/encoder.ts",
			summary: "encoder returns a constant",
			tags: ["encoder"],
			topic: "encoder-audit",
		});
		assert.match(memoryIdOf(written), /^[0-9a-f]{64}$/);
		assert.equal(written.assurance, "observation");

		// A different agent in a different session, sharing only the project store.
		register(
			{ mode: "synapse" },
			{
				provenance: { agent: "executor", attempt: 1, runId: "run-2", sessionId: "sess-2" },
				scope: { agent: "executor", pathPrefixes: [""], write: true },
			},
		);
		const found = await read({ action: "search", query: "encoder constant" });
		const hits = hitsOf(found);
		assert.equal(hits[0]?.memoryId, written.memoryId);
		assert.equal(hits[0]?.sourceAgent, "retriever");
		assert.equal(hits[0]?.validity, "current");
		assert.equal(found.semantic, "unavailable");

		const body = await read({ action: "get", memoryId: memoryIdOf(written) });
		assert.match(String(body.text), /never consults the store/);
	});

	it("survives a restart of the extension", async () => {
		register({ mode: "synapse" });
		const written = await write({ action: "remember", content: "持久化的证据", summary: "持久化观察", topic: "t" });
		register({ mode: "synapse" });
		const body = await read({ action: "get", memoryId: memoryIdOf(written) });
		assert.equal(body.text, "持久化的证据");
	});
});

describe("source invalidation through the tools (AC-07)", () => {
	it("marks a record stale after an uncommitted edit to its source", async () => {
		execFileSync("git", ["init", "--quiet"], { cwd: worktree, stdio: "ignore" });
		writeSource("src/a.ts", "export const a = 1;\n");
		execFileSync("git", ["add", "."], { cwd: worktree, stdio: "ignore" });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "seed"], { cwd: worktree, stdio: "ignore" });

		register({ mode: "synapse" });
		const written = await write({ action: "remember", content: "a is 1", sourcePath: "src/a.ts", summary: "a 的取值观察", topic: "constants" });
		assert.equal(written.validity, "current");

		// Working-tree edit only: HEAD is untouched, so a commit-based check would
		// still call this evidence current.
		writeSource("src/a.ts", "export const a = 2;\n");
		const hits = hitsOf(await read({ action: "search", query: "取值观察" }));
		assert.equal(hits[0]?.validity, "stale");
		const body = await read({ action: "get", memoryId: memoryIdOf(written) });
		assert.equal(body.validity, "stale");
	});

	it("retires the old record when a newer observation supersedes it", async () => {
		writeSource("src/a.ts", "export const a = 1;\n");
		register({ mode: "synapse" });
		const oldRecord = await write({ action: "remember", content: "a is 1", sourcePath: "src/a.ts", summary: "旧的取值观察", topic: "constants" });
		writeSource("src/a.ts", "export const a = 2;\n");
		const newRecord = await write({ action: "remember", content: "a is 2", sourcePath: "src/a.ts", summary: "新的取值观察", topic: "constants" });
		await write({ action: "supersede", newId: memoryIdOf(newRecord), oldId: memoryIdOf(oldRecord), reason: "source-changed" });

		const current = hitsOf(await read({ action: "search", query: "取值观察" }));
		assert.deepEqual(
			current.map((hit) => hit.memoryId),
			[newRecord.memoryId],
		);
		await assert.rejects(read({ action: "get", memoryId: memoryIdOf(oldRecord) }), /historical/);
		const history = await read({ action: "get", allowHistorical: true, memoryId: memoryIdOf(oldRecord) });
		assert.equal(history.historical, true);
	});
});

describe("authorisation through the tools (AC-12)", () => {
	it("hides an unauthorised record from search, including its summary", async () => {
		writeSource("secrets/keys.env", "TOKEN=abcdef\n");
		register({ mode: "synapse" });
		await write({ action: "remember", content: "TOKEN=abcdef", sourcePath: "secrets/keys.env", summary: "凭证文件的机密观察", topic: "secrets" });

		register({ mode: "synapse" }, { scope: { agent: "restricted", pathPrefixes: ["src"], write: true } });
		const found = await read({ action: "search", query: "机密观察" });
		assert.deepEqual(found.results, []);
		assert.equal(JSON.stringify(found).includes("机密"), false);
		assert.equal(JSON.stringify(found).includes("TOKEN"), false);
	});

	it("refuses a write from a read-only role", async () => {
		register({ mode: "synapse" }, { scope: { agent: "reader", pathPrefixes: [""], write: false } });
		await assert.rejects(write({ action: "remember", content: "x", summary: "观察", topic: "t" }), /not-authorised/);
	});

	it("refuses to record a source outside the caller's grant", async () => {
		writeSource("secrets/keys.env", "TOKEN=abcdef\n");
		register({ mode: "synapse" }, { scope: { agent: "restricted", pathPrefixes: ["src"], write: true } });
		await assert.rejects(
			write({ action: "remember", content: "x", sourcePath: "secrets/keys.env", summary: "观察", topic: "t" }),
			/not-authorised/,
		);
	});

	it("refuses a source path that escapes the worktree", async () => {
		register({ mode: "synapse" });
		await assert.rejects(write({ action: "remember", content: "x", sourcePath: "../outside.txt", summary: "观察", topic: "t" }), /outside-root/);
	});
});

describe("storage isolation and integrity (AC-13)", () => {
	it("keeps two experiment sequences in separate stores", async () => {
		const first = path.join(home, "runs", "seq-01");
		const second = path.join(home, "runs", "seq-02");
		register({ mode: "synapse", storageRoot: first });
		const written = await write({ action: "remember", content: "序列一的证据", summary: "序列一观察", topic: "t" });

		register({ mode: "synapse", storageRoot: second });
		assert.deepEqual((await read({ action: "search", query: "序列一观察" })).results, []);
		await assert.rejects(read({ action: "get", memoryId: memoryIdOf(written) }), /unknown-memory/);

		register({ mode: "synapse", storageRoot: first });
		assert.equal((await read({ action: "get", memoryId: memoryIdOf(written) })).text, "序列一的证据");
	});

	it("refuses a store that belongs to another worktree", async () => {
		const shared = path.join(home, "runs", "shared");
		register({ mode: "synapse", storageRoot: shared });
		await write({ action: "remember", content: "x", summary: "观察", topic: "t" });
		const otherWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-int-wt2-"));
		const previous = worktree;
		worktree = otherWorktree;
		try {
			register({ mode: "synapse", storageRoot: shared });
			await assert.rejects(write({ action: "remember", content: "x", summary: "观察", topic: "t" }), /namespace-mismatch/);
		} finally {
			worktree = previous;
			fs.rmSync(otherWorktree, { force: true, recursive: true });
		}
	});

	it("fails loudly when a body is lost instead of resolving to nothing", async () => {
		register({ mode: "synapse" });
		const written = await write({ action: "remember", content: "完整的正文", summary: "观察", topic: "t" });
		const objectsDir = path.join(namespaceDir(), "objects");
		const bodies = fs
			.readdirSync(objectsDir, { recursive: true })
			.map(String)
			.filter((entry) => entry.endsWith(".bin"));
		assert.equal(bodies.length, 1);
		fs.rmSync(path.join(objectsDir, bodies[0] ?? ""));
		await assert.rejects(read({ action: "search", query: "观察" }), /orphan/);
		await assert.rejects(read({ action: "get", memoryId: memoryIdOf(written) }), /object-unavailable/);
	});
});
