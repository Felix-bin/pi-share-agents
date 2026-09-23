import * as os from "node:os";
import { getAgentDir } from "../shared/utils.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { representationIdOf, resolveSynapseConfig, type SynapseDeliveryGear, type SynapseEmbeddingConfig, type UnvalidatedJson } from "./config.ts";
import { resolveLaunchContract, type LaunchContract } from "./lifecycle.ts";
import { deriveNamespaceId, resolveStorageRoot } from "./namespace.ts";
import { registerSynapseTools, type SynapseToolHost, type SynapseToolsRegistration } from "./register-tools.ts";
import { capabilityForAgent, consumesState } from "./roles.ts";

/**
 * The SYNAPSE contract a delegated child receives.
 *
 * Both execution paths build it at the same seam, from the same inputs, so a
 * foreground child and a background child of the same launch get identical
 * permissions, storage and snapshot identity. It is plain JSON because a
 * background child is a separate process that receives no live objects.
 *
 * Write access is not assumed. A child that was launched without any mutating
 * tool gets read-only memory: shared memory projects the authorisation the
 * child already has and never adds to it.
 */

const MUTATING_TOOLS = new Set(["bash", "edit", "powershell", "write"]);

export type SynapseChildContract = {
	agent: string;
	/**
	 * Whether the host distills this child's completed output into shared
	 * memory. Carried beside `delta` and `vectorCache` because it reaches the
	 * same close-of-delegation seam: memory reuse is a host decision made after
	 * the child finishes, and models rarely remember on their own (P50,
	 * 2026-09-21: zero voluntary writes in thirty rounds). Defaults to false so
	 * existing configurations keep a store that only changes when a tool call
	 * or an explicit experiment changes it.
	 */
	autoDistill: boolean;
	/**
	 * Every tool this child will actually have: what its role declared plus what
	 * the extension registers. The extension's tools reach the child through
	 * `permittedRuntimeTools`, a different channel from the role's declared
	 * tools, so a capability derived from the declared list alone would say the
	 * child cannot consume state while the child is in fact able to — which is
	 * how the whole state plane came to be unreachable.
	 *
	 * One launch derives this once and both planes negotiate from it: the
	 * delegated envelope and the state envelope freeze their snapshots from the
	 * same capability, so a list that moved for one and not the other would make
	 * the receiver reject every launch.
	 */
	capabilityTools: string[];
	/** Budget for the recalled memory section the child is handed at launch. */
	contextBudgetBytes: number;
	contract: LaunchContract;
	/**
	 * Why the contract's gear is not the configured one. Present only when the
	 * gear was degraded, so that the substitution is something a reader of a run
	 * can see rather than infer.
	 */
	deliveryGearNote?: string;
	/**
	 * Whether this launch may send a residual rather than the full vector.
	 *
	 * Carried beside `embedding` because it reaches the same decision at the same
	 * seam: only the launch knows both the configuration and the child index the
	 * sender-side base selection has to meter itself against. Defaults to false,
	 * so a config that predates this field keeps sending full vectors.
	 */
	delta: boolean;
	/**
	 * The configured embedding provider, carried so both halves of a state
	 * handover can be built from the contract alone: the host embeds the query
	 * it is about to send, and the receiver re-embeds that query if its
	 * recovery falls back to text. The key stays in the environment; nothing
	 * secret is ever written here.
	 */
	embedding: SynapseEmbeddingConfig | null;
	runId: string;
	sessionId: string;
	/**
	 * Whether memory-record vectors stay in memory in whichever process ranks them.
	 *
	 * Carried beside `delta` for the same reason it is: both reach the same seam, and
	 * only the launch knows them. Off by default so the frozen cold-base convention
	 * still describes a default run; on, the reads happen once per process instead of
	 * once per ranking. It changes where the bytes come from, never which vectors are
	 * compared — the same launch must rank identically either way.
	 */
	vectorCache: boolean;
};

