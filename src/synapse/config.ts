import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { CanonicalValue } from "./canonical-json.ts";

/**
 * Configuration for the SYNAPSE extension.
 *
 * The raw value is parsed against a schema at this boundary, and unknown keys
 * are rejected rather than ignored: a silently dropped key in an experiment
 * config would produce a run whose conditions do not match its manifest.
 *
 * The embedding identity lives here, never in a private key file, because those
 * four fields enter the representation id and must stay reproducible and
 * auditable. Only the key itself is read from the environment.
 */

export const SYNAPSE_MODES = ["off", "text", "synapse"] as const;
export const SYNAPSE_MEMORY_MODES = ["off", "project"] as const;
export const SYNAPSE_STATE_RECOVERIES = ["resend", "resend-then-text"] as const;
export const SYNAPSE_EMBEDDING_PROVIDERS = ["paratera", "siliconflow"] as const;

/**
 * Provider names reserved for the deterministic stub used in tests. Accepting
 * one here would let a run report semantic retrieval while measuring a hash.
 */
const TEST_ONLY_PROVIDERS = new Set(["deterministic-test", "fake", "hash"]);

/**
 * Semantic retrieval weights, frozen at the preliminary-round HybridRetriever
 * calibration (keyword 0.3 / tag 0.2 / semantic cosine 0.5). The P4-2 delta
 * calibration does not reopen them; any change requires a new frozen decision
 * recorded as such.
 */
export const SYNAPSE_SEMANTIC_KEYWORD_WEIGHT = 0.3;
export const SYNAPSE_SEMANTIC_TAG_WEIGHT = 0.2;
export const SYNAPSE_SEMANTIC_COSINE_WEIGHT = 0.5;

export const SYNAPSE_DEFAULT_CONTEXT_BUDGET_BYTES = 8192;
export const SYNAPSE_DEFAULT_MAX_OBJECT_BYTES = 1024 * 1024;
export const SYNAPSE_MAX_EMBEDDING_DIM = 8192;

/**
 * Whether a launch may send a residual rather than the full query vector.
 *
 * Off by default, and that default is a measurement rather than a preference:
 * the P4-4 full-account replay found the residual net-negative on every one of
 * 239 pairs whenever the base was not already resident, reaching 61x once base
 * selection's own reads are counted. Turning it on is a statement that an
 * experiment wants that cost measured on a real corpus, not a claim that it
 * pays off; the CCF-A acceptance card rules on that question with data.
 */
export const SYNAPSE_DEFAULT_DELTA = false;

/**
 * Whether a process keeps memory-record vectors in memory between rankings.
 *
 * Off by default, so the frozen `cold base` full-account convention still describes
 * the default configuration: with the cache off, every ranking reads every record's
 * vector from the store — the cost the P4-4 replay measured at 476 KiB per round.
 * Turning it on makes those reads happen once per process, which is exactly the
 * difference between the cold row and the hot row of the pre-registered table, and
 * turns the hot row from a derived figure into a measured one.
 *
 * It changes where the bytes come from, never which bytes are compared: a run with
 * the cache on and one with it off must rank identically, and a difference in
 * ranking between the two settings is a defect rather than a tuning result.
 */
export const SYNAPSE_DEFAULT_VECTOR_CACHE = false;

export const SYNAPSE_STATE_VERIFY_MODES = ["off", "reembed"] as const;
export type SynapseStateVerify = (typeof SYNAPSE_STATE_VERIFY_MODES)[number];

/**
 * The cosine below which a decoded state is refused.
 *
 * The residual is a lossy encoding: it is admitted on the sender's side only when
 * the payload is small, and the calibration that froze its grid measured an
 * ordered top-5 agreement well below 1 (the negative result this repository
 * reports in full). What was missing was a check *per message*: the receiver
 * rebuilt the vector and ranked with it without ever asking whether it still
 * meant the query. 0.99 is the same threshold the encoder's stop condition uses,
 * so a payload the sender considered "done" is a payload the receiver accepts —
 * one number, used on both sides of the wire, rather than two that drift.
 *
 * It is not 1.0: the quantised round trip cannot reproduce the original exactly,
 * and a threshold that no correct payload can meet would turn every message into
 * a recovery.
 */
export const SYNAPSE_STATE_VERIFY_MIN_COSINE = 0.99;

