import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { canonicalJson, type CanonicalValue } from "./canonical-json.ts";
import type { AccessScope } from "./access.ts";
import type { SynapseConfig } from "./config.ts";
import { createMemoryService, SYNAPSE_DEFAULT_SEARCH_K, SYNAPSE_MAX_SEARCH_K, type MemoryService } from "./memory-service.ts";
import type { MemoryProvenance } from "./memory-store.ts";
import { ensureNamespace, resolveStorageRoot } from "./namespace.ts";

/**
 * Registration of the model-visible SYNAPSE tools.
 *
 * With `synapse.mode` off nothing is registered and no directory is created, so
 * the unmodified upstream behaviour is the product default and also the control
 * condition an experiment can compare against.
 *
 * Every identity field — who is writing, in which session, run and attempt — is
 * supplied by the host. The schemas below have no place to put one, which is
 * what stops a model from filing a memory under another agent's name.
 */

export const SYNAPSE_READ_TOOL = "synapse_read";
export const SYNAPSE_WRITE_TOOL = "synapse_write";

const SynapseReadParams = Type.Object(
	{
		action: Type.Union([Type.Literal("search"), Type.Literal("get")], {
			description: "search: rank shared memories by keyword and tag. get: read the body of one memory.",
		}),
		allowHistorical: Type.Optional(Type.Boolean({ description: "get only: read a memory that has been superseded. Default false." })),
		includeHistorical: Type.Optional(Type.Boolean({ description: "search only: also return superseded memories, flagged as historical. Default false." })),
		k: Type.Optional(Type.Integer({ description: `search only: how many memories to return. Default ${SYNAPSE_DEFAULT_SEARCH_K}, maximum ${SYNAPSE_MAX_SEARCH_K}.`, minimum: 1 })),
		limitBytes: Type.Optional(Type.Integer({ description: "get only: how many bytes of the body to return. Capped at 16384.", minimum: 1 })),
		memoryId: Type.Optional(Type.String({ description: "get only: the memory to read." })),
		offsetBytes: Type.Optional(Type.Integer({ description: "get only: where to resume reading. Use nextOffsetBytes from the previous call.", minimum: 0 })),
		query: Type.Optional(Type.String({ description: "search only: what you are looking for." })),
		tags: Type.Optional(Type.Array(Type.String(), { description: "search only: tags to favour in ranking." })),
	},
	{ additionalProperties: false },
);

const SynapseWriteParams = Type.Object(
	{
		action: Type.Union([Type.Literal("remember"), Type.Literal("supersede")], {
			description: "remember: store a finding for later tasks. supersede: mark an earlier memory as retired by a newer one.",
		}),
		content: Type.Optional(Type.String({ description: "remember only: the full text to store." })),
		kind: Type.Optional(
			Type.Union([Type.Literal("evidence"), Type.Literal("tool-result"), Type.Literal("conclusion"), Type.Literal("strategy")], {
				description: "remember only: what this memory is. Defaults to evidence.",
			}),
		),
		newId: Type.Optional(Type.String({ description: "supersede only: the memory that replaces the old one." })),
		oldId: Type.Optional(Type.String({ description: "supersede only: the memory being retired." })),
		reason: Type.Optional(
			Type.Union([Type.Literal("source-changed"), Type.Literal("superseded-by-newer-observation"), Type.Literal("corrected")], {
				description: "supersede only: why the old memory no longer holds.",
			}),
		),
		sourcePath: Type.Optional(
			Type.String({ description: "remember only: the worktree-relative file this came from. Recording it lets the memory be invalidated when the file changes." }),
		),
		summary: Type.Optional(Type.String({ description: "remember only: one or two sentences another agent can rank without reading the body. At most 2048 bytes." })),
		tags: Type.Optional(Type.Array(Type.String(), { description: "remember only: short labels for later retrieval." })),
		topic: Type.Optional(Type.String({ description: "remember only: the task topic this belongs to." })),
	},
	{ additionalProperties: false },
);

/**
 * Who is calling, from where. Resolved per call rather than at activation: the
 * session id and working directory are not known until a session starts, and
 * both change when the user opens another one.
 */
export type SynapseToolContext = {
	provenance: MemoryProvenance;
	scope: Omit<AccessScope, "namespaceId">;
	worktreeRoot: string;
};

export type SynapseToolsOptions = {
	config: SynapseConfig;
	agentDir: string;
	/** Identifies the logical operation, so a retried call lands on the same memory. */
	nextOperationId: () => string;
	resolveContext: () => SynapseToolContext;
};

/**
 * The only host capability registration needs. Declared structurally rather
 * than as the whole ExtensionAPI so a test can stand in for the host without
 * impersonating an entire agent runtime.
 */
export type SynapseToolHost = {
	registerTool: <TParams extends TSchema>(tool: ToolDefinition<TParams, CanonicalValue>) => void;
};

export type SynapseReadInput = Static<typeof SynapseReadParams>;
export type SynapseWriteInput = Static<typeof SynapseWriteParams>;
export type SynapseToolCall<TInput> = (params: TInput) => Promise<AgentToolResult<CanonicalValue>>;

