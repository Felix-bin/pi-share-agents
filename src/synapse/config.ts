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
export const SYNAPSE_EMBEDDING_PROVIDERS = ["siliconflow"] as const;
/**
 * The envelope delivery gear (design §3.1, §4.3). `file` is the atomic-write
 * path `envelope-inbox.ts` has always used and stays the default: it is S4's
 * control arm for the text-vs-structured A/B, and S1's fallback when a
 * container launch degrades. `uds` is S2's addition, an AF_UNIX `SOCK_STREAM`
 * transport (`envelope-uds.ts`). This is a config key, not an environment
 * variable, because it is one of S4's experiment conditions: a gear a run
 * picked up from its environment rather than its manifest would make that
 * run's conditions unreproducible from the manifest alone.
 */
export const SYNAPSE_DELIVERY_GEARS = ["file", "uds"] as const;

/**
 * Provider names reserved for the deterministic stub used in tests. Accepting
 * one here would let a run report semantic retrieval while measuring a hash.
 */
const TEST_ONLY_PROVIDERS = new Set(["deterministic-test", "fake", "hash"]);

export const SYNAPSE_DEFAULT_CONTEXT_BUDGET_BYTES = 8192;
export const SYNAPSE_DEFAULT_MAX_OBJECT_BYTES = 1024 * 1024;
export const SYNAPSE_MAX_EMBEDDING_DIM = 8192;

/**
 * A JSON value as it arrives from config.json: parsed by the host, not yet
 * validated by us. Naming it keeps the unvalidated boundary visible.
 */
export type UnvalidatedJson = CanonicalValue | undefined;

export type SynapseMode = (typeof SYNAPSE_MODES)[number];
export type SynapseMemoryMode = (typeof SYNAPSE_MEMORY_MODES)[number];
export type SynapseStateRecovery = (typeof SYNAPSE_STATE_RECOVERIES)[number];
export type SynapseDeliveryGear = (typeof SYNAPSE_DELIVERY_GEARS)[number];

export type SynapseEmbeddingConfig = {
	dim: number;
	endpoint: string;
	keyEnv: string;
	model: string;
	provider: string;
};

export type SynapseConfig = {
	contextBudgetBytes: number;
	deliveryGear: SynapseDeliveryGear;
	embedding: SynapseEmbeddingConfig | null;
	maxObjectBytes: number;
	memory: SynapseMemoryMode;
	mode: SynapseMode;
	stateRecovery: SynapseStateRecovery;
	storageRoot: string | null;
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
		deliveryGear: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("uds")])),
		embedding: Type.Optional(EmbeddingSchema),
		maxObjectBytes: Type.Optional(Type.Integer({ minimum: 1 })),
		memory: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("project")])),
		mode: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("text"), Type.Literal("synapse")])),
		stateRecovery: Type.Optional(Type.Union([Type.Literal("resend"), Type.Literal("resend-then-text")])),
		storageRoot: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const rawConfigValidator = Compile(RawConfigSchema);
const recordProbe = Compile(Type.Record(Type.String(), Type.Unknown()));

const KNOWN_KEYS = new Set(Object.keys(RawConfigSchema.properties));
const KNOWN_EMBEDDING_KEYS = new Set(Object.keys(EmbeddingSchema.properties));

const ALLOWED_VALUES = new Map<string, readonly string[]>([
	["synapse.deliveryGear", SYNAPSE_DELIVERY_GEARS],
	["synapse.memory", SYNAPSE_MEMORY_MODES],
	["synapse.mode", SYNAPSE_MODES],
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
		// Off unless an experiment states it explicitly (Global Constraints: the
		// `uds` gear must never become the default path).
		deliveryGear: raw.deliveryGear ?? "file",
		embedding: raw.embedding === undefined ? null : resolveEmbedding(raw.embedding),
		maxObjectBytes: raw.maxObjectBytes ?? SYNAPSE_DEFAULT_MAX_OBJECT_BYTES,
		memory,
		mode,
		stateRecovery: raw.stateRecovery ?? "resend-then-text",
		storageRoot: raw.storageRoot === undefined ? null : resolveSynapseStorageRoot(raw.storageRoot, homeDir),
	};
}