/** Off by default: verification costs the receiver a second embedding call. */
export const SYNAPSE_DEFAULT_STATE_VERIFY: SynapseStateVerify = "off";

/**
 * A JSON value as it arrives from config.json: parsed by the host, not yet
 * validated by us. Naming it keeps the unvalidated boundary visible.
 */
export type UnvalidatedJson = CanonicalValue | undefined;

export type SynapseMode = (typeof SYNAPSE_MODES)[number];
export type SynapseMemoryMode = (typeof SYNAPSE_MEMORY_MODES)[number];
export type SynapseStateRecovery = (typeof SYNAPSE_STATE_RECOVERIES)[number];

export type SynapseEmbeddingConfig = {
	dim: number;
	endpoint: string;
	keyEnv: string;
	model: string;
	provider: string;
};

export type SynapseConfig = {
	contextBudgetBytes: number;
	/** Set by experiments to the id a `build-corpus` run produced; null keeps the "unset" placeholder. */
	corpusSnapshotId: string | null;
	/** Whether launches may send a residual; see {@link SYNAPSE_DEFAULT_DELTA}. */
	delta: boolean;
	embedding: SynapseEmbeddingConfig | null;
	maxObjectBytes: number;
	memory: SynapseMemoryMode;
	mode: SynapseMode;
	stateRecovery: SynapseStateRecovery;
	storageRoot: string | null;
	/** Whether record vectors stay in memory between rankings; see {@link SYNAPSE_DEFAULT_VECTOR_CACHE}. */
	vectorCache: boolean;
	/** Whether the receiver re-embeds the query to check the decoded state; see {@link SYNAPSE_DEFAULT_STATE_VERIFY}. */
	stateVerify: SynapseStateVerify;
};

const EmbeddingSchema = Type.Object(
	{
		dim: Type.Integer({ maximum: SYNAPSE_MAX_EMBEDDING_DIM, minimum: 1 }),
		endpoint: Type.String({ minLength: 1 }),
		keyEnv: Type.String({ minLength: 1 }),
		model: Type.String({ minLength: 1 }),
		provider: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const RawConfigSchema = Type.Object(
	{
		contextBudgetBytes: Type.Optional(Type.Integer({ minimum: 1 })),
		corpusSnapshotId: Type.Optional(
			Type.String({ minLength: 1, pattern: "^[0-9a-f]{64}$", description: "64-hex id from a build-corpus run" }),
		),
		delta: Type.Optional(Type.Boolean({ description: "send residuals instead of full vectors; off unless an experiment asks for it" })),
		embedding: Type.Optional(EmbeddingSchema),
		maxObjectBytes: Type.Optional(Type.Integer({ minimum: 1 })),
		memory: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("project")])),
		mode: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("text"), Type.Literal("synapse")])),
		stateRecovery: Type.Optional(Type.Union([Type.Literal("resend"), Type.Literal("resend-then-text")])),
		storageRoot: Type.Optional(Type.String({ minLength: 1 })),
		vectorCache: Type.Optional(Type.Boolean({ description: "keep record vectors in memory between rankings; off keeps the cold-base convention" })),
		stateVerify: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Literal("reembed")], {
				description: "re-embed the query on the receiving side and refuse a decoded state below the frozen cosine",
			}),
		),
	},
	{ additionalProperties: false },
);

const rawConfigValidator = Compile(RawConfigSchema);
const recordProbe = Compile(Type.Record(Type.String(), Type.Unknown()));

const KNOWN_KEYS = new Set(Object.keys(RawConfigSchema.properties));
const KNOWN_EMBEDDING_KEYS = new Set(Object.keys(EmbeddingSchema.properties));

const ALLOWED_VALUES = new Map<string, readonly string[]>([
	["synapse.memory", SYNAPSE_MEMORY_MODES],
	["synapse.mode", SYNAPSE_MODES],
	["synapse.stateVerify", SYNAPSE_STATE_VERIFY_MODES],
	["synapse.stateRecovery", SYNAPSE_STATE_RECOVERIES],
]);

/** Turns a JSON-schema pointer into the dotted setting name a user would recognise. */
function settingName(schemaPath: string): string {
	const parts = schemaPath
		.split("/")
		.filter((part) => part !== "#" && part !== "properties" && part !== "anyOf" && !/^\d+$/.test(part));
	return parts.length === 0 ? "synapse" : `synapse.${parts.join(".")}`;
}

