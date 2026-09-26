import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BeforeProviderRequestEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { registerNativeSupervisorClient } from "../../intercom/native-supervisor-channel.ts";
import { permissionDecision } from "./permissions.ts";
import type { SteerRequest } from "../background/control-channel.ts";
import { RUNTIME_EXTENSION_ACK_EVENT, isRuntimeAcknowledgedExtensionId } from "./runtime-acknowledged-extensions.ts";
import { createStructuredOutputToolParameters, MISSING_STRUCTURED_ACCEPTANCE_REPORT_ERROR, validateStructuredOutputValue } from "./structured-output.ts";
import { validateAcceptanceReport } from "./acceptance.ts";
import { formatChildToolDiagnostic } from "./tool-availability.ts";
import { shouldBlockToolForBudget, toolBudgetBlockedMessage, toolBudgetSoftNudge } from "./tool-budget.ts";
import type { ResolvedToolBudget, SubagentState } from "../../shared/types.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { getAgentDir } from "../../shared/utils.ts";
import { registerChildWatchdog } from "../../watchdog/register-child.ts";
import type { ChildWatchdogConfig } from "../../watchdog/child-status.ts";
import { requestWatchdogPermission, type WatchdogPermissionRequest, type WatchdogPermissionResult } from "../../watchdog/permission-arbiter.ts";
import { SUBAGENT_WATCHDOG_WARNING_TYPE } from "../../watchdog/types.ts";
import { registerSynapseChildTools } from "../../synapse/child-contract.ts";
import type { SynapseToolsRegistration } from "../../synapse/register-tools.ts";
import { consumeRetrieveState, meteringLogPath } from "../../synapse/delegation.ts";
import { resolveConfiguredEmbedder } from "../../synapse/embedding.ts";
import { receiveEnvelopeViaUdsRoute, selectEnvelopeRoute } from "../../synapse/envelope-gear.ts";
import { nodeIdFor, readDeliveredEnvelope, stateEnvelopePath, verifyEnvelopeAgainstContract, type DeliveredEnvelope } from "../../synapse/envelope-inbox.ts";
import type { EnvelopeWire } from "../../synapse/envelope.ts";
import { createMeteringLog, type MeteringIdentity } from "../../synapse/metering.ts";
import { SYNAPSE_MAX_SEARCH_K } from "../../synapse/memory-service.ts";
import { AUTO_DISTILL_CHILD_NOTE } from "../../synapse/auto-distill.ts";
import { redeemMemoryRefs, type RedemptionResult } from "../../synapse/redemption.ts";
import { recallsMemory, redeemsStageResults } from "../../synapse/roles.ts";
import { redeemStageResults, type StageRedemption } from "../../synapse/stage-result.ts";
import type { StateRetrievalHit } from "../../synapse/state-retrieval.ts";
import type { UdsServerTransport } from "../../synapse/envelope-uds.ts";
import { registerWaitTool } from "../background/wait-tool.ts";
import { drainOutstandingWork } from "../background/auto-drain.ts";
import {
	childSupervisorMetadata,
	evaluateChildToolDiagnostic,
	type ChildPermissions,
	type ChildRuntimeConfig,
} from "./child-runtime-config.ts";

const STRUCTURED_OUTPUT_INSTRUCTIONS = [
	"This subagent step has a strict structured output contract.",
	"Your final action must be to call the `structured_output` tool with JSON matching the provided schema.",
	"Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step.",
].join("\n");

export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent, not the parent orchestrator.",
	"The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
	"Ignore prior parent-only orchestration instructions in inherited conversation history.",
	"Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
	"If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

export const CHILD_FANOUT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent with explicit fanout responsibility for this assigned task.",
	"The parent session owns final orchestration, acceptance, and follow-up implementation launches.",
	"You may use the `subagent` tool only for the fanout work explicitly requested in this task.",
	"Do not broaden yourself into general parent orchestration. Do not launch follow-up workers unless the task explicitly asks for that.",
	"The maxSubagentDepth cap still applies and may block further fanout.",
	"If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

const PARENT_ONLY_CUSTOM_MESSAGE_TYPES = new Set([
	"subagent-orchestration-instructions",
	"subagent-slash-result",
	"subagent-slash-text-result",
	"subagent-notify",
	"subagent_control_notice",
	"subagent-control",
	"subagent-control-notice",
]);
const SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN = /<name>\s*pi-subagents\s*<\/name>/;
const PROJECT_CONTEXT_XML_HEADER = "\n\n<project_context>\n\n";
const PROJECT_CONTEXT_LEGACY_HEADER = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_HEADER = "\n\nThe following skills provide specialized instructions for specific tasks.";
const DATE_HEADER = "\nCurrent date:";

function registerRuntimeExtensionAcknowledgements(pi: ExtensionAPI, sink: ((ids: string[]) => void) | undefined): void {
	if (!sink) return;
	const ids: string[] = [];
	let finalized = false;
	const acknowledge = (payload: unknown): undefined => {
		if (finalized || !payload || typeof payload !== "object") return undefined;
		const id = (payload as { id?: unknown }).id;
		if (isRuntimeAcknowledgedExtensionId(id)) ids.push(id);
		return undefined;
	};
	const finalize = (): undefined => {
		if (finalized) return undefined;
		finalized = true;
		sink(ids);
		return undefined;
	};
	try {
		const events = (pi as { events?: { on?: (event: string, handler: (payload: unknown) => unknown) => unknown } }).events;
		events?.on?.(RUNTIME_EXTENSION_ACK_EVENT, acknowledge);
		const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => void;
		onRuntimeEvent("agent_end", finalize);
		onRuntimeEvent("session_shutdown", finalize);
	} catch {
		// Acknowledgement collection is optional observability and must not affect child execution.
	}
}

function findSectionEnd(prompt: string, startIndex: number, nextHeaders: string[]): number {
	let endIndex = prompt.length;
	for (const header of nextHeaders) {
		const index = prompt.indexOf(header, startIndex);
		if (index !== -1 && index < endIndex) {
			endIndex = index;
		}
	}
	return endIndex;
}

