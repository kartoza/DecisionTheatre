/**
 * Deletes entries older than `ttlMs` from a TTL-tagged cache Map, mutating it in place.
 *
 * A `Map` that only checks TTL on read (and never deletes stale entries) grows forever
 * for any key that isn't revisited after it expires - e.g. a cache keyed by viewport
 * bounds, where every pan produces a new key. Call this right before inserting a new
 * entry so the cache stays bounded to roughly one TTL window's worth of live entries.
 */
export function evictExpired<K, V extends { ts: number }>(cache: Map<K, V>, ttlMs: number, now = Date.now()): void {
  for (const [key, value] of cache) {
    if (now - value.ts >= ttlMs) cache.delete(key);
  }
}
