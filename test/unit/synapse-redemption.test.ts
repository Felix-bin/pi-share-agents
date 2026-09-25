import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { meteringLogPath, openDelegation, type DelegationIdentity } from "../../src/synapse/delegation.ts";
import { MEMORY_SECTION_HEADER } from "../../src/synapse/handoff.ts";
import { resolveLaunchContract, type LaunchContract } from "../../src/synapse/lifecycle.ts";
import { createMemoryService, type MemoryService } from "../../src/synapse/memory-service.ts";
import { createMeteringLog, type MeteringLog } from "../../src/synapse/metering.ts";
import { deriveNamespaceId } from "../../src/synapse/namespace.ts";
import { redeemMemoryRefs } from "../../src/synapse/redemption.ts";
import { capabilityForAgent } from "../../src/synapse/roles.ts";
import type { SynapseMode } from "../../src/synapse/config.ts";
import type { ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import registerSubagentPromptRuntime from "../../src/runs/shared/subagent-prompt-runtime.ts";

/**
 * Handle redemption: the receiving half of design §4.2.
 *
 * The point of the exchange is that the parent stops sending bodies and the
 * child reads them itself. Two things therefore have to be true at once, and
 * each of them is a way the feature can be silently useless: the parent's
 * prompt must lose the section, and the child's must gain it. A test that
 * checks only the first passes for an implementation that delivers nothing.
 *
 * The scope refusals are exercised against a real `MemoryService` rather than a
 * stub reader, because the claim being made is that redemption inherits the
 * child's own authorisation — a claim a fake reader would let pass while the
 * production path bypassed it entirely.
 */

const AGENT = "retriever";
const CHILD_TOOLS = ["read", "grep"] as const;
const CHILD_INDEX = 0;
const RUN_ID = "r1";
const BODY = "the login path checks the session cookie first";

let root = "";
let store = "";
let worktree = "";

function contractFor(mode: SynapseMode, pathPrefixes: string[] = [""]): LaunchContract {
	return resolveLaunchContract({
		capabilityId: capabilityForAgent({ agent: AGENT, childTools: [...CHILD_TOOLS], representationId: "unavailable" }).capabilityId,
		corpusSnapshotId: "unset",
		deliveryGear: "file",
		memoryRefs: [],
		mode,
		namespaceId: deriveNamespaceId(worktree),
		representationId: "unavailable",
		scope: { pathPrefixes, write: true },
		storageRoot: store,
	});
}

function identity(): DelegationIdentity {
	return {
		agent: AGENT,
		attempt: 1,
		childIndex: CHILD_INDEX,
		childTools: [...CHILD_TOOLS],
		receiverSessionId: "sess-child",
		requestId: "req-redeem-1",
		runId: RUN_ID,
		senderSessionId: "sess-parent",
	};
}

function serviceWithin(pathPrefixes: string[]): MemoryService {
	return createMemoryService({
		provenance: { agent: AGENT, attempt: 1, runId: RUN_ID, sessionId: "sess-child" },
		scope: { agent: AGENT, namespaceId: deriveNamespaceId(worktree), pathPrefixes, write: true },
		storeRoot: store,
		worktreeRoot: worktree,
	});
}

async function seedMemory(summary: string, content: string, sourcePath: string | undefined): Promise<string> {
	return (await serviceWithin([""]).remember({
		content,
		kind: "evidence",
		operationId: `seed/${summary}`,
		...(sourcePath === undefined ? {} : { sourcePath }),
		summary,
		tags: ["auth"],
		topic: "auth flow",
	})).record.memoryId;
}

function createLog(contract: LaunchContract): MeteringLog {
	return createMeteringLog(meteringLogPath(contract, RUN_ID));
}

type Handlers = Map<string, (payload?: unknown) => unknown>;

/**
 * Registers the child runtime with its memory tools present, which redemption
 * needs: reading goes through the very service those tools dispatch to.
 */
function registerChild(contract: LaunchContract, budgetBytes = 8192): Handlers {
	const handlers: Handlers = new Map();
	const config: ChildRuntimeConfig = {
		childIndex: CHILD_INDEX,
		depth: 1,
		fanoutChild: false,
		fast: false,
		synapse: { agent: AGENT, contextBudgetBytes: budgetBytes, contract, runId: RUN_ID, sessionId: "sess-child" },
		waitTool: { enabled: false },
	};
	registerSubagentPromptRuntime(
		{
			on(event: string, handler: (payload?: unknown) => unknown) {
				handlers.set(event, handler);
			},
			getAllTools: () => [],
			registerTool: () => {},
		} as never,
		config,
		undefined,
		{},
	);
	return handlers;
}

function openFor(contract: LaunchContract, message = "Task: explain the auth flow") {
	return openDelegation({
		budgetBytes: 8192,
		contract,
		deps: { log: createLog(contract), service: serviceWithin([...contract.scope.pathPrefixes]), udsClient: { send: async () => 0 } },
		identity: identity(),
		message,
		worktreeRoot: worktree,
	});
}

/** Runs the child's `before_agent_start`, which is where redemption reaches the prompt. */
async function systemPromptAfterStart(handlers: Handlers, systemPrompt: string): Promise<string> {
	const result = await handlers.get("before_agent_start")?.({ systemPrompt });
	if (result === undefined || result === null) return systemPrompt;
	const rewritten = (result as { systemPrompt?: string }).systemPrompt;
	return rewritten ?? systemPrompt;
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-redeem-"));
	store = path.join(root, "store");
	worktree = path.join(root, "worktree");
	fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
	fs.writeFileSync(path.join(worktree, "src", "auth.ts"), "export const login = 1;\n", "utf-8");
});

