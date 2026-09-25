/**
 * Read-only view of a SYNAPSE store, for dashboards that run outside the
 * extension (pi-web loads this module with jiti in its own server process).
 *
 * Every number a dashboard shows comes from the same functions the extension
 * uses — `aggregateMetering`, `aggregateWithKernelIo`, the acceptance judges —
 * so a chart and a report can never disagree about what a ledger says.
 *
 * Two rules keep the view honest and harmless:
 * - Nothing here writes to the store: no `ensureNamespace`, no metering log, no
 *   memory publish. Searching from a dashboard must not show up as a
 *   `memory-query` in the very ledger it is displaying.
 * - A missing or unreadable input is reported as such (`error`, `"unavailable"`,
 *   `"N/A"`), never replaced by a zero.
 *
 * The import graph of this file must stay free of `@earendil-works/*` and of
 * `src/extension/*`: the host process already has its own copy of pi, and a
 * second one loaded through here would split its module state.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CanonicalValue } from "../synapse/canonical-json.ts";
import {
	resolveSynapseConfig,
	SYNAPSE_DELIVERY_GEARS,
	SYNAPSE_MEMORY_MODES,
	SYNAPSE_MODES,
	type SynapseConfig,
} from "../synapse/config.ts";
import { createContentStore } from "../synapse/content-store.ts";
import { resolveConfiguredEmbedder, SYNAPSE_VECTOR_MEDIA_TYPE } from "../synapse/embedding.ts";
import { envelopeInboxPath, readDeliveredEnvelope, safeComponent, stateEnvelopePath, type DeliveredEnvelope } from "../synapse/envelope-inbox.ts";
import type { Receipt } from "../synapse/handoff.ts";
import { createMemoryService, type SearchResult } from "../synapse/memory-service.ts";
import { createMemoryStore, type MemoryRecord } from "../synapse/memory-store.ts";
import { aggregateMetering, readMeteringLog, type MeteringEvent, type MeteringTotals } from "../synapse/metering.ts";
import { aggregateWithKernelIo, type KernelIoAccount } from "../synapse/metering-kernel-io.ts";
import { resolveStorageRoot } from "../synapse/namespace.ts";
import { SYNAPSE_DELTA_MEDIA_TYPE } from "../synapse/state-payload.ts";
import { createTmpfsProbe, preflightObjectsTmpfs, sharedMemoryClaimPermitted, type TmpfsPreflight } from "../synapse/tmpfs-preflight.ts";
import { parseTraceLog } from "../synapse/trace-log.ts";
import { judgeS1AcceptanceReport, parseS1AcceptanceReport, type S1AcceptanceReport, type S1AcceptanceVerdict } from "../runs/shared/s1-acceptance-report.ts";
import { judgeS2AcceptanceReport, parseS2AcceptanceReport, type S2AcceptanceReport, type S2AcceptanceVerdict } from "../runs/shared/s2-acceptance-report.ts";
import { judgeS3AcceptanceReport, S3_ACCEPTANCE_SCHEMA_VERSION, type S3AcceptanceReport, type S3Verdict } from "../runs/shared/s3-acceptance-report.ts";

/** Bumped when a return shape changes incompatibly; dashboards check it before rendering. */
export const SYNAPSE_DASHBOARD_API_VERSION = 1;