function unknownKeysIn(value: UnvalidatedJson, known: Set<string>): string[] {
	if (!recordProbe.Check(value)) return [];
	return Object.keys(value).filter((key) => !known.has(key));
}

function reportInvalid(value: UnvalidatedJson): never {
	const strays = [
		...unknownKeysIn(value, KNOWN_KEYS).map((key) => `synapse.${key}`),
		...(recordProbe.Check(value) ? unknownKeysIn(value.embedding, KNOWN_EMBEDDING_KEYS).map((key) => `synapse.embedding.${key}`) : []),
	];
	if (strays.length > 0) {
		throw new Error(`${strays.join(", ")} is not a known setting`);
	}
	const [first] = [...rawConfigValidator.Errors(value)];
	if (first === undefined) throw new Error("synapse config is invalid");
	const setting = settingName(first.schemaPath);
	// A failed literal union reports only "must be equal to constant", which does
	// not tell the reader what to write instead.
	const allowed = ALLOWED_VALUES.get(setting);
	throw new Error(allowed === undefined ? `${setting} ${first.message}` : `${setting} must be one of ${allowed.join(" / ")}`);
}

/** Accepts an absolute path or a `~/`-prefixed one, matching the host's own convention. */
export function resolveSynapseStorageRoot(value: string, homeDir: string = os.homedir()): string {
	const expanded = value.startsWith("~/") ? path.join(homeDir, value.slice(2)) : value;
	if (!path.isAbsolute(expanded)) {
		throw new Error(`synapse.storageRoot must be an absolute path or "~/...", got ${JSON.stringify(value)}`);
	}
	return path.normalize(expanded);
}

function resolveEmbedding(embedding: SynapseEmbeddingConfig): SynapseEmbeddingConfig {
	if (TEST_ONLY_PROVIDERS.has(embedding.provider)) {
		throw new Error(`synapse.embedding.provider ${JSON.stringify(embedding.provider)} is a test-only stub and cannot be used in a real run`);
	}
	if (!SYNAPSE_EMBEDDING_PROVIDERS.some((candidate) => candidate === embedding.provider)) {
		throw new Error(`synapse.embedding.provider must be one of ${SYNAPSE_EMBEDDING_PROVIDERS.join(" / ")}, got ${JSON.stringify(embedding.provider)}`);
	}
	return { ...embedding };
}

/**
 * The representation two peers must agree on before a state payload can mean
 * the same thing to both. Derived from configuration alone so the same settings
 * always produce the same identity, and reported as `unavailable` rather than
 * as an empty string when no embedding is configured: peers must fail to agree
 * on a representation that does not exist.
 */
export function representationIdOf(config: SynapseConfig): string {
	return config.embedding === null ? "unavailable" : `${config.embedding.provider}/${config.embedding.model}/${config.embedding.dim}`;
}

export function resolveSynapseConfig(value: UnvalidatedJson, homeDir: string = os.homedir()): SynapseConfig {
	const raw = value ?? {};
	if (!rawConfigValidator.Check(raw)) reportInvalid(raw);
	const mode = raw.mode ?? "off";
	// Memory follows the mode unless it is set explicitly: synapse mode is about
	// reuse across tasks, text mode is a baseline that must not accumulate any.
	const memory = raw.memory ?? (mode === "synapse" ? "project" : "off");
	if (mode === "off" && memory !== "off") {
		throw new Error("synapse.memory must be off when synapse.mode is off");
	}
	return {
		contextBudgetBytes: raw.contextBudgetBytes ?? SYNAPSE_DEFAULT_CONTEXT_BUDGET_BYTES,
		corpusSnapshotId: raw.corpusSnapshotId ?? null,
		delta: raw.delta ?? SYNAPSE_DEFAULT_DELTA,
		embedding: raw.embedding === undefined ? null : resolveEmbedding(raw.embedding),
		maxObjectBytes: raw.maxObjectBytes ?? SYNAPSE_DEFAULT_MAX_OBJECT_BYTES,
		memory,
		mode,
		stateRecovery: raw.stateRecovery ?? "resend-then-text",
		storageRoot: raw.storageRoot === undefined ? null : resolveSynapseStorageRoot(raw.storageRoot, homeDir),
		vectorCache: raw.vectorCache ?? SYNAPSE_DEFAULT_VECTOR_CACHE,
		stateVerify: raw.stateVerify ?? SYNAPSE_DEFAULT_STATE_VERIFY,
	};
}
