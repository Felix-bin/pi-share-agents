import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { CanonicalValue } from "../../src/synapse/canonical-json.ts";
import { resolveSynapseConfig, SYNAPSE_DELIVERY_GEARS, SYNAPSE_MAX_EMBEDDING_DIM } from "../../src/synapse/config.ts";

const HOME = path.resolve("/home/dev");

function embedding(overrides: Record<string, CanonicalValue> = {}) {
	return {
		dim: 1024,
		endpoint: "https://api.siliconflow.cn/v1/embeddings",
		keyEnv: "SILICONFLOW_API_KEY",
		model: "BAAI/bge-m3",
		provider: "siliconflow",
		...overrides,
	};
}

describe("synapse config defaults", () => {
	it("is off when the extension config says nothing", () => {
		const config = resolveSynapseConfig(undefined, HOME);
		assert.equal(config.mode, "off");
		assert.equal(config.memory, "off");
		assert.equal(config.embedding, null);
		assert.equal(config.storageRoot, null);
		// Envelope delivery defaults to the file gear: the uds gear is one of S4's
		// experiment conditions and must never become the default path.
		assert.equal(config.deliveryGear, "file");
	});

	it("turns memory on with synapse mode and leaves the text baseline without it", () => {
		assert.equal(resolveSynapseConfig({ mode: "synapse" }, HOME).memory, "project");
		assert.equal(resolveSynapseConfig({ mode: "text" }, HOME).memory, "off");
	});

	it("lets an experiment state memory explicitly", () => {
		assert.equal(resolveSynapseConfig({ memory: "project", mode: "text" }, HOME).memory, "project");
		assert.equal(resolveSynapseConfig({ memory: "off", mode: "synapse" }, HOME).memory, "off");
	});

	it("refuses memory while the extension is off, instead of quietly storing nothing", () => {
		assert.throws(() => resolveSynapseConfig({ memory: "project", mode: "off" }, HOME), /must be off/);
	});
});

describe("synapse envelope delivery gear", () => {
	it("accepts an explicit uds gear", () => {
		assert.equal(resolveSynapseConfig({ deliveryGear: "uds", mode: "synapse" }, HOME).deliveryGear, "uds");
	});

	it("accepts an explicit file gear", () => {
		assert.equal(resolveSynapseConfig({ deliveryGear: "file", mode: "synapse" }, HOME).deliveryGear, "file");
	});

	it("rejects an unknown gear, naming the allowed set", () => {
		assert.throws(() => resolveSynapseConfig({ deliveryGear: "shm" }, HOME), /synapse\.deliveryGear must be one of file \/ uds/);
	});

	it("exposes exactly the gears the design fixes", () => {
		assert.deepEqual([...SYNAPSE_DELIVERY_GEARS], ["file", "uds"]);
	});
});

describe("synapse config strictness", () => {
	it("rejects an unknown key rather than ignoring it", () => {
		assert.throws(() => resolveSynapseConfig({ mode: "synapse", residualEnabled: true }, HOME), /not a known setting/);
	});

	it("rejects an unknown mode", () => {
		// The message must name the allowed values: a bare schema error would leave
		// the reader guessing what to write instead.
		assert.throws(() => resolveSynapseConfig({ mode: "hybrid" }, HOME), /synapse\.mode must be one of off \/ text \/ synapse/);
	});

	it("rejects a non-object", () => {
		assert.throws(() => resolveSynapseConfig("synapse", HOME), /must be object/);
		assert.throws(() => resolveSynapseConfig([], HOME), /must be object/);
	});

	it("rejects a non-positive budget", () => {
		assert.throws(() => resolveSynapseConfig({ contextBudgetBytes: 0 }, HOME), /synapse.contextBudgetBytes/);
		assert.throws(() => resolveSynapseConfig({ maxObjectBytes: -1 }, HOME), /synapse.maxObjectBytes/);
	});
});

describe("synapse storage root", () => {
	it("expands a home-relative root", () => {
		assert.equal(resolveSynapseConfig({ storageRoot: "~/runs/seq-01" }, HOME).storageRoot, path.join(HOME, "runs", "seq-01"));
	});

	it("keeps an absolute root as given", () => {
		const absolute = path.resolve("/tmp/seq-01");
		assert.equal(resolveSynapseConfig({ storageRoot: absolute }, HOME).storageRoot, path.normalize(absolute));
	});

	it("rejects a relative root, since an experiment sequence must name its own store", () => {
		assert.throws(() => resolveSynapseConfig({ storageRoot: "runs/seq-01" }, HOME), /absolute path/);
	});
});

describe("synapse embedding config", () => {
	it("accepts the v1 provider with every field stated", () => {
		const config = resolveSynapseConfig({ embedding: embedding(), mode: "synapse" }, HOME);
		assert.equal(config.embedding?.model, "BAAI/bge-m3");
		assert.equal(config.embedding?.dim, 1024);
	});

	it("requires every field that enters the representation id", () => {
		for (const missing of ["dim", "endpoint", "keyEnv", "model", "provider"]) {
			const partial = { ...embedding() } satisfies Record<string, CanonicalValue>;
			// SAFETY: `missing` comes from the literal list of this fixture's own keys.
			delete partial[missing as keyof typeof partial];
			assert.throws(() => resolveSynapseConfig({ embedding: partial, mode: "synapse" }, HOME), new RegExp(missing));
		}
	});

	it("refuses a test-only provider so a hash can never stand in for a semantic model", () => {
		for (const provider of ["deterministic-test", "fake", "hash"]) {
			assert.throws(() => resolveSynapseConfig({ embedding: embedding({ provider }), mode: "synapse" }, HOME), /test-only stub/);
		}
	});

	it("refuses an unknown provider", () => {
		assert.throws(() => resolveSynapseConfig({ embedding: embedding({ provider: "openai" }), mode: "synapse" }, HOME), /must be one of/);
	});

	it("refuses an inline key, which belongs in the environment", () => {
		assert.throws(
			() => resolveSynapseConfig({ embedding: embedding({ apiKey: "sk-live-secret" }), mode: "synapse" }, HOME),
			/not a known setting/,
		);
	});

	it("bounds the dimension", () => {
		assert.throws(() => resolveSynapseConfig({ embedding: embedding({ dim: 0 }), mode: "synapse" }, HOME), /synapse.embedding.dim/);
		assert.throws(
			() => resolveSynapseConfig({ embedding: embedding({ dim: SYNAPSE_MAX_EMBEDDING_DIM + 1 }), mode: "synapse" }, HOME),
			/synapse.embedding.dim/,
		);
	});
});