/** The platform the competition deliverable is judged on. */
export const SYNAPSE_TARGET_PLATFORM = { id: "openEuler", label: "openEuler 24.03-LTS-SP3", versionId: "24.03", sp: "SP3" } as const;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readJsonFile(filePath: string): { ok: true; value: unknown } | { ok: false; error: string } {
	let raw = "";
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		return { error: errorText(error), ok: false };
	}
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch {
		return { error: `${filePath} is not valid JSON`, ok: false };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statOrNull(filePath: string): fs.Stats | null {
	try {
		return fs.statSync(filePath);
	} catch {
		return null;
	}
}

function listDir(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Context: configuration and where the store lives
// ---------------------------------------------------------------------------

export function defaultAgentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
	if (fromEnv !== undefined && fromEnv.length > 0) return path.resolve(fromEnv.startsWith("~/") ? path.join(os.homedir(), fromEnv.slice(2)) : fromEnv);
	return path.join(os.homedir(), ".pi", "agent");
}

export function synapseConfigPath(agentDir: string): string {
	return path.join(agentDir, "extensions", "subagent", "config.json");
}

export function defaultAcceptanceDir(agentDir: string): string {
	return path.join(agentDir, "synapse", "acceptance");
}

export function defaultExperimentsDir(agentDir: string): string {
	return path.join(agentDir, "synapse", "experiments");
}

export type DashboardContext = {
	agentDir: string;
	apiVersion: number;
	/** The validated configuration, or null when the stored block does not validate. */
	config: SynapseConfig | null;
	configError: string | null;
	configPath: string;
	namespaceId: string;
	/** The `.synapse` block exactly as stored, for an editor to start from. */
	rawConfig: CanonicalValue | null;
	storageRoot: string;
	storageRootSource: "default" | "override";
	storeExists: boolean;
	worktreePath: string;
};

function readRawSynapseBlock(configPath: string): { error: string | null; value: CanonicalValue | undefined } {
	if (statOrNull(configPath) === null) return { error: null, value: undefined };
	const parsed = readJsonFile(configPath);
	if (!parsed.ok) return { error: parsed.error, value: undefined };
	if (!isRecord(parsed.value)) return { error: `${configPath} does not hold a JSON object`, value: undefined };
	// SAFETY: the value came out of JSON.parse, so it is a canonical JSON value.
	return { error: null, value: parsed.value.synapse as CanonicalValue | undefined };
}

export function resolveDashboardContext(input: { agentDir?: string; cwd: string }): DashboardContext {
	const agentDir = input.agentDir ?? defaultAgentDir();
	const configPath = synapseConfigPath(agentDir);
	const raw = readRawSynapseBlock(configPath);
	let config: SynapseConfig | null = null;
	let configError = raw.error;
	if (configError === null) {
		try {
			config = resolveSynapseConfig(raw.value);
		} catch (error) {
			configError = errorText(error);
		}
	}
	const resolved = resolveStorageRoot({ agentDir, override: config?.storageRoot ?? undefined, worktreePath: input.cwd });
	return {
		agentDir,
		apiVersion: SYNAPSE_DASHBOARD_API_VERSION,
		config,
		configError,
		configPath,
		namespaceId: resolved.namespaceId,
		rawConfig: raw.value ?? null,
		storageRoot: resolved.root,
		storageRootSource: resolved.source,
		storeExists: statOrNull(resolved.root)?.isDirectory() ?? false,
		worktreePath: resolved.worktreePath,
	};
}

// ---------------------------------------------------------------------------
// Runs: one metering ledger per run id
// ---------------------------------------------------------------------------

export type RunSummary = {
	agents: string[];
	bytes: number;
	eventCount: number;
	firstTs: string | null;
	/** The first unparseable line, if any; the rest of the summary covers the lines before it. */
	integrity: string | null;
	kinds: Record<string, number>;
	lastTs: string | null;
	modes: string[];
	mtimeMs: number;
	runId: string;
	sessionIds: string[];
};

function meteringDir(storageRoot: string): string {
	return path.join(storageRoot, "metering");
}

function meteringFileFor(storageRoot: string, runId: string): string {
	return path.join(meteringDir(storageRoot), `${safeComponent(runId)}.jsonl`);
}

function traceFileFor(storageRoot: string, runId: string): string {
	return path.join(storageRoot, "trace", `${safeComponent(runId)}.ndjson`);
}

function summarizeLedger(filePath: string, runId: string, stat: fs.Stats): RunSummary {
	const summary: RunSummary = {
		agents: [],
		bytes: stat.size,
		eventCount: 0,
		firstTs: null,
		integrity: null,
		kinds: {},
		lastTs: null,
		modes: [],
		mtimeMs: stat.mtimeMs,
		runId,
		sessionIds: [],
	};
	let raw = "";
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		summary.integrity = errorText(error);
		return summary;
	}
	const agents = new Set<string>();
	const modes = new Set<string>();
	const sessions = new Set<string>();
	for (const [index, line] of raw.split("\n").entries()) {
		if (line.trim().length === 0) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			summary.integrity = `line ${index + 1} is not valid JSON`;
			break;
		}
		if (!isRecord(event)) continue;
		summary.eventCount += 1;
		if (typeof event.agent === "string") agents.add(event.agent);
		if (typeof event.mode === "string") modes.add(event.mode);
		if (typeof event.sessionId === "string") sessions.add(event.sessionId);
		if (typeof event.kind === "string") summary.kinds[event.kind] = (summary.kinds[event.kind] ?? 0) + 1;
		if (typeof event.ts === "string") {
			if (summary.firstTs === null || event.ts < summary.firstTs) summary.firstTs = event.ts;
			if (summary.lastTs === null || event.ts > summary.lastTs) summary.lastTs = event.ts;
		}
	}
	summary.agents = [...agents].sort();
	summary.modes = [...modes].sort();
	summary.sessionIds = [...sessions].sort();
	return summary;
}

