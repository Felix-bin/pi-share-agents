import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	clearStoredKey,
	credentialsPath,
	fingerprintKey,
	readStoredKey,
	resolveEmbeddingKey,
	SYNAPSE_KEY_ENV,
	parseEnteredKey,
	writeStoredKey,
} from "../../src/synapse/credentials.ts";

let agentDir = "";
const KEY = "sk-abcdef0123456789abcdef0123456789";

beforeEach(() => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-cred-"));
});

afterEach(() => {
	fs.rmSync(agentDir, { force: true, recursive: true });
});

describe("entered key", () => {
	it("accepts a plausible key and trims surrounding whitespace", () => {
		const parsed = parseEnteredKey(`  ${KEY}\n`);
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.key, KEY);
	});

	it("rejects an empty entry as a cancellation rather than storing a blank key", () => {
		for (const raw of ["", "   ", "\n"]) {
			const parsed = parseEnteredKey(raw);
			assert.equal(parsed.ok, false);
			if (parsed.ok) continue;
			assert.match(parsed.reason, /empty/i);
		}
	});

	it("rejects a value with inner whitespace, which is a paste accident rather than a key", () => {
		const parsed = parseEnteredKey("sk-abc def");
		assert.equal(parsed.ok, false);
		if (parsed.ok) return;
		assert.match(parsed.reason, /whitespace/i);
	});

	it("rejects a value too short to be a key", () => {
		assert.equal(parseEnteredKey("sk-123").ok, false);
	});

	it("never repeats the value it rejected", () => {
		const parsed = parseEnteredKey("sk-abc def");
		assert.equal(parsed.ok, false);
		if (parsed.ok) return;
		assert.equal(parsed.reason.includes("sk-abc"), false);
	});
});

describe("fingerprint", () => {
	it("identifies a key without revealing it", () => {
		const fingerprint = fingerprintKey(KEY);
		assert.match(fingerprint, /^[0-9a-f]{8}$/);
		assert.equal(fingerprint.includes(KEY.slice(3, 11)), false);
		assert.equal(KEY.includes(fingerprint), false);
	});

	it("distinguishes two different keys", () => {
		assert.notEqual(fingerprintKey(KEY), fingerprintKey(`${KEY}x`));
	});

	it("is stable for the same key", () => {
		assert.equal(fingerprintKey(KEY), fingerprintKey(KEY));
	});
});

describe("stored key", () => {
	it("round-trips through a file of its own, never the extension config", () => {
		const written = writeStoredKey(agentDir, KEY);
		assert.equal(written.path, credentialsPath(agentDir));
		assert.equal(readStoredKey(agentDir), KEY);
		assert.equal(fs.existsSync(path.join(agentDir, "extensions", "subagent", "config.json")), false);
	});

	it("stores the key and nothing else", () => {
		writeStoredKey(agentDir, KEY);
		const stored = JSON.parse(fs.readFileSync(credentialsPath(agentDir), "utf-8"));
		assert.deepEqual(Object.keys(stored), ["siliconflowApiKey"]);
	});

	it("reports honestly whether the filesystem enforced owner-only permissions", () => {
		const written = writeStoredKey(agentDir, KEY);
		// Windows ignores POSIX modes; claiming protection we do not have would be
		// worse than saying so.
		assert.equal(written.ownerOnly, process.platform !== "win32");
		if (process.platform !== "win32") {
			assert.equal(fs.statSync(written.path).mode & 0o077, 0);
		}
	});

	it("replaces an existing key rather than appending a second one", () => {
		writeStoredKey(agentDir, KEY);
		writeStoredKey(agentDir, `${KEY}-second`);
		assert.equal(readStoredKey(agentDir), `${KEY}-second`);
	});

	it("returns null when nothing was ever stored", () => {
		assert.equal(readStoredKey(agentDir), null);
	});

	it("reports an unreadable credentials file instead of silently looking unset", () => {
		fs.mkdirSync(path.dirname(credentialsPath(agentDir)), { recursive: true });
		fs.writeFileSync(credentialsPath(agentDir), "{ not json");
		assert.throws(() => readStoredKey(agentDir), /credentials/i);
	});

	it("removes the stored key on request and reports whether there was one", () => {
		assert.equal(clearStoredKey(agentDir), false);
		writeStoredKey(agentDir, KEY);
		assert.equal(clearStoredKey(agentDir), true);
		assert.equal(readStoredKey(agentDir), null);
	});
});

describe("resolution order", () => {
	it("prefers the environment variable, so a script never picks up a stale stored key", () => {
		writeStoredKey(agentDir, KEY);
		const resolved = resolveEmbeddingKey({ agentDir, env: { [SYNAPSE_KEY_ENV]: `${KEY}-from-env` } });
		assert.equal(resolved.source, "env");
		assert.equal(resolved.key, `${KEY}-from-env`);
		assert.equal(resolved.storedAlsoPresent, true);
	});

	it("falls back to the stored key when the environment is silent", () => {
		writeStoredKey(agentDir, KEY);
		const resolved = resolveEmbeddingKey({ agentDir, env: {} });
		assert.equal(resolved.source, "file");
		assert.equal(resolved.key, KEY);
	});

	it("reports missing rather than an empty string when neither exists", () => {
		const resolved = resolveEmbeddingKey({ agentDir, env: {} });
		assert.equal(resolved.source, "missing");
		assert.equal(resolved.key, null);
		assert.equal(resolved.fingerprint, null);
	});

	it("ignores an environment variable that is blank", () => {
		writeStoredKey(agentDir, KEY);
		assert.equal(resolveEmbeddingKey({ agentDir, env: { [SYNAPSE_KEY_ENV]: "   " } }).source, "file");
	});

	it("carries a fingerprint so two keys can be told apart in a report", () => {
		const resolved = resolveEmbeddingKey({ agentDir, env: { [SYNAPSE_KEY_ENV]: KEY } });
		assert.equal(resolved.fingerprint, fingerprintKey(KEY));
	});
});
