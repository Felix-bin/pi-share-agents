import type { MemoryRecord } from "./memory-store.ts";

/**
 * Authorisation projection for SYNAPSE shared memory.
 *
 * Memory is data. It never widens what an agent may reach: a record is visible
 * only where the project grant and the subagent grant already overlap, and
 * `mode=synapse` alone grants nothing. Anything that cannot be projected onto an
 * existing grant is denied rather than shared (§7.3).
 *
 * This is a projection of the host's own access policy, not a sandbox. It does
 * not claim to contain malicious code or an agent that already holds a shell.
 */

export type AccessScope = {
	agent: string;
	namespaceId: string;
	/**
	 * Worktree-relative POSIX prefixes this scope may read. `""` denotes the whole
	 * worktree; an empty array denotes no access at all.
	 */
	pathPrefixes: string[];
	write: boolean;
};

const WHOLE_WORKTREE = "";

function normalizePrefix(prefix: string): string {
	return prefix.split("\\").join("/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * True when `candidate` is at or below `prefix`, comparing whole path segments.
 * A plain `startsWith` would let a grant over `src` admit `src-private`.
 */
function isUnderPrefix(candidate: string, prefix: string): boolean {
	if (prefix === WHOLE_WORKTREE) return true;
	return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

export function intersectScopes(project: AccessScope, agent: AccessScope): AccessScope {
	if (project.namespaceId !== agent.namespaceId) {
		throw new Error(`namespace-mismatch: ${project.namespaceId} vs ${agent.namespaceId}`);
	}
	const projectPrefixes = project.pathPrefixes.map(normalizePrefix);
	const agentPrefixes = agent.pathPrefixes.map(normalizePrefix);
	const kept = new Set<string>();
	// The intersection of two prefix sets is the narrower member of every pair
	// that overlaps; keeping the broader one would hand back access the narrower
	// grant withheld.
	for (const projectPrefix of projectPrefixes) {
		for (const agentPrefix of agentPrefixes) {
			if (isUnderPrefix(agentPrefix, projectPrefix)) kept.add(agentPrefix);
			else if (isUnderPrefix(projectPrefix, agentPrefix)) kept.add(projectPrefix);
		}
	}
	return {
		agent: agent.agent,
		namespaceId: project.namespaceId,
		pathPrefixes: [...kept].sort(),
		write: project.write && agent.write,
	};
}

/**
 * Whether a worktree-relative path falls inside the scope. Callers use this to
 * check a freshly taken fingerprint that has no record yet, so a body can never
 * be filed under a path the writer may not reach.
 */
export function isPathInScope(sourcePath: string, scope: AccessScope): boolean {
	if (scope.pathPrefixes.length === 0) return false;
	const candidate = normalizePrefix(sourcePath);
	return scope.pathPrefixes.map(normalizePrefix).some((prefix) => isUnderPrefix(candidate, prefix));
}

export function isReadable(record: MemoryRecord, scope: AccessScope): boolean {
	if (scope.pathPrefixes.length === 0) return false;
	if (record.source === null) {
		// A conclusion with no file behind it cannot be projected onto a narrower
		// grant, so only a whole-worktree scope may see it.
		return scope.pathPrefixes.map(normalizePrefix).includes(WHOLE_WORKTREE);
	}
	return isPathInScope(record.source.path, scope);
}

export function requireWritable(scope: AccessScope): void {
	if (!scope.write || scope.pathPrefixes.length === 0) {
		throw new Error(`not-authorised: ${scope.agent} may not write shared memory`);
	}
}
