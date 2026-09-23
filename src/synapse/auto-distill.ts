import type { SynapseChildContract } from "./child-contract.ts";
import { createContentStore } from "./content-store.ts";
import { createMemoryStore, type MemoryProvenance } from "./memory-store.ts";

/**
 * Host-side memory distillation: the deterministic path to memory reuse.
 *
 * Why it exists: the measured behaviour (P50, 2026-09-21 — thirty rounds, zero
 * `synapse_write` calls beyond the tool definitions' own text in the
 * transcripts) is that models rarely call the remember tool on their own, so a
 * memory plane whose reuse story depends on model goodwill accumulates nothing
 * and reuse cannot happen. The distiller runs after a delegation completes, on
 * the host, over the child's own final output: the child stays the authority on
 * what was found, and the host decides — by one frozen rule — what is worth
 * keeping. The rule keys on the `ESTABLISHED:` status block the retriever's
 * output contract produces, and falls back to the output's bullet lines when
 * that block is absent; either way the body is capped, so a memory never
 * becomes a second copy of the answer itself.
 *
 * Failure posture: a line that cannot be embedded still lands as a record with
 * a null vector (keyword and tag recall still find it) while a warning says so
 * — sediment first, semantic ranking best-effort. A store failure is a warning
 * on the close path too, never a failed delegation: memory is a side condition
 * of the run, not a result of it.
 */

const DEFAULT_MAX_LINES = 12;
const DEFAULT_MAX_CHARS = 400;

/** The memory-worthy lines of a completed child's output; never the whole body. */
export function distillMemoryLines(text: string, limits: { maxChars?: number; maxLines?: number } = {}): string[] {
	const maxChars = limits.maxChars ?? DEFAULT_MAX_CHARS;
	const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES;
	const lines = text.split(/\r?\n/);
	const establishedAt = lines.findIndex((line) => /^ESTABLISHED:/i.test(line.trim()));
	const picked: string[] = [];
	if (establishedAt >= 0) {
		// The status block runs to NOT ESTABLISHED or end of output; each non-empty
		// continuation is one fact the child itself vouched for.
		for (const line of lines.slice(establishedAt)) {
			if (/^NOT ESTABLISHED:/i.test(line.trim())) break;
			const cleaned = line.replace(/^ESTABLISHED:/i, "").replace(/^[-*\s]+/, "").trim();
			if (cleaned.length > 0) picked.push(cleaned);
		}
	} else {
		// No status block: the output's own bullet lines are the best available
		// distillate, and a floor on length keeps headings out of memory.
		for (const line of lines) {
			const match = line.match(/^\s*[-*]\s+(.{20,})$/);
			if (match !== null) picked.push(match[1]!.trim());
		}
	}
	return picked.map((line) => (line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line)).slice(0, maxLines);
}

export type DistillEmbedder = {
	embed: (text: string) => Promise<Float32Array>;
	representationId: string;
};

export type AutoDistillInput = {
	/** The embedder the launch already resolved; null leaves records keyword-only. */
	embedder: DistillEmbedder | null;
	limits?: { maxChars?: number; maxLines?: number };
	/** The delegation's identity material; provenance lands on every record. */
	provenance: MemoryProvenance;
	/** The delegated task text; the topic a later task is ranked against. */
	taskText: string;
	/** The child's contract, for the store root and the switch itself. */
	contract: SynapseChildContract;
};

export type AutoDistillResult = {
	/** Lines that became records. */
	written: number;
	/** Records stored without a vector because their embedding call failed. */
	withoutVector: number;
};

const taskTopicOf = (taskText: string): string => {
	const trimmed = taskText.replace(/\s+/g, " ").trim();
	return trimmed.length > 0 ? trimmed.slice(0, 80) : "unattributed-task";
};

export async function autoDistillOutput(input: AutoDistillInput, output: string): Promise<AutoDistillResult> {
	const lines = distillMemoryLines(output, input.limits);
	if (lines.length === 0 || !input.contract.autoDistill) return { written: 0, withoutVector: 0 };
	const storeRoot = input.contract.contract.storageRoot;
	const contentStore = createContentStore(storeRoot);
	const memoryStore = createMemoryStore(storeRoot, { contentStore });
	const taskTopic = taskTopicOf(input.taskText);
	let withoutVector = 0;
	for (const line of lines) {
		const contentId = contentStore.put(new TextEncoder().encode(line), "text/markdown");
		let embedding: { dim: number; objectId: string; representationId: string } | null = null;
		if (input.embedder !== null) {
			try {
				const vector = await input.embedder.embed(line);
				const buffer = Buffer.alloc(vector.length * 4);
				for (const [index, value] of vector.entries()) buffer.writeFloatLE(value, index * 4);
				embedding = { dim: vector.length, objectId: contentStore.put(new Uint8Array(buffer), "application/octet-stream"), representationId: input.embedder.representationId };
			} catch (error) {
				// Sediment first: the record still lands, keyword and tag recall can
				// still find it, and the warning keeps the gap visible rather than
				// silently degrading the whole memory plane to keyword-only.
				withoutVector += 1;
				console.warn(`[pi-subagents] synapse: auto-distill embedding failed for one line (${error instanceof Error ? error.message : String(error)})`);
			}
		}
		memoryStore.publish({
			assurance: "observation",
			contentId,
			embedding: embedding ?? undefined,
			kind: "evidence",
			operationId: `auto-distill/${input.provenance.runId}/${input.provenance.agent}`,
			provenance: input.provenance,
			summary: line.split(/\s+/).slice(0, 12).join(" "),
			tags: ["auto-distill"],
			taskTopic,
		});
	}
	return { written: lines.length, withoutVector };
}