/** Every run with a ledger under the store, newest first. */
export function listRuns(storageRoot: string): RunSummary[] {
	const dir = meteringDir(storageRoot);
	const runs: RunSummary[] = [];
	for (const name of listDir(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const filePath = path.join(dir, name);
		const stat = statOrNull(filePath);
		if (stat === null || !stat.isFile()) continue;
		runs.push(summarizeLedger(filePath, name.slice(0, -".jsonl".length), stat));
	}
	return runs.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

export type RunDetail =
	| { integrity: string; runId: string }
	| {
		events: MeteringEvent[];
		integrity: null;
		kernel: KernelIoAccount;
		runId: string;
		totals: MeteringTotals;
		traceCollected: boolean;
	};

function readTraceCollection(storageRoot: string, runId: string) {
	const tracePath = traceFileFor(storageRoot, runId);
	let raw: string;
	try {
		raw = fs.readFileSync(tracePath, "utf-8");
	} catch {
		return { collection: { kind: "not-collected" } as const, collected: false };
	}
	return { collection: { kind: "collected", trace: parseTraceLog(raw) } as const, collected: true };
}

/** One run's events and totals; the kernel account is filled when a trace was collected. */
export function readRun(storageRoot: string, runId: string): RunDetail {
	let events: MeteringEvent[];
	try {
		events = readMeteringLog(meteringFileFor(storageRoot, runId));
	} catch (error) {
		return { integrity: errorText(error), runId };
	}
	const trace = readTraceCollection(storageRoot, runId);
	const { application, kernel } = aggregateWithKernelIo(events, { collection: trace.collection, storageRoot });
	return { events, integrity: null, kernel, runId, totals: application, traceCollected: trace.collected };
}

export type RunsAggregate = {
	/** Runs whose ledger could not be read, with the reason; they are left out of the totals. */
	excluded: Array<{ integrity: string; runId: string }>;
	included: string[];
	totals: MeteringTotals;
};

/** Totals over several runs, e.g. every run a chat session delegated. */
export function aggregateRuns(storageRoot: string, runIds: readonly string[]): RunsAggregate {
	const events: MeteringEvent[] = [];
	const excluded: RunsAggregate["excluded"] = [];
	const included: string[] = [];
	for (const runId of new Set(runIds)) {
		try {
			events.push(...readMeteringLog(meteringFileFor(storageRoot, runId)));
			included.push(runId);
		} catch (error) {
			excluded.push({ integrity: errorText(error), runId });
		}
	}
	return { excluded, included, totals: aggregateMetering(events) };
}

// ---------------------------------------------------------------------------
// Protocol: envelopes, receipts, and what each message cost as text vs envelope
// ---------------------------------------------------------------------------

export type EnvelopeEntry = {
	bytes: number | null;
	childIndex: string;
	envelope: DeliveredEnvelope;
	state: DeliveredEnvelope | null;
	stateBytes: number | null;
};

export type ReceiptEntry = { error: string | null; receipt: Receipt | null; requestId: string };

export type MessageCost = {
	agent: string;
	envelopeBytes: number;
	messageId: string;
	mode: string;
	textBytes: number;
	ts: string;
};

export type RunProtocol = {
	envelopes: EnvelopeEntry[];
	messages: MessageCost[];
	/** capability-probe events: the handshake that decides whether state may travel. */
	probes: MeteringEvent[];
	receipts: ReceiptEntry[];
	runId: string;
	/** state-prepare/send/receive/consume/verify/restore events, in ledger order. */
	stateEvents: MeteringEvent[];
};

const STATE_KINDS = new Set(["state-prepare", "state-send", "state-receive", "state-consume", "state-verify", "state-restore"]);

export function readRunProtocol(storageRoot: string, runId: string): RunProtocol {
	const envelopeDir = path.join(storageRoot, "envelopes", safeComponent(runId));
	const envelopes: EnvelopeEntry[] = [];
	for (const name of listDir(envelopeDir).sort()) {
		if (!name.endsWith(".json") || name.endsWith(".state.json")) continue;
		const childIndex = name.slice(0, -".json".length);
		const index = /^\d+$/.test(childIndex) ? Number(childIndex) : undefined;
		const inbox = envelopeInboxPath(storageRoot, runId, index);
		const statePath = stateEnvelopePath(storageRoot, runId, index);
		const stateStat = statOrNull(statePath);
		envelopes.push({
			bytes: statOrNull(inbox)?.size ?? null,
			childIndex,
			envelope: readDeliveredEnvelope(inbox),
			state: stateStat === null ? null : readDeliveredEnvelope(statePath),
			stateBytes: stateStat?.size ?? null,
		});
	}

	const receiptsDir = path.join(storageRoot, "receipts");
	const prefix = `${safeComponent(runId)}-`;
	const receipts: ReceiptEntry[] = [];
	for (const name of listDir(receiptsDir).sort()) {
		if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
		const requestId = name.slice(0, -".json".length);
		const parsed = readJsonFile(path.join(receiptsDir, name));
		// SAFETY: receipts are written by buildReceipt; a dashboard shows them, it does not act on them.
		receipts.push(parsed.ok ? { error: null, receipt: parsed.value as Receipt, requestId } : { error: parsed.error, receipt: null, requestId });
	}

	let events: MeteringEvent[] = [];
	try {
		events = readMeteringLog(meteringFileFor(storageRoot, runId));
	} catch {
		events = [];
	}
	const messages: MessageCost[] = [];
	for (const event of events) {
		if (event.kind !== "message-delivered") continue;
		messages.push({ agent: event.agent, envelopeBytes: event.envelopeBytes, messageId: event.messageId, mode: event.mode, textBytes: event.textBytes, ts: event.ts });
	}
	return {
		envelopes,
		messages,
		probes: events.filter((event) => event.kind === "capability-probe"),
		receipts,
		runId,
		stateEvents: events.filter((event) => STATE_KINDS.has(event.kind)),
	};
}

// ---------------------------------------------------------------------------
// Shared memory
// ---------------------------------------------------------------------------

export type MemoryListing = { error: string | null; records: MemoryRecord[] };

export function listMemories(storageRoot: string, options: { includeSuperseded?: boolean } = {}): MemoryListing {
	if (statOrNull(path.join(storageRoot, "memory")) === null) return { error: null, records: [] };
	try {
		const store = createMemoryStore(storageRoot, { contentStore: createContentStore(storageRoot) });
		const records = store.list({ includeSuperseded: options.includeSuperseded ?? true });
		return { error: null, records: records.sort((left, right) => right.createdAt.localeCompare(left.createdAt)) };
	} catch (error) {
		return { error: errorText(error), records: [] };
	}
}

export type MemorySearchInput = {
	includeHistorical?: boolean;
	k?: number;
	query?: string;
	/** Rank with the configured embedder as well; falls back to keyword and tag when there is none. */
	semantic?: boolean;
	tags?: string[];
};

export type MemorySearchOutcome = {
	error: string | null;
	/** What actually ranked the results, which can differ from what was asked for. */
	ranking: "keyword-tag" | "semantic";
	result: SearchResult | null;
	semanticReason: string | null;
};

export async function searchMemories(context: DashboardContext, input: MemorySearchInput): Promise<MemorySearchOutcome> {
	let embedder: ReturnType<typeof resolveConfiguredEmbedder> = undefined;
	let semanticReason: string | null = null;
	if (input.semantic === true) {
		if (context.config?.embedding == null) semanticReason = "no embedding provider is configured";
		else {
			embedder = resolveConfiguredEmbedder(context.config.embedding, context.storageRoot);
			if (embedder === undefined) semanticReason = `no key in ${context.config.embedding.keyEnv} or the stored credentials`;
		}
	}
	try {
		const service = createMemoryService({
			embedder,
			maxObjectBytes: context.config?.maxObjectBytes,
			provenance: { agent: "dashboard", attempt: 0, runId: "dashboard", sessionId: "dashboard" },
			scope: { agent: "dashboard", namespaceId: context.namespaceId, pathPrefixes: [""], write: false },
			storeRoot: context.storageRoot,
			worktreeRoot: context.worktreePath,
		});
		const searchInput = { includeHistorical: input.includeHistorical, k: input.k, query: input.query, tags: input.tags };
		const result = embedder === undefined ? service.search(searchInput) : await service.searchSemantic(searchInput);
		return { error: null, ranking: result.semantic === "ok" ? "semantic" : "keyword-tag", result, semanticReason };
	} catch (error) {
		return { error: errorText(error), ranking: "keyword-tag", result: null, semanticReason };
	}
}

export type ReuseEdge = { count: number; from: string; memoryIds: string[]; to: string };

export type HitPoint = {
	/** Hits divided by queries over this run and every earlier one, the curve a reuse claim rests on. */
	cumulativeHitRate: number | "N/A";
	hits: number;
	queries: number;
	reuses: number;
	runId: string;
	ts: string | null;
};

export type MemoryReuseGraph = {
	/** Agents that wrote records, from the records' own provenance. */
	authors: Record<string, number>;
	distilled: number;
	edges: ReuseEdge[];
	excludedRuns: string[];
	series: HitPoint[];
};

/**
 * Who reused whose memory, across every run in the store, and how the hit
 * rate moved over time. A hit is a query that returned at least one
 * authorised, valid record — the definition `aggregateMetering` uses.
 */
export function memoryReuseGraph(storageRoot: string): MemoryReuseGraph {
	const edges = new Map<string, ReuseEdge>();
	const series: HitPoint[] = [];
	const excludedRuns: string[] = [];
	let distilled = 0;
	let totalQueries = 0;
	let totalHits = 0;
	const runs = listRuns(storageRoot).sort((left, right) => (left.firstTs ?? "").localeCompare(right.firstTs ?? ""));
	for (const run of runs) {
		let events: MeteringEvent[];
		try {
			events = readMeteringLog(meteringFileFor(storageRoot, run.runId));
		} catch {
			excludedRuns.push(run.runId);
			continue;
		}
		let queries = 0;
		let hits = 0;
		let reuses = 0;
		for (const event of events) {
			if (event.kind === "memory-query") {
				queries += 1;
				if (event.authorisedValidHits > 0) hits += 1;
			} else if (event.kind === "memory-reuse") {
				reuses += 1;
				const key = `${event.sourceAgent}\u0000${event.agent}`;
				const edge = edges.get(key) ?? { count: 0, from: event.sourceAgent, memoryIds: [], to: event.agent };
				edge.count += 1;
				if (!edge.memoryIds.includes(event.memoryId)) edge.memoryIds.push(event.memoryId);
				edges.set(key, edge);
			} else if (event.kind === "memory-distill") {
				distilled += event.written;
			}
		}
		totalQueries += queries;
		totalHits += hits;
		series.push({ cumulativeHitRate: totalQueries === 0 ? "N/A" : totalHits / totalQueries, hits, queries, reuses, runId: run.runId, ts: run.firstTs });
	}
	const authors: Record<string, number> = {};
	for (const record of listMemories(storageRoot).records) authors[record.provenance.agent] = (authors[record.provenance.agent] ?? 0) + 1;
	return { authors, distilled, edges: [...edges.values()].sort((left, right) => right.count - left.count), excludedRuns, series };
}

// ---------------------------------------------------------------------------
// State payloads: what a non-text handoff actually carried
// ---------------------------------------------------------------------------

export type StatePayloadView =
	| { error: string; payloadId: string }
	| {
		byteLength: number;
		dim: number | null;
		encoding: "float32-vector" | "delta" | "other";
		error: null;
		max: number | null;
		mediaType: string;
		min: number | null;
		norm: number | null;
		payloadId: string;
		/** The first components, for a heat strip; null for a residual, which needs its base to decode. */
		values: number[] | null;
	};

export function readStatePayload(storageRoot: string, payloadId: string, maxDims = 256): StatePayloadView {
	try {
		const store = createContentStore(storageRoot);
		if (!store.has(payloadId)) return { error: "payload not in the store", payloadId };
		const mediaType = store.mediaTypeOf(payloadId);
		const bytes = store.read(payloadId);
		if (mediaType !== SYNAPSE_VECTOR_MEDIA_TYPE || bytes.byteLength % 4 !== 0) {
			const encoding = mediaType === SYNAPSE_DELTA_MEDIA_TYPE ? "delta" : "other";
			return { byteLength: bytes.byteLength, dim: null, encoding, error: null, max: null, mediaType, min: null, norm: null, payloadId, values: null };
		}
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const dim = bytes.byteLength / 4;
		let sumSquares = 0;
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		const values: number[] = [];
		for (let index = 0; index < dim; index += 1) {
			const value = view.getFloat32(index * 4, true);
			sumSquares += value * value;
			if (value < min) min = value;
			if (value > max) max = value;
			if (index < maxDims) values.push(value);
		}
		return { byteLength: bytes.byteLength, dim, encoding: "float32-vector", error: null, max, mediaType, min, norm: Math.sqrt(sumSquares), payloadId, values };
	} catch (error) {
		return { error: errorText(error), payloadId };
	}
}

// ---------------------------------------------------------------------------
// Platform: the openEuler facts the system-layer work depends on
// ---------------------------------------------------------------------------

export type ToolProbe = { detail: string | null; present: boolean; version: string | null };

export type PlatformProbe = {
	arch: string;
	btf: boolean;
	kernel: string;
	osRelease: Record<string, string>;
	/** Whether this host is the platform the deliverable is judged on, and why not when it is not. */
	target: { expected: string; matches: boolean; reason: string | null };
	tmpfs: { claimPermitted: boolean; objectsPath: string; preflight: TmpfsPreflight };
	tools: { bpftrace: ToolProbe; docker: ToolProbe; isula: ToolProbe & { daemon: boolean | "unknown" }; podman: ToolProbe };
	uid: number | null;
	wsl: boolean;
};

function parseOsRelease(raw: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
		if (match === null) continue;
		fields[match[1]!] = match[2]!.replace(/^"(.*)"$/, "$1");
	}
	return fields;
}

function run(command: string, args: string[], timeoutMs = 3000): Promise<{ code: number | null; missing: boolean; output: string }> {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
			const output = `${stdout}${stderr}`.trim();
			if (error === null) return resolve({ code: 0, missing: false, output });
			// SAFETY: execFile's error carries the errno string in `code` when the binary could not be spawned.
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return resolve({ code: null, missing: true, output: "" });
			resolve({ code: typeof code === "number" ? code : 1, missing: false, output: output || errorText(error) });
		});
	});
}

