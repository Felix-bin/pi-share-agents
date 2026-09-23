import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { CanonicalValue } from "./canonical-json.ts";
import { SYNAPSE_MODES, type SynapseConfig, type SynapseMode } from "./config.ts";
import { SYNAPSE_KEY_ENV, type KeySource, type ResolvedKey } from "./credentials.ts";

export { SYNAPSE_KEY_ENV };

/**
 * The `/synapse-setup` command: report what shared memory is doing right now,
 * and switch the mode without hand-editing JSON.
 *
 * The command never accepts a credential as an argument. A key typed into a
 * slash command lands in the session transcript, which is exactly where it must
 * not be, so an argument that looks like a key is refused without being echoed.
 * `/synapse-setup key` asks for it in a dialog instead, which the transcript
 * never sees, and stores it outside the extension config.
 *
 * Switching the mode rewrites config.json but cannot change the running
 * session: tools are registered when the extension activates. Every reply says
 * so rather than leaving the user to wonder why the tool list is unchanged.
 */

/** Parses the existing block before it is merged, rather than narrowing by typeof. */
const recordProbe = Compile(Type.Record(Type.String(), Type.Unknown()));

/**
 * The persisted `synapse` block. Settings this command does not understand are
 * preserved verbatim, so switching mode never silently drops one.
 */
export type SynapseConfigBlock = Record<string, CanonicalValue>;

/** A value that looks like a credential, however the user phrased it. */
const SECRET_PATTERN = /(^|[\s=])(sk|pk|api)[-_][A-Za-z0-9._-]{8,}/i;

export type SetupArgument =
	| { kind: "status" }
	| { kind: "mode"; mode: SynapseMode }
	| { kind: "key" }
	| { kind: "key-clear" }
	| { kind: "error"; message: string };

/**
 * Whether semantic retrieval is actually available, and why not when it is not.
 *
 * Answered by the same resolution the run path uses, so the report cannot drift
 * from what a run will do. It is not a probe of the provider — reaching out to it
 * from a status command would spend quota and fail for reasons that have nothing
 * to do with the configuration.
 */
export type SynapseSemanticStatus = { available: false; reason: string } | { available: true; representationId: string };

export type SynapseStatus = {
	config: SynapseConfig;
	configPath: string;
	key: ResolvedKey;
	recordCount: number | "unavailable";
	semantic: SynapseSemanticStatus;
	storageRoot: string | null;
	storeExists: boolean;
};

export function parseSetupArgument(raw: string): SetupArgument {
	const argument = raw.trim();
	if (argument.length === 0) return { kind: "status" };
	if (SECRET_PATTERN.test(argument)) {
		// Deliberately does not echo the argument: repeating it would copy the
		// secret into the transcript this refusal exists to keep it out of.
		return {
			kind: "error",
			message: `Never paste an API key into a command — it would be stored in this session's transcript. Set the ${SYNAPSE_KEY_ENV} environment variable instead, then run /synapse-setup to confirm it is visible.`,
		};
	}
	const normalised = argument.toLowerCase();
	if (normalised === "key") return { kind: "key" };
	if (normalised === "key clear" || normalised === "key-clear") return { kind: "key-clear" };
	const mode = SYNAPSE_MODES.find((candidate) => candidate === normalised);
	if (mode !== undefined) return { kind: "mode", mode };
	return {
		kind: "error",
		message: `Unknown argument ${JSON.stringify(argument)}. Usage: /synapse-setup [off / text / synapse | key | key clear]`,
	};
}

/**
 * The `synapse` block to persist for a mode change, preserving every other
 * setting. An explicit `memory` is dropped when switching off, because
 * `memory: project` with `mode: off` is rejected by the parser and would stop
 * the extension from loading in the next session.
 */
export function synapseModePatch(current: CanonicalValue | undefined, mode: SynapseMode) {
	const patched: SynapseConfigBlock = {};
	if (recordProbe.Check(current)) {
		for (const [key, value] of Object.entries(current)) patched[key] = value;
	}
	patched.mode = mode;
	if (mode === "off") delete patched.memory;
	return patched;
}

function describeKeySource(source: KeySource): string {
	if (source === "env") return "set from the environment";
	if (source === "file") return "set from the stored credentials file";
	return "not set";
}

function describeKey(key: ResolvedKey): string {
	const suffix = key.fingerprint === null ? "" : ` (fingerprint ${key.fingerprint})`;
	const shadowed = key.source === "env" && key.storedAlsoPresent ? "; a stored key exists but the environment wins" : "";
	return `${describeKeySource(key.source)}${suffix}${shadowed}`;
}