afterEach(() => {
	fs.rmSync(root, { force: true, recursive: true });
});

describe("the parent stops sending bodies, the child starts reading them", () => {
	it("moves the recalled body out of the parent's prompt and into the child's", async () => {
		const memoryId = await seedMemory("login is verified in src/auth.ts", BODY, "src/auth.ts");
		const contract = contractFor("synapse");
		const delegation = openFor(contract);
		assert.ok(delegation);

		// The sending half: nothing but the task.
		assert.equal(delegation.prompt, "Task: explain the auth flow");
		assert.doesNotMatch(delegation.prompt, /session cookie/);
		assert.doesNotMatch(delegation.prompt, /login is verified/);
		assert.deepEqual(delegation.envelope.memoryRefs, [memoryId], "the handle travels instead");

		// The receiving half: the body appears without the model asking for it.
		const handlers = registerChild(contract);
		const prompt = await systemPromptAfterStart(handlers, "SYSTEM");
		assert.match(prompt, new RegExp(BODY));
		assert.ok(prompt.includes(MEMORY_SECTION_HEADER), "the section is framed the same way both gears frame it");
		assert.ok(prompt.startsWith("SYSTEM"), "redemption appends; it never rewrites what was already there");
		assert.ok(prompt.includes(memoryId.slice(0, 12)), "the handle is echoed so a reader can tell which record spoke");
	});

	it("redeems once, however many turns the child takes", async () => {
		await seedMemory("login is verified in src/auth.ts", BODY, "src/auth.ts");
		const contract = contractFor("synapse");
		assert.ok(openFor(contract));
		const handlers = registerChild(contract);

		const first = await systemPromptAfterStart(handlers, "SYSTEM");
		const second = await systemPromptAfterStart(handlers, "SYSTEM");
		assert.equal(second, first, "a second turn must not pay to read the bodies again, nor stack a second section");
		assert.equal(first.split(MEMORY_SECTION_HEADER).length - 1, 1);
	});

	it("leaves the text baseline exactly where it was: bodies in the prompt, nothing redeemed", async () => {
		await seedMemory("login is verified in src/auth.ts", BODY, "src/auth.ts");
		const contract = contractFor("text");
		const delegation = openFor(contract);
		assert.ok(delegation);

		// The control condition must not be touched by this change, or the A/B it
		// exists for compares two things that both moved.
		assert.match(delegation.prompt, new RegExp(BODY));
		assert.ok(delegation.prompt.includes(MEMORY_SECTION_HEADER));
		assert.equal(delegation.handoff.carriedBodies, true);

		const handlers = registerChild(contract);
		const prompt = await systemPromptAfterStart(handlers, "SYSTEM");
		assert.equal(prompt, "SYSTEM", "the text gear's child redeems nothing: it would double the section and the bytes");
	});

	it("survives a store that lost its objects, on the path a real child takes", async () => {
		await seedMemory("login is verified in src/auth.ts", BODY, "src/auth.ts");
		const contract = contractFor("synapse");
		const delegation = openFor(contract);
		assert.ok(delegation);
		assert.equal(delegation.envelope.memoryRefs.length, 1);

		// A reboot between the parent's recall and the child's redemption: tmpfs is
		// gone, the index on disk is not. Design §4.4 accepts this outcome; what it
		// must not do is stop the child running the task it was given.
		fs.rmSync(path.join(store, "objects"), { force: true, recursive: true });

		const handlers = registerChild(contract);
		const prompt = await systemPromptAfterStart(handlers, "SYSTEM");
		assert.equal(prompt, "SYSTEM", "no body, no section — and no throw");
	});

	it("runs the task unchanged when no envelope arrived at all", async () => {
		await seedMemory("login is verified in src/auth.ts", BODY, "src/auth.ts");
		const contract = contractFor("synapse");
		// No delegation opened, so no envelope was ever published. An absent
		// envelope has always meant "run upstream's own task", and redemption must
		// not turn it into a failure.
		const handlers = registerChild(contract);
		const prompt = await systemPromptAfterStart(handlers, "SYSTEM");
		assert.equal(prompt, "SYSTEM");
	});
});