export type ResolveChildContractInput = {
	agentName: string;
	childTools: readonly string[];
	/** What the extension registers for the child, when it is on. */
	extensionTools?: readonly string[];
	cwd: string;
	extensionConfig: UnvalidatedJson;
	/** Overrides the resolved Pi agent directory; tests supply their own. */
	agentDir?: string;
	/**
	 * Whether this child will run on a different machine than its parent. An
	 * AF_UNIX endpoint is a path in one kernel's filesystem, so the `uds` gear
	 * has no meaning across that boundary.
	 */
	placedOnAnotherMachine?: boolean;
	runId: string;
	sessionId: string;
};

export type EffectiveDeliveryGear = {
	gear: SynapseDeliveryGear;
	/** Set only when `gear` differs from what was configured. */
	note?: string;
};

/**
 * Which gear will actually carry the envelope, as opposed to which one was asked
 * for.
 *
 * `uds` across a machine boundary cannot work and cannot be made to work: the
 * parent would bind a path in its own filesystem and the child would connect to
 * an unrelated path in another, or to nothing. Left alone, that produces the
 * worst available outcome — the parent's send fails as a `persistence` error and
 * the child waits out the full receive deadline before running anyway, once per
 * child, with nothing naming the cause.
 *
 * So the gear is degraded here, and the degraded value is what enters the
 * contract. That matters more than it looks: the gear takes part in
 * `contractId`, so a contract must not claim a transport the run will not use —
 * S4 compares runs by their conditions, and a run labelled `uds` that actually
 * wrote files is a condition that disagrees with its own manifest. The
 * substitution is named in `note` rather than being silent.
 */
export function resolveEffectiveDeliveryGear(input: { configured: SynapseDeliveryGear; placedOnAnotherMachine: boolean }): EffectiveDeliveryGear {
	if (input.configured !== "uds" || !input.placedOnAnotherMachine) return { gear: input.configured };
	return {
		gear: "file",
		note: "deliveryGear \"uds\" degraded to \"file\": an AF_UNIX endpoint is a path in one kernel's filesystem and this child runs on another machine",
	};
}

/**
 * Whether this configuration will give children a memory contract. Answered
 * from configuration alone, because the child's tool allowlist has to be built
 * before the contract exists and must already permit the memory tools.
 */
export function synapseChildToolsEnabled(extensionConfig: UnvalidatedJson): boolean {
	const config = resolveSynapseConfig(extensionConfig, os.homedir());
	return config.mode !== "off" && config.memory !== "off";
}

export function childMayWrite(childTools: readonly string[]): boolean {
	return childTools.some((tool) => MUTATING_TOOLS.has(tool));
}

/**
 * Whether this child could consume a state payload at all.
 *
 * The answer is the receiver role's own rule, not a second copy of it: a child
 * that was not granted a state-consuming tool negotiates to text no matter what
 * the sender offers, so the host asks this before spending an embedding call on
 * a handover that cannot land.
 */
export function childConsumesState(childTools: readonly string[]): boolean {
	return consumesState(childTools);
}

/**
 * Returns null when the extension is off or memory is disabled, in which case
 * no contract travels to the child and nothing about its launch changes.
 */