/**
 * What registration produced. The executors are the very functions the tools
 * dispatch to, so a test can drive them with schema-typed parameters instead of
 * impersonating the host's dispatcher.
 */
export type SynapseToolsRegistration =
	| { registered: false }
	| { read: SynapseToolCall<SynapseReadInput>; registered: true; write: SynapseToolCall<SynapseWriteInput> };

export type SynapseService = {
	service: MemoryService;
	storageRoot: string;
};

/** Tool results carry the JSON the model reads plus the same value for logs. */
function toolOutput(payload: CanonicalValue): AgentToolResult<CanonicalValue> {
	return { content: [{ text: canonicalJson(payload), type: "text" }], details: payload };
}

function requireField<T>(action: string, field: string, value: T | undefined): T {
	if (value === undefined) throw new Error(`${action} requires ${field}`);
	return value;
}

function readAction(service: MemoryService, params: SynapseReadInput): AgentToolResult<CanonicalValue> {
	if (params.action === "search") {
		const result = service.search({
			includeHistorical: params.includeHistorical,
			k: params.k,
			query: requireField("search", "query", params.query),
			tags: params.tags,
		});
		return toolOutput({ results: result.results, semantic: result.semantic });
	}
	const page = service.get({
		allowHistorical: params.allowHistorical,
		limitBytes: params.limitBytes,
		memoryId: requireField("get", "memoryId", params.memoryId),
		offsetBytes: params.offsetBytes,
	});
	return toolOutput({ ...page });
}

function writeAction(service: MemoryService, params: SynapseWriteInput, operationId: string): AgentToolResult<CanonicalValue> {
	if (params.action === "remember") {
		const written = service.remember({
			content: requireField("remember", "content", params.content),
			kind: params.kind ?? "evidence",
			operationId,
			sourcePath: params.sourcePath,
			summary: requireField("remember", "summary", params.summary),
			tags: params.tags ?? [],
			topic: requireField("remember", "topic", params.topic),
		});
		return toolOutput({
			assurance: written.record.assurance,
			memoryId: written.record.memoryId,
			source: written.record.source,
			validity: written.validity,
		});
	}
	const event = service.supersede({
		newId: requireField("supersede", "newId", params.newId),
		oldId: requireField("supersede", "oldId", params.oldId),
		reason: params.reason ?? "superseded-by-newer-observation",
	});
	return toolOutput({ eventId: event.eventId, newId: event.newId, oldId: event.oldId, reason: event.reason });
}

export function createSynapseService(config: SynapseConfig, agentDir: string, context: SynapseToolContext): SynapseService {
	const resolved = resolveStorageRoot({
		agentDir,
		override: config.storageRoot ?? undefined,
		worktreePath: context.worktreeRoot,
	});
	ensureNamespace(resolved);
	return {
		service: createMemoryService({
			maxObjectBytes: config.maxObjectBytes,
			provenance: context.provenance,
			scope: { ...context.scope, namespaceId: resolved.namespaceId },
			storeRoot: resolved.root,
			worktreeRoot: context.worktreeRoot,
		}),
		storageRoot: resolved.root,
	};
}

export function registerSynapseTools(pi: SynapseToolHost, options: SynapseToolsOptions): SynapseToolsRegistration {
	// mode=off registers nothing and creates no directory, so the unmodified
	// upstream behaviour stays both the product default and the control condition.
	if (options.config.mode === "off" || options.config.memory === "off") return { registered: false };
	const currentService = (): MemoryService => createSynapseService(options.config, options.agentDir, options.resolveContext()).service;

	const read: SynapseToolCall<SynapseReadInput> = async (params) => readAction(currentService(), params);
	const write: SynapseToolCall<SynapseWriteInput> = async (params) => writeAction(currentService(), params, options.nextOperationId());

	const readTool: ToolDefinition<typeof SynapseReadParams, CanonicalValue> = {
		description:
			"Read shared memory recorded by this project's agents. search ranks memories by keyword and tag overlap and returns summaries, provenance and whether each one's source file still matches. get returns a verified page of one memory's body. Semantic ranking is not available in this build and is reported as such rather than approximated.",
		execute: async (_id, params) => read(params),
		label: "Shared Memory Read",
		name: SYNAPSE_READ_TOOL,
		parameters: SynapseReadParams,
	};

	const writeTool: ToolDefinition<typeof SynapseWriteParams, CanonicalValue> = {
		description:
			"Record a finding in shared memory so later tasks and other agents can reuse it instead of redoing the work. Give a sourcePath whenever the finding comes from a file: a memory with a source is invalidated automatically when that file changes, including uncommitted edits. A memory records what was observed or derived; it never asserts that a task was accepted.",
		execute: async (_id, params) => write(params),
		label: "Shared Memory Write",
		name: SYNAPSE_WRITE_TOOL,
		parameters: SynapseWriteParams,
	};

	pi.registerTool(readTool);
	pi.registerTool(writeTool);
	return { read, registered: true, write };
}