export function stripProjectContext(prompt: string): string {
	const xmlStartIndex = prompt.indexOf(PROJECT_CONTEXT_XML_HEADER);
	if (xmlStartIndex !== -1) {
		const closingTag = "</project_context>";
		const closingIndex = prompt.indexOf(closingTag, xmlStartIndex + PROJECT_CONTEXT_XML_HEADER.length);
		if (closingIndex !== -1) {
			return `${prompt.slice(0, xmlStartIndex)}${prompt.slice(closingIndex + closingTag.length)}`;
		}
	}
	const legacyStartIndex = prompt.indexOf(PROJECT_CONTEXT_LEGACY_HEADER);
	if (legacyStartIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, legacyStartIndex + PROJECT_CONTEXT_LEGACY_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
	return `${prompt.slice(0, legacyStartIndex)}${prompt.slice(endIndex)}`;
}

const GLOBAL_CONTEXT_FILE_NAMES = new Set(["agents.md", "agents.override.md", "claude.md"]);

function canonicalDirectory(dir: string): string {
	try {
		return fs.realpathSync(dir);
	} catch {
		return path.resolve(dir);
	}
}

function expandContextPath(filePath: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	return filePath === "~"
		? home ?? filePath
		: /^~[\\/]/.test(filePath)
			? path.join(home ?? "~", filePath.slice(2))
			: filePath;
}

function isContextFilePath(filePath: string): boolean {
	return GLOBAL_CONTEXT_FILE_NAMES.has(path.basename(expandContextPath(filePath)).toLowerCase());
}

function isGlobalContextFile(filePath: string): boolean {
	const expanded = expandContextPath(filePath);
	if (!isContextFilePath(filePath)) return false;
	return canonicalDirectory(path.dirname(expanded)) === canonicalDirectory(getAgentDir());
}

function stripGlobalInstructionsFromXmlContext(context: string): string {
	const block = /<project_instructions\s+path=(["'])(.*?)\1\s*>[\s\S]*?<\/project_instructions>\s*/gi;
	return context.replace(block, (match, _quote: string, filePath: string) => isGlobalContextFile(filePath) ? "" : match);
}

function stripGlobalInstructionsFromLegacyContext(context: string): string {
	const sections = [...context.matchAll(/^## ([^\r\n]+)(?:\r?\n|$)/gm)]
		.filter((match) => isContextFilePath(match[1]!.trim()));
	let rewritten = "";
	let cursor = 0;
	for (let index = 0; index < sections.length; index++) {
		const section = sections[index]!;
		const start = section.index!;
		const end = sections[index + 1]?.index ?? context.length;
		rewritten += context.slice(cursor, start);
		if (!isGlobalContextFile(section[1]!.trim())) rewritten += context.slice(start, end);
		cursor = end;
	}
	return `${rewritten}${context.slice(cursor)}`;
}

export function stripGlobalContext(prompt: string): string {
	const rewrittenXml = prompt.replace(/<project_context>[\s\S]*?<\/project_context>/gi, (context) => {
		const rewritten = stripGlobalInstructionsFromXmlContext(context);
		return /<project_instructions\b/i.test(rewritten) ? rewritten : "";
	});
	const legacyStartIndex = rewrittenXml.indexOf(PROJECT_CONTEXT_LEGACY_HEADER);
	if (legacyStartIndex === -1) return rewrittenXml;
	const legacyEndIndex = findSectionEnd(rewrittenXml, legacyStartIndex + PROJECT_CONTEXT_LEGACY_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
	const legacyContext = rewrittenXml.slice(legacyStartIndex, legacyEndIndex);
	return `${rewrittenXml.slice(0, legacyStartIndex)}${stripGlobalInstructionsFromLegacyContext(legacyContext)}${rewrittenXml.slice(legacyEndIndex)}`;
}

export function stripInheritedSkills(prompt: string): string {
	const startIndex = prompt.indexOf(SKILLS_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + SKILLS_HEADER.length, [DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripSubagentOrchestrationSkill(prompt: string): string {
	return prompt
		.replace(/\n{0,2}<skill\s+name=["']pi-subagents["'][^>]*>[\s\S]*?<\/skill>\n{0,2}/g, "\n\n")
		.replace(/[ \t]*<skill>\s*[\s\S]*?<\/skill>\s*/g, (block) => SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN.test(block) ? "" : block);
}

function stripChildBoundaryInstructions(prompt: string): string {
	let rewritten = prompt;
	for (const boundary of [CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS, CHILD_FANOUT_BOUNDARY_INSTRUCTIONS]) {
		rewritten = rewritten.split(boundary).join("");
	}
	return rewritten.replace(/^(?:[ \t]*\r?\n)+/, "");
}

export function rewriteSubagentPrompt(
	prompt: string,
	options: { inheritProjectContext: boolean; inheritGlobalContext: boolean; inheritSkills: boolean; fanoutChild?: boolean; structuredOutput?: boolean },
): string {
	let rewritten = prompt;
	if (!options.inheritProjectContext) {
		rewritten = stripProjectContext(rewritten);
	}
	if (!options.inheritGlobalContext) {
		rewritten = stripGlobalContext(rewritten);
	}
	if (!options.inheritSkills) {
		rewritten = stripInheritedSkills(rewritten);
	}
	rewritten = stripSubagentOrchestrationSkill(rewritten);
	rewritten = stripChildBoundaryInstructions(rewritten);
	const boundary = options.fanoutChild ? CHILD_FANOUT_BOUNDARY_INSTRUCTIONS : CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS;
	const structured = options.structuredOutput ? `\n\n${STRUCTURED_OUTPUT_INSTRUCTIONS}` : "";
	return `${boundary}${structured}\n\n${rewritten}`;
}

function isParentOnlySubagentMessage(message: unknown): boolean {
	const m = message as { role?: string; customType?: string };
	if (m?.role !== "custom" || typeof m.customType !== "string") return false;
	if (m.customType === SUBAGENT_WATCHDOG_WARNING_TYPE) return true;
	return PARENT_ONLY_CUSTOM_MESSAGE_TYPES.has(m.customType);
}

function isSubagentToolResultMessage(message: unknown): boolean {
	const m = message as { role?: string; toolName?: string };
	return m?.role === "toolResult" && m.toolName === "subagent";
}

function isSubagentToolCallBlock(block: unknown): boolean {
	const b = block as { type?: string; name?: string };
	return b?.type === "toolCall" && b.name === "subagent";
}

const PORTABLE_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_PORTABLE_TOOL_ID_LENGTH = 64;
const COMPOSITE_TOOL_ID_APIS = new Set([
	"azure-openai-responses",
	"cursor-native",
	"openai-completions",
	"openai-responses",
]);
const PROMPT_CACHE_KEY_APIS = new Set([
	"azure-openai-responses",
	"openai-codex-responses",
	"openai-completions",
	"openai-responses",
]);

export function rewriteForkCacheProviderRequest(event: BeforeProviderRequestEvent, ctx: Pick<ExtensionContext, "model"> | undefined, forkCacheKey: string | undefined): unknown {
	const key = forkCacheKey?.trim();
	if (!key || !PROMPT_CACHE_KEY_APIS.has(ctx?.model?.api ?? "")) return undefined;
	if (!event || typeof event !== "object") return undefined;
	const payload = event.payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	if (typeof (payload as { prompt_cache_key?: unknown }).prompt_cache_key !== "string") return undefined;
	return { ...payload, prompt_cache_key: key };
}

function portableToolId(id: string): string {
	if (PORTABLE_TOOL_ID_PATTERN.test(id) && id.length <= MAX_PORTABLE_TOOL_ID_LENGTH) return id;
	const encoded = `tool_${Buffer.from(id).toString("base64url") || "empty"}`;
	if (encoded.length <= MAX_PORTABLE_TOOL_ID_LENGTH) return encoded;
	return `tool_${createHash("sha256").update(id).digest("base64url")}`;
}

function sanitizeToolHistoryMessage(message: unknown): unknown {
	const m = message as { role?: string; content?: unknown; toolCallId?: unknown };
	if (m?.role === "toolResult" && typeof m.toolCallId === "string") {
		const toolCallId = portableToolId(m.toolCallId);
		return toolCallId === m.toolCallId ? message : { ...m, toolCallId };
	}
	if (m?.role !== "assistant" || !Array.isArray(m.content)) return message;
	let changed = false;
	const content = m.content.map((block) => {
		const b = block as { type?: string; id?: unknown };
		if (b?.type !== "toolCall" || typeof b.id !== "string") return block;
		const id = portableToolId(b.id);
		if (id === b.id) return block;
		changed = true;
		return { ...b, id };
	});
	return changed ? { ...m, content } : message;
}

function stripAssistantSubagentToolCallBlocks(message: unknown): unknown | undefined {
	const m = message as { role?: string; content?: unknown };
	if (m?.role !== "assistant" || !Array.isArray(m.content)) return message;
	const filteredContent = m.content.filter((block) => !isSubagentToolCallBlock(block));
	if (filteredContent.length === m.content.length) return message;
	if (filteredContent.length === 0) return undefined;
	return { ...m, content: filteredContent };
}

export function stripParentOnlySubagentMessages(messages: unknown[], options: { sanitizeToolIds?: boolean; preserveFanoutToolHistory?: boolean } = {}): unknown[] {
	const preserveCurrentFanoutToolHistory = options.preserveFanoutToolHistory === true;
	const sanitizeToolIds = options.sanitizeToolIds ?? true;
	let changed = false;
	const filtered: unknown[] = [];
	for (const message of messages) {
		if (isParentOnlySubagentMessage(message) || (!preserveCurrentFanoutToolHistory && isSubagentToolResultMessage(message))) {
			changed = true;
			continue;
		}
		const stripped = preserveCurrentFanoutToolHistory ? message : stripAssistantSubagentToolCallBlocks(message);
		if (stripped === undefined) {
			changed = true;
			continue;
		}
		const sanitized = sanitizeToolIds ? sanitizeToolHistoryMessage(stripped) : stripped;
		if (stripped !== message || sanitized !== stripped) changed = true;
		filtered.push(sanitized);
	}
	return changed ? filtered : messages;
}

export function formatSteerMessage(request: SteerRequest): string {
	return [
		request.mode === "follow_up" ? "Queued follow-up from the parent orchestrator:" : "Mid-run steering from the parent orchestrator:",
		"",
		request.message,
		"",
		"Incorporate this guidance at the next safe point. Do not restart the task unless the guidance explicitly asks you to.",
	].join("\n");
}

export function registerPermissionGate(
	pi: ExtensionAPI,
	permissions: ChildPermissions | undefined,
	childWatchdog: ChildWatchdogConfig | undefined,
	requestPermission: (request: WatchdogPermissionRequest) => Promise<WatchdogPermissionResult> = requestWatchdogPermission,
): void {
	const rules = permissions?.rules;
	if (!rules || Object.keys(rules).length === 0) return;
	const rawWatchdogConfig = childWatchdog ? JSON.stringify(childWatchdog) : undefined;
	const timeoutMs = childWatchdog?.agentEndTimeoutMs ?? 30_000;
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: { toolName?: string; input?: unknown }, ctx: ExtensionContext) => unknown) => void;
	onRuntimeEvent("tool_call", async (event, ctx) => {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const decision = permissionDecision(rules, toolName);
		if (decision === "allow") return undefined;
		if (decision === "deny") return { block: true, reason: `Blocked by pi-subagents permission rule: '${toolName}' is denied.` };
		if (ctx.signal?.aborted) return { block: true, reason: "Blocked by pi-subagents permission rule: Watchdog permission decision was cancelled." };
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let abort: (() => void) | undefined;
		let result: WatchdogPermissionResult;
		try {
			result = await Promise.race([
				requestPermission({
					ctx,
					toolName,
					args: event.input ?? {},
					rawWatchdogConfig,
					auditPath: permissions.auditPath,
					...(ctx.signal ? { signal: ctx.signal } : {}),
				}),
				new Promise<WatchdogPermissionResult>((resolve) => {
					if (!ctx.signal) return;
					abort = () => resolve({ approved: false, reason: "Watchdog permission decision was cancelled.", source: "watchdog" });
					ctx.signal.addEventListener("abort", abort, { once: true });
				}),
				new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Watchdog permission decision timed out after ${timeoutMs}ms.`)), timeoutMs); }),
			]);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { block: true, reason: `Blocked by pi-subagents permission rule: Watchdog permission arbiter failed closed: ${reason}` };
		} finally {
			if (timeout) clearTimeout(timeout);
			if (abort) ctx.signal?.removeEventListener("abort", abort);
		}
		if (result.approved) return undefined;
		return { block: true, reason: `Blocked by pi-subagents permission rule: ${result.reason}` };
	});
}

/**
 * How this child will receive its envelope, decided once at registration.
 *
 * `none` covers every case in which nothing can arrive — no SYNAPSE contract,
 * or a `uds` endpoint this host cannot even address — and is therefore the
 * absent case, not a refusal.
 */
type EnvelopeReceipt =
	| { inbox: string; kind: "file" }
	| { kind: "none" }
	| { kind: "uds"; received: Promise<DeliveredEnvelope> };

export type SubagentPromptRuntimeDeps = {
	/**
	 * The AF_UNIX server the `uds` gear listens on. Unset in production, where
	 * the gear builds the real `node:net` one; supplied by tests, because this
	 * repository's sandbox cannot bind an AF_UNIX path at all.
	 */
	udsServerTransport?: UdsServerTransport;
};

/**
 * Opens the receiving end of the envelope delivery, before anything else this
 * child does.
 *
 * **The bind has to happen here, at registration, not at the first agent
 * turn.** The parent creates this child's session, publishes the envelope, and
 * only then prompts it; the `file` gear tolerates that order because a file
 * written before anyone reads it is still there to be read, but a socket does
 * not — bind late and the parent's connect has already failed, and the
 * envelope is gone with nothing to say so. Registration is the last moment
 * that is still strictly earlier than the parent's send. `receiveOnce` binds
 * synchronously inside the call this makes, so returning from here means the
 * endpoint is live.
 *
 * A gear that cannot be addressed at all degrades to `none` rather than
 * throwing: this runs during extension registration, where a throw would take
 * the child down before it ever started, and the outcome an unaddressable
 * endpoint produces is precisely "no envelope will arrive".
 */
function beginEnvelopeReceipt(config: ChildRuntimeConfig, deps: SubagentPromptRuntimeDeps): EnvelopeReceipt {
	const synapse = config.synapse;
	if (!synapse) return { kind: "none" };
	if (synapse.deliveryGearNote !== undefined) {
		// The contract already carries the substituted gear, so nothing below
		// behaves differently; this is the only place that says a substitution
		// happened at all.
		console.warn(`[pi-subagents] synapse: ${synapse.deliveryGearNote}`);
	}
	let route: ReturnType<typeof selectEnvelopeRoute>;
	try {
		route = selectEnvelopeRoute({
			childIndex: config.childIndex,
			deliveryGear: synapse.contract.deliveryGear,
			runId: synapse.runId,
			storageRoot: synapse.contract.storageRoot,
		});
	} catch (error) {
		console.warn(`[pi-subagents] synapse: envelope receipt skipped: ${error instanceof Error ? error.message : String(error)}`);
		return { kind: "none" };
	}
	if (route.gear === "file") return { inbox: route.address, kind: "file" };
	const received = receiveEnvelopeViaUdsRoute(route.address, deps.udsServerTransport).then((outcome) => {
		// Downgraded to absent because no byte ever arrived. Visible, because a
		// parent that meant to deliver and could not is worth seeing in a log,
		// but not fatal: an envelope that never came is upstream's own task.
		if (outcome.silentReason !== null) {
			console.warn(`[pi-subagents] synapse: no envelope arrived at ${route.address}: ${outcome.silentReason}`);
		}
		return outcome.delivered;
	});
	return { kind: "uds", received };
}

/**
 * Verifies the structured envelope the parent addressed to this child.
 *
 * An absent envelope is not a failure: the parent skips delegation whenever
 * negotiation refuses it or the meter cannot be opened, and the child then runs
 * exactly the task upstream would have sent. An envelope that is present but
 * does not describe this launch is a divergence, and the child refuses rather
 * than running work under a contract nobody chose.
 *
 * Returns nothing on the `file` gear and a promise on `uds`, rather than being
 * uniformly async. The distinction is load-bearing: a socket receive genuinely
 * cannot be awaited without one, while the `file` gear's read, its refusal and
 * the throw that carries it must stay exactly as synchronous as they were —
 * an `async` wrapper would turn that throw into a rejected promise and leave
 * the default path's refusal depending on whether the host happens to await
 * its event handlers.
 */
function verifyDeliveredEnvelope(config: ChildRuntimeConfig, receipt: EnvelopeReceipt): EnvelopeWire | null | Promise<EnvelopeWire | null> {
	if (receipt.kind === "none") return null;
	if (receipt.kind === "file") return checkDeliveredEnvelope(config, readDeliveredEnvelope(receipt.inbox));
	return receipt.received.then((delivered) => checkDeliveredEnvelope(config, delivered));
}

/**
 * The decision itself, identical for both gears: absent runs, rejected refuses,
 * ready is checked against the contract.
 *
 * The accepted wire is returned rather than dropped. It is the only thing that
 * names which memories this task was handed — the parent no longer puts them in
 * the prompt under the `synapse` gear — so discarding it after the check would
 * leave the child with nothing to redeem. `null` means there is nothing to
 * redeem, which an absent envelope genuinely is.
 */
function checkDeliveredEnvelope(config: ChildRuntimeConfig, delivered: DeliveredEnvelope): EnvelopeWire | null {
	const synapse = config.synapse;
	if (!synapse) return null;
	if (delivered.status === "absent") return null;
	if (delivered.status === "rejected") throw new Error(`SYNAPSE envelope rejected: ${delivered.reason}`);
	const mismatch = verifyEnvelopeAgainstContract({ contract: synapse.contract, wire: delivered.wire });
	if (mismatch !== null) throw new Error(`SYNAPSE envelope rejected: ${mismatch}`);
	return delivered.wire;
}

/**
 * Reads the bodies this task's handles name, through this child's own tools.
 *
 * Only the `synapse` mode redeems: under `text` the parent already put the
 * bodies in the prompt, and reading them again here would double both the bytes
 * and the section.
 *
 * The reader is the service the child's own memory tools dispatch to, so the
 * scope `isReadable` checks is the child's. Refusals are classified by
 * `redeemMemoryRefs` and surfaced here; none of them stops the run, because a
 * store wiped by a reboot (design §4.4) and a handle the parent recalled beyond
 * this child's reach are both facts about the material, not failures of the
 * task that was asked for.
 */
function redeemEnvelopeMemories(config: ChildRuntimeConfig, wire: EnvelopeWire, registration: SynapseToolsRegistration | undefined): RedemptionResult | undefined {
	const synapse = config.synapse;
	if (!synapse || synapse.contract.mode !== "synapse") return undefined;
	if (wire.memoryRefs.length === 0) return undefined;
	if (registration === undefined || !registration.registered) {
		// The handles arrived but this child has no memory tools to read them
		// with. Saying so beats a silently empty section: the parent stopped
		// sending bodies on the assumption that this side could fetch them.
		console.warn(`[pi-subagents] synapse: ${wire.memoryRefs.length} handle(s) could not be redeemed: memory tools are not registered in this child`);
		return undefined;
	}
	const budgetBytes = synapse.contextBudgetBytes;
	const result = redeemMemoryRefs({
		budgetBytes,
		memoryRefs: wire.memoryRefs,
		readBody: (memoryId) => registration.service().get({ limitBytes: budgetBytes, memoryId }).text,
	});
	for (const refusal of result.refusals) {
		console.warn(`[pi-subagents] synapse: handle ${refusal.memoryId} not redeemed (${refusal.category}): ${refusal.reason}`);
	}
	if (result.omitted > 0) {
		console.warn(`[pi-subagents] synapse: ${result.omitted} redeemed body/bodies did not fit the ${budgetBytes}-byte context budget`);
	}
	// The redeemed section enters the system prompt, off the wire the task is
	// metered on; recording it is what keeps the synapse arm's recalled context
	// in the account instead of making it look free.
	if (result.redeemed.length > 0) {
		try {
			const identity: MeteringIdentity = { agent: synapse.agent, attempt: 1, mode: synapse.contract.mode, nodeId: nodeIdFor(synapse.runId, config.childIndex), runId: synapse.runId, sessionId: wire.receiverSessionId, snapshotId: null };
			createMeteringLog(meteringLogPath(synapse.contract, synapse.runId)).record(identity, { bytes: result.bytes, kind: "memory-redeem", records: result.redeemed.length });
		} catch {
			// Metering the redemption must never be what costs the run.
		}
	}
	return result;
}

/**
 * Hands a role that acts on or concludes from the earlier stages their full
 * text at startup, read by the handles its task carries (see
 * `redeemsStageResults`). Metered as a redemption, so the bytes stay in the
 * account instead of looking free.
 */
function redeemTaskStageResults(config: ChildRuntimeConfig, prompt: string, registration: SynapseToolsRegistration | undefined): StageRedemption | undefined {
	const synapse = config.synapse;
	if (!synapse || synapse.contract.mode !== "synapse" || !redeemsStageResults(synapse.agent)) return undefined;
	if (registration === undefined || !registration.registered) return undefined;
	const result = redeemStageResults({
		prompt,
		readBody: (memoryId) => {
			const read = registration.service().get({ limitBytes: synapse.contextBudgetBytes * 16, memoryId });
			return { text: read.text, totalBytes: read.totalBytes };
		},
	});
	if (result.records > 0) {
		try {
			const identity: MeteringIdentity = { agent: synapse.agent, attempt: 1, mode: synapse.contract.mode, nodeId: nodeIdFor(synapse.runId, config.childIndex), runId: synapse.runId, sessionId: synapse.sessionId, snapshotId: null };
			createMeteringLog(meteringLogPath(synapse.contract, synapse.runId)).record(identity, { bytes: result.bytes, kind: "memory-redeem", records: result.records });
		} catch {
			// Metering the redemption must never be what costs the run.
		}
	}
	return result;
}

/**
 * The retrieve parameters the sender wrote into the envelope.
 *
 * Params travel as canonical JSON text, which the wire schema validates only as
 * a string — what they hold is the sender's choice, so the receiver checks the
 * shape it is about to use instead of trusting it. A payload that does not
 * carry the two fields this side needs is not consumable, and saying so is
 * better than recovering with a default the sender never chose.
 */
const RetrieveParamsSchema = Type.Object({
	k: Type.Integer({ maximum: SYNAPSE_MAX_SEARCH_K, minimum: 1 }),
	query: Type.String({ minLength: 1 }),
});
const retrieveParamsValidator = Compile(RetrieveParamsSchema);

function retrieveParamsOf(wire: EnvelopeWire): { k: number; query: string } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(wire.inputParamsJson);
	} catch {
		return null;
	}
	if (!retrieveParamsValidator.Check(parsed)) return null;
	return { k: parsed.k, query: parsed.query };
}

/**
 * The chunks a state handover selected, rendered for the child's own context.
 *
 * The plane carried a vector; what a model can act on is where the ranking put
 * it. Paths and line ranges are the honest rendering — the same fields the
 * memory tool would have returned had the child searched for itself — so the
 * handover is a shortcut rather than a second retrieval policy.
 */
function stateHitsMessage(result: { corpusSnapshotId: string; hits: readonly StateRetrievalHit[] }): string {
	const lines = result.hits.map((hit) => {
		const anchor = `- ${hit.path}:${hit.startLine}-${hit.endLine} (cosine ${hit.cosine.toFixed(4)})`;
		// A hit that names its first line lets the child recognise the region
		// before it reads; the anchor steers the first read, it never replaces it.
		return hit.preview ? `${anchor} — ${hit.preview}` : anchor;
	});
	return [
		"The delegating agent handed over a retrieval state for the shared corpus — a query vector, not the retrieved text.",
		`Ranking it in this session selected these chunks (corpus ${result.corpusSnapshotId.slice(0, 12)}):`,
		...lines,
		"Read the files for their contents; treat the ranking as a starting point, not as a summary.",
	].join("\n");
}

/** One warning line, never a throw: a state-plane problem must not cost the run. */
function warnState(stage: string, reason: string): void {
	console.warn(`[pi-subagents] synapse: ${stage} skipped: ${reason}`);
}

/**
 * Whether a consumed ranking is worth a steer message.
 *
 * A ranking that selected nothing has nothing for the child to act on, and the
 * message's whole content is the list — so steering it would spend context on
 * every later turn of that session to say "a vector arrived and selected
 * nothing", which reads as evidence where there is none. The fact is not lost:
 * the consume is metered whether or not a steer follows, so an experiment counts
 * empty rankings from the ledger rather than from the child's prompt.
 *
 * Exported because the choice is otherwise unpinnable: `buildCorpus` refuses an
 * empty corpus and the ranking applies no score floor, so no fixture can make a
 * real consumption return zero hits (review item §7.4, 2026-09-20).
 */
export function shouldSteerHits(hits: readonly StateRetrievalHit[]): boolean {
	return hits.length > 0;
}

/**
 * Consumes the state-plane envelope addressed to this child and steers the
 * session with what the ranking selected.
 *
 * Totality is the same one the sending seam keeps: an absent envelope means
 * this delegation never negotiated a state delivery and the child runs exactly
 * the task it was sent, and every other failure — an unreadable file, a
 * divergence from the contract, a refused payload — is recorded and skipped
 * rather than thrown. The delegate inbox is checked separately and *is* fatal
 * on divergence, because that one decides whether the launch was delegated at
 * all.
 *
 * `sessionId` is this child's own session id as the session manager reports it.
 * It labels the meter entries this consumption writes and nothing else: the
 * sender addresses the envelope to the id the host minted for the child
 * session, and the two strings are not reliably equal, so admission is bound to
 * the run, the node id and the sender identity instead. When the manager reports
 * nothing the entry carries the same placeholder an unattributed launch uses,
 * rather than a guess at which session this was.
 */
async function consumeStateEnvelope(config: ChildRuntimeConfig, sessionId: string, sendSteer: ((text: string) => void) | undefined): Promise<void> {
	const synapse = config.synapse;
	if (synapse === undefined) return;
	const contract = synapse.contract;
	// The ledger is opened before the first check, the same way the consumer opens
	// it before its own: a refusal this side makes is still a delivery that will
	// never be consumed, and an append-only log is the only place that fact can be
	// read back from. Recording it is what separates "the payload was refused" from
	// "nothing ever ran" for anyone reconciling sent against consumed.
	const log = createMeteringLog(meteringLogPath(contract, synapse.runId));
	const identity: MeteringIdentity = { agent: synapse.agent, attempt: 1, mode: contract.mode, nodeId: nodeIdFor(synapse.runId, config.childIndex), runId: synapse.runId, sessionId, snapshotId: null };
	const refuse = (reason: string): void => {
		log.record(identity, { category: "configuration", detail: reason, kind: "error" });
		warnState("state consumption", reason);
	};
	const delivered = readDeliveredEnvelope(stateEnvelopePath(contract.storageRoot, synapse.runId, config.childIndex));
	if (delivered.status === "absent") return;
	if (delivered.status === "rejected") return refuse(delivered.reason);
	const mismatch = verifyEnvelopeAgainstContract({ contract, wire: delivered.wire });
	if (mismatch !== null) return refuse(mismatch);
	const wire = delivered.wire;
	// Only a retrieve action carries state. Nothing this side publishes reaches
	// the state inbox without one, so an envelope here that carries no state is a
	// divergence rather than a delivery to ignore, and it is recorded as one.
	if (wire.action !== "retrieve" || wire.stateRef === null) {
		return refuse(`the state inbox holds a ${wire.action} envelope with no state payload`);
	}
	const params = retrieveParamsOf(wire);
	if (params === null) return refuse("the envelope's input parameters are not a retrieve query");
	let outcome: Awaited<ReturnType<typeof consumeRetrieveState>>;
	try {
		outcome = await consumeRetrieveState({
			contract,
			deps: {
				// The receiver's own provider re-embeds the query if recovery falls
				// back to text; the payload itself needs no embedder.
				embedder: resolveConfiguredEmbedder(synapse.embedding, contract.storageRoot),
				log,
			},
			envelope: wire,
			expectedSenderSessionId: synapse.sessionId,
			fallbackQuery: params.query,
			identity: { agent: synapse.agent, attempt: 1, childIndex: config.childIndex, runId: synapse.runId, sessionId },
			k: params.k,
			stateRecovery: "resend-then-text",
			worktreeRoot: synapse.worktreePath ?? process.cwd(),
		});
	} catch (error) {
		// consumeRetrieveState reports its own failures as outcomes; a throw here
		// means the seam itself broke, which is still not the child's problem.
		return refuse(error instanceof Error ? error.message : String(error));
	}
	if (outcome.kind === "text-fallback") {
		// The recovery ran and is metered, but its result is a memory ranking, not
		// the corpus ranking the state plane produces. Injecting it under the same
		// name would make the two kinds of hit indistinguishable in the child's
		// context, so the recovery's value stays what it is: the retrieval did not
		// fail, and the child's own tools cover the rest.
		return warnState("state hits", "the payload needed the text fallback, whose result is not a state ranking");
	}
	if (outcome.kind !== "consumed") return warnState("state consumption", outcome.reason);
	if (sendSteer === undefined) return;
	if (!shouldSteerHits(outcome.result.hits)) return;
	try {
		sendSteer(stateHitsMessage(outcome.result));
	} catch (error) {
		// Steering is best effort; the consume is already metered either way.
		warnState("state hit delivery", error instanceof Error ? error.message : String(error));
	}
}

function registerToolBudget(pi: ExtensionAPI, budget: ResolvedToolBudget | undefined): void {
	if (!budget) return;
	let toolCount = 0;
	let softNudged = false;
	const sendUserMessage = (pi as { sendUserMessage?: (content: string, options: { deliverAs: "steer" }) => unknown }).sendUserMessage;
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: { toolName?: string }) => unknown) => void;
	onRuntimeEvent("tool_call", (event) => {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		toolCount++;
		if (budget.soft !== undefined && toolCount >= budget.soft && !softNudged) {
			softNudged = true;
			try {
				sendUserMessage?.(toolBudgetSoftNudge(budget, toolCount), { deliverAs: "steer" });
			} catch {
				// Budget nudges are advisory; blocking below remains authoritative.
			}
		}
		if (!shouldBlockToolForBudget(budget, toolName, toolCount)) return undefined;
		return { block: true, reason: toolBudgetBlockedMessage(budget, toolName, toolCount) };
	});
}

function registerStructuredOutputTool(pi: ExtensionAPI, structured: NonNullable<ChildRuntimeConfig["structuredOutput"]>): void {
	const required = structured.acceptanceReport === "required";
	const parameters = createStructuredOutputToolParameters(structured.schema, { acceptanceReport: structured.acceptanceReport });
	const registerTool = pi.registerTool as unknown as (tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute: (_id: string, params: { value: unknown; acceptanceReport?: unknown }) => Promise<unknown>;
	}) => void;
	registerTool({
		name: "structured_output",
		label: "Structured Output",
		description: "Submit the required final structured output for this subagent step. This terminates the step.",
		parameters,
		async execute(_id: string, params: { value: unknown; acceptanceReport?: unknown }) {
			const validation = await validateStructuredOutputValue(structured.schema, params.value);
			if (validation.status === "invalid") {
				throw new Error(`Structured output validation failed: ${validation.message}`);
			}
			if (required && params.acceptanceReport === undefined) {
				throw new Error(MISSING_STRUCTURED_ACCEPTANCE_REPORT_ERROR);
			}
			if (required && params.acceptanceReport !== undefined) {
				const acceptanceValidation = validateAcceptanceReport(params.acceptanceReport, "acceptanceReport");
				if (!acceptanceValidation.report) {
					throw new Error(`Invalid structured output acceptance report: ${acceptanceValidation.errors.join("; ")}`);
				}
			}
			structured.capture(params.value, structured.acceptanceReport ? params.acceptanceReport : undefined);
			return {
				content: [{ type: "text", text: "Structured output captured." }],
				details: {},
				terminate: true,
			};
		},
	});
}

/** Register every child-side hook the prompt runtime owns for one child session. */
export default function registerSubagentPromptRuntime(
	pi: ExtensionAPI,
	config?: ChildRuntimeConfig,
	drainObservation?: import("./readonly-drain-observation.ts").ReadonlyDrainObservation,
	deps: SubagentPromptRuntimeDeps = {},
): void {
	// A path-based load has no ChildRuntimeConfig. This can happen if an
	// ambient-extension discovery path finds the runtime module in addition to
	// the configured inline factory. It must be inert rather than crashing the
	// child before startup; the inline factory remains the real registration path.
	if (!config) return;
	registerRuntimeExtensionAcknowledgements(pi, config.runtimeAcknowledgements);
	registerPermissionGate(pi, config.permissions, config.childWatchdog);
	registerToolBudget(pi, config.toolBudget);
	registerChildWatchdog(pi, config.childWatchdog, config.watchdogStatus);
	const waitState = config.runtimeState ?? {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as unknown as SubagentState;
	// A child whose wait tool is off never registers it at all: the definition
	// (~4.4 KB of description plus schema) would be billed on every request of
	// every retrieval-style child while there is no background work it could
	// ever resolve. The host process keeps the registered-but-disabled shape
	// for interactive sessions; a child only sees bg_wait when it can use it.
	//
	// A child whose allowlist names bg_wait still gets it when the tool is off —
	// in the disabled shape that returns immediately — because a named tool is a
	// required one and its absence would fail the child at its first turn.
	const waitToolRequired = config.requiredTools?.includes("bg_wait") === true;
	if ((config.waitTool.enabled || waitToolRequired) && typeof pi.registerTool === "function") {
		registerWaitTool(pi, waitState, config.waitTool.enabled, undefined, config.waitTool.defaultTimeoutMs);
	}
	// The child registers its own memory tools from the contract it was launched
	// with, so a delegated agent reads and writes the project's shared memory
	// under its own identity rather than the parent's.
	let synapseRegistration: SynapseToolsRegistration | undefined;
	if (config.synapse && typeof pi.registerTool === "function") {
		// The parent's worktree, not this process's cwd (see SynapseChildContract.worktreePath).
		synapseRegistration = registerSynapseChildTools(pi, config.synapse, config.synapse.worktreePath ?? process.cwd());
	}
	// The envelope is published after this session exists and immediately before
	// the task is sent, so it is checked at the first agent turn rather than at
	// session start, when the inbox is still empty. The flag is set only after a
	// clean check: a rejected envelope must keep refusing every later turn.
	//
	// Receiving, unlike checking, cannot wait for the first turn: see
	// beginEnvelopeReceipt. The `file` gear's receipt is just the inbox path, so
	// opening it here reads nothing and changes nothing about when it is read.
	const envelopeReceipt = beginEnvelopeReceipt(config, deps);
	let envelopeVerified = false;
	let redemption: RedemptionResult | undefined;
	let stageRedemption: StageRedemption | undefined;
	// Redemption is what the child does with an accepted envelope, so it belongs
	// to the same "once" as the check: a second turn must neither re-verify nor
	// pay to read the bodies again.
	const acceptEnvelope = (wire: EnvelopeWire | null): void => {
		envelopeVerified = true;
		if (wire !== null) redemption = redeemEnvelopeMemories(config, wire, synapseRegistration);
	};
	const verifyEnvelopeOnce = (): void | Promise<void> => {
		if (envelopeVerified) return;
		const pending = verifyDeliveredEnvelope(config, envelopeReceipt);
		if (!(pending instanceof Promise)) {
			acceptEnvelope(pending);
			return;
		}
		return pending.then(acceptEnvelope);
	};
	const supervisorMetadata = childSupervisorMetadata(config);
	let nativeSupervisorClientRegistered = false;
	const registerNativeSupervisorClientOnce = (): void => {
		if (nativeSupervisorClientRegistered) return;
		nativeSupervisorClientRegistered = true;
		registerNativeSupervisorClient(pi, supervisorMetadata);
	};
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: unknown, ctx?: ExtensionContext) => unknown) => void;
	// This child's own session id, for labelling meter entries this side writes.
	// It is deliberately not an admission input: see consumeStateEnvelope.
	let childSessionId: string | null = null;
	onRuntimeEvent("session_start", (_event: unknown, ctx?: ExtensionContext) => {
		const sessionManager = (ctx as { sessionManager?: Parameters<typeof resolveCurrentSessionId>[0] } | undefined)?.sessionManager;
		waitState.currentSessionId = sessionManager ? resolveCurrentSessionId(sessionManager) : null;
		try {
			childSessionId = sessionManager?.getSessionId() ?? null;
		} catch {
			childSessionId = null;
		}
		registerNativeSupervisorClientOnce();
	});
	// Consuming the state plane is best effort and fires once. It is deliberately
	// not awaited: the child is already running the task it was sent, and a state
	// payload that arrives a moment later is worth more than a first turn held
	// open for it.
	let stateConsumed = false;
	const consumeStateOnce = (): void => {
		if (stateConsumed) return;
		stateConsumed = true;
		void consumeStateEnvelope(config, childSessionId ?? "unattributed-session", (text) => {
			// Bound explicitly: an unbound call would depend on the host's method
			// never reading `this`, and a throw here would silently drop the hits.
			const send = (pi as { sendUserMessage?: (content: string, options: { deliverAs: "steer" }) => unknown }).sendUserMessage;
			send?.call(pi, text, { deliverAs: "steer" });
		}).catch((error: unknown) => {
			// The consumer records its refusals on the ledger, and the ledger itself
			// can fail (an unwritable store); nothing on this path may become an
			// unhandled rejection that takes the child's process down with it.
			warnState("state consumption", error instanceof Error ? error.message : String(error));
		});
	};
	const checkRequiredTools = (): undefined => {
		if (!config.requiredTools) return;
		const diagnostic = evaluateChildToolDiagnostic(config, pi.getAllTools().map((tool) => tool.name));
		config.toolDiagnostic?.(diagnostic);
		if (diagnostic) throw new Error(formatChildToolDiagnostic(diagnostic));
		return;
	};
	onRuntimeEvent("agent_start", () => {
		const pending = verifyEnvelopeOnce();
		// Only the `uds` gear produces a promise here. Returning one where none
		// existed before would make this handler asynchronous for every child,
		// including the ones whose refusals are raised synchronously today.
		// State consumption follows a clean check on either path, as it always
		// did: a rejected envelope throws before the state plane is touched.
		if (pending !== undefined) {
			return pending.then(() => {
				consumeStateOnce();
				return checkRequiredTools();
			});
		}
		consumeStateOnce();
		return checkRequiredTools();
	});
	onRuntimeEvent("agent_end", async (_event: unknown, ctx: unknown) => {
		if ((ctx as { hasUI?: boolean } | undefined)?.hasUI === true) drainObservation?.deny();
		if (drainObservation) {
			try {
				if ((ctx as ExtensionContext)?.sessionManager?.getSessionFile() !== waitState.currentSessionId) drainObservation.deny();
			} catch { drainObservation.deny(); }
		}
		config.holdFinalDrain?.(true);
		try {
			await drainOutstandingWork({ state: waitState, events: pi.events, hasPendingSupervisorRequest: config.hasPendingSupervisorRequest }, drainObservation);
		} finally {
			config.holdFinalDrain?.(false);
		}
	});
	if (config.structuredOutput) registerStructuredOutputTool(pi, config.structuredOutput);

	onRuntimeEvent("before_provider_request", (event: unknown, ctx?: ExtensionContext) => rewriteForkCacheProviderRequest(event as BeforeProviderRequestEvent, ctx, config.forkCacheKey));

	onRuntimeEvent("context", (event: unknown, ctx?: ExtensionContext) => {
		if (!event || typeof event !== "object" || !("messages" in event) || !Array.isArray(event.messages)) return undefined;
		const messages = stripParentOnlySubagentMessages(event.messages, {
			sanitizeToolIds: !COMPOSITE_TOOL_ID_APIS.has(ctx?.model?.api ?? ""),
			preserveFanoutToolHistory: config.fanoutChild,
		});
		if (messages === event.messages) return undefined;
		return { messages };
	});

	onRuntimeEvent("before_agent_start", async (event: unknown) => {
		if (!event || typeof event !== "object" || !("systemPrompt" in event) || typeof event.systemPrompt !== "string") return undefined;
		registerNativeSupervisorClientOnce();
		// Redemption has to happen here rather than at `agent_start`, because this
		// is the last event that can still change what the model reads and it
		// fires first. Under `synapse` that pulls the envelope check forward with
		// it — bodies must never be spliced in from an envelope that has not been
		// matched against the contract. Under every other mode the check stays
		// exactly where it was, at `agent_start`, synchronous throw included.
		if (config.synapse?.contract.mode === "synapse") await verifyEnvelopeOnce();
		// The intercom target is a routing address and always wins; the display
		// name (agent + task excerpt, computed by the parent at launch) only
		// applies when the bridge is not addressing this child.
		const childSessionName = config.intercomSessionName || config.sessionName;
		if (childSessionName && typeof pi.setSessionName === "function") {
			pi.setSessionName(childSessionName);
		}

		const { inheritProjectContext, inheritGlobalContext, inheritSkills } = config;
		const fanoutChild = config.fanoutChild;
		let rewritten = event.systemPrompt;
		if (inheritProjectContext !== undefined || inheritGlobalContext !== undefined || inheritSkills !== undefined || fanoutChild) {
			rewritten = rewriteSubagentPrompt(event.systemPrompt, {
				inheritProjectContext: inheritProjectContext ?? true,
				inheritGlobalContext: inheritGlobalContext ?? true,
				inheritSkills: inheritSkills ?? true,
				fanoutChild,
				structuredOutput: Boolean(config.structuredOutput),
			});
		}
		if (config.synapse?.autoDistill && recallsMemory(config.synapse.agent)) rewritten = `${rewritten}\n\n${AUTO_DISTILL_CHILD_NOTE}`;
		// The redeemed section is appended last so it cannot be rearranged by the
		// inheritance rewrite above, and so its absence leaves that rewrite's
		// output byte-identical to what it produced before redemption existed.
		if (redemption !== undefined && redemption.section.length > 0) {
			rewritten = `${rewritten}\n\n${redemption.section}`;
		}
		const prompt = "prompt" in event && typeof event.prompt === "string" ? event.prompt : "";
		stageRedemption ??= redeemTaskStageResults(config, prompt, synapseRegistration);
		if (stageRedemption !== undefined && stageRedemption.section.length > 0) {
			rewritten = `${rewritten}\n\n${stageRedemption.section}`;
		}
		if (rewritten === event.systemPrompt) return;
		return { systemPrompt: rewritten };
	});
}
