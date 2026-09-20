import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createCapabilityProbeCache, stateRetrievalProbeCheck, STATE_RETRIEVAL_PROBE, SYNAPSE_PROBE_FAILURE_TTL_MS, SYNAPSE_PROBE_TTL_MS } from "../../src/synapse/capability-probe.ts";
import { buildCorpus } from "../../src/synapse/corpus.ts";
import { createDeterministicEmbedder } from "../support/deterministic-embedder.ts";
import type { SynapseEmbeddingConfig } from "../../src/synapse/config.ts";

/**
 * The probe's own promises, independent of the negotiation wiring that will
 * consume them: the state-retrieval check verifies exactly what a consume would
 * touch (embedder constructible, pinned corpus loadable), and the cache holds a
 * result for its TTL then re-runs it — the §2.2 "verifiable promise" semantics
 * the prototype froze, with the one difference this build makes deliberate: the
 * result is advisory there and wired into negotiation here.
 */

const DIM = 8;
const KEY_ENV = "SYNAPSE_PROBE_TEST_KEY";
// The corpus must live in the representation the probe's embedding config
// claims — the probe verifies exactly that agreement — so the fixture builds it
// under the config's identity while keeping the deterministic, offline vectors.
const REPRESENTATION_ID = "paratera/probe-model/8";

let root = "";
let storageRoot = "";
let corpusRoot = "";
let snapshotId = "";
let originalKey: string | undefined;

const builder = createDeterministicEmbedder(DIM, REPRESENTATION_ID);

const embedding = (): SynapseEmbeddingConfig => ({
	dim: DIM,
	endpoint: "https://probe.invalid/v1/embeddings",
	keyEnv: KEY_ENV,
	model: "probe-model",
	provider: "paratera",
});
const representationId = REPRESENTATION_ID;

before(async () => {
	originalKey = process.env[KEY_ENV];
	process.env[KEY_ENV] = "probe-test-key";
	root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-probe-"));
	storageRoot = path.join(root, "store");
	corpusRoot = path.join(root, "work");
	fs.mkdirSync(corpusRoot, { recursive: true });
	fs.writeFileSync(path.join(corpusRoot, "alpha.md"), "# Alpha\n\nThe state plane carries a vector, not a transcript.\n");
	fs.writeFileSync(path.join(corpusRoot, "beta.md"), "# Beta\n\nA residual is quantised against a predicted base.\n");
	const built = await buildCorpus({ allowlist: [".md"], corpusRoot, embedder: builder, sourceCommit: "p".repeat(40), storageRoot });
	snapshotId = built.corpusSnapshotId;
});

after(() => {
	if (originalKey === undefined) delete process.env[KEY_ENV];
	else process.env[KEY_ENV] = originalKey;
	fs.rmSync(root, { force: true, recursive: true });
});

function probeInput(overrides: Partial<Parameters<typeof stateRetrievalProbeCheck>[0]> = {}) {
	return {
		corpusSnapshotId: snapshotId,
		embedding: embedding(),
		representationId,
		storageRoot,
		...overrides,
	};
}

describe("state-retrieval probe check", () => {
	it("passes when the embedder is constructible and the pinned corpus loads", () => {
		assert.equal(stateRetrievalProbeCheck(probeInput()), true);
	});

	it("fails when no embedding is configured", () => {
		assert.equal(stateRetrievalProbeCheck(probeInput({ embedding: null })), false);
	});

	it("fails when the key is absent, without touching any stored credential", () => {
		const saved = process.env[KEY_ENV];
		delete process.env[KEY_ENV];
		try {
			assert.equal(stateRetrievalProbeCheck(probeInput()), false);
		} finally {
			process.env[KEY_ENV] = saved;
		}
	});

	it("fails when the representation is not the corpus's space", () => {
		assert.equal(stateRetrievalProbeCheck(probeInput({ representationId: "other/model/8" })), false);
	});

	it("fails when the pinned snapshot is not published", () => {
		assert.equal(stateRetrievalProbeCheck(probeInput({ corpusSnapshotId: "a".repeat(64) })), false);
	});

	it("fails when the corpus vectors are truncated", () => {
		const vectors = path.join(storageRoot, "corpus", snapshotId, "vectors.f32");
		const original = fs.readFileSync(vectors);
		try {
			fs.writeFileSync(vectors, original.subarray(0, original.byteLength - 4));
			assert.equal(stateRetrievalProbeCheck(probeInput()), false);
		} finally {
			fs.writeFileSync(vectors, original);
		}
		assert.equal(stateRetrievalProbeCheck(probeInput()), true);
	});
});