function firstVersion(text: string): string | null {
	return /\d+\.\d+(?:\.\d+)?/.exec(text)?.[0] ?? null;
}

async function probeTool(command: string, args: string[]): Promise<ToolProbe> {
	const result = await run(command, args);
	if (result.missing) return { detail: null, present: false, version: null };
	return { detail: result.code === 0 ? null : result.output.split("\n")[0] ?? null, present: true, version: firstVersion(result.output) };
}

function targetVerdict(osRelease: Record<string, string>, wsl: boolean): PlatformProbe["target"] {
	const expected = SYNAPSE_TARGET_PLATFORM.label;
	if (osRelease.ID !== SYNAPSE_TARGET_PLATFORM.id) return { expected, matches: false, reason: `host is ${osRelease.PRETTY_NAME ?? osRelease.ID ?? "unknown"}` };
	const version = osRelease.VERSION ?? "";
	if (osRelease.VERSION_ID !== SYNAPSE_TARGET_PLATFORM.versionId) return { expected, matches: false, reason: `host is openEuler ${version}` };
	if (!version.includes(SYNAPSE_TARGET_PLATFORM.sp)) return { expected, matches: false, reason: `host is openEuler ${version}, not ${SYNAPSE_TARGET_PLATFORM.sp}` };
	if (wsl) return { expected, matches: false, reason: "openEuler userland on a WSL2 kernel" };
	return { expected, matches: true, reason: null };
}

