import * as fs from "node:fs";
import * as path from "node:path";
import type { CanonicalValue } from "./canonical-json.ts";
import { resolveSynapseConfig, representationIdOf, type SynapseConfig, type SynapseMode } from "./config.ts";
import { resolveConfiguredEmbedder } from "./embedding.ts";
import { resolveStorageRoot } from "./namespace.ts";
import { clearStoredKey, credentialsPath, fingerprintKey, resolveEmbeddingKey, parseEnteredKey, writeStoredKey, SYNAPSE_KEY_ENV } from "./credentials.ts";
import {
	parseSetupArgument,
	renderKeyCleared,
	renderKeyGuidance,
	renderKeyStored,
	renderModeChange,
	renderSynapseStatus,
	synapseModePatch,
	type SynapseConfigBlock,
	type SynapseSemanticStatus,
	type SynapseStatus,
} from "./setup-command.ts";

/**
 * Registration of `/synapse-setup`.
 *
 * Every side effect is injected: reading the raw config, persisting a mode, and
 * reporting text. That keeps the command's behaviour testable without a running
 * Pi, and keeps the decision about where configuration lives with the host.
 */

export type SetupCommandDeps = {
	agentDir: () => string;
	/**
	 * Asks the user for a value in a dialog. Absent in a headless session, where
	 * the command explains the environment variable instead of prompting.
	 */
	askSecret?: (title: string, placeholder: string) => Promise<string | undefined>;
	env: NodeJS.ProcessEnv;
	loadRawConfig: () => CanonicalValue | undefined;
	saveMode: (patch: SynapseConfigBlock) => void;
	sendText: (text: string) => void;
	worktreeRoot: () => string;
};

/**
 * The part of a command context this command uses. Declared structurally so a
 * test can stand in for Pi without building an agent runtime.
 */
export type SetupCommandContext = {
	hasUI: boolean;
	ui: { input: (title: string, placeholder?: string) => Promise<string | undefined> };
};

export type SetupCommandHost = {
	registerCommand: (
		name: string,
		command: {
			description: string;
			getArgumentCompletions?: (prefix: string) => { label: string; value: string }[];
			handler: (args: string, ctx: SetupCommandContext) => Promise<void>;
		},
	) => void;
};

/** What a user may type after the command name. */
const SETUP_COMPLETIONS: readonly { label: string; value: string }[] = [
	{ label: "off — stop recording; register no tools", value: "off" },
	{ label: "text — plain-text baseline, no cross-task memory", value: "text" },
	{ label: "synapse — shared memory across agents and tasks", value: "synapse" },
	{ label: "key — enter or review the embedding API key", value: "key" },
	{ label: "key clear — remove the stored key", value: "key clear" },
];

function countRecords(storageRoot: string): number | "unavailable" {
	try {
		return fs.readdirSync(path.join(storageRoot, "memory")).filter((entry) => entry.endsWith(".json")).length;
	} catch {
		// A store that has never been written has no memory directory yet; that is
		// not the same as failing to read one, but neither is it a count of zero
		// the user should read as "nothing was remembered".
		return "unavailable";
	}
}

/**
 * Whether a run would get an embedder, asked through the same call the run makes.
 *
 * Building the embedder here is what keeps the report honest: if this function
 * can build one, so can the delegation seam, because it is the same function
 * over the same configuration. No network call is made — the client is
 * constructed, not exercised.
 */
function semanticStatus(config: SynapseConfig, storageRoot: string | null): SynapseSemanticStatus {
	if (config.embedding === null) return { available: false, reason: "no embedding provider is configured" };
	if (storageRoot === null) return { available: false, reason: "no storage root is resolved, so no embedder can be built" };
	const embedder = resolveConfiguredEmbedder(config.embedding, storageRoot);
	if (embedder !== undefined) return { available: true, representationId: embedder.representationId };
	return {
		available: false,
		reason: `configured (${representationIdOf(config)}), but the embedder could not be built — the ${config.embedding.keyEnv} key is not readable from the environment or the stored credentials`,
	};
}

