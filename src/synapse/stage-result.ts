import { distillMemoryLines, taskTopicOf } from "./auto-distill.ts";
import type { SynapseChildContract } from "./child-contract.ts";
import { createContentStore } from "./content-store.ts";
import { createMemoryStore, type MemoryProvenance } from "./memory-store.ts";
import { stageOutputKind } from "./roles.ts";

/**
 * The result half of the protocol: what a pipeline stage hands back.
 *
 * Without it, a stage's whole output travels to the orchestrator and from there
 * — pasted into the next task — to every later stage, and each of them rereads
 * it on every call. With it, the output travels once, into the shared store,
 * and the orchestrator receives a bounded block: the stage's status lines and
 * a handle that `synapse_read` resolves to the full text. A later stage that
 * needs the detail pulls it by handle; one that does not, never pays for it.
 *
 * Only the intermediate roles (planner, retriever, executor) are covered. The
 * summarizer's output is the deliverable the orchestrator answers with, and an
 * agent outside the pipeline is somebody's ad-hoc delegation whose caller
 * expects the answer itself. The lines come from the same frozen rule the
 * distiller uses, so a block and the memory it sediments agree on what the
 * stage established.
 */

export const STAGE_OUTPUT_TAG = "stage-output";
export const STAGE_RESULT_MAX_BYTES = 1536;
export const STAGE_RESULT_MAX_LINES = 12;
export const STAGE_RESULT_MAX_LINE_CHARS = 200;
/**
 * How the block offers the rest. A bare "Full text:" reads as the next step, and
 * E1-follow-up smoke runs (2026-09-26) saw the next stage redeem almost every
 * block it was handed, paying the block, the body and a model turn where the
 * inline text alone would have cost the body.
 */
export const STAGE_RESULT_FOOTER_LEAD = "Full text, only if a step needs a detail the lines above do not carry";
/** Of the line budget, the most that NOT ESTABLISHED may take, so open questions never crowd out findings. */
const MAX_OPEN_LINES = 4;
const HEAD_FALLBACK_BYTES = 1024;
const SUMMARY_WORDS = 12;

export type StageOutcome = {
	/** The CAS object holding the whole output. */
	contentId: string;
	/** The ESTABLISHED lines the block carries, for the receipt. */
	established: string[];
	fullBytes: number;
	memoryId: string;
	/** What the orchestrator receives in place of the output. */
	rendered: string;
	renderedBytes: number;
};

export function stageResultApplies(agent: string): boolean {
	return stageOutputKind(agent) !== null;
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf-8");

/** The longest prefix of `text` within `maxBytes`, never splitting a character. */
function utf8Head(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf-8");
	if (bytes.byteLength <= maxBytes) return text;
	let end = maxBytes;
	// Step back over continuation bytes (10xxxxxx) to a character boundary.
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end).toString("utf-8");
}

function clip(line: string): string {
	return line.length > STAGE_RESULT_MAX_LINE_CHARS ? `${line.slice(0, STAGE_RESULT_MAX_LINE_CHARS - 1)}…` : line;
}

/** The lines under NOT ESTABLISHED (inline remainder included), up to the next blank-line-separated block. */
function openLines(output: string): string[] {
	const lines = output.split(/\r?\n/);
	const at = lines.findIndex((line) => /^NOT ESTABLISHED:/i.test(line.trim()));
	if (at < 0) return [];
	const picked: string[] = [];
	for (const line of lines.slice(at)) {
		// A fence ends the prose the block can quote.
		if (line.trim().startsWith("```")) break;
		const cleaned = line.trim().replace(/^NOT ESTABLISHED:/i, "").replace(/^[-*\s]+/, "").trim();
		if (cleaned.length > 0) picked.push(clip(cleaned));
	}
	return picked;
}

export function renderStageResult(input: { agent: string; memoryId: string; output: string }): string {
	return renderParts(input).text;
}