export async function probePlatform(storageRoot: string): Promise<PlatformProbe> {
	let osRelease: Record<string, string> = {};
	try {
		osRelease = parseOsRelease(fs.readFileSync("/etc/os-release", "utf-8"));
	} catch {
		osRelease = {};
	}
	const kernel = os.release();
	const wsl = /microsoft|wsl/i.test(kernel);
	const [isulaVersion, bpftrace, docker, podman] = await Promise.all([
		run("isula", ["version"]),
		probeTool("bpftrace", ["--version"]),
		probeTool("docker", ["--version"]),
		probeTool("podman", ["--version"]),
	]);
	let isula: PlatformProbe["tools"]["isula"];
	if (isulaVersion.missing) isula = { daemon: false, detail: null, present: false, version: null };
	else {
		// `isula version` prints the client first and then asks the daemon; the
		// second half failing is the one fact an S1 run needs before it starts.
		const unreachable = /can not connect|cannot connect|connection refused|no such file/i.test(isulaVersion.output);
		const clientVersion = /Version:\s*([\d.]+)/.exec(isulaVersion.output)?.[1] ?? firstVersion(isulaVersion.output);
		isula = {
			daemon: unreachable ? false : isulaVersion.code === 0 ? true : "unknown",
			detail: unreachable ? "iSulad daemon is not reachable" : null,
			present: true,
			version: clientVersion,
		};
	}
	const objectsPath = path.join(storageRoot, "objects");
	const probe = createTmpfsProbe({ lstatSync: fs.lstatSync, platform: process.platform, readFileSync: fs.readFileSync, statfsSync: fs.statfsSync });
	const preflight = preflightObjectsTmpfs(objectsPath, probe);
	return {
		arch: os.arch(),
		btf: statOrNull("/sys/kernel/btf/vmlinux") !== null,
		kernel,
		osRelease,
		target: targetVerdict(osRelease, wsl),
		tmpfs: { claimPermitted: sharedMemoryClaimPermitted(preflight), objectsPath, preflight },
		tools: { bpftrace, docker, isula, podman },
		uid: typeof process.getuid === "function" ? process.getuid() : null,
		wsl,
	};
}

