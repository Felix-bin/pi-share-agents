import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { captureSource, checkSource } from "../../src/synapse/source-fingerprint.ts";

let root = "";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-src-"));
});

afterEach(() => {
	fs.rmSync(root, { force: true, recursive: true });
});

function write(relPath: string, text: string): void {
	const target = path.join(root, relPath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, text);
}

function git(...args: string[]): void {
	execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

describe("synapse source capture", () => {
	it("returns the fingerprint together with the very bytes it hashed", () => {
		write("docs/note.md", "first version");
		const captured = captureSource(root, "docs/note.md");
		assert.equal(captured.status, "present");
		if (captured.status !== "present") return;
		// The consumer must use these bytes; re-reading the file would consume data
		// that was never verified against the fingerprint just computed.
		assert.equal(new TextDecoder().decode(captured.bytes), "first version");
		assert.equal(captured.fingerprint.path, "docs/note.md");
		assert.equal(captured.fingerprint.byteLength, 13);
		assert.match(captured.fingerprint.digest, /^[0-9a-f]{64}$/);
	});

	it("normalises separators so a fingerprint taken on Windows matches one taken on Linux", () => {
		write("docs/note.md", "x");
		const viaBackslash = captureSource(root, "docs\\note.md");
		const viaSlash = captureSource(root, "docs/note.md");
		assert.equal(viaBackslash.status, "present");
		if (viaBackslash.status !== "present" || viaSlash.status !== "present") return;
		assert.equal(viaBackslash.fingerprint.path, "docs/note.md");
		assert.deepEqual(viaBackslash.fingerprint, viaSlash.fingerprint);
	});

	it("reports a missing source as unavailable rather than throwing a raw fs error", () => {
		const captured = captureSource(root, "docs/absent.md");
		assert.equal(captured.status, "unavailable");
		if (captured.status !== "unavailable") return;
		assert.equal(captured.reason, "source-missing");
	});

	it("reports a directory as unavailable instead of hashing whatever it can read", () => {
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		const captured = captureSource(root, "docs");
		assert.equal(captured.status, "unavailable");
	});

	it("refuses paths that escape the worktree", () => {
		assert.throws(() => captureSource(root, "../outside.md"), /outside-root/);
		assert.throws(() => captureSource(root, path.join(os.tmpdir(), "absolute.md")), /outside-root/);
	});
});

describe("synapse source validity", () => {
	it("keeps a record current while the bytes are unchanged", () => {
		write("src/a.ts", "export const a = 1;\n");
		const captured = captureSource(root, "src/a.ts");
		assert.equal(captured.status, "present");
		if (captured.status !== "present") return;
		const checked = checkSource(root, captured.fingerprint);
		assert.equal(checked.status, "current");
	});

	it("marks a record stale after an uncommitted edit, not only after a commit", () => {
		git("init", "--quiet");
		write("src/a.ts", "export const a = 1;\n");
		git("add", ".");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "seed");
		const captured = captureSource(root, "src/a.ts");
		assert.equal(captured.status, "present");
		if (captured.status !== "present") return;

		// Edit in the working tree only. HEAD is untouched, so any check based on
		// the commit id would still call this evidence current.
		write("src/a.ts", "export const a = 2;\n");
		const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
		const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
		assert.equal(headBefore, headAfter);

		const checked = checkSource(root, captured.fingerprint);
		assert.equal(checked.status, "stale");
		if (checked.status !== "stale") return;
		assert.notEqual(checked.current.digest, captured.fingerprint.digest);
	});

	it("marks a record stale when only whitespace changed", () => {
		write("src/a.ts", "export const a = 1;\n");
		const captured = captureSource(root, "src/a.ts");
		if (captured.status !== "present") return assert.fail("expected present");
		write("src/a.ts", "export const a = 1;\n\n");
		assert.equal(checkSource(root, captured.fingerprint).status, "stale");
	});

	it("marks a record stale when the bytes are restored but at a different length", () => {
		write("data/log.txt", "alpha");
		const captured = captureSource(root, "data/log.txt");
		if (captured.status !== "present") return assert.fail("expected present");
		write("data/log.txt", "alpha ");
		assert.equal(checkSource(root, captured.fingerprint).status, "stale");
	});

	it("returns to current when an edit is reverted byte for byte", () => {
		write("src/a.ts", "original\n");
		const captured = captureSource(root, "src/a.ts");
		if (captured.status !== "present") return assert.fail("expected present");
		write("src/a.ts", "changed\n");
		assert.equal(checkSource(root, captured.fingerprint).status, "stale");
		write("src/a.ts", "original\n");
		assert.equal(checkSource(root, captured.fingerprint).status, "current");
	});

	it("reports unavailable, not stale, when the source is gone", () => {
		write("src/a.ts", "export const a = 1;\n");
		const captured = captureSource(root, "src/a.ts");
		if (captured.status !== "present") return assert.fail("expected present");
		fs.rmSync(path.join(root, "src/a.ts"));
		const checked = checkSource(root, captured.fingerprint);
		assert.equal(checked.status, "unavailable");
		if (checked.status !== "unavailable") return;
		assert.equal(checked.reason, "source-missing");
	});

	it("hands the verified bytes back on a current check so the caller never re-reads", () => {
		write("src/a.ts", "verified\n");
		const captured = captureSource(root, "src/a.ts");
		if (captured.status !== "present") return assert.fail("expected present");
		const checked = checkSource(root, captured.fingerprint);
		assert.equal(checked.status, "current");
		if (checked.status !== "current") return;
		assert.equal(new TextDecoder().decode(checked.bytes), "verified\n");
	});
});
