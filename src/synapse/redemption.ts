import { classifySynapseError, type SynapseErrorClassification } from "./errors.ts";
import { MEMORY_SECTION_HEADER } from "./handoff.ts";

/**
 * Handle redemption: turning the references an envelope carried into the bodies
 * the child actually reads.
 *
 * This is the receiving half of the exchange design §4.2 describes. Under the
 * `synapse` gear the parent stops putting recalled memory in the prompt and
 * sends handles instead; the bytes are only really saved if the body is read
 * here, on the receiving side, from a store both processes share.
 *
 * **Redemption is deterministic and happens at startup — it is not the model
 * deciding to call a tool.** That distinction is the whole reason this module
 * exists rather than the child being told "you may look these up". If
 * redemption depended on the model remembering, S4's A/B would record "the
 * model did not call the tool" as a quality deficit of the `synapse` gear,
 * which is measurement contamination rather than a finding.
 *
 * **Reading goes through the caller's own MemoryService and nothing else.** The
 * reader is injected, and every production caller passes the service the child
 * registered from its own contract — built with the child's scope, so
 * `isReadable` is asking about the child rather than about its parent. Reading
 * the CAS files directly would be faster and would silently discard that
 * projection: a child could redeem a handle it is not allowed to read, and the
 * refusal this module classifies as `permission` would never be raised at all.
 *
 * A refusal is not fatal. The two that matter are both ordinary facts about a
 * store rather than defects: a body that outlived its object (design §4.4 — the
 * objects live on tmpfs, so after a reboot *every* handle resolves to
 * `object-unavailable`, and that is the accepted behaviour) and a handle
 * outside this child's scope. Both are recorded and the child runs on with the
 * material it could read, because the alternative — failing the run — would
 * make a reboot, or a parent that recalled one record too broadly, destroy work
 * that had nothing to do with either.
 */

export type RedemptionRefusal = {
	category: SynapseErrorClassification;
	memoryId: string;
	reason: string;
};

export type RedeemedMemory = {
	memoryId: string;
	text: string;
};

export type RedemptionResult = {
	/** UTF-8 bytes of `section`, which is what the child is charged for reading. */
	bytes: number;
	/** Handles dropped because the remaining budget could not hold a whole entry. */
	omitted: number;
	redeemed: RedeemedMemory[];
	refusals: RedemptionRefusal[];
	/** The prompt section, empty when nothing was redeemed. */
	section: string;
};

/**
 * How much of a redeemed body the child's prompt carries. A longer body is
 * previewed and named: the child reads it by handle only when it needs it, so a
 * recalled record costs its preview rather than its whole text on every call.
 */
export const SYNAPSE_REDEMPTION_PREVIEW_BYTES = 300;

export type RedemptionInput = {
	budgetBytes: number;
	memoryRefs: readonly string[];
	/** Defaults to SYNAPSE_REDEMPTION_PREVIEW_BYTES. */
	previewBytes?: number;
	/**
	 * Reads one body. Must be backed by a MemoryService carrying this child's own
	 * scope; it is injected so that the budget arithmetic and the classification
	 * of a refusal can be proven without a store on disk.
	 */
	readBody: (memoryId: string) => string;
};

/** The longest prefix within `maxBytes` that does not split a character. */
function utf8Prefix(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf-8");
	if (bytes.byteLength <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end).toString("utf-8");
}

function entryFor(memory: RedeemedMemory, previewBytes: number): string {
	// The handle is echoed alongside the body so a reader of the transcript can
	// tell which record a passage came from — the parent no longer says.
	const total = Buffer.byteLength(memory.text, "utf-8");
	if (total <= previewBytes) return `- [${memory.memoryId.slice(0, 12)}]\n  ${memory.text}`;
	return `- [${memory.memoryId.slice(0, 12)}] (${total} B; full: synapse_read {"action":"get","memoryId":"${memory.memoryId}"})\n  ${utf8Prefix(memory.text, previewBytes)}…`;
}

export function redeemMemoryRefs(input: RedemptionInput): RedemptionResult {
	const entries: string[] = [];
	const redeemed: RedeemedMemory[] = [];
	const refusals: RedemptionRefusal[] = [];
	let bytes = 0;
	let omitted = 0;
	// A handle repeated in the envelope must not be charged to the budget twice,
	// and must not appear twice in the prompt.
	for (const memoryId of [...new Set(input.memoryRefs)]) {
		let text: string;
		try {
			text = input.readBody(memoryId);
		} catch (error) {
			// Classified from the cause itself, not from a string rebuilt out of it:
			// `classifySynapseError` reads `Error.message` and answers `unclassified`
			// for anything else, so handing it text would quietly collapse every
			// refusal below into one indistinguishable bucket.
			//
			// Classified where the refusal happens, so a scope refusal and a missing
			// object stay two different facts. Folding either into the other would
			// report an authorisation boundary working correctly as a broken store,
			// or a wiped tmpfs as a permissions problem.
			refusals.push({
				category: classifySynapseError(error),
				memoryId,
				reason: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		const memory: RedeemedMemory = { memoryId, text };
		const entry = entryFor(memory, input.previewBytes ?? SYNAPSE_REDEMPTION_PREVIEW_BYTES);
		const addition = Buffer.byteLength(entries.length === 0 ? entry : `\n${entry}`, "utf-8");
		// Whole entries only, as on the sending side: half a body is not evidence,
		// and a truncated one reads as though the record said less than it does.
		if (bytes + addition > input.budgetBytes) {
			omitted += 1;
			continue;
		}
		entries.push(entry);
		redeemed.push(memory);
		bytes += addition;
	}
	const body = entries.join("\n");
	const section = body.length === 0 ? "" : `${MEMORY_SECTION_HEADER}\n${body}`;
	return { bytes: Buffer.byteLength(body, "utf-8"), omitted, redeemed, refusals, section };
}