// ---------------------------------------------------------------------------
// Acceptance reports (S1 containers, S2 data plane, S3 eBPF)
// ---------------------------------------------------------------------------

export type AcceptanceEntry<Report, Verdict> = {
	error: string | null;
	file: string;
	mtimeMs: number;
	report: Report | null;
	verdict: Verdict | null;
};

export type AcceptanceOverview = {
	dir: string;
	history: Array<{ error: string | null; file: string; kind: "s1" | "s2" | "s3"; mtimeMs: number; verdict: string | null }>;
	s1: AcceptanceEntry<S1AcceptanceReport, S1AcceptanceVerdict> | null;
	s2: AcceptanceEntry<S2AcceptanceReport, S2AcceptanceVerdict> | null;
	s3: AcceptanceEntry<S3AcceptanceReport, S3Verdict> | null;
};

function readS1(filePath: string, mtimeMs: number): AcceptanceEntry<S1AcceptanceReport, S1AcceptanceVerdict> {
	let raw = "";
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		return { error: errorText(error), file: filePath, mtimeMs, report: null, verdict: null };
	}
	const parsed = parseS1AcceptanceReport(raw);
	if (!parsed.ok) return { error: parsed.error, file: filePath, mtimeMs, report: null, verdict: null };
	return { error: null, file: filePath, mtimeMs, report: parsed.report, verdict: judgeS1AcceptanceReport(parsed.report) };
}

