import * as os from "node:os";
import { getAgentDir } from "../shared/utils.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveSynapseConfig, type UnvalidatedJson } from "./config.ts";
import { resolveLaunchContract, type LaunchContract } from "./lifecycle.ts";
import { deriveNamespaceId, resolveStorageRoot } from "./namespace.ts";
import { registerSynapseTools, type SynapseToolHost, type SynapseToolsRegistration } from "./register-tools.ts";

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
	contract: LaunchContract;
	runId: string;
	sessionId: string;
};

export type ResolveChildContractInput = {
	agentName: string;
	childTools: readonly string[];
	cwd: string;
	extensionConfig: UnvalidatedJson;
	/** Overrides the resolved Pi agent directory; tests supply their own. */
	agentDir?: string;
	runId: string;
	sessionId: string;
};

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
	return {
		agent: input.agentName.trim().length > 0 ? input.agentName : "unattributed-agent",
		contract: resolveLaunchContract({
			// Capability and corpus identity become meaningful with the state plane;
			// until then they are stable placeholders that still take part in the
			// contract id, so a later change to either is visible as a new contract.
			capabilityId: "0".repeat(64),
			contextRefs: [],
			corpusSnapshotId: "unset",
			mode: config.mode,
			namespaceId: deriveNamespaceId(input.cwd),
			representationId: config.embedding === null ? "unavailable" : `${config.embedding.provider}/${config.embedding.model}/${config.embedding.dim}`,
			scope: { pathPrefixes: [""], write: childMayWrite(input.childTools) },
			storageRoot: resolved.root,
		}),
		runId,
		sessionId,
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
			contextBudgetBytes: 8192,
			embedding: null,
			maxObjectBytes: 1024 * 1024,
			memory: "project",
			mode: contract.contract.mode,
			stateRecovery: "resend-then-text",
			storageRoot: contract.contract.storageRoot,
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
