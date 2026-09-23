import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { writeAtomicJson } from "../shared/atomic-json.ts";
import { getAgentDir } from "../shared/utils.ts";
import { resolveEmbeddingKey, SYNAPSE_KEY_ENV } from "./credentials.ts";
import type { SynapseEmbeddingConfig } from "./config.ts";
import { createContentStore, type ContentStore } from "./content-store.ts";
import type { MeteringIdentity, MeteringLog } from "./metering.ts";

/**
 * SiliconFlow embeddings client and its two-level cache.
 *
 * Wire format discipline: requests always use `encoding_format: "base64"`.
 * The provider's default JSON decimal encoding perturbs the low bits of each
 * float, and those low bits are exactly what the residual calibration (spec
 * §8.1) quantises — a polluted input would silently invalidate the calibration
 * corpus. Queries are sent one text per request because batch composition
 * influences inference output; batching is reserved for corpus construction,
 * where a fixed batch size keeps runs reproducible.
 *
 * The cache is an optimisation, never a source of truth: a cache entry is only
 * ever replayed after the content store has re-verified the vector bytes
 * against their digest, and any unreadable or mismatched entry is treated as a
 * miss. A hit makes no network call and records no `embedding-call` event,
 * because no call happened.
 */

export const SYNAPSE_EMBEDDING_TIMEOUT_MS = 30_000;
/** Corpus batching only; queries are always single-text (see module comment). */
export const SYNAPSE_EMBEDDING_BATCH_LIMIT = 32;

export const SYNAPSE_VECTOR_MEDIA_TYPE = "application/x-float32-vector";

const EMBEDDING_CACHE_DIR = "embedding-cache";

export type EmbeddingRequest = { text: string };

export type EmbeddingResult = {
	vector: Float32Array;
	promptTokens: number | null;
	latencyMs: number;
	cached: boolean;
};

export type Embedder = {
	embedQuery(text: string): Promise<EmbeddingResult>;
	embedBatch(texts: readonly string[]): Promise<readonly EmbeddingResult[]>;
	readonly representationId: string;
};

/**
 * Wraps an embedder so the calls it makes are recorded in the run's ledger.
 *
 * The run's embedder is built from configuration alone and never carries an
 * identity, so nothing it does would otherwise appear as an `embedding-call` —
 * and an embedding whose cost is invisible is exactly the failure the P4-5
 * pre-registration names as a silent bias: the account would look complete while
 * the provider's tokens and latency were dropped on the floor. Wrapping at the
 * call site that owns the identity keeps the provider itself ignorant of who is
 * asking.
 *
 * A cache hit records nothing, matching the provider's own rule: a hit makes no
 * network call, so counting it would report a request that never happened.
 */
export function meteredEmbedder(embedder: Embedder, identity: MeteringIdentity, log: MeteringLog): Embedder {
	const record = (ok: boolean, durationMs: number, inputTokens: number | null): void => {
		log.record(identity, { costUsd: null, durationMs, inputTokens, kind: "embedding-call", ok, requests: 1 });
	};
	return {
		async embedBatch(texts: readonly string[]): Promise<readonly EmbeddingResult[]> {
			try {
				const results = await embedder.embedBatch(texts);
				// One request covers the batch, so it is recorded once rather than per
				// vector; a fully cached batch records nothing.
				const measured = results.filter((result) => !result.cached);
				if (measured.length > 0) {
					record(true, measured.reduce((total, result) => total + result.latencyMs, 0), measured.reduce((total, result) => total + (result.promptTokens ?? 0), 0));
				}
				return results;
			} catch (error) {
				record(false, 0, null);
				throw error;
			}
		},
		async embedQuery(text: string): Promise<EmbeddingResult> {
			try {
				const result = await embedder.embedQuery(text);
				if (!result.cached) record(true, result.latencyMs, result.promptTokens);
				return result;
			} catch (error) {
				record(false, 0, null);
				throw error;
			}
		},
		representationId: embedder.representationId,
	};
}

