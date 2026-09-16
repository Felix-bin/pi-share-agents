import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { canonicalizeWorktreePath, deriveNamespaceId, ensureNamespace, resolveStorageRoot } from "../../src/synapse/namespace.ts";

let home = "";
let agentDir = "";
let worktree = "";

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-home-"));
	agentDir = path.join(home, ".pi", "agent");
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-wt-"));
});

afterEach(() => {
	fs.rmSync(home, { force: true, recursive: true });
	fs.rmSync(worktree, { force: true, recursive: true });
});

describe("synapse namespace id", () => {
	it("is the first 16 hex digits of the sha-256 of the canonical worktree path", () => {
		const id = deriveNamespaceId("/home/dev/projects/synapse");
		const expected = createHash("sha256").update("/home/dev/projects/synapse", "utf-8").digest("hex").slice(0, 16);
		assert.equal(id, expected);
		assert.match(id, /^[0-9a-f]{16}$/);
	});

	it("ignores trailing separators and redundant path segments", () => {
		const base = deriveNamespaceId(path.join(worktree, "repo"));
		assert.equal(deriveNamespaceId(path.join(worktree, "repo") + path.sep), base);
		assert.equal(deriveNamespaceId(path.join(worktree, "nested", "..", "repo")), base);
	});

	it("keeps distinct checkouts of the same repository apart", () => {
		assert.notEqual(deriveNamespaceId("/home/dev/a/synapse"), deriveNamespaceId("/home/dev/b/synapse"));
	});

	it("treats paths that differ only by case as distinct", () => {
		// POSIX filesystems are case-sensitive; folding case here would silently
		// merge two real worktrees on Linux.
		assert.notEqual(deriveNamespaceId("/home/dev/Synapse"), deriveNamespaceId("/home/dev/synapse"));
	});

	it("rejects a relative path instead of guessing a working directory", () => {
		assert.throws(() => deriveNamespaceId("./synapse"), /absolute/);
	});
});

describe("synapse storage root resolution", () => {
	it("defaults to the pi agent directory under the namespace id", () => {
		const resolved = resolveStorageRoot({ agentDir, worktreePath: worktree });
		assert.equal(resolved.source, "default");
		assert.equal(resolved.namespaceId, deriveNamespaceId(worktree));
		assert.equal(resolved.root, path.join(agentDir, "synapse", resolved.namespaceId));
	});

	it("honours an explicit override so each experiment sequence gets its own empty store", () => {
		const override = path.join(home, "runs", "seq-01");
		const resolved = resolveStorageRoot({ agentDir, override, worktreePath: worktree });
		assert.equal(resolved.source, "override");
		assert.equal(resolved.root, override);
		// The namespace id still identifies the worktree, so records stay attributable.
		assert.equal(resolved.namespaceId, deriveNamespaceId(worktree));
	});

	it("rejects a relative override rather than resolving it against the current directory", () => {
		assert.throws(() => resolveStorageRoot({ agentDir, override: "runs/seq-01", worktreePath: worktree }), /absolute/);
	});
});

describe("synapse namespace marker", () => {
	it("records the real worktree path so a hashed directory can be traced back", () => {
		const resolved = resolveStorageRoot({ agentDir, worktreePath: worktree });
		ensureNamespace(resolved);
		const marker = JSON.parse(fs.readFileSync(path.join(resolved.root, "namespace.json"), "utf-8"));
		assert.equal(marker.namespaceId, resolved.namespaceId);
		assert.equal(marker.worktreePath, canonicalizeWorktreePath(worktree));
	});

	it("is idempotent across repeated sessions", () => {
		const resolved = resolveStorageRoot({ agentDir, worktreePath: worktree });
		ensureNamespace(resolved);
		const first = fs.readFileSync(path.join(resolved.root, "namespace.json"), "utf-8");
		ensureNamespace(resolved);
		assert.equal(fs.readFileSync(path.join(resolved.root, "namespace.json"), "utf-8"), first);
	});

	it("fails loudly when an existing store belongs to a different worktree", () => {
		const override = path.join(home, "shared-store");
		ensureNamespace(resolveStorageRoot({ agentDir, override, worktreePath: worktree }));
		const other = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-wt2-"));
		try {
			assert.throws(
				() => ensureNamespace(resolveStorageRoot({ agentDir, override, worktreePath: other })),
				/namespace-mismatch/,
			);
		} finally {
			fs.rmSync(other, { force: true, recursive: true });
		}
	});
});
