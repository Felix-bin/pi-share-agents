import { canonicalDigest, canonicalJson, type CanonicalValue } from "./canonical-json.ts";
import { SYNAPSE_DEFAULT_STATE_VERIFY, type SynapseMode, type SynapseStateVerify } from "./config.ts";
import type { SynapseErrorCategory } from "./errors.ts";

/**
 * Launch contracts, rehydration and run reconciliation.
 *
 * One contract serves both execution paths. Foreground and background derive
 * their SYNAPSE inputs from the same function, so identical input cannot
 * produce different permissions, snapshots or references depending on where the
 * work happened to run — the parity AC-10 asks for is structural rather than a
 * pair of code paths kept in step by hand.
 *
 * A contract is plain JSON. A background process receives no live objects, no
 * callbacks and no parent memory, so anything that cannot survive serialisation
 * has no business in the contract.
 *
 * On reload the contract is re-validated rather than trusted. Permissions that
 * narrowed refuse the resume; permissions that widened are ignored, because a
 * frozen snapshot must never gain reach by being resumed later.
 */

export const SYNAPSE_MAX_ATTEMPTS = 3;

export type ContractScope = {
	pathPrefixes: readonly string[];
	write: boolean;
};

export type LaunchContractInput = {
	capabilityId: string;
	corpusSnapshotId: string;
	memoryRefs: readonly string[];
	mode: SynapseMode;
	namespaceId: string;
	representationId: string;
	scope: ContractScope;
	/** Optional: a contract persisted before this setting existed carries none, and defaults to off. */
	stateVerify?: SynapseStateVerify;
	storageRoot: string;
};

export type LaunchContract = {
	capabilityId: string;
	contractId: string;
	corpusSnapshotId: string;
	memoryRefs: string[];
	mode: SynapseMode;
	namespaceId: string;
	representationId: string;
	scope: { pathPrefixes: string[]; write: boolean };
	/**
	 * Whether the receiver re-embeds the query to check a decoded state before it
	 * ranks with it. Frozen into the contract because it is the *receiver's*
	 * behaviour, and because it changes what a consumed state is allowed to be.
	 */
	stateVerify: SynapseStateVerify;
	storageRoot: string;
};

export type RehydrationChecks = {
	currentNamespaceId: string;
	currentScope: ContractScope;
	/** Whether the memory record still exists; the refs name records, not their bodies. */
	memoryExists: (memoryId: string) => boolean;
};

export type RehydrationResult =
	| { contract: LaunchContract; status: "ready" }
	| { category: SynapseErrorCategory; reason: string; status: "refused" };

export type TerminalState = "completed" | "failed" | "cancelled" | null;

export type RunRecord = {
	attempt: number;
	deliveredReceipts: number;
	nodeId: string;
	runId: string;
	terminalState: TerminalState;
};

export type ReconciliationSummary = {
	abandoned: string[];
	cancelled: number;
	delivered: number;
	duplicateDeliveries: number;
	failed: number;
	undelivered: string[];
};

function identityOf(record: Pick<RunRecord, "attempt" | "nodeId" | "runId">): string {
	return `${record.runId}/${record.nodeId}/${record.attempt}`;
}

function normaliseScope(scope: ContractScope) {
	return { pathPrefixes: [...new Set(scope.pathPrefixes)].sort(), write: scope.write };
}

function contractBody(input: LaunchContractInput): CanonicalValue {
	const scope = normaliseScope(input.scope);
	// Normalised here as well as in the resolver, because this function is also reached
	// with a contract parsed back off disk, where a setting added after that contract was
	// written is simply absent.
	const stateVerify = input.stateVerify ?? SYNAPSE_DEFAULT_STATE_VERIFY;
	const body = {
		capabilityId: input.capabilityId,
		corpusSnapshotId: input.corpusSnapshotId,
		memoryRefs: [...new Set(input.memoryRefs)].sort(),
		mode: input.mode,
		namespaceId: input.namespaceId,
		representationId: input.representationId,
		scope: { pathPrefixes: scope.pathPrefixes, write: scope.write },
		storageRoot: input.storageRoot,
	};
	// A setting at its default is not part of the contract's identity: a launch that never
	// sets it keeps the identity it had before the setting existed, so a contract persisted
	// by an older build still rehydrates instead of reading as tampered.
	if (stateVerify === SYNAPSE_DEFAULT_STATE_VERIFY) return body;
	return { ...body, stateVerify };
}