export function collectSynapseStatus(deps: SetupCommandDeps): SynapseStatus {
	const config = resolveSynapseConfig(deps.loadRawConfig());
	const configPath = path.join(deps.agentDir(), "extensions", "subagent", "config.json");
	if (config.mode === "off") {
		return {
			config,
			configPath,
			key: resolveEmbeddingKey({ agentDir: deps.agentDir(), env: deps.env }),
			recordCount: "unavailable",
			semantic: semanticStatus(config, null),
			storageRoot: null,
			storeExists: false,
		};
	}
	const resolved = resolveStorageRoot({
		agentDir: deps.agentDir(),
		override: config.storageRoot ?? undefined,
		worktreePath: deps.worktreeRoot(),
	});
	const storeExists = fs.existsSync(resolved.root);
	return {
		config,
		configPath,
		key: resolveEmbeddingKey({ agentDir: deps.agentDir(), env: deps.env }),
		recordCount: storeExists ? countRecords(resolved.root) : "unavailable",
		semantic: semanticStatus(config, resolved.root),
		storageRoot: resolved.root,
		storeExists,
	};
}

export async function runSetupCommand(argument: string, deps: SetupCommandDeps): Promise<void> {
	const parsed = parseSetupArgument(argument);
	if (parsed.kind === "error") {
		deps.sendText(parsed.message);
		return;
	}
	if (parsed.kind === "key-clear") {
		deps.sendText(renderKeyCleared(clearStoredKey(deps.agentDir()), credentialsPath(deps.agentDir())));
		return;
	}
	if (parsed.kind === "key") {
		await promptForKey(deps);
		return;
	}
	if (parsed.kind === "status") {
		deps.sendText(renderSynapseStatus(collectSynapseStatus(deps)));
		return;
	}

	const raw = deps.loadRawConfig();
	const previous: SynapseMode = resolveSynapseConfig(raw).mode;
	const patch = synapseModePatch(raw, parsed.mode);
	// Validate before writing: a config the parser rejects would stop the
	// extension from loading in the next session, which is a worse outcome than
	// refusing the change now.
	const validated = resolveSynapseConfig(patch);
	if (previous !== parsed.mode) deps.saveMode(patch);
	const storageRoot =
		validated.mode === "off"
			? null
			: resolveStorageRoot({ agentDir: deps.agentDir(), override: validated.storageRoot ?? undefined, worktreePath: deps.worktreeRoot() }).root;
	deps.sendText(renderModeChange(previous, parsed.mode, storageRoot));
}

/**
 * Asks for the key in a dialog rather than reading it from the command line, so
 * the value never enters the session transcript. Without a dialog — a headless
 * run — the command explains the environment variable instead of prompting.
 */
async function promptForKey(deps: SetupCommandDeps): Promise<void> {
	const agentDir = deps.agentDir();
	const resolved = resolveEmbeddingKey({ agentDir, env: deps.env });
	if (deps.askSecret === undefined) {
		deps.sendText(renderKeyGuidance(resolved, credentialsPath(agentDir)));
		return;
	}
	const entered = await deps.askSecret(`${SYNAPSE_KEY_ENV} (stored outside this transcript)`, "paste the key, or leave empty to cancel");
	if (entered === undefined) {
		deps.sendText("Cancelled. Nothing was stored.");
		return;
	}
	const validated = parseEnteredKey(entered);
	if (!validated.ok) {
		deps.sendText(validated.reason);
		return;
	}
	const written = writeStoredKey(agentDir, validated.key);
	deps.sendText(renderKeyStored(fingerprintKey(validated.key), written.path, written.ownerOnly, resolved.source === "env"));
}

export function registerSynapseSetupCommand(host: SetupCommandHost, deps: SetupCommandDeps): void {
	host.registerCommand("synapse-setup", {
		description: "Show SYNAPSE shared-memory status, or switch mode: /synapse-setup [off / text / synapse | key]",
		getArgumentCompletions: (prefix: string) => SETUP_COMPLETIONS.filter((item) => item.value.startsWith(prefix.trim().toLowerCase())),
		handler: async (args: string, ctx: SetupCommandContext) => {
			try {
				// The dialog comes from the command's own context: what the user
				// types there never becomes a chat message.
				const askSecret = ctx.hasUI ? (title: string, placeholder: string) => ctx.ui.input(title, placeholder) : undefined;
				await runSetupCommand(args, askSecret === undefined ? deps : { ...deps, askSecret });
			} catch (error) {
				// A malformed existing config must produce a readable message here
				// rather than an unhandled rejection in the command dispatcher.
				deps.sendText(`SYNAPSE setup failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});
}
