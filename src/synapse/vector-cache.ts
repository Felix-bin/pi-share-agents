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
 * 1. **Keyed by the object id**, which is the digest of the vector's own bytes. An
 *    entry can therefore never answer for a different object, and a record whose
 *    vector changed is a different key rather than a stale hit. Records are
 *    immutable and vectors are content-addressed, so nothing else needs
 *    invalidating — there is no eviction policy to get wrong.
 * 2. **A hit performs no read, so it records no read event.** The metering stays a
 *    record of I/O that actually happened, and the one-time cost of filling the
 *    cache is attributed to the call that paid it. Nothing has to be subtracted
 *    from the account to make the cache visible: an account with the cache on simply
 *    has fewer read events, and the run's configuration says the cache was on.
 *
 * Vectors are copied on the way out and on the way in, so a caller that mutates what
 * it received cannot poison a later reader of the same entry. At dim 1024 that is
 * 4 KiB of memcpy against a file read — the trade the cache exists to make.
 */
export type MemoryVectorCache = {
	/** A copy of the cached vector, or null when this object was never read here. */
	get(objectId: string): Float32Array | null;
	hits: number;
	misses: number;
	put(objectId: string, vector: Float32Array): void;
	/** Reads served from the cache since creation. */
	readonly size: number;
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
		get size(): number {
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
 */
const PROCESS_CACHES = new Map<string, MemoryVectorCache>();

export function memoryVectorCacheFor(storageRoot: string, embedder: Embedder): MemoryVectorCache {
	const key = `${storageRoot}\n${embedder.representationId}`;
	const existing = PROCESS_CACHES.get(key);
	if (existing !== undefined) return existing;
	const created = createMemoryVectorCache();
	PROCESS_CACHES.set(key, created);
	return created;
}

/** Drops every process cache. Tests call this between cases; nothing else should. */
export function resetMemoryVectorCaches(): void {
	PROCESS_CACHES.clear();
}