describe("a refusal to redeem names which fact it is", () => {
	it("classifies a handle outside the child's scope as a permission refusal, not a missing object", async () => {
		const memoryId = await seedMemory("login is verified in src/auth.ts", BODY, "src/auth.ts");
		// The child's own service, scoped to somewhere the record is not. This is
		// the projection the design leans on: redemption reads through the service
		// the child registered, so `isReadable` is asking about the child.
		const narrow = serviceWithin(["docs"]);
		const result = redeemMemoryRefs({
			budgetBytes: 8192,
			memoryRefs: [memoryId],
			readBody: (id) => narrow.get({ memoryId: id }).text,
		});
		assert.equal(result.section, "");
		assert.deepEqual(result.redeemed, []);
		assert.equal(result.refusals.length, 1);
		assert.equal(result.refusals[0]?.category, "permission");
		assert.notEqual(result.refusals[0]?.category, "object-unavailable");
	});

	it("classifies a body whose object is gone as object-unavailable, and keeps running", async () => {
		const memoryId = await seedMemory("login is verified in src/auth.ts", BODY, undefined);
		const wide = serviceWithin([""]);
		assert.equal(wide.get({ memoryId }).text, BODY, "readable before the store loses the object");

		// What a reboot does to a tmpfs store: the index survives on disk, every
		// object under it does not. Design §4.4 calls this the accepted behaviour
		// of the shared-memory gear, not a defect to repair.
		fs.rmSync(path.join(store, "objects"), { force: true, recursive: true });

		const result = redeemMemoryRefs({
			budgetBytes: 8192,
			memoryRefs: [memoryId],
			readBody: (id) => serviceWithin([""]).get({ memoryId: id }).text,
		});
		assert.equal(result.refusals.length, 1);
		assert.equal(result.refusals[0]?.category, "object-unavailable");
		assert.equal(result.section, "");
	});

	it("keeps the bodies it could read when only some handles refuse", async () => {
		const readable = await seedMemory("readable", "the readable body", undefined);
		const result = redeemMemoryRefs({
			budgetBytes: 8192,
			memoryRefs: [readable, "0".repeat(64)],
			readBody: (id) => serviceWithin([""]).get({ memoryId: id }).text,
		});
		assert.deepEqual(result.redeemed.map((entry) => entry.memoryId), [readable]);
		assert.equal(result.refusals[0]?.category, "object-unavailable");
		assert.match(result.section, /the readable body/);
	});
});

describe("redemption arithmetic", () => {
	it("drops whole entries rather than half a body when the budget runs out", () => {
		const result = redeemMemoryRefs({
			budgetBytes: 40,
			memoryRefs: ["a".repeat(64), "b".repeat(64)],
			readBody: (id) => `${id.slice(0, 1)}`.repeat(30),
		});
		// Either entry alone is ~50 bytes, so neither fits; a truncated body would
		// read as though the record said less than it does.
		assert.deepEqual(result.redeemed, []);
		assert.equal(result.omitted, 2);
		assert.equal(result.section, "");
	});

	it("charges a repeated handle once and prints it once", () => {
		const id = "a".repeat(64);
		const result = redeemMemoryRefs({ budgetBytes: 8192, memoryRefs: [id, id], readBody: () => "body" });
		assert.equal(result.redeemed.length, 1);
		assert.equal(result.section.split("body").length - 1, 1);
	});

	it("produces no section at all when there was nothing to redeem", () => {
		const result = redeemMemoryRefs({ budgetBytes: 8192, memoryRefs: [], readBody: () => "unreachable" });
		assert.equal(result.section, "");
		assert.equal(result.bytes, 0);
		assert.deepEqual(result.refusals, []);
	});

	it("previews a long body and names the handle that reads the rest", () => {
		const id = "c".repeat(64);
		const body = "证据".repeat(200);
		const result = redeemMemoryRefs({ budgetBytes: 8192, memoryRefs: [id], readBody: () => body });
		const entry = result.section.split("\n").slice(1).join("\n");
		assert.ok(entry.startsWith(`- [${"c".repeat(12)}] (${Buffer.byteLength(body)} B; full: synapse_read {"action":"get","memoryId":"${id}"})\n  `));
		assert.ok(entry.endsWith("…"));
		assert.ok(!entry.includes("\uFFFD"), "the preview never splits a character");
		assert.ok(result.bytes < 600, "a preview, not the body");
	});

	it("carries a short body whole", () => {
		const result = redeemMemoryRefs({ budgetBytes: 8192, memoryRefs: ["d".repeat(64)], readBody: () => "short body" });
		assert.match(result.section, /- \[d{12}\]\n {2}short body$/);
	});

	it("counts the bytes of the entries, not of the header it prepends", () => {
		const result = redeemMemoryRefs({ budgetBytes: 8192, memoryRefs: ["a".repeat(64)], readBody: () => "body" });
		assert.equal(result.bytes, Buffer.byteLength(`- [${"a".repeat(12)}]\n  body`, "utf-8"));
		assert.ok(result.section.length > result.bytes, "the header is framing, and is not charged to the budget");
	});
});
