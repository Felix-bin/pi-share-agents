import type { SynapseMode } from "./config.ts";
import type { MemoryValidity } from "./memory-service.ts";

/**
 * Automatic context preparation and the compact receipt.
 *
 * Preparation only ever builds the injected memory section. The user's task and
 * its constraints are never part of the budget, so a tight budget can drop
 * recalled material but can never quietly shorten the instruction the agent was
 * given.
 *
 * The receipt is where an honest run is won or lost. A summary cannot promote a
 * failed task to a completed one, a stored memory is not acceptance of the task
 * that produced it, and an output reference is published only after the output
 * was verified — a reference to something unverified would let a later reader
 * treat missing work as delivered.
 */

export const SYNAPSE_RECEIPT_SUMMARY_BYTES = 2048;

export type HandoffCandidate = {
	contentId: string;
	memoryId: string;
	score: number;
	sourceAgent: string;
	sourcePath: string | null;
	summary: string;
	validity: MemoryValidity;
};

export type HandoffContextInput = {
	budgetBytes: number;
	candidates: readonly HandoffCandidate[];
	mode: SynapseMode;
	readBody: (memoryId: string) => string;
};

export type HandoffContext = {
	bytes: number;
	/** True when the section contains bodies rather than references. */
	carriedBodies: boolean;
	excludedByValidity: number;
	omitted: number;
	refs: string[];
	text: string;
};

export type ReceiptOutcome = "completed" | "failed" | "cancelled";
export type PersistenceStatus = "stored" | "failed" | "skipped";

export type ReceiptOutputRef = {
	bytes: number;
	contentId: string;
	verified: boolean;
};

export type ReceiptInput = {
	memoryRefs: readonly string[];
	meteringRef: string;
	outcome: ReceiptOutcome;
	outputRef: ReceiptOutputRef | null;
	persistence: PersistenceStatus;
	snapshotId: string;
	summary: string;
};

export type Receipt = {
	/** Whether the task itself was accepted. Never inferred from a summary. */
	accepted: boolean;
	memoryRefs: string[];
	meteringRef: string;
	outcome: ReceiptOutcome;
	outputRef: { bytes: number; contentId: string } | null;
	persistence: PersistenceStatus;
	snapshotId: string;
	summary: string;
	summaryTruncated: boolean;
};

function entryFor(candidate: HandoffCandidate, mode: SynapseMode, readBody: (memoryId: string) => string): string {
	const origin = candidate.sourcePath === null ? candidate.sourceAgent : `${candidate.sourceAgent} · ${candidate.sourcePath}`;
	const head = `- [${candidate.memoryId.slice(0, 12)}] (${origin}) ${candidate.summary}`;
	// In text mode the receiver has no store to read from, so the body has to
	// travel with the task; that cost is real and is what the text baseline
	// measures.
	return mode === "text" ? `${head}\n  ${readBody(candidate.memoryId)}` : head;
}

function truncateUtf8(text: string, limitBytes: number) {
	if (Buffer.byteLength(text, "utf-8") <= limitBytes) return { text, truncated: false };
	const buffer = Buffer.from(text, "utf-8").subarray(0, limitBytes);
	// Cutting at a fixed byte count can land inside a character. Decoding that
	// would substitute a 3-byte replacement character for the fragment and push
	// the result back over the limit, so the fragment is dropped instead.
	let start = buffer.length - 1;
	while (start > 0 && ((buffer[start] ?? 0) & 0xc0) === 0x80) start -= 1;
	const lead = buffer[start] ?? 0;
	const charLength = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
	const end = start + charLength <= buffer.length ? buffer.length : start;
	return { text: buffer.subarray(0, end).toString("utf-8"), truncated: true };
}

export function prepareHandoffContext(input: HandoffContextInput): HandoffContext {
	const empty: HandoffContext = { bytes: 0, carriedBodies: false, excludedByValidity: 0, omitted: 0, refs: [], text: "" };
	if (input.mode === "off") return empty;

	// Only material whose source still matches may be presented as current
	// evidence; a stale record stays retrievable on request but is never injected.
	const usable = input.candidates.filter((candidate) => candidate.validity === "current");
	const excludedByValidity = input.candidates.length - usable.length;
	const ranked = [...usable].sort((left, right) => {
		if (left.score !== right.score) return right.score - left.score;
		return left.memoryId < right.memoryId ? -1 : 1;
	});

	const lines: string[] = [];
	const refs: string[] = [];
	let bytes = 0;
	let omitted = 0;
	for (const candidate of ranked) {
		const entry = entryFor(candidate, input.mode, input.readBody);
		const addition = Buffer.byteLength(lines.length === 0 ? entry : `\n${entry}`, "utf-8");
		// Whole entries only: half an entry is not evidence, and a reference cut in
		// two cannot be resolved.
		if (bytes + addition > input.budgetBytes) {
			omitted += 1;
			continue;
		}
		lines.push(entry);
		refs.push(candidate.memoryId);
		bytes += addition;
	}

	const text = lines.join("\n");
	return {
		bytes: Buffer.byteLength(text, "utf-8"),
		carriedBodies: input.mode === "text" && lines.length > 0,
		excludedByValidity,
		omitted,
		refs,
		text,
	};
}

export function buildReceipt(input: ReceiptInput): Receipt {
	// An unverified output is not a deliverable. Dropping the reference and
	// marking persistence failed keeps the task outcome intact while making the
	// missing artefact impossible to mistake for a stored one.
	const verifiedOutput = input.outputRef !== null && input.outputRef.verified;
	const persistence: PersistenceStatus = input.outputRef !== null && !input.outputRef.verified ? "failed" : input.persistence;
	const summary = truncateUtf8(input.summary, SYNAPSE_RECEIPT_SUMMARY_BYTES);

	return {
		// Acceptance follows the task's own terminal state. Neither a stored memory
		// nor a confident summary can supply it.
		accepted: input.outcome === "completed",
		memoryRefs: [...input.memoryRefs],
		meteringRef: input.meteringRef,
		outcome: input.outcome,
		outputRef: verifiedOutput && input.outputRef !== null ? { bytes: input.outputRef.bytes, contentId: input.outputRef.contentId } : null,
		persistence,
		snapshotId: input.snapshotId,
		summary: summary.text,
		summaryTruncated: summary.truncated,
	};
}
