import type { AccessScope } from "./access.ts";
import type { MemoryValidity } from "./memory-service.ts";
import type { MemoryRecord } from "./memory-store.ts";
import { type MemoryQuery, searchMemories, type SemanticScoring } from "./retrieval.ts";

/**
 * Predicted-base selection for a delta handoff (query-top1).
 *
 * A residual is only cheap to decode if the receiver can rebuild the very same
 * base from the id alone, so the base is chosen out of retrieval order: the
 * first ranked record that still owns a usable vector. Two properties make this
 * the only admissible rule. It re-ranks nothing — a selector that promoted
 * records for merely carrying a vector would name a different base than the
 * retrieval path reports, and a calibration recorded against that order would
 * have measured a rule no run applies. And it adds no target-aware step: the
 * base is never chosen as the candidate nearest the vector being sent. That
 * nearest-cosine rule is the Python prototype's oracle policy, an optimistic
 * estimate rather than something a receiver can reproduce from the query, and
 * the prototype itself reports it separately from the honest numbers.
 *
 * The ranking this reads is the frozen shared retrieval, which scores records
 * partly by cosine to the query's own embedding. That is not the oracle: the
 * receiver holds the same query, memory and weights, so it reproduces the order
 * exactly, and the ban is on an extra selection step, not on retrieval.
 *
 * Null is a normal answer rather than a failure. Memory with no comparable
 * vector leaves the caller sending a full vector; a zero base would be cheaper
 * but the envelope's delta validation refuses a residual without a base id, so
 * the fallback has to happen at the caller.
 */

export type PredictedBase = {
	memoryId: string;
	/** The space the vector lives in, so a sender can refuse a cross-space residual. */
	representationId: string;
	vector: Float32Array;
};

export type PredictBaseInput = {
	query: MemoryQuery;
	/** Candidate records; authorisation filtering happens inside the ranking. */
	records: readonly MemoryRecord[];
	scope: AccessScope;
	/**
	 * When present, the ranking carries the frozen semantic weights and holds the
	 * vectors themselves. Absent means no query vector exists, and without one no
	 * base can be named at all.
	 */
	semantic?: SemanticScoring;
	/** Whether the record's source still backs it; the store's own check, injected. */
	validityOf: (record: MemoryRecord) => MemoryValidity;
};

export function selectPredictedBase(input: PredictBaseInput): PredictedBase | null {
	const { semantic } = input;
	if (semantic === undefined) return null;
	const ranked = searchMemories({
		includeSuperseded: false,
		query: input.query,
		records: input.records,
		scope: input.scope,
		semantic,
	});
	for (const entry of ranked) {
		const { record } = entry;
		if (record.embedding === null) continue;
		const vector = semantic.recordVectors.get(record.memoryId);
		// A record whose vector is absent from the map was not loadable in this run —
		// a foreign representation, an unreadable object — so it cannot carry a base
		// however strongly its text ranked.
		if (vector === undefined) continue;
		if (input.validityOf(record) !== "current") continue;
		// The caller reads this vector to quantize a base from it; a copy keeps that
		// read out of the map's storage.
		return { memoryId: record.memoryId, representationId: record.embedding.representationId, vector: new Float32Array(vector) };
	}
	return null;
}
