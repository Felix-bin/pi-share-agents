import { createHash } from "node:crypto";
import type { Embedder } from "../../src/synapse/embedding.ts";

/**
 * Deterministic embedder for tests and offline demos: each text's vector is
 * derived from sha256, so the same corpus always embeds to the same bytes with
 * zero network. It measures nothing semantic and must never reach a real run —
 * config.ts rejects its provider names for exactly that reason.
 */
export function createDeterministicEmbedder(dim: number, representationId = "deterministic-test/sha256/v1"): Embedder {
	function vectorOf(text: string): Float32Array {
		const values = new Float32Array(dim);
		for (let index = 0; index < dim; index += 1) {
			const digest = createHash("sha256").update(`${index}:${text}`, "utf-8").digest();
			values[index] = (digest[index % digest.length] ?? 0) / 255 - 0.5;
		}
		let normSquared = 0;
		for (const value of values) normSquared += value * value;
		const norm = Math.sqrt(normSquared);
		if (norm === 0) throw new Error("deterministic embedder produced a zero vector");
		for (let index = 0; index < dim; index += 1) values[index] = values[index]! / norm;
		return values;
	}
	return {
		async embedBatch(texts) {
			return texts.map((text) => ({ cached: false, latencyMs: 0, promptTokens: null, vector: vectorOf(text) }));
		},
		async embedQuery(text) {
			return { cached: false, latencyMs: 0, promptTokens: null, vector: vectorOf(text) };
		},
		representationId,
	};
}
