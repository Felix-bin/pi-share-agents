import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CanonicalValue } from "../../src/synapse/canonical-json.ts";
import type { SynapseConfigBlock } from "../../src/synapse/setup-command.ts";
import { credentialsPath, fingerprintKey, readStoredKey, writeStoredKey } from "../../src/synapse/credentials.ts";
import {
	collectSynapseStatus,
	registerSynapseSetupCommand,
	runSetupCommand,
	type SetupCommandContext,
	type SetupCommandDeps,
} from "../../src/synapse/setup-registration.ts";

let agentDir = "";
let worktree = "";
let raw: CanonicalValue | undefined;
let saved: SynapseConfigBlock | null = null;
let sent: string[] = [];

function deps(overrides: Partial<SetupCommandDeps> = {}): SetupCommandDeps {
	const built: SetupCommandDeps = {
		agentDir: overrides.agentDir ?? (() => agentDir),
		env: overrides.env ?? {},
		loadRawConfig: overrides.loadRawConfig ?? (() => raw),
		saveMode: overrides.saveMode ?? ((patch) => { saved = patch; }),
		sendText: overrides.sendText ?? ((text) => sent.push(text)),
		worktreeRoot: overrides.worktreeRoot ?? (() => worktree),
	};
	// Left absent unless a test supplies one, so the headless path is the default.
	if (overrides.askSecret) built.askSecret = overrides.askSecret;
	return built;
}

beforeEach(() => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-setup-agent-"));
	worktree = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-setup-wt-"));
	raw = undefined;
	saved = null;
	sent = [];
});

afterEach(() => {
	fs.rmSync(agentDir, { force: true, recursive: true });
	fs.rmSync(worktree, { force: true, recursive: true });
});

describe("status", () => {
	it("reports the off default without creating anything", async () => {
		await runSetupCommand("", deps());
		assert.match(sent[0] ?? "", /mode: +off/);
		assert.deepEqual(fs.readdirSync(agentDir), []);
	});

	it("names the store and counts what is in it", async () => {
		raw = { mode: "synapse" };
		const status = collectSynapseStatus(deps());
		assert.ok(status.storageRoot);
		fs.mkdirSync(path.join(status.storageRoot ?? "", "memory"), { recursive: true });
		fs.writeFileSync(path.join(status.storageRoot ?? "", "memory", `${"a".repeat(64)}.json`), "{}");
		await runSetupCommand("", deps());
		assert.match(sent[0] ?? "", /1 memories/);
	});

	it("does not report zero for a store that was never created", async () => {
		raw = { mode: "synapse" };
		await runSetupCommand("", deps());
		assert.match(sent[0] ?? "", /not created yet/);
	});

	it("reports the key as present without printing it", async () => {
		raw = { mode: "synapse" };
		await runSetupCommand("", deps({ env: { SILICONFLOW_API_KEY: "sk-secret-value" } }));
		assert.match(sent[0] ?? "", /SILICONFLOW_API_KEY: set/);
		assert.equal((sent[0] ?? "").includes("sk-secret-value"), false);
	});
});