function describeRecords(status: SynapseStatus): string {
	if (!status.storeExists) return "store not created yet";
	return status.recordCount === "unavailable" ? "record count unavailable" : `${status.recordCount} memories`;
}

/**
 * The `semantic` line.
 *
 * This used to be a constant, and it said "unavailable — retrieval ranks by
 * keyword and tag only" whatever the configuration was. A user who had just
 * configured a provider and a working key read that line, believed the vector
 * path was off, and had no way to tell a correct setup from a broken one — which
 * is the one thing this command exists to answer.
 */
function describeSemantic(status: SynapseStatus): string {
	if (status.semantic.available) return `available — ${status.semantic.representationId}`;
	return `unavailable — ${status.semantic.reason}`;
}

export function renderSynapseStatus(status: SynapseStatus): string {
	const lines = [
		"SYNAPSE shared memory",
		"",
		`  mode:      ${status.config.mode}`,
		`  memory:    ${status.config.memory}`,
		`  store:     ${status.storageRoot ?? "(none while off)"}`,
		`  contents:  ${describeRecords(status)}`,
		`  semantic:  ${describeSemantic(status)}`,
		`  ${SYNAPSE_KEY_ENV}: ${describeKey(status.key)}`,
		`  config:    ${status.configPath}`,
		"",
	];

	if (status.config.mode === "off") {
		lines.push(
			"Shared memory is off: no tools are registered and no files are written.",
			"Run /synapse-setup synapse to turn it on.",
		);
	} else {
		lines.push(
			"Agents can call synapse_read (search / get) and synapse_write (remember / supersede).",
			"A memory recorded against a file is invalidated when that file changes, including uncommitted edits.",
			"Run /synapse-setup off to stop recording.",
		);
	}
	lines.push("", "A mode change takes effect in a new session — tools are registered when the extension starts.");
	return lines.join("\n");
}

export function renderKeyGuidance(key: ResolvedKey, credentialsFile: string): string {
	return [
		`Embedding key (${SYNAPSE_KEY_ENV}): ${describeKey(key)}`,
		"",
		"Two ways to provide it, in this order of precedence:",
		"  1. Environment variable — always wins, never stored:",
		`       PowerShell:  $env:${SYNAPSE_KEY_ENV} = "<key>"`,
		`       bash:        export ${SYNAPSE_KEY_ENV}="<key>"`,
		"  2. /synapse-setup key in an interactive session — prompts for the key and stores it in",
		`       ${credentialsFile}`,
		"",
		"The key is never written to the extension config and never appears in this transcript.",
		"Run /synapse-setup key clear to remove a stored key.",
		"",
		"It is not needed yet: retrieval ranks by keyword and tag, and a request for vector state fails with",
		"capability-unavailable rather than quietly falling back to keywords.",
	].join("\n");
}

export function renderKeyStored(fingerprint: string, credentialsFile: string, ownerOnly: boolean, shadowedByEnv: boolean): string {
	const lines = [`Stored the embedding key (fingerprint ${fingerprint}) in ${credentialsFile}.`];
	lines.push(
		ownerOnly
			? "The file is readable only by your user account."
			: "This filesystem does not enforce owner-only permissions, so the file is protected only by the directory it sits in.",
	);
	if (shadowedByEnv) {
		lines.push(`${SYNAPSE_KEY_ENV} is set in this environment and takes precedence, so the stored key will not be used here.`);
	}
	return lines.join("\n");
}

export function renderKeyCleared(removed: boolean, credentialsFile: string): string {
	return removed ? `Removed the stored key from ${credentialsFile}.` : `No stored key to remove (${credentialsFile} does not exist).`;
}

export function renderModeChange(previous: SynapseMode, next: SynapseMode, storageRoot: string | null): string {
	if (previous === next) return `SYNAPSE mode is already ${next}. Nothing changed.`;
	const lines = [`SYNAPSE mode: ${previous} → ${next}`];
	if (next === "off") {
		lines.push("No tools will be registered and nothing further is recorded. Existing memories are left on disk.");
	} else {
		lines.push(`Memories will be stored in ${storageRoot ?? "the project namespace under the Pi agent directory"}.`);
	}
	lines.push("Start a new session for this to take effect — tools are registered when the extension starts.");
	return lines.join("\n");
}
