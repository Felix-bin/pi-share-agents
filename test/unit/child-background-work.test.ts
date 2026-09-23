import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInProcessChildLaunch, childCanHaveBackgroundWork } from "../../src/runs/shared/child-launch.ts";
import type { BuildInProcessChildLaunchInput } from "../../src/runs/shared/child-launch.ts";

/**
 * A retrieval-style child (no subagent tool, no extensions, no fanout budget)
 * can never hold background work, so its launch leaves bg_wait off and the
 * child-side registration skips the tool entirely (~4.4 KB per request saved).
 * The matrix pins the default; the configured waitToolEnabled is the ceiling
 * over it, and the construction-site tests below pin that composition.
 */
const base: BuildInProcessChildLaunchInput = {
	sessionEnabled: false,
	inheritProjectContext: true,
	inheritGlobalContext: false,
	inheritSkills: false,
	cwd: "D:/tmp/worktree",
	childAgentName: "retriever",
	childIndex: 0,
	host: "runner",
};

describe("childCanHaveBackgroundWork", () => {
	it("is false for a retrieval-style child that names its tools", () => {
		assert.equal(childCanHaveBackgroundWork({ ...base, tools: ["read", "grep", "find", "ls", "write", "contact_supervisor"] }), false);
	});

	it("is true when the subagent tool is in the named tool list", () => {
		assert.equal(childCanHaveBackgroundWork({ ...base, tools: ["read", "grep", "subagent"] }), true);
	});

	it("is true when the tool list is unspecified (ambient set includes subagent)", () => {
		assert.equal(childCanHaveBackgroundWork({ ...base }), true);
	});

	it("is true when any extension could register provider work", () => {
		assert.equal(childCanHaveBackgroundWork({ ...base, tools: ["read"], extensions: ["some-provider"] }), true);
		assert.equal(childCanHaveBackgroundWork({ ...base, tools: ["read"], subagentOnlyExtensions: ["some-provider"] }), true);
	});

	it("is true when a fanout budget is attached (inherited counts too)", () => {
		assert.equal(childCanHaveBackgroundWork({ ...base, tools: ["read"], runFanoutBudget: { maxFanout: 2 } as BuildInProcessChildLaunchInput["runFanoutBudget"] }), true);
		assert.equal(childCanHaveBackgroundWork({ ...base, tools: ["read"], inherited: { runFanoutBudget: { maxFanout: 2 } } as BuildInProcessChildLaunchInput["inherited"] }), true);
	});
});

describe("the launch's waitTool setting", () => {
	const enabledFor = (input: Partial<BuildInProcessChildLaunchInput>) => buildInProcessChildLaunch({ ...base, ...input }).config.waitTool.enabled;

	it("leaves bg_wait off for a retrieval-style child even when configuration resolved it on", () => {
		// Every production caller passes a resolved boolean; if it won outright the
		// heuristic above would never run and the saving would never happen.
		assert.equal(enabledFor({ tools: ["read", "grep"], waitToolEnabled: true }), false);
	});

	it("keeps bg_wait for a child whose tool list names it", () => {
		assert.equal(childCanHaveBackgroundWork({ ...base, tools: ["read", "bg_wait"] }), true);
		assert.equal(enabledFor({ tools: ["read", "bg_wait"], waitToolEnabled: true }), true);
	});

	it("never turns bg_wait on where configuration turned it off", () => {
		assert.equal(enabledFor({ tools: ["read", "subagent"], waitToolEnabled: false }), false);
	});

	it("defaults to on for a child that can hold background work when nothing is configured", () => {
		assert.equal(enabledFor({ tools: ["read", "subagent"] }), true);
	});
});