describe("mode switching", () => {
	it("persists the new mode and says a new session is needed", async () => {
		await runSetupCommand("synapse", deps());
		assert.deepEqual(saved, { mode: "synapse" });
		assert.match(sent[0] ?? "", /off → synapse/);
		assert.match(sent[0] ?? "", /new session/i);
	});

	it("writes nothing when the mode is already what was asked for", async () => {
		raw = { mode: "synapse" };
		await runSetupCommand("synapse", deps());
		assert.equal(saved, null);
		assert.match(sent[0] ?? "", /already synapse/);
	});

	it("keeps an experiment's storage root while switching mode", async () => {
		const isolated = path.join(agentDir, "runs", "seq-01");
		raw = { mode: "off", storageRoot: isolated };
		await runSetupCommand("synapse", deps());
		assert.deepEqual(saved, { mode: "synapse", storageRoot: isolated });
		assert.match(sent[0] ?? "", new RegExp(isolated.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
	});

	it("does not leave behind a config the extension would refuse to load", async () => {
		raw = { memory: "project", mode: "synapse" };
		await runSetupCommand("off", deps());
		assert.deepEqual(saved, { mode: "off" });
	});
});

describe("credentials", () => {
	it("refuses a key pasted as an argument and does not echo it", async () => {
		await runSetupCommand("key sk-live-abcdef012345", deps());
		assert.match(sent[0] ?? "", /never paste/i);
		assert.equal((sent[0] ?? "").includes("sk-live-abcdef012345"), false);
		assert.equal(saved, null);
	});

	it("explains where the key comes from in a session that cannot prompt", async () => {
		await runSetupCommand("key", deps());
		assert.match(sent[0] ?? "", /SILICONFLOW_API_KEY/);
		assert.match(sent[0] ?? "", /environment/i);
		assert.match(sent[0] ?? "", /credentials\.json/);
	});

	it("stores a key entered in the dialog, reporting only its fingerprint", async () => {
		const entered = "sk-abcdef0123456789abcdef0123456789";
		await runSetupCommand("key", deps({ askSecret: async () => entered }));
		assert.equal(readStoredKey(agentDir), entered);
		assert.match(sent[0] ?? "", new RegExp(fingerprintKey(entered)));
		assert.equal((sent[0] ?? "").includes(entered), false);
	});

	it("keeps the key out of the extension config", async () => {
		await runSetupCommand("key", deps({ askSecret: async () => "sk-abcdef0123456789abcdef0123456789" }));
		assert.equal(saved, null);
		assert.equal(fs.existsSync(path.join(agentDir, "extensions", "subagent", "config.json")), false);
	});

	it("warns that a stored key is shadowed while the environment variable is set", async () => {
		await runSetupCommand("key", deps({ askSecret: async () => "sk-abcdef0123456789abcdef0123456789", env: { SILICONFLOW_API_KEY: "sk-environment-key-value" } }));
		assert.match(sent[0] ?? "", /takes precedence/i);
	});

	it("stores nothing when the dialog is cancelled", async () => {
		await runSetupCommand("key", deps({ askSecret: async () => undefined }));
		assert.equal(readStoredKey(agentDir), null);
		assert.match(sent[0] ?? "", /cancelled/i);
	});

	it("rejects an implausible entry without echoing it", async () => {
		await runSetupCommand("key", deps({ askSecret: async () => "sk-too short" }));
		assert.equal(readStoredKey(agentDir), null);
		assert.equal((sent[0] ?? "").includes("sk-too short"), false);
	});

	it("removes a stored key on request", async () => {
		writeStoredKey(agentDir, "sk-abcdef0123456789abcdef0123456789");
		await runSetupCommand("key clear", deps());
		assert.equal(readStoredKey(agentDir), null);
		assert.match(sent[0] ?? "", /removed/i);
	});

	it("says plainly when there was nothing to remove", async () => {
		await runSetupCommand("key clear", deps());
		assert.match(sent[0] ?? "", /no stored key/i);
		assert.match(sent[0] ?? "", new RegExp(credentialsPath(agentDir).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
	});
});

describe("registration", () => {
	it("registers one command whose description lists the arguments", async () => {
		const registered: { description: string; name: string }[] = [];
		registerSynapseSetupCommand(
			{ registerCommand: (name, command) => registered.push({ description: command.description, name }) },
			deps(),
		);
		assert.equal(registered.length, 1);
		assert.equal(registered[0]?.name, "synapse-setup");
		assert.match(registered[0]?.description ?? "", /off \/ text \/ synapse/);
	});

	it("reports a broken config as a message instead of throwing at the dispatcher", async () => {
		raw = { mode: "hybrid" };
		let handler: ((args: string, ctx: SetupCommandContext) => Promise<void>) | undefined;
		registerSynapseSetupCommand({ registerCommand: (_name, command) => { handler = command.handler; } }, deps());
		assert.ok(handler);
		await assert.doesNotReject(async () => handler?.("", { hasUI: false, ui: { input: async () => undefined } }));
		assert.match(sent[0] ?? "", /SYNAPSE setup failed/);
		assert.match(sent[0] ?? "", /synapse\.mode must be one of/);
	});
});
