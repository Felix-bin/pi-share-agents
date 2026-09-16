import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

/**
 * The embedding API key: where it comes from and where it is kept.
 *
 * The environment variable always wins. An experiment or CI run sets it
 * explicitly, and a stale file left over from an interactive session must never
 * be able to override that choice silently.
 *
 * The key lives in a file of its own, never in the extension config: the
 * embedding provider, model and dimension are part of the reproducible
 * representation contract and belong in version-controlled configuration, while
 * the credential must not be anywhere near it.
 *
 * Nothing here ever prints the key. Reports carry a short fingerprint instead,
 * which is enough to tell two keys apart and useless for authenticating.
 */

export const SYNAPSE_KEY_ENV = "SILICONFLOW_API_KEY";

const CREDENTIALS_FILE = "credentials.json";
const MIN_KEY_LENGTH = 16;
const FINGERPRINT_LENGTH = 8;
const OWNER_ONLY = 0o600;

const StoredCredentialsSchema = Type.Object({ siliconflowApiKey: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const storedCredentialsValidator = Compile(StoredCredentialsSchema);

export type EnteredKey = { key: string; ok: true } | { ok: false; reason: string };

export type KeySource = "env" | "file" | "missing";

export type ResolvedKey = {
	fingerprint: string | null;
	key: string | null;
	source: KeySource;
	/** True when a stored key exists but the environment variable takes precedence. */
	storedAlsoPresent: boolean;
};

export function credentialsPath(agentDir: string): string {
	return path.join(agentDir, "synapse", CREDENTIALS_FILE);
}

/** A short, non-reversible identifier for a key, safe to show in a report. */
export function fingerprintKey(key: string): string {
	return createHash("sha256").update(key, "utf-8").digest("hex").slice(0, FINGERPRINT_LENGTH);
}

export function parseEnteredKey(raw: string): EnteredKey {
	const key = raw.trim();
	if (key.length === 0) return { ok: false, reason: "The entry was empty, so nothing was stored." };
	// Rejections never echo the value: repeating it would put the secret exactly
	// where this whole module exists to keep it out of.
	if (/\s/.test(key)) return { ok: false, reason: "That value contains whitespace, which usually means part of a line was pasted. Nothing was stored." };
	if (key.length < MIN_KEY_LENGTH) return { ok: false, reason: `That value is shorter than ${MIN_KEY_LENGTH} characters, so it is not a key. Nothing was stored.` };
	return { key, ok: true };
}

export function readStoredKey(agentDir: string): string | null {
	const target = credentialsPath(agentDir);
	let raw = "";
	try {
		raw = fs.readFileSync(target, "utf-8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`credentials file is not valid JSON: ${target}`);
	}
	if (!storedCredentialsValidator.Check(parsed)) {
		// Reported rather than ignored: a file that exists but cannot be read looks
		// identical to no key at all, and the user would have no idea why.
		throw new Error(`credentials file does not hold a key: ${target}`);
	}
	return parsed.siliconflowApiKey;
}

export function writeStoredKey(agentDir: string, key: string) {
	const target = credentialsPath(agentDir);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const temporary = `${target}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify({ siliconflowApiKey: key })}\n`, { encoding: "utf-8", mode: OWNER_ONLY });
		fs.renameSync(temporary, target);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
	let ownerOnly = false;
	try {
		fs.chmodSync(target, OWNER_ONLY);
		// Windows does not apply POSIX modes, so the mode bits are not evidence of
		// protection there and must not be reported as though they were.
		ownerOnly = process.platform !== "win32" && (fs.statSync(target).mode & 0o077) === 0;
	} catch {
		ownerOnly = false;
	}
	return { ownerOnly, path: target };
}

/** Removes a stored key. Returns whether one was there to remove. */
export function clearStoredKey(agentDir: string): boolean {
	const target = credentialsPath(agentDir);
	if (!fs.existsSync(target)) return false;
	fs.rmSync(target, { force: true });
	return true;
}

export function resolveEmbeddingKey(input: { agentDir: string; env: NodeJS.ProcessEnv }): ResolvedKey {
	const stored = readStoredKey(input.agentDir);
	const fromEnv = (input.env[SYNAPSE_KEY_ENV] ?? "").trim();
	if (fromEnv.length > 0) {
		return { fingerprint: fingerprintKey(fromEnv), key: fromEnv, source: "env", storedAlsoPresent: stored !== null };
	}
	if (stored !== null) {
		return { fingerprint: fingerprintKey(stored), key: stored, source: "file", storedAlsoPresent: true };
	}
	return { fingerprint: null, key: null, source: "missing", storedAlsoPresent: false };
}
