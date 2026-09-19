import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import type { UnvalidatedJson } from "../synapse/config.ts";

/**
 * The line protocol spoken over the collector's local socket.
 *
 * Two rules make this a control and measurement channel rather than a second
 * agent transport. It carries no task data: identifiers, counters and
 * timestamps only. And it is strict in both directions — an unknown field or an
 * unknown protocol string is refused, because a message half-understood by one
 * side produces numbers the other side cannot defend.
 *
 * Counters are cumulative per registration, not deltas. A client that missed
 * snapshots recovers by taking the newest value; a client that receives one
 * twice discards it by sequence. Neither case can double count.
 */

export const OBSERVATION_PROTOCOL = "synapse-io/1";

/** A collector snapshot for a thousand processes still fits well inside this. */
export const OBSERVATION_MAX_LINE_BYTES = 1024 * 1024;

export const OBSERVATION_CATEGORIES = ["envelope", "content", "memoryIndex", "unclassified"] as const;
export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number];

/** `[log2 bucket, count]` pairs; zero buckets are omitted by the collector. */
const HistogramSchema = Type.Array(Type.Tuple([Type.Integer({ maximum: 63, minimum: 0 }), Type.Integer({ minimum: 0 })]));

const CountersSchema = Type.Object(
	{
		failedOps: Type.Integer({ minimum: 0 }),
		readBytes: Type.Integer({ minimum: 0 }),
		readHist: HistogramSchema,
		readNs: Type.Integer({ minimum: 0 }),
		readOps: Type.Integer({ minimum: 0 }),
		writeBytes: Type.Integer({ minimum: 0 }),
		writeHist: HistogramSchema,
		writeNs: Type.Integer({ minimum: 0 }),
		writeOps: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const ProcessSchema = Type.Object(
	{
		/** `exclusive` when one registration owns the pid, `shared` when several do. */
		attribution: Type.Union([Type.Literal("exclusive"), Type.Literal("shared")]),
		categories: Type.Object(
			{
				content: CountersSchema,
				envelope: CountersSchema,
				memoryIndex: CountersSchema,
				unclassified: CountersSchema,
			},
			{ additionalProperties: false },
		),
		exited: Type.Boolean(),
		nodeId: Type.String(),
		/** When the kernel began counting for this registration, not when the run began. */
		observedFromMs: Type.Integer({ minimum: 0 }),
		pid: Type.Integer({ minimum: 1 }),
		registrationId: Type.String({ minLength: 1 }),
		runId: Type.String(),
		startTicks: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const SnapshotSchema = Type.Object(
	{
		collectorInstance: Type.String({ minLength: 1 }),
		emittedAtMs: Type.Integer({ minimum: 0 }),
		processes: Type.Array(ProcessSchema),
		protocol: Type.Literal(OBSERVATION_PROTOCOL),
		quality: Type.Object(
			{
				classifyIncomplete: Type.Integer({ minimum: 0 }),
				mapOverflows: Type.Integer({ minimum: 0 }),
				unpairedReturns: Type.Integer({ minimum: 0 }),
			},
			{ additionalProperties: false },
		),
		sequence: Type.Integer({ minimum: 1 }),
		type: Type.Literal("snapshot"),
	},
	{ additionalProperties: false },
);

const WelcomeSchema = Type.Object(
	{
		abiVersion: Type.Integer({ minimum: 1 }),
		collectorInstance: Type.String({ minLength: 1 }),
		/** The VFS entry points this build actually attached. */
		coverage: Type.Array(Type.String()),
		/** Named so a report can say what was not watched instead of implying totality. */
		excluded: Type.Array(Type.String()),
		protocol: Type.Literal(OBSERVATION_PROTOCOL),
		snapshotIntervalMs: Type.Integer({ minimum: 1 }),
		type: Type.Literal("welcome"),
	},
	{ additionalProperties: false },
);

const RegisteredSchema = Type.Object(
	{
		collectorInstance: Type.String({ minLength: 1 }),
		observedFromMs: Type.Integer({ minimum: 0 }),
		registrationId: Type.String({ minLength: 1 }),
		requestId: Type.String(),
		type: Type.Literal("registered"),
	},
	{ additionalProperties: false },
);

const UnregisteredSchema = Type.Object(
	{
		registrationId: Type.String(),
		requestId: Type.String(),
		type: Type.Literal("unregistered"),
	},
	{ additionalProperties: false },
);

const CollectorErrorSchema = Type.Object(
	{
		code: Type.String({ minLength: 1 }),
		message: Type.String(),
		requestId: Type.String(),
		type: Type.Literal("error"),
	},
	{ additionalProperties: false },
);

const CollectorMessageSchema = Type.Union([SnapshotSchema, WelcomeSchema, RegisteredSchema, UnregisteredSchema, CollectorErrorSchema]);

const collectorMessageValidator = Compile(CollectorMessageSchema);

export type ObservationCounters = Static<typeof CountersSchema>;
export type ObservationProcessSnapshot = Static<typeof ProcessSchema>;
export type CollectorSnapshot = Static<typeof SnapshotSchema>;
export type CollectorWelcome = Static<typeof WelcomeSchema>;
export type CollectorRegistered = Static<typeof RegisteredSchema>;
export type CollectorMessage = Static<typeof CollectorMessageSchema>;

export type CollectorDecode = { message: CollectorMessage; ok: true } | { ok: false; reason: string };

/**
 * Decodes one line from the collector.
 *
 * A line that does not decode is reported as a reason, never thrown and never
 * skipped silently: a client that quietly drops malformed snapshots would show
 * stale numbers as if they were current.
 */
export function decodeCollectorLine(line: string): CollectorDecode {
	if (Buffer.byteLength(line, "utf-8") > OBSERVATION_MAX_LINE_BYTES) {
		return { ok: false, reason: `message exceeds ${OBSERVATION_MAX_LINE_BYTES} bytes` };
	}
	let parsed: UnvalidatedJson;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { ok: false, reason: "message is not valid JSON" };
	}
	if (!collectorMessageValidator.Check(parsed)) {
		const [first] = [...collectorMessageValidator.Errors(parsed)];
		return { ok: false, reason: first === undefined ? "message does not match the protocol" : `${first.schemaPath} ${first.message}` };
	}
	return { message: parsed, ok: true };
}

export type RegisterRequest = {
	nodeId: string;
	pid: number;
	requestId: string;
	runId: string;
	/** Field 22 of /proc/<pid>/stat: the collector refuses a mismatch. */
	startTicks: number;
	storageRoot: string;
};

/**
 * Client messages are flat and escape-free by contract, because the collector
 * parses them with a deliberately small reader rather than a full JSON parser.
 * Encoding them here keeps that contract in one place.
 */
export function encodeHello(clientVersion: string): string {
	return `${JSON.stringify({ client: "pi-subagents", clientVersion, protocol: OBSERVATION_PROTOCOL, type: "hello" })}\n`;
}

export function encodeRegister(request: RegisterRequest): string {
	return `${JSON.stringify({
		nodeId: request.nodeId,
		pid: request.pid,
		requestId: request.requestId,
		runId: request.runId,
		startTicks: request.startTicks,
		storageRoot: request.storageRoot,
		type: "register",
	})}\n`;
}

export function encodeUnregister(requestId: string, registrationId: string): string {
	return `${JSON.stringify({ registrationId, requestId, type: "unregister" })}\n`;
}
