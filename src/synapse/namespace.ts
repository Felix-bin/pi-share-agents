import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { writeAtomicJson } from "../shared/atomic-json.ts";

/**
 * SYNAPSE storage namespacing.
 *
 * Shared memory belongs to one worktree. Two checkouts of the same repository
 * are separate namespaces in v1, because a remote URL does not tell us whether
 * the two working trees hold the same bytes. The namespace id is derived from
 * the canonical absolute worktree path so the mapping is reproducible without
 * consulting any index, and `namespace.json` records the real path so a hashed
 * directory can be traced back by a human.
 */

const NAMESPACE_ID_LENGTH = 16;
const NAMESPACE_MARKER = "namespace.json";

export type StorageRootSource = "default" | "override";

export type ResolvedStorageRoot = {
	namespaceId: string;
	root: string;
	source: StorageRootSource;
	worktreePath: string;
};

export type ResolveStorageRootInput = {
	/**
	 * The resolved Pi agent directory (PI_CODING_AGENT_DIR when set). Deriving
	 * this from the OS home instead would leave the store shared across runs that
	 * deliberately isolated everything else about the agent.
	 */
	agentDir: string;
	override?: string;
	worktreePath: string;
};

/**
 * Canonical form of a worktree path: absolute, free of `.`/`..` segments and
 * trailing separators, written with forward slashes.
 *
 * Case is deliberately preserved. Folding it would merge two genuinely distinct
 * worktrees on a case-sensitive filesystem, which is the environment the
 * experiments must run in.
 */
export function canonicalizeWorktreePath(worktreePath: string): string {
	if (!path.isAbsolute(worktreePath)) {
		throw new Error(`worktree path must be absolute: ${JSON.stringify(worktreePath)}`);
	}
	const normalized = path.normalize(worktreePath).split(path.sep).join("/").split("\\").join("/");
	const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
	return trimmed.length > 0 ? trimmed : "/";
}

export function deriveNamespaceId(worktreePath: string): string {
	const canonical = canonicalizeWorktreePath(worktreePath);
	return createHash("sha256").update(canonical, "utf-8").digest("hex").slice(0, NAMESPACE_ID_LENGTH);
}

export function resolveStorageRoot(input: ResolveStorageRootInput): ResolvedStorageRoot {
	const worktreePath = canonicalizeWorktreePath(input.worktreePath);
	const namespaceId = deriveNamespaceId(worktreePath);
	if (input.override !== undefined) {
		if (!path.isAbsolute(input.override)) {
			throw new Error(`synapse.storageRoot must be absolute: ${JSON.stringify(input.override)}`);
		}
		return { namespaceId, root: path.normalize(input.override), source: "override", worktreePath };
	}
	return {
		namespaceId,
		root: path.join(input.agentDir, "synapse", namespaceId),
		source: "default",
		worktreePath,
	};
}

const NamespaceMarkerSchema = Type.Object(
	{
		namespaceId: Type.String({ pattern: `^[0-9a-f]{${NAMESPACE_ID_LENGTH}}$` }),
		version: Type.Literal(1),
		worktreePath: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const namespaceMarkerValidator = Compile(NamespaceMarkerSchema);

/**
 * Creates the store directory and its marker, or verifies that an existing
 * store belongs to this worktree. A mismatch is reported rather than repaired:
 * silently adopting another worktree's store would let one experiment sequence
 * inherit another's memory.
 */
export function ensureNamespace(resolved: ResolvedStorageRoot): void {
	const markerPath = path.join(resolved.root, NAMESPACE_MARKER);
	let raw = "";
	try {
		raw = fs.readFileSync(markerPath, "utf-8");
	} catch {
		fs.mkdirSync(resolved.root, { recursive: true });
		writeAtomicJson(markerPath, {
			namespaceId: resolved.namespaceId,
			version: 1,
			worktreePath: resolved.worktreePath,
		});
		return;
	}
	const parsed = JSON.parse(raw);
	if (!namespaceMarkerValidator.Check(parsed)) {
		throw new Error(`namespace-corrupt: ${markerPath}`);
	}
	if (parsed.worktreePath !== resolved.worktreePath || parsed.namespaceId !== resolved.namespaceId) {
		throw new Error(
			`namespace-mismatch: ${resolved.root} belongs to ${parsed.worktreePath}, not ${resolved.worktreePath}`,
		);
	}
}
