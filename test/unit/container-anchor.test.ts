import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	classifyAgentContainerStart,
	resolveAnchorGate,
	resolveAnchorTeardown,
} from "../../src/runs/shared/container-anchor.ts";

describe("anchor gate", () => {
	it("lets an agent container launch once the anchor is running", () => {
		const gate = resolveAnchorGate({ anchor: { phase: "running", containerId: "anchor-7" } });

		assert.equal(gate.decision, "launch");
		assert.equal(gate.decision === "launch" && gate.anchorContainerId, "anchor-7");
	});

	it("waits while the anchor is still coming up", () => {
		assert.equal(resolveAnchorGate({ anchor: { phase: "starting" } }).decision, "wait");
	});

	it("waits when the anchor has not been created yet", () => {
		assert.equal(resolveAnchorGate({ anchor: { phase: "absent" } }).decision, "wait");
	});

	it("refuses the agent when the anchor failed, rather than letting it hold its own IPC namespace", () => {
		const gate = resolveAnchorGate({ anchor: { phase: "failed", reason: "image pull failed" } });

		assert.equal(gate.decision, "refuse");
		assert.match(gate.decision === "refuse" ? gate.reason : "", /image pull failed/);
	});

	it("refuses to join an anchor that is shutting down", () => {
		const gate = resolveAnchorGate({ anchor: { phase: "stopping" } });

		assert.equal(gate.decision, "refuse");
		assert.match(gate.decision === "refuse" ? gate.reason : "", /shutting down|stopping/i);
	});

	it("never answers launch without an anchor id to join", () => {
		const phases = [
			{ phase: "absent" as const },
			{ phase: "starting" as const },
			{ phase: "failed" as const, reason: "x" },
			{ phase: "stopping" as const },
			{ phase: "running" as const, containerId: "anchor-1" },
		];
		for (const anchor of phases) {
			const gate = resolveAnchorGate({ anchor });
			if (gate.decision === "launch") assert.ok(gate.anchorContainerId.length > 0);
		}
	});
});

describe("anchor teardown", () => {
	it("holds the anchor while any agent container is still alive", () => {
		const teardown = resolveAnchorTeardown({ activeAgentContainers: 1 });

		assert.equal(teardown.decision, "hold");
		assert.match(teardown.reason, /1/);
	});

	it("destroys the anchor only after the last agent container is gone", () => {
		assert.equal(resolveAnchorTeardown({ activeAgentContainers: 0 }).decision, "destroy");
	});

	it("treats a negative count as a bug rather than as permission to destroy", () => {
		const teardown = resolveAnchorTeardown({ activeAgentContainers: -1 });

		assert.equal(teardown.decision, "hold");
	});
});

describe("agent container start classification", () => {
	it("refuses the agent when it could not join the shared IPC namespace", () => {
		const outcome = classifyAgentContainerStart({
			exitCode: 125,
			stderr: "Error: failed to join IPC namespace of container anchor-7: no such container",
		});

		assert.equal(outcome.outcome, "refuse-agent");
		assert.match(outcome.reason, /IPC namespace/i);
	});

	it("never degrades an IPC join failure into an isolated container", () => {
		const outcome = classifyAgentContainerStart({ exitCode: 125, stderr: "cannot join ipc namespace" });

		assert.notEqual(outcome.outcome, "degrade-to-process");
		assert.notEqual(outcome.outcome, "started");
	});

	it("reports a clean start as started", () => {
		assert.equal(classifyAgentContainerStart({ exitCode: 0, stderr: "" }).outcome, "started");
	});

	it("keeps an unrelated start failure distinguishable from an IPC join failure", () => {
		const outcome = classifyAgentContainerStart({ exitCode: 127, stderr: "isula: command not found" });

		assert.equal(outcome.outcome, "refuse-agent");
		assert.doesNotMatch(outcome.reason, /IPC namespace/i);
		assert.match(outcome.reason, /command not found/);
	});
});