function readS2(filePath: string, mtimeMs: number): AcceptanceEntry<S2AcceptanceReport, S2AcceptanceVerdict> {
	let raw = "";
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		return { error: errorText(error), file: filePath, mtimeMs, report: null, verdict: null };
	}
	const parsed = parseS2AcceptanceReport(raw);
	if (!parsed.ok) return { error: parsed.error, file: filePath, mtimeMs, report: null, verdict: null };
	return { error: null, file: filePath, mtimeMs, report: parsed.report, verdict: judgeS2AcceptanceReport(parsed.report) };
}

function readS3(filePath: string, mtimeMs: number): AcceptanceEntry<S3AcceptanceReport, S3Verdict> {
	const parsed = readJsonFile(filePath);
	if (!parsed.ok) return { error: parsed.error, file: filePath, mtimeMs, report: null, verdict: null };
	if (!isRecord(parsed.value) || parsed.value.schemaVersion !== S3_ACCEPTANCE_SCHEMA_VERSION) {
		return { error: `not an S3 acceptance report of schema ${S3_ACCEPTANCE_SCHEMA_VERSION}`, file: filePath, mtimeMs, report: null, verdict: null };
	}
	// SAFETY: judge-s3-report.ts accepts a report on exactly this schemaVersion check, and the judge call below is wrapped so a malformed body becomes an error entry.
	const report: S3AcceptanceReport = JSON.parse(JSON.stringify(parsed.value));
	try {
		return { error: null, file: filePath, mtimeMs, report, verdict: judgeS3AcceptanceReport(report) };
	} catch (error) {
		return { error: errorText(error), file: filePath, mtimeMs, report: null, verdict: null };
	}
}

/** The newest report of each kind in `dir` (files named `s1-*.json`, `s2-*.json`, `s3-*.json`), plus the history. */
export function readAcceptance(dir: string): AcceptanceOverview {
	const overview: AcceptanceOverview = { dir, history: [], s1: null, s2: null, s3: null };
	const kindOf = (name: string): "s1" | "s2" | "s3" | null => (name.startsWith("s1-") ? "s1" : name.startsWith("s2-") ? "s2" : name.startsWith("s3-") ? "s3" : null);
	const files = listDir(dir)
		.filter((name) => name.endsWith(".json"))
		.flatMap((name) => {
			const kind = kindOf(name);
			return kind === null ? [] : [{ filePath: path.join(dir, name), kind, mtimeMs: statOrNull(path.join(dir, name))?.mtimeMs ?? 0 }];
		})
		.sort((left, right) => right.mtimeMs - left.mtimeMs);
	for (const file of files) {
		if (file.kind === "s1") {
			const entry = readS1(file.filePath, file.mtimeMs);
			overview.history.push({ error: entry.error, file: file.filePath, kind: file.kind, mtimeMs: file.mtimeMs, verdict: entry.verdict?.verdict ?? null });
			overview.s1 ??= entry;
		} else if (file.kind === "s2") {
			const entry = readS2(file.filePath, file.mtimeMs);
			overview.history.push({ error: entry.error, file: file.filePath, kind: file.kind, mtimeMs: file.mtimeMs, verdict: entry.verdict?.verdict ?? null });
			overview.s2 ??= entry;
		} else {
			const entry = readS3(file.filePath, file.mtimeMs);
			overview.history.push({ error: entry.error, file: file.filePath, kind: file.kind, mtimeMs: file.mtimeMs, verdict: entry.verdict?.verdict ?? null });
			overview.s3 ??= entry;
		}
	}
	return overview;
}

// ---------------------------------------------------------------------------
// Experiments written by experiments/bench
// ---------------------------------------------------------------------------

export type ExperimentSummary = {
	dir: string;
	hasSummary: boolean;
	id: string;
	lastProgress: unknown;
	manifest: unknown;
	mtimeMs: number;
	rounds: number;
};

export type ExperimentDetail =
	| { error: string; id: string }
	| { dir: string; error: null; id: string; manifest: unknown; progress: unknown[]; rounds: unknown[]; summary: unknown };