function renderParts(input: { agent: string; memoryId: string; output: string }): { established: string[]; text: string } {
	const fullBytes = byteLength(input.output);
	const header = `[SYNAPSE result] agent=${input.agent} status=completed handle=${input.memoryId} bytes=${fullBytes}`;
	const inline = `${header} (full text inline)\n${input.output}`;
	if (byteLength(inline) <= STAGE_RESULT_MAX_BYTES) return { established: distillMemoryLines(input.output, { maxChars: STAGE_RESULT_MAX_LINE_CHARS, maxLines: STAGE_RESULT_MAX_LINES }), text: inline };

	const footer = `${STAGE_RESULT_FOOTER_LEAD}: synapse_read {"action":"get","memoryId":"${input.memoryId}"}`;
	const open = openLines(input.output).slice(0, MAX_OPEN_LINES);
	const vouched = input.output.split(/\r?\n/).some((line) => /^ESTABLISHED:/i.test(line.trim()));
	const established = distillMemoryLines(input.output, { maxChars: STAGE_RESULT_MAX_LINE_CHARS, maxLines: STAGE_RESULT_MAX_LINES - open.length, numberedItems: true });
	if (established.length === 0 && open.length === 0) {
		const room = STAGE_RESULT_MAX_BYTES - byteLength(`${header}\n\n\n${footer}`) - 80;
		const note = `(no ESTABLISHED lines; first ${HEAD_FALLBACK_BYTES} bytes follow, the rest is behind the handle)`;
		return { established: [], text: `${header}\n${note}\n${utf8Head(input.output, Math.min(HEAD_FALLBACK_BYTES, room))}\n${footer}` };
	}
	// Drop lines from the end of each block until the whole block fits; findings go last.
	const keptEstablished = [...established];
	const keptOpen = [...open];
	const compose = (): string => {
		const parts = [header];
		// Only a stage that wrote a status block vouched for its lines; a plan's steps are not findings.
		if (keptEstablished.length > 0) parts.push(vouched ? "ESTABLISHED:" : "KEY LINES:", ...keptEstablished.map((line) => `- ${line}`));
		if (keptOpen.length > 0) parts.push("NOT ESTABLISHED:", ...keptOpen.map((line) => `- ${line}`));
		parts.push(footer);
		return parts.join("\n");
	};
	let block = compose();
	while (byteLength(block) > STAGE_RESULT_MAX_BYTES && keptOpen.length + keptEstablished.length > 1) {
		if (keptOpen.length > 1 || keptEstablished.length <= 1) keptOpen.pop();
		else keptEstablished.pop();
		block = compose();
	}
	return { established: keptEstablished, text: block };
}

/** A block that stands in for its output: the header, not followed by "(full text inline)". */
const STAGE_BLOCK_HANDLE = /\[SYNAPSE result\] agent=([a-z][a-z-]*) status=completed handle=([0-9a-f]{64}) bytes=\d+(?!\d)(?! \(full text inline\))/g;
export const STAGE_REDEMPTION_BUDGET_BYTES = 49152;
export const STAGE_REDEMPTION_HEADER = "## Stage results handed to you, in full\nThe host read each [SYNAPSE result] block in your task by its handle; the whole text is below, so do not call synapse_read for those handles.";

/** A whole result block: its header up to the footer that names the same handle. */
const STAGE_BLOCK_WHOLE = /(\[SYNAPSE result\] agent=[a-z][a-z-]* status=completed handle=([0-9a-f]{64}) bytes=\d+)(?!\d)(?! \(full text inline\))[^\n]*\n[\s\S]*?synapse_read \{"action":"get","memoryId":"\2"\}/g;
export const STAGE_BLOCK_CONDENSED_NOTE = "(whole text handed to you at startup; read it by this handle if it is not there)";

/**
 * The task a redeeming role is sent: each result block cut to its header line.
 * The role is handed the whole text at startup (`redeemStageResults`), so the
 * block's lines would reach it twice; the header keeps the handle, which is
 * all the redemption reads.
 */
export function condenseStageBlocks(task: string): string {
	return task.replace(STAGE_BLOCK_WHOLE, (_whole, header: string) => `${header} ${STAGE_BLOCK_CONDENSED_NOTE}`);
}

