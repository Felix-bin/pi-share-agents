import * as path from "node:path";
import type { Embedder } from "./embedding.ts";

/**
 * A process-lifetime store of memory-record vectors.
 *
 * Why it exists: choosing a prediction base means ranking the sender's own records,
 * and ranking means comparing the query against every record's vector. Reading those
 * vectors from the content store once per send made the *selection* cost an order of
 * magnitude more than the payload it was trying to shrink (the P4-4 replay measured
 * 476 KiB of reads per round against a 4 KiB payload), which is the whole reason the
 * residual path came out net-negative on the full account. The bytes were real, so
 * they stay in the account — this makes them happen once instead of once per send.
 *
 * Two properties keep it honest rather than merely cheaper:
 *
 * 1. **Keyed by the object id**, which the content store derives from the vector's own
 *    bytes and re-verifies on every read. An entry can therefore never answer for a
 *    different object, and a record whose vector changed is a different key rather
 *    than a stale hit. The cache itself enforces none of that — it trusts the id it
 *    is handed — so the premise is stated here: the only caller passes the id the
 *    store computed, and no eviction policy is needed because nothing is mutated.
 * 2. **A hit performs no read, so it records no read event.** The metering stays a
 *    record of I/O that actually happened, and the one-time cost of filling the
 *    cache is attributed to the call that paid it. Nothing has to be subtracted
 *    from the account to make the cache visible: an account with the cache on simply
 *    has fewer read events, and the run's configuration says the cache was on.
 *
 * Two consequences are declared rather than discovered:
 *
 * - **A hit trusts the first verified read.** The dimension and finiteness checks in
 *   `readRecordVector` run once, when the entry is filled. If bytes under a cached id
 *   were later replaced, the cold path would report corruption and this one would
 *   keep serving the vector it verified — which is what a cache is, and why the
 *   object id has to be a digest.
 * - **Per-purpose read rows are not comparable across a cache-on and a cache-off
 *   run.** A vector is filled under whichever purpose touched it first, so which
 *   purpose "gets cheaper" depends on the order the run happened to rank things in.
 *   The total is comparable; the breakdown is not, and a report that prints the
 *   breakdown must say so.
 *
 * Vectors are copied on the way out and on the way in, so a caller that mutates what
 * it received cannot poison a later reader of the same entry. At dim 1024 that is
 * 4 KiB of memcpy against a file read — the trade the cache exists to make.
 */
export type MemoryVectorCache = {
	/** How many entries are held. Not a hit count: hits are `hits`. */
	readonly entryCount: number;
	/** A copy of the cached vector, or null when this object was never read here. */
	get(objectId: string): Float32Array | null;
	hits: number;
	misses: number;
	put(objectId: string, vector: Float32Array): void;
};

export function createMemoryVectorCache(): MemoryVectorCache {
	const entries = new Map<string, Float32Array>();
	const cache: MemoryVectorCache = {
		get(objectId: string): Float32Array | null {
			const held = entries.get(objectId);
			if (held === undefined) {
				cache.misses += 1;
				return null;
			}
			cache.hits += 1;
			return held.slice();
		},
		hits: 0,
		misses: 0,
		put(objectId: string, vector: Float32Array): void {
			entries.set(objectId, vector.slice());
		},
		get entryCount(): number {
			return entries.size;
		},
	};
	return cache;
}

/**
 * The cache a process shares between memory services.
 *
 * The services that need this are constructed per delegation — one per send, and one
 * per state consumption — so a cache owned by any single service would be discarded
 * before its second use and would save nothing. The key is the storage root plus the
 * representation: two runs reading different stores, or the same store under
 * different embedding spaces, must not share entries even though a content id would
 * never collide across them.
 *
 * Two details keep the registry from being a leak. Paths are resolved and, on
 * Windows, case-folded, so the same directory reached by two spellings is one entry
 * rather than two caches that each miss; and the registry holds at most
 * `MAX_REGISTERED_CACHES` stores, evicting the oldest, because a long-lived process
 * can be pointed at any number of stores and an unbounded map of whole vector sets is
 * a memory leak with a cache's name.
 */
const MAX_REGISTERED_CACHES = 8;
const PROCESS_CACHES = new Map<string, MemoryVectorCache>();

function registryKey(storageRoot: string, embedder: Embedder): string {
	// Resolved so `.` and `..` do not make two keys for one directory; case-folded on
	// Windows only, where the filesystem is case-insensitive. The value is a map key,
	// never used as a path, so folding it cannot affect where anything is read from.
	const resolved = path.resolve(storageRoot);
	const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	return `${normalized}\n${embedder.representationId}`;
}

export function memoryVectorCacheFor(storageRoot: string, embedder: Embedder): MemoryVectorCache {
	const key = registryKey(storageRoot, embedder);
	const existing = PROCESS_CACHES.get(key);
	if (existing !== undefined) return existing;
	const created = createMemoryVectorCache();
	PROCESS_CACHES.set(key, created);
	// Insertion-ordered, so the first key is the oldest.
	if (PROCESS_CACHES.size > MAX_REGISTERED_CACHES) {
		const oldest = PROCESS_CACHES.keys().next().value;
		if (oldest !== undefined) PROCESS_CACHES.delete(oldest);
	}
	return created;
}

/** Drops every process cache. Tests call this between cases; nothing else should. */
export function resetMemoryVectorCaches(): void {
	PROCESS_CACHES.clear();
}