type EmbedderBaseDeps = {
	key: string;
	/** Enables the persistent L2 cache rooted at the project storage directory. */
	storageRoot?: string;
	fetchFn?: typeof fetch;
};

export type EmbedderDeps =
	| (EmbedderBaseDeps & {
			/** Event identity comes from the host and must not be invented here; it is only meaningful together with a metering log. */
			identity: MeteringIdentity;
			metering: MeteringLog;
	  })
	| (EmbedderBaseDeps & { identity?: undefined; metering?: undefined });

export class EmbeddingHttpError extends Error {
	constructor(status: number) {
		super(`embedding request failed with http ${status}`);
		this.name = "EmbeddingHttpError";
	}
}

/**
 * How a provider puts a vector on the wire.
 *
 * Two shapes exist and they are not interchangeable. SiliconFlow honours
 * `encoding_format: "base64"` and returns packed float32; an ordinary
 * OpenAI-compatible gateway ignores the parameter and returns an array of JSON
 * numbers. Sending the base64 request to the latter is not a hard failure — it
 * returns numbers anyway — so a client that assumed one shape would decode the
 * other into a plausible wrong vector, and those low bits are exactly what the
 * residual calibration quantises (spec §8.1). The format is therefore chosen by
 * provider, never sniffed from the response.
 */
export type EmbeddingWireFormat = "base64-float32" | "json-number-array";

/**
 * What the client has to know about a provider to talk to it.
 *
 * Both fields are properties of the endpoint, not preferences: the format is
 * described above, and `dimensionsParam` says whether the output width can be
 * asked for. A model whose native width differs from the configured one needs
 * that field — declaring 1024 and receiving 2048 is a dimension mismatch that
 * would surface as a failed run rather than as a wrong answer, which is the
 * better of the two, but still not a run.
 */
export type EmbeddingProviderProfile = {
	dimensionsParam: boolean;
	format: EmbeddingWireFormat;
};

/**
 * The profile of a whitelisted provider. Exported so the pairing can be tested
 * as a pairing: a provider the config parser accepts but this table does not
 * know would fail at the first embedding call rather than at load.
 */
export function embeddingProviderProfileFor(provider: string): EmbeddingProviderProfile {
	if (provider === "paratera") return { dimensionsParam: true, format: "json-number-array" };
	if (provider === "siliconflow") return { dimensionsParam: false, format: "base64-float32" };
	// Unreachable through the config parser, which refuses providers outside its
	// whitelist; a direct caller gets an error rather than a guessed default.
	throw new Error(`no embedding wire format is defined for provider ${JSON.stringify(provider)}`);
}

function profileOf(cfg: SynapseEmbeddingConfig): EmbeddingProviderProfile {
	return embeddingProviderProfileFor(cfg.provider);
}

/** What this client puts on the wire: the two shared fields, plus what the profile allows. */
type EmbeddingRequestBody = {
	dimensions?: number;
	encoding_format?: string;
	input: string | readonly string[];
	model: string;
};

const EmbeddingItemSchema = Type.Object({
	embedding: Type.String({ minLength: 1 }),
	index: Type.Optional(Type.Integer()),
});

const EmbeddingResponseSchema = Type.Object({
	data: Type.Array(EmbeddingItemSchema, { minItems: 1 }),
	usage: Type.Optional(Type.Object({ prompt_tokens: Type.Optional(Type.Number()) })),
});

const JsonEmbeddingItemSchema = Type.Object({
	embedding: Type.Array(Type.Number()),
	index: Type.Optional(Type.Integer()),
});

const JsonEmbeddingResponseSchema = Type.Object({
	data: Type.Array(JsonEmbeddingItemSchema, { minItems: 1 }),
	usage: Type.Optional(Type.Object({ prompt_tokens: Type.Optional(Type.Number()) })),
});

const embeddingResponseValidator = Compile(EmbeddingResponseSchema);
const jsonEmbeddingResponseValidator = Compile(JsonEmbeddingResponseSchema);

