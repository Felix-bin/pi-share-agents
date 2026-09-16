import { isReadable, type AccessScope } from "./access.ts";
import type { MemoryRecord } from "./memory-store.ts";

/**
 * Deterministic keyword retrieval over shared memory (P1).
 *
 * Every record is scored on its own text alone. No corpus statistic such as IDF
 * takes part, so a record's score for a given query never drifts as the store
 * grows and a past run's ranking stays recomputable from its log — the property
 * the controlled comparison depends on.
 *
 * The semantic component is reported as `unavailable` rather than approximated.
 * A hash-based stand-in would look like a semantic score while measuring
 * nothing, which is exactly the substitution the design forbids.
 */

export const KEYWORD_WEIGHT = 0.6;
export const TAG_WEIGHT = 0.4;

export type SemanticComponent = number | "unavailable";

export type MemoryQuery = {
	tags?: string[];
	text: string;
};

export type MemorySearchResult = {
	components: { keyword: number; semantic: SemanticComponent; tag: number };
	historical: boolean;
	record: MemoryRecord;
	score: number;
};

export type MemorySearchInput = {
	includeSuperseded?: boolean;
	limit?: number;
	query: MemoryQuery;
	records: readonly MemoryRecord[];
	/** Required: scoring an unauthorised record would leak its summary. */
	scope: AccessScope;
};

// Latin/digit runs, or a single CJK ideograph. Word segmentation for Chinese
// would need a dictionary, and a stale dictionary is a silent recall change;
// per-character tokens keep the rule inspectable and stable across platforms.
const TOKEN_PATTERN = /[a-z0-9]+|[㐀-䶿一-鿿]/g;

export function tokenize(text: string): string[] {
	const matches = text.toLowerCase().match(TOKEN_PATTERN) ?? [];
	return [...new Set(matches)].sort();
}

function jaccard(left: readonly string[], right: readonly string[]): number {
	if (left.length === 0 || right.length === 0) return 0;
	const rightSet = new Set(right);
	let shared = 0;
	for (const token of left) {
		if (rightSet.has(token)) shared += 1;
	}
	const union = left.length + right.length - shared;
	return union === 0 ? 0 : shared / union;
}

function normalizeTags(tags: readonly string[]): string[] {
	return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))].sort();
}

export function searchMemories(input: MemorySearchInput): MemorySearchResult[] {
	const queryTokens = tokenize(input.query.text);
	const queryTags = normalizeTags(input.query.tags ?? []);
	if (queryTokens.length === 0 && queryTags.length === 0) return [];

	const scored: MemorySearchResult[] = [];
	for (const record of input.records) {
		// Authorisation is checked before scoring: a denied record must not reach
		// the ranking at all, or its summary could surface in the result set.
		if (!isReadable(record, input.scope)) continue;
		const historical = record.recordStatus !== "active";
		if (historical && input.includeSuperseded !== true) continue;
		// Summary and topic are scored separately and the better one wins. Pooling
		// them would let a long unrelated topic dilute an exact summary match.
		const keyword = Math.max(jaccard(queryTokens, tokenize(record.summary)), jaccard(queryTokens, tokenize(record.taskTopic)));
		const tag = jaccard(queryTags, normalizeTags(record.tags));
		const score = KEYWORD_WEIGHT * keyword + TAG_WEIGHT * tag;
		if (score <= 0) continue;
		scored.push({ components: { keyword, semantic: "unavailable", tag }, historical, record, score });
	}

	scored.sort((left, right) => {
		if (left.score !== right.score) return right.score - left.score;
		return left.record.memoryId < right.record.memoryId ? -1 : 1;
	});
	return input.limit === undefined ? scored : scored.slice(0, input.limit);
}
