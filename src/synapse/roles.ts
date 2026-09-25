import { describeCapability, type CapabilityDeclaration, type CapabilityRecord, type SynapseAction, type SynapseEncoding } from "./capability.ts";
import { STATE_RETRIEVAL_PROBE } from "./capability-probe.ts";
import type { MemoryKind } from "./memory-store.ts";

/**
 * The collaboration roles and the capability each one declares.
 *
 * The four roles are the ones the task statement names — planning, retrieval,
 * execution and summarisation — and they exist here rather than only as prompt
 * files because negotiation needs to know what a peer can do before the peer is
 * launched. An agent file describes behaviour to a model; this describes the
 * same agent to the protocol.
 *
 * Two properties are deliberately not read from the agent file. `consumesState`
 * is derived from the tools the child was actually granted, because a role that
 * merely claims to understand vectors would make negotiation report a state path
 * that cannot exist. And an agent this module does not know is given the plain
 * text delegate declaration rather than a guessed one: an unknown peer is a peer
 * whose capabilities we have not established.
 */

export const SYNAPSE_ROLES = ["planner", "retriever", "executor", "summarizer"] as const;

export type SynapseRole = (typeof SYNAPSE_ROLES)[number];

/**
 * Bumped when the meaning of a declaration changes rather than its contents.
 * It enters the capability id, so two peers running different versions never
 * share one record.
 */
export const SYNAPSE_CONSUMER_VERSION = 1;

/**
 * Tools whose presence means the child session can consume a decoded state.
 * `synapse_read` is the one: the SYNAPSE extension that registers it also
 * carries the state-retrieval path (stateId → verified payload → corpus
 * cosine) the host drives on the child's behalf when a delegated retrieve
 * arrives carrying a stateRef — the model itself never handles raw vectors.
 * Staying derived from the granted tools, rather than read from the agent
 * file, keeps a role that merely claims to understand vectors from making
 * negotiation report a state path that cannot exist.
 */
export const SYNAPSE_STATE_CONSUMING_TOOLS: readonly string[] = ["synapse_read"];

type RoleSpec = {
	actions: readonly SynapseAction[];
	/** Encodings the role would accept if a channel for them existed. */
	encodings: readonly SynapseEncoding[];
};

/**
 * `delegate` is "can be given a task"; `retrieve` is "can serve a request for
 * evidence", which is the only action a state payload can ride on. Planner and
 * executor are therefore delegate-only: neither answers retrieval requests.
 */
const ROLE_SPECS = {
	executor: { actions: ["delegate"], encodings: ["text", "float32-vector"] },
	planner: { actions: ["delegate"], encodings: ["text"] },
	retriever: { actions: ["delegate", "retrieve"], encodings: ["text", "float32-vector"] },
	summarizer: { actions: ["delegate"], encodings: ["text", "float32-vector"] },
} satisfies Record<SynapseRole, RoleSpec>;

/**
 * The memory kind a role's whole stage output is filed under when it is
 * published as a stage result: what the stage produced, in the vocabulary the
 * store already has. The summarizer has none because its output is the
 * deliverable, returned in full rather than as a result block.
 */
const STAGE_OUTPUT_KINDS = {
	executor: "tool-result",
	planner: "strategy",
	retriever: "evidence",
} as const satisfies Partial<Record<SynapseRole, MemoryKind>>;

export type StageRole = keyof typeof STAGE_OUTPUT_KINDS;

/** The memory kind of a pipeline stage whose output travels as a result block, or null for every other agent. */
export function stageOutputKind(agent: string): MemoryKind | null {
	return Object.hasOwn(STAGE_OUTPUT_KINDS, agent) ? STAGE_OUTPUT_KINDS[agent as StageRole] : null;
}

/** The declaration used for any agent outside the four roles, including upstream's. */
const GENERIC_SPEC: RoleSpec = { actions: ["delegate"], encodings: ["text"] };

export function isSynapseRole(agent: string): agent is SynapseRole {
	return SYNAPSE_ROLES.some((role) => role === agent);
}

/** True when the granted tools include one that decodes a state payload. */
export function consumesState(childTools: readonly string[]): boolean {
	return childTools.some((tool) => SYNAPSE_STATE_CONSUMING_TOOLS.includes(tool));
}

export type CapabilityForAgentInput = {
	agent: string;
	childTools: readonly string[];
	representationId: string;
};

export function capabilityForAgent(input: CapabilityForAgentInput): CapabilityRecord {
	const spec = isSynapseRole(input.agent) ? ROLE_SPECS[input.agent] : GENERIC_SPEC;
	const consumes = consumesState(input.childTools);
	// A role that claims the state path claims the verifiable promise behind it:
	// its embedder can be constructed and the pinned corpus loads. The promise is
	// strict — without a probe verdict the negotiation takes text — so the one
	// production seam always wires the probe.
	const probeField = consumes && spec.encodings.includes("float32-vector") ? { probe: [STATE_RETRIEVAL_PROBE] } : {};
	const declaration: CapabilityDeclaration = {
		actions: spec.actions,
		agent: input.agent,
		consumesState: consumes,
		consumerVersion: SYNAPSE_CONSUMER_VERSION,
		encodings: spec.encodings,
		...probeField,
		representationId: input.representationId,
	};
	return describeCapability(declaration);
}

/**
 * The parent session's own declaration. It delegates and it can answer a
 * retrieval request out of shared memory, but it holds no state-decoding tool
 * either, so it cannot be the peer that makes a vector path appear.
 */
export function hostCapability(representationId: string): CapabilityRecord {
	return describeCapability({
		actions: ["delegate", "retrieve"],
		agent: "parent",
		consumesState: false,
		consumerVersion: SYNAPSE_CONSUMER_VERSION,
		encodings: ["text"],
		representationId,
	});
}