const CacheEntrySchema = Type.Object(
	{
		contentId: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		dim: Type.Integer({ minimum: 1 }),
		promptTokens: Type.Union([Type.Number(), Type.Null()]),
		representationId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const cacheEntryValidator = Compile(CacheEntrySchema);

type CacheEntry = { contentId: string; dim: number; promptTokens: number | null; representationId: string };

/** Mirrors `representationIdOf` in config.ts for callers holding only the embedding block. */
function representationIdOfConfig(cfg: SynapseEmbeddingConfig): string {
	return `${cfg.provider}/${cfg.model}/${cfg.dim}`;
}

function cacheKeyOf(representationId: string, text: string): string {
	return createHash("sha256").update(`${representationId}\0${text}`, "utf-8").digest("hex");
}

function decodeFloat32LE(bytes: Uint8Array): Float32Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out = new Float32Array(Math.floor(bytes.byteLength / 4));
	for (let index = 0; index < out.length; index += 1) {
		out[index] = view.getFloat32(index * 4, true);
	}
	return out;
}

function decodeEmbeddingBytes(bytes: Uint8Array): Float32Array {
	// A payload whose length is not a whole number of float32 values would
	// otherwise be silently truncated by decodeFloat32LE, and a dimension check
	// cannot distinguish that from a provider bug it should have reported.
	if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
		throw new Error(`embedding payload of ${bytes.byteLength} bytes is not a whole number of float32 values`);
	}
	return decodeFloat32LE(bytes);
}

function bytesOfVector(vector: Float32Array): Uint8Array {
	return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * The response body as vectors, in request order, decoded by the provider's own
 * wire format — plus the provider's own token count when it reports one.
 *
 * Takes the raw text rather than an already-parsed value on purpose: parsing,
 * shape checking and decoding are one boundary. Split apart, this would become a
 * function that accepts "some JSON" and promises a vector — the shape that lets a
 * wrong-space response decode into a plausible wrong answer.
 */
/** What one response body yielded: the provider's token count, and the vectors. */
type DecodedEmbeddingResponse = { promptTokens: number | null; vectors: Float32Array[] };

function decodeResponseBody(body: string, format: EmbeddingWireFormat, expectedCount: number, dim: number): DecodedEmbeddingResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("embedding response is not valid JSON");
	}
	if (format === "json-number-array") {
		if (!jsonEmbeddingResponseValidator.Check(parsed)) throw new Error("embedding response does not match the expected schema");
		if (parsed.data.length !== expectedCount) {
			throw new Error(`embedding response holds ${parsed.data.length} vectors for ${expectedCount} inputs`);
		}
		const vectors = [...parsed.data]
			.sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
			// A JSON number is a double and the vector is float32; the narrowing happens
			// here in one place, so the wire type and the stored type cannot drift apart.
			.map((item) => validatedUnitVector(Float32Array.from(item.embedding), dim));
		return { promptTokens: parsed.usage?.prompt_tokens ?? null, vectors };
	}
	if (!embeddingResponseValidator.Check(parsed)) throw new Error("embedding response does not match the expected schema");
	if (parsed.data.length !== expectedCount) {
		throw new Error(`embedding response holds ${parsed.data.length} vectors for ${expectedCount} inputs`);
	}
	const vectors = [...parsed.data]
		.sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
		.map((item) => validatedUnitVector(decodeEmbeddingBytes(Buffer.from(item.embedding, "base64")), dim));
	return { promptTokens: parsed.usage?.prompt_tokens ?? null, vectors };
}

function validatedUnitVector(values: Float32Array, dim: number): Float32Array {
	if (values.length !== dim) {
		throw new Error(`embedding dimension mismatch: response holds ${values.length} floats, configuration declares ${dim}`);
	}
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index]!;
		if (!Number.isFinite(value)) {
			throw new Error(`embedding vector contains a non-finite value at index ${index}`);
		}
	}
	// hypot cannot overflow the way a naive sum of squares can for large components.
	const norm = Math.hypot(...values);
	if (!(norm > 0)) {
		throw new Error("embedding vector has zero norm and cannot be normalized");
	}
	const unit = new Float32Array(dim);
	for (let index = 0; index < dim; index += 1) {
		unit[index] = values[index]! / norm;
	}
	return unit;
}

