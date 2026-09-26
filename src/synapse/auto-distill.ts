import type { SynapseChildContract } from "./child-contract.ts";
import { createContentStore } from "./content-store.ts";
import { createMemoryStore, type MemoryProvenance, type MemoryRecord } from "./memory-store.ts";
import { captureSource } from "./source-fingerprint.ts";

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
 * and executor's output contracts produce, and an output without one files
 * nothing: its bullets mix findings with caveats, and a caveat recalled as
 * evidence costs the next task more than it saves. The body is capped, so a
 * memory never becomes a second copy of the answer itself.
 *
 * Failure posture: a line that cannot be embedded still lands as a record with
 * a null vector (keyword and tag recall still find it) while a warning says so
 * — sediment first, semantic ranking best-effort. A store failure is a warning
 * on the close path too, never a failed delegation: memory is a side condition
 * of the run, not a result of it.
 *
 * Authority: the write is the host's, made under a switch the operator turned
 * on, not the child's. The child's memory scope governs what the child's own
 * tools may do, and a read-only child gains nothing from this — it cannot write
 * a line of its choosing. A read-only retriever is, if anything, the role whose
 * findings are most worth keeping, so the scope is deliberately not consulted.
 */

/**
 * What a child is told when the host distills for it. Without this the role
 * prompts' "remember each finding" still stands, and a child records by hand
 * what the distiller records anyway: every such call is one more model turn
 * over the whole context, and E1 (2026-09-25) measured four to six of them per
 * round — plus the supersedes they provoke — for no memory the distiller would
 * not have written.
 */
export const AUTO_DISTILL_CHILD_NOTE = [
	"## Shared memory is recorded for you",
	"When you finish, the host records the ESTABLISHED lines of your final output in shared memory. Do not call `synapse_write` to record your findings; call it only to supersede a memory you found to be wrong.",
	"Memory the host recalled for this task, if any, is in this prompt already: search only for what it does not cover. A recalled item that cites a file was checked against that file when it was recalled, and the host retires it when the file changes: take it as established and do not reopen the file to prove it again.",
].join("\n");

const DEFAULT_MAX_LINES = 12;
const DEFAULT_MAX_CHARS = 400;

/** The memory-worthy lines of a completed child's output; never the whole body. */
export function distillMemoryLines(text: string, limits: { maxChars?: number; maxLines?: number; numberedItems?: boolean; statusOnly?: boolean } = {}): string[] {
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
	} else if (limits.statusOnly !== true) {
		// No status block: the output's own bullet lines are the best available
		// distillate, and a floor on length keeps headings out of memory.
		// A result block also takes numbered items: a plan is a numbered list, and
		// without its steps the block is a blind head the next stage must redeem.
		// Memory does not: a plan step is an instruction, not evidence to recall.
		const item = limits.numberedItems === true ? /^\s*(?:[-*]|\d+[.)])\s+(.{20,})$/ : /^\s*[-*]\s+(.{20,})$/;
		for (const line of lines) {
			const match = line.match(item);
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
	/**
	 * The child's worktree. When given, a line that cites a file in it is filed
	 * with that file's fingerprint, so the record retires when the file changes.
	 */
	worktreeRoot?: string;
};

/** A path-shaped token: at least one directory and an extension, an optional `:line` after it. */
const CITED_PATH = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+(?=[:`'")\],;\s]|$)/g;

/**
 * The fingerprint of the first worktree file a distilled line cites, or null.
 *
 * Without it a distilled record has no source, so it can never be invalidated
 * and a later child has no reason to take it as still true of the worktree:
 * E1's store held no auto-distilled record with a source at all, although most
 * of the lines named the file they came from.
 */
export function citedSource(line: string, worktreeRoot: string): NonNullable<MemoryRecord["source"]> | null {
	for (const match of line.matchAll(CITED_PATH)) {
		try {
			const captured = captureSource(worktreeRoot, match[0]);
			if (captured.status === "present") return captured.fingerprint;
		} catch {
			// A token outside the worktree is not a source; try the next one.
		}
	}
	return null;
}

export type AutoDistillResult = {
	/** Lines that became records. */
	written: number;
	/** Records stored without a vector because their embedding call failed. */
	withoutVector: number;
};

/** The topic a record is filed under: the delegated task's first 80 characters, whitespace collapsed. */
export const taskTopicOf = (taskText: string): string => {
	const trimmed = taskText.replace(/\s+/g, " ").trim();
	return trimmed.length > 0 ? trimmed.slice(0, 80) : "unattributed-task";
};

export async function autoDistillOutput(input: AutoDistillInput, output: string): Promise<AutoDistillResult> {
	// Memory takes only what the child vouched for in its status block. The
	// bullet fallback filed a summarizer's caveats ("this is only a wording
	// match…") as evidence, and a later planner handed those spent its reasoning
	// re-litigating them: +34k output tokens over ten MuSiQue rounds against the
	// arm without memory (2026-09-26 smoke runs v8+v9).
	const lines = distillMemoryLines(output, { ...input.limits, statusOnly: true });
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
		const source = input.worktreeRoot === undefined ? null : citedSource(line, input.worktreeRoot);
		memoryStore.publish({
			// The same rule the memory service applies: only verified source bytes make an observation.
			assurance: source === null ? "derived" : "observation",
			contentId,
			embedding: embedding ?? undefined,
			source: source ?? undefined,
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
