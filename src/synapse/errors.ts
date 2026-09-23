/**
 * The fixed error vocabulary for SYNAPSE.
 *
 * The categories are closed on purpose. Every failure a run can report maps to
 * one of them plus details, and none of them maps to a successful task outcome:
 * a memory that could not be written, a source that moved, or a state that
 * failed verification must never be able to turn a failed task into a completed
 * one.
 *
 * An error this module does not recognise is reported as `unclassified` rather
 * than folded into the nearest category. Bucketing an unhandled crash as, say,
 * `object-unavailable` would make it read in the run log like an ordinary
 * expected outcome, and the whole point of the fixed set is that the log can be
 * trusted.
 */

export const SYNAPSE_ERROR_CATEGORIES = [
	"configuration",
	"permission",
	"source-stale",
	"object-unavailable",
	"integrity",
	"representation",
	"persistence",
	"cancelled",
	"timeout",
] as const;

export type SynapseErrorCategory = (typeof SYNAPSE_ERROR_CATEGORIES)[number];

/** What a classifier returns when it does not recognise the failure. */
export type SynapseErrorClassification = SynapseErrorCategory | "unclassified";

/** Upstream's outcome vocabulary. SYNAPSE adds no state of its own. */
export type TaskOutcome = "cancelled" | "failed";

/**
 * Message prefixes this codebase raises, in match order. The list is ordered
 * because some prefixes are substrings of longer phrases.
 */
const PREFIX_CATEGORIES: readonly (readonly [string, SynapseErrorCategory])[] = [
	["not-authorised", "permission"],
	["outside-root", "permission"],
	["source-stale", "source-stale"],
	// A superseded record is retired evidence, not a missing object: the caller
	// should re-read the current version, which is the same remedy as staleness.
	["historical", "source-stale"],
	["source-missing", "object-unavailable"],
	["source-unreadable", "object-unavailable"],
	["object-unavailable", "object-unavailable"],
	["unknown-memory", "object-unavailable"],
	["orphan", "integrity"],
	["namespace-corrupt", "integrity"],
	// A stream that ended mid-frame lost data the sender believed it sent, the
	// same fact as a corrupt object failing its digest check.
	["frame-truncated", "integrity"],
	["integrity", "integrity"],
	// A residual that does not decode is corruption of a payload that already passed
	// its digest check, so it belongs in the same class as any other damaged object —
	// and in the recovery chain, which only object and integrity failures enter. Left
	// unclassified it would skip recovery entirely and fail as an unknown error.
	["decodeDelta:", "integrity"],
	// A state whose decoded vector does not mean what the query means is not a
	// damaged object — every digest matched — but it is unusable for the same
	// reason, and its remedy is the same: the recovery chain. It enters that class
	// under its own prefix so the failure stays identifiable in the detail column
	// instead of being indistinguishable from corruption.
	["state-verify:", "integrity"],
	["namespace-mismatch", "configuration"],
	["k-out-of-range", "configuration"],
	["summary-too-large", "configuration"],
	["query-required", "configuration"],
	// An endpoint path that cannot fit the kernel's sun_path budget is a bound
	// violation on a derived value, the same shape as k-out-of-range above.
	["uds-endpoint-path-too-long", "configuration"],
	// A declared frame length over the ceiling is the same shape: a value
	// rejected for being out of the bound the protocol allows.
	["frame-too-large", "configuration"],
	["stateRef-required", "configuration"],
	["invalid corpus snapshot id", "configuration"],
	["capability-unavailable", "representation"],
	["representation-mismatch", "representation"],
	["maxObjectBytes exceeded", "persistence"],
	["persistence", "persistence"],
	["cancelled", "cancelled"],
	["timeout", "timeout"],
];

/** Config rejections are phrased as settings, not as a prefixed code. */
const CONFIGURATION_PATTERN = /^synapse(\.[A-Za-z]+)* /;

// `cause` is the caught value: JavaScript permits throwing anything, so this
// function is the parsing boundary rather than a consumer of parsed input.
function messageOf(cause: unknown): string | null {
	return cause instanceof Error ? cause.message : null;
}

export function classifySynapseError(cause: unknown): SynapseErrorClassification {
	const message = messageOf(cause);
	if (message === null) return "unclassified";
	for (const [prefix, category] of PREFIX_CATEGORIES) {
		if (message.startsWith(prefix)) return category;
	}
	if (CONFIGURATION_PATTERN.test(message)) return "configuration";
	if (/ requires /.test(message)) return "configuration";
	return "unclassified";
}

export function taskOutcomeFor(classification: SynapseErrorClassification): TaskOutcome {
	return classification === "cancelled" ? "cancelled" : "failed";
}