type PersistentCache = {
	load: (key: string) => { bytes: Uint8Array; promptTokens: number | null } | null;
	store: (key: string, vector: Float32Array, promptTokens: number | null) => void;
};

function createPersistentCache(storageRoot: string, representationId: string, dim: number): PersistentCache {
	const cacheDir = path.join(storageRoot, EMBEDDING_CACHE_DIR);
	const contentStore: ContentStore = createContentStore(storageRoot);

	function entryPath(key: string): string {
		return path.join(cacheDir, key.slice(0, 2), `${key}.json`);
	}

	function readEntry(key: string): CacheEntry | null {
		let raw = "";
		try {
			raw = fs.readFileSync(entryPath(key), "utf-8");
		} catch {
			return null;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}
		if (!cacheEntryValidator.Check(parsed)) return null;
		// The cache key already binds representationId and text, so a mismatching
		// entry can only be corruption: fall through to a miss instead of serving it.
		if (parsed.representationId !== representationId || parsed.dim !== dim) return null;
		return parsed;
	}

	return {
		load(key: string) {
			const entry = readEntry(key);
			if (entry === null) return null;
			try {
				// The content store re-verifies the digest on every read, so a cached
				// vector is byte-accountable or not served at all.
				return { bytes: contentStore.read(entry.contentId), promptTokens: entry.promptTokens };
			} catch {
				return null;
			}
		},
		store(key: string, vector: Float32Array, promptTokens: number | null) {
			const contentId = contentStore.put(bytesOfVector(vector), SYNAPSE_VECTOR_MEDIA_TYPE);
			writeAtomicJson(entryPath(key), {
				contentId,
				dim,
				promptTokens,
				representationId,
			} satisfies CacheEntry);
		},
	};
}

/**
 * Builds the configured embedder, or none when semantic retrieval is not
 * configured or cannot start.
 *
 * Takes the embedding config rather than the whole synapse config so the two
 * senders that need it — the host before a delegation and the receiver's own
 * text fallback — can both call it from what they hold. Both resolve their
 * storage root through the same `resolveStorageRoot`, so the cache subtree is
 * shared and a vector embedded once is not paid for twice.
 *
 * The key comes from the environment only, never from a key file, and a missing
 * key degrades to keyword ranking rather than failing the caller.
 */
/**
 * The key the configured provider is called with: the named environment
 * variable first, then the one `/synapse-setup key` stored.
 *
 * The stored key is consulted only when the configuration names the
 * provider's own variable. That guard is what keeps a stored credential out
 * of every other caller: `resolveEmbeddingKey` matches the canonical name on
 * its own, so a differently-named variable would skip the environment branch
 * entirely and fall through to the user's credentials file — which is
 * exactly what a test naming its own variable must never do.
 *
 * Without this fallback the plugin's own guidance is a trap: a key stored
 * with `/synapse-setup key` makes the status line report a configured
 * fingerprint while every embedder built from configuration stays absent, so
 * semantic retrieval and the whole state plane go quietly unused.
 */
function resolveEmbeddingKeyFor(embedding: SynapseEmbeddingConfig): string | undefined {
	const fromEnv = process.env[embedding.keyEnv];
	if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
	if (embedding.keyEnv !== SYNAPSE_KEY_ENV) return undefined;
	return resolveEmbeddingKey({ agentDir: getAgentDir(), env: process.env }).key ?? undefined;
}