describe("capability probe cache", () => {
	it("runs the check once per key within the TTL and reports the cached verdict", () => {
		let runs = 0;
		let clock = 1_000;
		const cache = createCapabilityProbeCache({ now: () => clock, ttlMs: SYNAPSE_PROBE_TTL_MS });
		assert.equal(cache.probe("k", () => {
			runs += 1;
			return true;
		}), true);
		clock += SYNAPSE_PROBE_TTL_MS - 1;
		assert.equal(cache.probe("k", () => {
			runs += 1;
			return false;
		}), true);
		assert.equal(runs, 1);
		assert.equal(cache.verified("k"), true);
	});

	it("holds a FAILURE for only the short window: a transient environment fact must not pin a delegation window to text", () => {
		let verdict = false;
		let clock = 1_000;
		const cache = createCapabilityProbeCache({ now: () => clock, ttlMs: SYNAPSE_PROBE_TTL_MS });
		assert.equal(cache.probe("k", () => verdict), false);
		// Within the failure TTL the verdict is still served without re-running.
		clock += SYNAPSE_PROBE_FAILURE_TTL_MS - 1;
		let runs = 0;
		assert.equal(cache.probe("k", () => {
			runs += 1;
			return verdict;
		}), false);
		assert.equal(runs, 0);
		// Past it — long before the pass TTL — the check re-runs and a revived
		// capability is trusted again.
		verdict = true;
		clock += 2;
		assert.equal(cache.probe("k", () => verdict), true);
	});

	it("re-runs an expired entry, so a revived capability is trusted again", () => {
		let verdict = false;
		let clock = 1_000;
		const cache = createCapabilityProbeCache({ now: () => clock, ttlMs: 100 });
		assert.equal(cache.probe("k", () => verdict), false);
		verdict = true;
		// The ttlMs is for passes; this entry is a failure, so it lives for the
		// failure window and no longer.
		clock += SYNAPSE_PROBE_FAILURE_TTL_MS + 1;
		assert.equal(cache.verified("k"), null);
		assert.equal(cache.probe("k", () => verdict), true);
	});

	it("keys are independent: one corpus's verdict does not answer for another", () => {
		const cache = createCapabilityProbeCache({ ttlMs: 10_000 });
		assert.equal(cache.probe(`${STATE_RETRIEVAL_PROBE}:a`, () => true), true);
		assert.equal(cache.probe(`${STATE_RETRIEVAL_PROBE}:b`, () => false), false);
		assert.equal(cache.verified(`${STATE_RETRIEVAL_PROBE}:a`), true);
		assert.equal(cache.verified(`${STATE_RETRIEVAL_PROBE}:b`), false);
		assert.equal(cache.verified("never-probed"), null);
	});

	it("clear() drops every verdict — the test/administration surface", () => {
		const cache = createCapabilityProbeCache({ ttlMs: 10_000 });
		assert.equal(cache.probe("k", () => true), true);
		cache.clear();
		assert.equal(cache.verified("k"), null);
		let runs = 0;
		assert.equal(cache.probe("k", () => {
			runs += 1;
			return true;
		}), true);
		assert.equal(runs, 1);
	});
});