export function resolveLaunchContract(input: LaunchContractInput): LaunchContract {
	const scope = normaliseScope(input.scope);
	return {
		capabilityId: input.capabilityId,
		contractId: canonicalDigest(contractBody(input)),
		corpusSnapshotId: input.corpusSnapshotId,
		memoryRefs: [...new Set(input.memoryRefs)].sort(),
		mode: input.mode,
		namespaceId: input.namespaceId,
		representationId: input.representationId,
		scope,
		stateVerify: input.stateVerify ?? SYNAPSE_DEFAULT_STATE_VERIFY,
		storageRoot: input.storageRoot,
	};
}

export function serialiseLaunchContract(contract: LaunchContract): string {
	return canonicalJson({ ...contract, scope: { pathPrefixes: [...contract.scope.pathPrefixes], write: contract.scope.write } });
}

/** True when `current` grants everything `frozen` did. */
function stillGrants(frozen: LaunchContract["scope"], current: ContractScope): boolean {
	if (frozen.write && !current.write) return false;
	const currentPrefixes = current.pathPrefixes.map((prefix) => prefix.replace(/\/+$/, ""));
	return frozen.pathPrefixes.every((prefix) =>
		currentPrefixes.some((granted) => granted === "" || granted === prefix || prefix.startsWith(`${granted}/`)),
	);
}

export function rehydrateLaunchContract(serialised: string, checks: RehydrationChecks): RehydrationResult {
	let parsed: LaunchContract;
	try {
		parsed = JSON.parse(serialised);
	} catch {
		// Unreadable persisted state is missing state. Starting from defaults would
		// silently run the task under conditions nobody chose.
		return { category: "integrity", reason: "persisted contract is not valid JSON", status: "refused" };
	}
	const recomputed = resolveLaunchContract(parsed);
	if (recomputed.contractId !== parsed.contractId) {
		return { category: "integrity", reason: "contract id does not match its content", status: "refused" };
	}
	if (parsed.namespaceId !== checks.currentNamespaceId) {
		return { category: "configuration", reason: `contract belongs to namespace ${parsed.namespaceId}`, status: "refused" };
	}
	if (!stillGrants(parsed.scope, checks.currentScope)) {
		return { category: "permission", reason: "authorisation narrowed since the snapshot was frozen", status: "refused" };
	}
	for (const memoryId of parsed.memoryRefs) {
		if (!checks.memoryExists(memoryId)) {
			return { category: "object-unavailable", reason: `referenced memory ${memoryId} is gone`, status: "refused" };
		}
	}
	// The frozen scope is returned even when the current grant is wider: resuming
	// must not be a way to acquire reach the original launch did not have.
	return { contract: recomputed, status: "ready" };
}

export function reconcileRuns(records: readonly RunRecord[]): ReconciliationSummary {
	const summary: ReconciliationSummary = { abandoned: [], cancelled: 0, delivered: 0, duplicateDeliveries: 0, failed: 0, undelivered: [] };
	for (const record of records) {
		const identity = identityOf(record);
		if (record.terminalState === null) summary.abandoned.push(identity);
		if (record.terminalState === "cancelled") summary.cancelled += 1;
		if (record.terminalState === "failed") summary.failed += 1;
		if (record.deliveredReceipts > 0) {
			// Delivery is per attempt: a repeated receipt for one attempt is
			// duplication, while a retry is a second attempt that really ran.
			summary.delivered += 1;
			summary.duplicateDeliveries += record.deliveredReceipts - 1;
		} else if (record.terminalState !== null) {
			summary.undelivered.push(identity);
		}
	}
	summary.abandoned.sort();
	summary.undelivered.sort();
	return summary;
}

export function shouldRetry(record: Pick<RunRecord, "attempt" | "terminalState">): boolean {
	if (record.terminalState === "completed" || record.terminalState === "cancelled") return false;
	return record.attempt < SYNAPSE_MAX_ATTEMPTS;
}