export function resolveConfiguredEmbedder(embedding: SynapseEmbeddingConfig | null, storageRoot: string): Embedder | undefined {
	if (embedding === null) return undefined;
	const key = resolveEmbeddingKeyFor(embedding);
	if (key === undefined) return undefined;
	try {
		// The persistent cache lives in its own subtree, so embedding-cache object
		// writes never mix into the memory store's object-io accounting.
		return createEmbeddingClient(embedding, { key, storageRoot: path.join(storageRoot, "embedding-store") });
	} catch {
		return undefined;
	}
}

export function createEmbeddingClient(cfg: SynapseEmbeddingConfig, deps: EmbedderDeps): Embedder {
	const representationId = representationIdOfConfig(cfg);
	const fetchFn = deps.fetchFn ?? fetch;
	const memory = new Map<string, EmbeddingResult>();
	const persistent = deps.storageRoot === undefined ? null : createPersistentCache(deps.storageRoot, representationId, cfg.dim);

	function recordCall(ok: boolean, durationMs: number, inputTokens: number | null): void {
		if (deps.metering === undefined || deps.identity === undefined) return;
		deps.metering.record(deps.identity, { costUsd: null, durationMs, inputTokens, kind: "embedding-call", ok, requests: 1 });
	}

	async function requestEmbeddings(input: string | readonly string[]): Promise<{ durationMs: number; vectors: Float32Array[]; promptTokens: number | null }> {
		const expectedCount = Array.isArray(input) ? input.length : 1;
		const { dimensionsParam, format } = profileOf(cfg);
		// Each field is added only where the endpoint honours it: the parameter asked
		// for from a provider that ignores it would state a request the response does
		// not answer, and the width has to be asked for where the model's native
		// width is not the configured one. An absent key and a present one matter to
		// the wire, so the body is assembled rather than spread over a default.
		const body: EmbeddingRequestBody = { input, model: cfg.model };
		if (dimensionsParam) body.dimensions = cfg.dim;
		if (format === "base64-float32") body.encoding_format = "base64";
		const startedAt = performance.now();
		try {
			const response = await fetchFn(cfg.endpoint, {
				body: JSON.stringify(body),
				headers: { authorization: `Bearer ${deps.key}`, "content-type": "application/json" },
				method: "POST",
				signal: AbortSignal.timeout(SYNAPSE_EMBEDDING_TIMEOUT_MS),
			});
			if (!response.ok) {
				// Drain without reading into any error message: an error body is not
				// evidence and must not leak into logs or prompts.
				await response.arrayBuffer().catch(() => undefined);
				throw new EmbeddingHttpError(response.status);
			}
			const { promptTokens, vectors } = decodeResponseBody(await response.text(), format, expectedCount, cfg.dim);
			const durationMs = performance.now() - startedAt;
			recordCall(true, durationMs, promptTokens);
			return { durationMs, promptTokens, vectors };
		} catch (error) {
			recordCall(false, performance.now() - startedAt, null);
			throw error;
		}
	}

	function fromCacheHit(key: string, bytes: Uint8Array, promptTokens: number | null, latencyMs: number): EmbeddingResult | null {
		// Cached bytes were unit-normalized before they were stored and the content
		// store has re-verified them against their digest, so replaying them without
		// re-normalising keeps the cache byte-exact by construction; normalising
		// again could flip a last-bit rounding on some vectors.
		let vector: Float32Array;
		try {
			vector = decodeEmbeddingBytes(bytes);
		} catch {
			// An undecodable payload is a miss, like every other unreadable entry.
			return null;
		}
		// The digest verifies the bytes against the content id, not against the
		// entry's dimension claim, so a corrupted entry must miss here rather than
		// serve a wrong-dimension vector as cached.
		if (vector.length !== cfg.dim) return null;
		const result: EmbeddingResult = { cached: true, latencyMs, promptTokens, vector };
		// The cache keeps its own copy so a caller mutating a returned vector can
		// never poison later cache hits.
		memory.set(key, { ...result, vector: new Float32Array(vector) });
		return result;
	}

	function storeQuietly(key: string, vector: Float32Array, promptTokens: number | null): void {
		if (persistent === null) return;
		try {
			persistent.store(key, vector, promptTokens);
		} catch {
			// The cache is an optimisation: a failed persistent write must not fail
			// an embedding that already succeeded over the network.
		}
	}

	async function embedQuery(text: string): Promise<EmbeddingResult> {
		if (text.length === 0) throw new Error("embedding input must be a non-empty string");
		const startedAt = performance.now();
		const key = cacheKeyOf(representationId, text);
		const inMemory = memory.get(key);
		if (inMemory !== undefined) {
			return { ...inMemory, cached: true, latencyMs: performance.now() - startedAt, vector: new Float32Array(inMemory.vector) };
		}
		if (persistent !== null) {
			const hit = persistent.load(key);
			if (hit !== null) {
				const replayed = fromCacheHit(key, hit.bytes, hit.promptTokens, performance.now() - startedAt);
				if (replayed !== null) return replayed;
			}
		}
		const { promptTokens, vectors } = await requestEmbeddings(text);
		const result: EmbeddingResult = { cached: false, latencyMs: performance.now() - startedAt, promptTokens, vector: vectors[0]! };
		memory.set(key, { ...result, vector: new Float32Array(result.vector) });
		storeQuietly(key, result.vector, promptTokens);
		return result;
	}

	async function embedBatch(texts: readonly string[]): Promise<readonly EmbeddingResult[]> {
		const results: (EmbeddingResult | undefined)[] = Array.from<EmbeddingResult | undefined>({ length: texts.length });
		const pending = new Map<string, { indexes: number[]; text: string }>();
		for (const [position, text] of texts.entries()) {
			if (text.length === 0) throw new Error("embedding input must be a non-empty string");
			const startedAt = performance.now();
			const key = cacheKeyOf(representationId, text);
			const inMemory = memory.get(key);
			if (inMemory !== undefined) {
				results[position] = { ...inMemory, cached: true, latencyMs: performance.now() - startedAt, vector: new Float32Array(inMemory.vector) };
				continue;
			}
			if (persistent !== null) {
				const hit = persistent.load(key);
				if (hit !== null) {
					const replayed = fromCacheHit(key, hit.bytes, hit.promptTokens, performance.now() - startedAt);
					if (replayed !== null) {
						results[position] = replayed;
						continue;
					}
				}
			}
			const existing = pending.get(key);
			if (existing === undefined) pending.set(key, { indexes: [position], text });
			else existing.indexes.push(position);
		}
		const misses = [...pending.entries()];
		for (let start = 0; start < misses.length; start += SYNAPSE_EMBEDDING_BATCH_LIMIT) {
			const chunk = misses.slice(start, start + SYNAPSE_EMBEDDING_BATCH_LIMIT);
			const { durationMs, promptTokens, vectors } = await requestEmbeddings(chunk.map(([, miss]) => miss.text));
			// promptTokens is the provider's usage for the whole chunk, not a per-text value.
			for (const [[key, miss], vector] of zip(chunk, vectors)) {
				const result: EmbeddingResult = { cached: false, latencyMs: durationMs, promptTokens, vector };
				// Every returned result and the cache each hold their own vector, so no
				// caller mutation can reach another slot or a later cache hit.
				memory.set(key, { ...result, vector: new Float32Array(vector) });
				results[miss.indexes[0]!] = { ...result, vector: new Float32Array(vector) };
				for (const duplicate of miss.indexes.slice(1)) {
					results[duplicate] = { ...result, cached: true, vector: new Float32Array(vector) };
				}
				storeQuietly(key, vector, promptTokens);
			}
		}
		return results.map((result) => {
			if (result === undefined) throw new Error("embedding batch left an unfilled slot");
			return result;
		});
	}

	return { embedBatch, embedQuery, representationId };
}

function zip<Key, Value>(keys: readonly Key[], values: readonly Value[]): [Key, Value][] {
	if (keys.length !== values.length) throw new Error(`zip: ${keys.length} keys for ${values.length} values`);
	return keys.map((key, index) => [key, values[index]!]);
}
