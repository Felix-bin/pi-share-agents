import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { negotiate } from "../../src/synapse/capability.ts";
import { capabilityForAgent, consumesState, hostCapability, isSynapseRole, SYNAPSE_ROLES } from "../../src/synapse/roles.ts";

/**
 * The roles exist so negotiation can answer "what can this peer do" before the
 * peer is launched. These tests pin the two answers that matter: an unknown
 * agent is not guessed at, and a role that lists an encoding is still not a
 * peer that can consume one.
 */

const REPRESENTATION = "siliconflow/BAAI-bge-m3/1024";

function capability(agent: string, childTools: readonly string[] = []) {
	return capabilityForAgent({ agent, childTools, representationId: REPRESENTATION });
}

describe("synapse roles", () => {
	it("declares the four collaboration roles the task statement names", () => {
		assert.deepEqual([...SYNAPSE_ROLES], ["planner", "retriever", "executor", "summarizer"]);
		for (const role of SYNAPSE_ROLES) assert.ok(isSynapseRole(role), `${role} must be recognised as a role`);
		assert.equal(isSynapseRole("scout"), false);
	});

	it("gives every role an action, and identifies the capability rather than the peer", () => {
		for (const role of SYNAPSE_ROLES) {
			assert.ok(capability(role).declaration.actions.length > 0, `${role} must declare an action`);
		}
		// The id is over what a peer can do, so a role that serves retrieval or
		// speaks a different set of encodings is a different capability...
		assert.notEqual(capability("retriever").capabilityId, capability("executor").capabilityId);
		assert.notEqual(capability("planner").capabilityId, capability("executor").capabilityId);
		// ...while two roles that declare exactly the same thing share one record
		// on purpose: the capability is not a name.
		assert.equal(capability("executor").capabilityId, capability("summarizer").capabilityId);
	});

	it("treats an agent it does not know as a plain text delegate rather than guessing", () => {
		const unknown = capability("scout");
		assert.deepEqual([...unknown.declaration.actions], ["delegate"]);
		assert.deepEqual([...unknown.declaration.encodings], ["text"]);
		assert.equal(unknown.declaration.consumesState, false);
	});

	it("derives state consumption from the granted tools, not from the role's claims", () => {
		assert.equal(consumesState(["read", "grep", "bash"]), false);
		assert.equal(consumesState(["read", "synapse_read"]), true);
		assert.equal(capability("retriever", ["read", "synapse_read"]).declaration.consumesState, true);
		// A child without the memory tools keeps consuming nothing, and the host
		// still cannot be the peer that makes a vector path appear.
		assert.equal(capability("retriever", ["read"]).declaration.consumesState, false);
		assert.equal(hostCapability(REPRESENTATION).declaration.consumesState, false);
	});

	it("selects the state path when every negotiation condition holds (P3-4)", () => {
		const receiver = capability("retriever", ["read", "synapse_read"]).declaration;
		const sender = { ...receiver, agent: "parent" };
		const result = negotiate({
			action: "retrieve",
			allowTextFallback: true,
			mode: "synapse",
			receiver,
			receiverMayRead: true,
			sender,
		});
		assert.deepEqual(result, { capabilityId: capability("retriever", ["read", "synapse_read"]).capabilityId, encoding: "float32-vector", outcome: "state" });
	});

	it("falls back to text with a named reason when the receiver holds no consuming tool (AC-05 unit form)", () => {
		const receiver = capability("retriever", ["read"]).declaration;
		const sender = { ...receiver, agent: "parent" };
		const result = negotiate({
			action: "retrieve",
			allowTextFallback: true,
			mode: "synapse",
			receiver,
			receiverMayRead: true,
			sender,
		});
		assert.deepEqual(result, { capabilityId: capability("retriever", ["read"]).capabilityId, outcome: "text", reason: "receiver-cannot-consume-state" });
	});

	it("separates the representation: the same role under two representations is two capabilities", () => {
		const other = capabilityForAgent({ agent: "retriever", childTools: [], representationId: "unavailable" });
		assert.notEqual(capability("retriever").capabilityId, other.capabilityId);
	});

	it("falls back to text for a stated reason instead of reporting a vector path", () => {
		const result = negotiate({
			action: "retrieve",
			allowTextFallback: true,
			mode: "synapse",
			receiver: capability("retriever").declaration,
			receiverMayRead: true,
			sender: hostCapability(REPRESENTATION).declaration,
		});
		// The host declares text only, so the pair never reaches the consumption
		// check: the recorded reason must name the encoding, not the consumer.
		assert.deepEqual(result, { capabilityId: capability("retriever").capabilityId, outcome: "text", reason: "no-common-encoding" });
	});

	it("refuses an action the receiving role does not serve", () => {
		const result = negotiate({
			action: "retrieve",
			allowTextFallback: true,
			mode: "synapse",
			receiver: capability("planner").declaration,
			receiverMayRead: true,
			sender: hostCapability(REPRESENTATION).declaration,
		});
		// Text would be a different task, not a degraded version of this one.
		assert.deepEqual(result, { outcome: "refused", reason: "action-unsupported" });
	});

	it("accepts a delegated task for every role, as text", () => {
		for (const role of SYNAPSE_ROLES) {
			const result = negotiate({
				action: "delegate",
				allowTextFallback: true,
				mode: "synapse",
				receiver: capability(role).declaration,
				receiverMayRead: true,
				sender: hostCapability(REPRESENTATION).declaration,
			});
			assert.equal(result.outcome, "text", `${role} must accept a delegated task`);
		}
	});
});
