import { resolveConfiguredEmbedder } from "./embedding.ts";
import { loadCorpusVectors } from "./state-retrieval.ts";
import type { SynapseEmbeddingConfig } from "./config.ts";

/**
 * Runtime capability probing — the "verifiable promise" half of CNR
 * (`protocol/handshake.py` §2.2 in the Python prototype): a declared capability
 * that names probe items is only trusted once the probe has actually run and
 * passed, and the result is cached with a TTL rather than held forever.
 *
 * What the promise is — stated exactly, because it is narrower than "the state
 * path works": the state-retrieval probe verifies that the receiving side can
 * CONSTRUCT its embedder (key resolvable from the environment, provider client
 * buildable — no network call) and that the pinned corpus loads end to end
 * under the agreed representation (the same loader a consume would use, local
 * files only). It does NOT verify that the endpoint answers, that the key is
 * accepted, or that a real embedding call succeeds — those surface at send time
 * through the metered embedding-call events, not here. Materials quoting this
 * mechanism must say "constructibility and corpus loadability", never "the
 * provider was tested live".
 *
 * The prototype's own negotiate() never consumed its verification cache — the
 * verified set was queryable but advisory. This build wires the result into
 * negotiation (a failed probe takes the text path with an explicit reason and
 * a metering event), so the claim in the docstring becomes behaviour here; that
 * difference, and this one, are recorded in the migration coverage doc.
 */

/** Probe item names this build defines. */
export const SYNAPSE_PROBE_ITEMS = ["state-retrieval"] as const;
export type SynapseProbeItem = (typeof SYNAPSE_PROBE_ITEMS)[number];

export const STATE_RETRIEVAL_PROBE: SynapseProbeItem = "state-retrieval";

/** The prototype's default TTL (300 s) for a PASS, kept so the semantics travel. */
export const SYNAPSE_PROBE_TTL_MS = 300_000;
/**
 * A FAILURE is held for a much shorter window than a pass: a pass was expensive
 * to establish (it loads the corpus) and stable, while a failure is often a
 * transient environment fact — a key not yet injected into this process, a
 * corpus still being published — and re-testing a failing check is cheap
 * because it fails fast. Holding a false verdict for the full TTL would pin a
 * whole delegation window to the text path on a race; the prototype cached both
 * verdicts equally, and this deliberate deviation is documented here.
 */
export const SYNAPSE_PROBE_FAILURE_TTL_MS = 30_000;

export type StateRetrievalProbeInput = {
	corpusSnapshotId: string;
	/** The embedding configuration the receiving side would build from. */
	embedding: SynapseEmbeddingConfig | null;
	representationId: string;
	storageRoot: string;
};

/**
 * The state-retrieval probe check: true when the claim it backs holds right
 * now. Both failures are ordinary facts of the environment, so the check
 * returns booleans rather than throwing — an unreachable store is an unverified
 * promise, not an exceptional event.
 */
export function stateRetrievalProbeCheck(input: StateRetrievalProbeInput): boolean {
	if (input.embedding === null) return false;
	const embedder = resolveConfiguredEmbedder(input.embedding, input.storageRoot);
	if (embedder === undefined) return false;
	if (embedder.representationId !== input.representationId) return false;
	try {
		loadCorpusVectors(input.storageRoot, input.corpusSnapshotId, input.embedding.dim, input.representationId);
		return true;
	} catch {
		return false;
	}
}

export type CapabilityProbeCacheOptions = {
	now?: () => number;
	ttlMs?: number;
};

type CacheEntry = { ok: boolean; probedAt: number };

/**
 * Per-key verification results with the prototype's TTL semantics, one
 * deliberate deviation: an entry within its TTL answers without re-running the
 * check (passes live for ttlMs, failures only for SYNAPSE_PROBE_FAILURE_TTL_MS),
 * an expired entry is cleared and the next probe re-runs it. The key names the
 * facts the check depends on (store, snapshot, representation, embedding
 * config), so two launches against the same corpus share one verification and a
 * reconfigured store is a different key.
 */
export function createCapabilityProbeCache(options: CapabilityProbeCacheOptions = {}) {
	const ttlMs = options.ttlMs ?? SYNAPSE_PROBE_TTL_MS;
	const now = options.now ?? (() => Date.now());
	const entries = new Map<string, CacheEntry>();

	const live = (entry: CacheEntry): boolean => now() - entry.probedAt <= (entry.ok ? ttlMs : SYNAPSE_PROBE_FAILURE_TTL_MS);

	return {
		probe(key: string, run: () => boolean): boolean {
			const cached = entries.get(key);
			if (cached !== undefined && live(cached)) return cached.ok;
			const ok = run();
			entries.set(key, { ok, probedAt: now() });
			return ok;
		},
		/** The verified set a caller may report; null when nothing is cached or the verdict's TTL has passed. */
		verified(key: string): boolean | null {
			const cached = entries.get(key);
			if (cached === undefined || !live(cached)) return null;
			return cached.ok;
		},
		/** Drops every cached verdict. A test/administration surface: the production seam never calls it. */
		clear(): void {
			entries.clear();
		},
	};
}
