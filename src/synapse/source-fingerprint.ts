import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Source validity for SYNAPSE memory records.
 *
 * A fingerprint is the SHA-256 of the bytes actually present in the worktree,
 * never a commit id: an uncommitted edit changes what the evidence describes
 * just as much as a commit does, and HEAD cannot see it.
 *
 * Capture and check both return the bytes they hashed. Callers must consume
 * those bytes. Re-opening the file after a check would consume a version that
 * was never verified against the fingerprint the caller just trusted.
 */

export type SourceFingerprint = {
	byteLength: number;
	digest: string;
	path: string;
};

export type SourceUnavailableReason = "source-missing" | "source-unreadable";

export type CapturedSource =
	| { bytes: Uint8Array; fingerprint: SourceFingerprint; status: "present" }
	| { reason: SourceUnavailableReason; status: "unavailable" };

export type CheckedSource =
	| { bytes: Uint8Array; status: "current" }
	| { bytes: Uint8Array; current: SourceFingerprint; status: "stale" }
	| { reason: SourceUnavailableReason; status: "unavailable" };

/**
 * Resolves a worktree-relative path, rejecting anything that leaves the root.
 * Memory is data and must not widen a subagent's reach (§7.3).
 */
function resolveWithinRoot(root: string, relPath: string) {
	const rootAbsolute = path.resolve(root);
	const absolute = path.resolve(rootAbsolute, relPath);
	const relative = path.relative(rootAbsolute, absolute);
	if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`outside-root: ${JSON.stringify(relPath)}`);
	}
	return { absolute, relative: relative.split(path.sep).join("/") };
}

function readFileBytes(absolute: string): { bytes: Uint8Array } | { reason: SourceUnavailableReason } {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(absolute);
	} catch {
		return { reason: "source-missing" };
	}
	if (!stat.isFile()) {
		return { reason: "source-unreadable" };
	}
	try {
		return { bytes: new Uint8Array(fs.readFileSync(absolute)) };
	} catch {
		return { reason: "source-unreadable" };
	}
}

export function captureSource(worktreeRoot: string, relPath: string): CapturedSource {
	const { absolute, relative } = resolveWithinRoot(worktreeRoot, relPath);
	const read = readFileBytes(absolute);
	if (!("bytes" in read)) {
		return { reason: read.reason, status: "unavailable" };
	}
	return {
		bytes: read.bytes,
		fingerprint: {
			byteLength: read.bytes.byteLength,
			digest: createHash("sha256").update(read.bytes).digest("hex"),
			path: relative,
		},
		status: "present",
	};
}

export function checkSource(worktreeRoot: string, recorded: SourceFingerprint): CheckedSource {
	const captured = captureSource(worktreeRoot, recorded.path);
	if (captured.status === "unavailable") {
		return { reason: captured.reason, status: "unavailable" };
	}
	if (captured.fingerprint.digest === recorded.digest && captured.fingerprint.byteLength === recorded.byteLength) {
		return { bytes: captured.bytes, status: "current" };
	}
	return { bytes: captured.bytes, current: captured.fingerprint, status: "stale" };
}
