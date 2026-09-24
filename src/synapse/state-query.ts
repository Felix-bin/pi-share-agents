/**
 * The text a launch's state plane embeds as its retrieval query.
 *
 * The delegated message is the wrong query on its own: a retriever is handed a
 * whole plan, and one embedding of several kilobytes of steps, paths and
 * instructions averages them into a direction that ranks generic chunks. So the
 * query is, in order of preference:
 *
 * 1. the delegating agent's own answer — a line `State query: …` (or
 *    `状态查询：…`) in the message, which the sender writes because it knows what
 *    the child is looking for;
 * 2. otherwise the head of the message, whole lines up to a byte bound, which is
 *    where a task states what it is about before it lists how to do it.
 *
 * The rule is a pure function of the message, so the query a run embedded can be
 * recomputed from the task it was sent.
 */

/** Upper bound on the query's UTF-8 bytes; well inside any provider's input limit. */
export const SYNAPSE_STATE_QUERY_MAX_BYTES = 1024;

const EXPLICIT_QUERY_LINE = /^[ \t]*(?:State query|状态查询)[ \t]*[:：][ \t]*(.+?)[ \t]*$/im;

/** The host's own prefix on a delegated message; it says nothing about the task. */
const TASK_PREFIX = /^Task:[ \t]*/;

export type StateQuery = { source: "explicit" | "head"; text: string };

export function stateQueryOf(message: string): StateQuery {
	const explicit = EXPLICIT_QUERY_LINE.exec(message)?.[1];
	if (explicit !== undefined && explicit.length > 0) return { source: "explicit", text: boundedBytes(explicit) };
	return { source: "head", text: headLines(message.replace(TASK_PREFIX, "")) };
}

/** Whole lines while they fit; a first line longer than the bound is cut at a character. */
function headLines(text: string): string {
	const kept: string[] = [];
	let bytes = 0;
	for (const line of text.split("\n")) {
		const lineBytes = Buffer.byteLength(line, "utf-8") + (kept.length === 0 ? 0 : 1);
		if (bytes + lineBytes > SYNAPSE_STATE_QUERY_MAX_BYTES) break;
		kept.push(line);
		bytes += lineBytes;
	}
	const head = kept.join("\n").trim();
	return head.length > 0 ? head : boundedBytes(text.trim());
}

/** Cuts at a code point, never inside one: a split UTF-8 sequence would embed as noise. */
function boundedBytes(text: string): string {
	if (Buffer.byteLength(text, "utf-8") <= SYNAPSE_STATE_QUERY_MAX_BYTES) return text;
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const charBytes = Buffer.byteLength(char, "utf-8");
		if (bytes + charBytes > SYNAPSE_STATE_QUERY_MAX_BYTES) break;
		bytes += charBytes;
		end += char.length;
	}
	return text.slice(0, end);
}