export function resolveSynapseChildContract(input: ResolveChildContractInput): SynapseChildContract | null {
	const agentDir = input.agentDir ?? getAgentDir();
	const config = resolveSynapseConfig(input.extensionConfig, os.homedir());
	if (config.mode === "off" || config.memory === "off") return null;

	const resolved = resolveStorageRoot({
		agentDir,
		override: config.storageRoot ?? undefined,
		worktreePath: input.cwd,
	});
	// Provenance fields must never be empty: a record written with a blank
	// session or run id passes the write but fails its own schema on the way
	// back, turning a stored observation into an integrity error later.
	const runId = input.runId.trim().length > 0 ? input.runId : "unattributed-run";
	const sessionId = input.sessionId.trim().length > 0 ? input.sessionId : "unattributed-session";
	const agent = input.agentName.trim().length > 0 ? input.agentName : "unattributed-agent";
	const representationId = representationIdOf(config);
	const effectiveGear = resolveEffectiveDeliveryGear({
		configured: config.deliveryGear,
		placedOnAnotherMachine: input.placedOnAnotherMachine ?? false,
	});
	// The capability is what the child can actually do, so the extension's tools
	// belong in it. With the extension off this is the declared list unchanged.
	const capabilityTools = [...input.childTools, ...(input.extensionTools ?? [])];
	return {
		agent,
		autoDistill: config.autoDistill,
		contextBudgetBytes: config.contextBudgetBytes,
		contract: resolveLaunchContract({
			// The capability is the receiving role's own declaration, so the contract
			// id changes when what the child can do changes. Corpus identity comes
			// from configuration: an experiment pins the snapshot id a build-corpus
			// run produced, and without one the stable "unset" placeholder keeps the
			// vector path disabled.
			capabilityId: capabilityForAgent({ agent, childTools: capabilityTools, representationId }).capabilityId,
			corpusSnapshotId: config.corpusSnapshotId ?? "unset",
			// The one place the gear enters the contract. Both sides of the delivery
			// read it from here afterwards, so the address the parent sends to and
			// the address the child listens on are derived from one value rather
			// than resolved twice from configuration. It is the *effective* gear,
			// never the configured one, so the contract cannot promise a transport
			// this launch will not use.
			deliveryGear: effectiveGear.gear,
			memoryRefs: [],
			mode: config.mode,
			namespaceId: deriveNamespaceId(input.cwd),
			representationId,
			scope: { pathPrefixes: [""], write: childMayWrite(input.childTools) },
			// The receiver's own behaviour, so it freezes with the rest of the launch.
			stateVerify: config.stateVerify,
			storageRoot: resolved.root,
		}),
		capabilityTools,
		delta: config.delta,
		embedding: config.embedding,
		...(effectiveGear.note === undefined ? {} : { deliveryGearNote: effectiveGear.note }),
		runId,
		sessionId,
		vectorCache: config.vectorCache,
	};
}

/**
 * Registers the memory tools inside a delegated child, using the child's own
 * identity for provenance so a record says which agent actually observed it.
 */
export function registerSynapseChildTools(pi: SynapseToolHost, contract: SynapseChildContract, worktreeRoot: string): SynapseToolsRegistration {
	let operations = 0;
	return registerSynapseTools(pi, {
		config: {
			// Inert on this path rather than copied: distillation runs on the host
			// after this child completes, so the child's own tool runtime never
			// distills and the value here stays false whatever the launch set.
			autoDistill: false,
			contextBudgetBytes: contract.contextBudgetBytes,
			// This SynapseConfig only feeds register-tools.ts's memory tools, which
			// never reads deliveryGear (envelope delivery is a different seam
			// entirely); "file" here is a structurally required value, not a choice.
			deliveryGear: "file",
			corpusSnapshotId: contract.contract.corpusSnapshotId === "unset" ? null : contract.contract.corpusSnapshotId,
			// Inert on this path rather than copied: the child's own tools never
			// select a base, so the parent's residual switch has nothing to act on
			// here. False states that instead of repeating a value that does nothing.
			delta: false,
			embedding: null,
			maxObjectBytes: 1024 * 1024,
			memory: "project",
			mode: contract.contract.mode,
			stateRecovery: "resend-then-text",
			// Inert on this path: the child's own tools never consume a transferred
			// state, so nothing here re-embeds a query to check one.
			stateVerify: "off",
			storageRoot: contract.contract.storageRoot,
			// Inert on this path TODAY, and stated as such: the child's own recall
			// service has no embedder (embedding: null above), so its semantic
			// ranking — the only consumer of the cache — never runs here, and this
			// value only becomes live if a future card gives the child's recall an
			// embedder. Kept wired rather than hardcoded false so that day needs no
			// contract change. Registered beside the V7 debt (README known-gap #10).
			vectorCache: contract.vectorCache,
		},
		agentDir: getAgentDir(),
		nextOperationId: () => `${contract.runId}/${contract.agent}/${(operations += 1)}`,
		resolveContext: () => ({
			provenance: { agent: contract.agent, attempt: 1, runId: contract.runId, sessionId: contract.sessionId },
			scope: { agent: contract.agent, pathPrefixes: [...contract.contract.scope.pathPrefixes], write: contract.contract.scope.write },
			worktreeRoot,
		}),
	});
}

/** Narrow view of the host used by the child runtime, which holds a full ExtensionAPI. */
export type ChildToolHost = Pick<ExtensionAPI, "registerTool">;
