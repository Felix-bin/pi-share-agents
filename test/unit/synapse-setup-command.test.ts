import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSynapseConfig } from "../../src/synapse/config.ts";
import { fingerprintKey, type ResolvedKey } from "../../src/synapse/credentials.ts";
import { parseSetupArgument, renderSynapseStatus, synapseModePatch, type SynapseStatus } from "../../src/synapse/setup-command.ts";

const KEY = "sk-abcdef0123456789abcdef";

function key(overrides: Partial<ResolvedKey> = {}): ResolvedKey {
	return {
		fingerprint: overrides.fingerprint === undefined ? null : overrides.fingerprint,
		key: overrides.key === undefined ? null : overrides.key,
		source: overrides.source ?? "missing",
		storedAlsoPresent: overrides.storedAlsoPresent ?? false,
	};
}

function status(overrides: Partial<SynapseStatus> = {}): SynapseStatus {
	return {
		config: overrides.config ?? resolveSynapseConfig({ mode: "synapse" }),
		configPath: overrides.configPath ?? "/home/dev/.pi/agent/extensions/subagent/config.json",
		key: overrides.key ?? key(),
		recordCount: overrides.recordCount ?? 0,
		semantic: overrides.semantic ?? { available: false, reason: "no embedding provider is configured" },
		storageRoot: overrides.storageRoot === undefined ? "/home/dev/.pi/agent/synapse/0123456789abcdef" : overrides.storageRoot,
		storeExists: overrides.storeExists ?? true,
	};
}

describe("argument parsing", () => {
	it("shows status when called with no argument", () => {
		assert.deepEqual(parseSetupArgument(""), { kind: "status" });
		assert.deepEqual(parseSetupArgument("   "), { kind: "status" });
	});

	it("accepts each mode, case-insensitively", () => {
		assert.deepEqual(parseSetupArgument("off"), { kind: "mode", mode: "off" });
		assert.deepEqual(parseSetupArgument("TEXT"), { kind: "mode", mode: "text" });
		assert.deepEqual(parseSetupArgument(" synapse "), { kind: "mode", mode: "synapse" });
	});

	it("explains the choices when the argument is not a mode", () => {
		const parsed = parseSetupArgument("hybrid");
		assert.equal(parsed.kind, "error");
		if (parsed.kind !== "error") return;
		assert.match(parsed.message, /off \/ text \/ synapse/);
	});

	it("accepts a request to clear the stored key", () => {
		assert.deepEqual(parseSetupArgument("key clear"), { kind: "key-clear" });
	});

	it("refuses a key pasted into the command rather than storing it", () => {
		// A key typed as a command argument lands in the session transcript, which
		// is exactly where a credential must never be.
		for (const argument of ["key sk-abcdef0123456789", "key=sk-abcdef0123456789", "sk-abcdef0123456789"]) {
			const parsed = parseSetupArgument(argument);
			assert.equal(parsed.kind, "error", argument);
			if (parsed.kind !== "error") continue;
			assert.match(parsed.message, /never paste|do not paste/i);
			assert.equal(parsed.message.includes("sk-abcdef0123456789"), false, "the message must not echo the secret");
		}
	});

	it("explains where the key comes from when asked", () => {
		assert.deepEqual(parseSetupArgument("key"), { kind: "key" });
	});
});

describe("mode switching", () => {
	it("writes the requested mode", () => {
		assert.deepEqual(synapseModePatch(undefined, "synapse"), { mode: "synapse" });
		assert.deepEqual(synapseModePatch({ mode: "off" }, "text"), { mode: "text" });
	});

	it("keeps unrelated settings", () => {
		const patched = synapseModePatch({ mode: "off", storageRoot: "/tmp/seq-01" }, "synapse");
		assert.deepEqual(patched, { mode: "synapse", storageRoot: "/tmp/seq-01" });
	});

	it("drops an explicit memory setting when switching off, instead of writing a config that will not load", () => {
		// memory=project with mode=off is rejected by the parser, so leaving it in
		// place would make the extension fail to start on the next session.
		const patched = synapseModePatch({ memory: "project", mode: "synapse" }, "off");
		assert.deepEqual(patched, { mode: "off" });
		assert.doesNotThrow(() => resolveSynapseConfig(patched));
	});

	it("produces a config the parser accepts for every mode", () => {
		for (const mode of ["off", "text", "synapse"] as const) {
			assert.equal(resolveSynapseConfig(synapseModePatch({ memory: "project", mode: "synapse" }, mode)).mode, mode);
		}
	});
});

describe("status rendering", () => {
	it("reports the active mode and where memory lives", () => {
		const text = renderSynapseStatus(status());
		assert.match(text, /mode: +synapse/);
		assert.match(text, /0123456789abcdef/);
	});

	it("says plainly that nothing is registered while off", () => {
		const text = renderSynapseStatus(status({ config: resolveSynapseConfig(undefined), storageRoot: null, storeExists: false }));
		assert.match(text, /mode: +off/);
		assert.match(text, /no tools are registered/i);
	});

	it("reports semantic retrieval as unavailable rather than implying it works", () => {
		const text = renderSynapseStatus(status());
		assert.match(text, /semantic/i);
		assert.match(text, /unavailable/i);
		assert.match(text, /no embedding provider is configured/, "and says which of the two reasons it is");
	});

	it("reports semantic retrieval as available, with the space, when an embedder can be built", () => {
		// The line used to be a constant. A user who had just configured a provider
		// and a working key read "unavailable" and had no way to tell a correct
		// setup from a broken one — the single question this command exists to
		// answer. This pins the other half of the pair.
		const text = renderSynapseStatus(status({ semantic: { available: true, representationId: "siliconflow/BAAI/bge-m3/1024" } }));
		assert.match(text, /semantic: +available — siliconflow\/BAAI\/bge-m3\/1024/);
		assert.doesNotMatch(text, /unavailable/);
	});

	it("shows how many memories the store holds", () => {
		assert.match(renderSynapseStatus(status({ recordCount: 12 })), /12/);
	});

	it("does not claim a count it could not read", () => {
		const text = renderSynapseStatus(status({ recordCount: "unavailable", storeExists: false }));
		assert.match(text, /unavailable|not created yet/i);
		assert.equal(/\b0 memories\b/.test(text), false);
	});

	it("reports where the key came from without printing it", () => {
		const fromEnv = renderSynapseStatus(status({ key: key({ fingerprint: fingerprintKey(KEY), key: KEY, source: "env" }) }));
		assert.match(fromEnv, /SILICONFLOW_API_KEY: set from the environment/);
		assert.match(fromEnv, new RegExp(fingerprintKey(KEY)));
		assert.equal(fromEnv.includes(KEY), false);
		assert.match(renderSynapseStatus(status()), /SILICONFLOW_API_KEY: not set/);
	});

	it("says which key is actually in effect when both sources have one", () => {
		const both = renderSynapseStatus(status({ key: key({ fingerprint: fingerprintKey(KEY), key: KEY, source: "env", storedAlsoPresent: true }) }));
		assert.match(both, /environment wins/);
	});

	it("names the stored file as the source when no environment variable is set", () => {
		assert.match(renderSynapseStatus(status({ key: key({ fingerprint: "abcd1234", key: KEY, source: "file" }) })), /stored credentials file/);
	});

	it("names the file a user would edit by hand", () => {
		assert.match(renderSynapseStatus(status()), /config\.json/);
	});

	it("says a mode change needs a new session, since tools register at startup", () => {
		assert.match(renderSynapseStatus(status()), /new session|restart|reload/i);
	});
});