const EXPERIMENT_ID = /^[A-Za-z0-9._-]+$/;

function readJsonLines(filePath: string, limit?: number): unknown[] {
	let raw = "";
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}
	const rows: unknown[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			// A torn last line is what a running experiment looks like; skip it.
		}
	}
	return limit === undefined ? rows : rows.slice(-limit);
}

export function listExperiments(dir: string): ExperimentSummary[] {
	const experiments: ExperimentSummary[] = [];
	for (const name of listDir(dir)) {
		if (!EXPERIMENT_ID.test(name)) continue;
		const expDir = path.join(dir, name);
		const manifestPath = path.join(expDir, "manifest.json");
		const stat = statOrNull(manifestPath);
		if (stat === null) continue;
		const manifest = readJsonFile(manifestPath);
		const rounds = readJsonLines(path.join(expDir, "rounds.jsonl"));
		const progress = readJsonLines(path.join(expDir, "progress.ndjson"), 1);
		const latest = Math.max(stat.mtimeMs, statOrNull(path.join(expDir, "rounds.jsonl"))?.mtimeMs ?? 0, statOrNull(path.join(expDir, "progress.ndjson"))?.mtimeMs ?? 0);
		experiments.push({
			dir: expDir,
			hasSummary: statOrNull(path.join(expDir, "summary.json")) !== null,
			id: name,
			lastProgress: progress[0] ?? null,
			manifest: manifest.ok ? manifest.value : null,
			mtimeMs: latest,
			rounds: rounds.length,
		});
	}
	return experiments.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

export function readExperiment(dir: string, id: string): ExperimentDetail {
	if (!EXPERIMENT_ID.test(id)) return { error: "invalid experiment id", id };
	const expDir = path.join(dir, id);
	const manifest = readJsonFile(path.join(expDir, "manifest.json"));
	if (!manifest.ok) return { error: manifest.error, id };
	const summary = readJsonFile(path.join(expDir, "summary.json"));
	return {
		dir: expDir,
		error: null,
		id,
		manifest: manifest.value,
		progress: readJsonLines(path.join(expDir, "progress.ndjson"), 200),
		rounds: readJsonLines(path.join(expDir, "rounds.jsonl")),
		summary: summary.ok ? summary.value : null,
	};
}

// ---------------------------------------------------------------------------
// Configuration writes (the one thing here that writes, and only the config)
// ---------------------------------------------------------------------------

export type SynapseConfigPatch = {
	autoDistill?: boolean;
	deliveryGear?: (typeof SYNAPSE_DELIVERY_GEARS)[number];
	memory?: (typeof SYNAPSE_MEMORY_MODES)[number];
	mode?: (typeof SYNAPSE_MODES)[number];
};

export type ConfigWriteResult = { config: SynapseConfig; error: null; rawConfig: CanonicalValue } | { error: string };

/**
 * Applies a patch to the `.synapse` block and writes it back, keeping every
 * other key in the file. The block is validated by the extension's own
 * resolver before anything is written, so a dashboard cannot store a
 * configuration the extension would refuse at its next start.
 */
export function writeSynapseConfig(agentDir: string, patch: SynapseConfigPatch): ConfigWriteResult {
	const configPath = synapseConfigPath(agentDir);
	let file: Record<string, unknown> = {};
	if (statOrNull(configPath) !== null) {
		const parsed = readJsonFile(configPath);
		if (!parsed.ok) return { error: parsed.error };
		if (!isRecord(parsed.value)) return { error: `${configPath} does not hold a JSON object` };
		file = parsed.value;
	}
	const current = isRecord(file.synapse) ? file.synapse : {};
	const next: Record<string, unknown> = { ...current };
	for (const [key, value] of Object.entries(patch)) if (value !== undefined) next[key] = value;
	// Switching to off means no memory at all (the resolver refuses anything
	// else), and a dashboard switching modes should not have to know that. An
	// explicit memory patch is left alone so that the resolver can refuse it.
	if (patch.mode === "off" && patch.memory === undefined) delete next.memory;
	let config: SynapseConfig;
	try {
		// SAFETY: built from parsed JSON and the typed patch, so it is canonical JSON.
		config = resolveSynapseConfig(next as CanonicalValue);
	} catch (error) {
		return { error: errorText(error) };
	}
	file.synapse = next;
	try {
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		const tempPath = `${configPath}.${process.pid}.tmp`;
		fs.writeFileSync(tempPath, `${JSON.stringify(file, null, "\t")}\n`, "utf-8");
		fs.renameSync(tempPath, configPath);
	} catch (error) {
		return { error: errorText(error) };
	}
	// SAFETY: as above.
	return { config, error: null, rawConfig: next as CanonicalValue };
}