export type StageRedemption = {
	/** UTF-8 bytes of `section`, what the child is charged for reading. */
	bytes: number;
	/** Handles left in the task because their whole text did not fit the budget or could not be read. */
	left: number;
	records: number;
	section: string;
};

/**
 * The full text behind every result block in a task, for a role that would
 * redeem them anyway (see `redeemsStageResults`). Deterministic and read at
 * startup, like recalled memory: the child is not left to spend a turn per
 * handle. Whole entries only — half a stage's output reads as though the stage
 * said less — and a handle that does not fit stays in the task for the child
 * to read itself.
 */
export function redeemStageResults(input: { budgetBytes?: number; prompt: string; readBody: (memoryId: string) => { text: string; totalBytes: number } }): StageRedemption {
	const budget = input.budgetBytes ?? STAGE_REDEMPTION_BUDGET_BYTES;
	const entries: string[] = [];
	const seen = new Set<string>();
	let used = 0;
	let left = 0;
	for (const match of input.prompt.matchAll(STAGE_BLOCK_HANDLE)) {
		const [, agent, memoryId] = match;
		if (seen.has(memoryId!)) continue;
		seen.add(memoryId!);
		let body: { text: string; totalBytes: number };
		try {
			body = input.readBody(memoryId!);
		} catch {
			left += 1;
			continue;
		}
		const entry = `### ${agent} (handle ${memoryId!.slice(0, 12)})\n${body.text}`;
		if (byteLength(body.text) < body.totalBytes || used + byteLength(entry) > budget) {
			left += 1;
			continue;
		}
		entries.push(entry);
		used += byteLength(entry);
	}
	if (entries.length === 0) return { bytes: 0, left, records: 0, section: "" };
	const section = [STAGE_REDEMPTION_HEADER, ...entries].join("\n\n");
	return { bytes: byteLength(section), left, records: entries.length, section };
}

export type PublishStageOutputInput = {
	agent: string;
	contract: SynapseChildContract;
	output: string;
	provenance: MemoryProvenance;
	taskText: string;
};

/**
 * Files the whole output as one record under the role's kind. No vector: the
 * record is reached by its handle, and automatic recall leaves stage outputs
 * out, so an embedding call here would buy nothing.
 */
export function publishStageOutput(input: PublishStageOutputInput): { bytes: number; contentId: string; memoryId: string } {
	const kind = stageOutputKind(input.agent);
	if (kind === null) throw new Error(`stage-result: ${input.agent} is not an intermediate pipeline role`);
	const storeRoot = input.contract.contract.storageRoot;
	const contentStore = createContentStore(storeRoot);
	const memoryStore = createMemoryStore(storeRoot, { contentStore });
	const contentId = contentStore.put(new TextEncoder().encode(input.output), "text/markdown");
	const firstLine = distillMemoryLines(input.output, { maxLines: 1 })[0] ?? input.output.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? input.agent;
	const record = memoryStore.publish({
		assurance: "derived",
		contentId,
		kind,
		operationId: `stage-output/${input.provenance.runId}/${input.agent}`,
		provenance: input.provenance,
		summary: firstLine.split(/\s+/).slice(0, SUMMARY_WORDS).join(" "),
		tags: [STAGE_OUTPUT_TAG, input.agent],
		taskTopic: taskTopicOf(input.taskText),
	});
	return { bytes: byteLength(input.output), contentId, memoryId: record.memoryId };
}

/** Publishes and renders for an intermediate role; null when the agent is not one or there is nothing to hand over. */
export function stageOutcomeFor(input: PublishStageOutputInput): StageOutcome | null {
	if (!stageResultApplies(input.agent) || input.output.trim().length === 0) return null;
	const published = publishStageOutput(input);
	const parts = renderParts({ agent: input.agent, memoryId: published.memoryId, output: input.output });
	return { contentId: published.contentId, established: parts.established, fullBytes: published.bytes, memoryId: published.memoryId, rendered: parts.text, renderedBytes: byteLength(parts.text) };
}
