/**
 * One in-flight request per key, shared by every caller, cancelled once the last
 * caller has walked away.
 *
 * Three separate problems on the map's interaction path, all of which the
 * existing `Map<string, {promise, ts}>` caches solved only halfway:
 *
 *  1. **Fan-out.** Twelve panes ask for the same aggregate or the same viewport's
 *     catchment values in the same tick. A promise cache collapses those to one
 *     request — that part already worked.
 *
 *  2. **Supersession.** A pan makes the previous viewport's request pointless
 *     before it lands. Ignoring the answer still leaves the connection and the
 *     server working on it, so the caller passes an `AbortSignal` and the
 *     request is really cancelled.
 *
 *  3. **The collision between the two.** A shared request has several owners, so
 *     one owner losing interest must not cancel it for the rest. Subscribers are
 *     counted, and the abort only fires when the count reaches zero.
 *
 * The grace period exists because callers routinely release and re-subscribe to
 * the same key across an await — MapView's applyColors supersedes its own
 * previous run before it knows whether the parameters changed. Aborting
 * immediately would cancel a request the very next tick wants back. Waiting a
 * few milliseconds costs nothing against a 4-second query and makes the common
 * "recompute with identical parameters" path free.
 */

const DEFAULT_ABORT_GRACE_MS = 50;

export interface SharedEntry<T> {
  promise: Promise<T>;
  /** Start time, for TTL eviction — see evictExpired. */
  ts: number;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
  abortTimer: ReturnType<typeof setTimeout> | null;
}

export type SharedCache<T> = Map<string, SharedEntry<T>>;

/** True for the rejection an aborted fetch produces, in either shape. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'AbortError';
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function subscribe<T>(entry: SharedEntry<T>): void {
  entry.subscribers += 1;
  if (entry.abortTimer !== null) {
    clearTimeout(entry.abortTimer);
    entry.abortTimer = null;
  }
}

function release<T>(cache: SharedCache<T>, key: string, entry: SharedEntry<T>, graceMs: number): void {
  entry.subscribers -= 1;
  if (entry.subscribers > 0 || entry.settled || entry.abortTimer !== null) return;

  entry.abortTimer = setTimeout(() => {
    entry.abortTimer = null;
    // Someone re-subscribed, or the answer arrived, during the grace period.
    if (entry.subscribers > 0 || entry.settled) return;
    entry.controller.abort();
    if (cache.get(key) === entry) cache.delete(key);
  }, graceMs);
}

/**
 * Reject as soon as this caller's own signal aborts, without disturbing the
 * shared request that other callers may still be waiting on.
 */
function rejectOnAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    const done = () => signal.removeEventListener('abort', onAbort);
    promise.then(
      (value) => { done(); resolve(value); },
      (err) => { done(); reject(err); },
    );
  });
}

/**
 * Run `work` for `key`, or join the run already under way for it.
 *
 * `work` receives the shared `AbortSignal`; pass it to fetch. `signal` is the
 * caller's own — abort it when this caller's result stops being wanted.
 *
 * Rejections are never cached: a failed request must not poison the key for the
 * rest of the TTL window.
 */
export function sharedRequest<T>(
  cache: SharedCache<T>,
  key: string,
  ttlMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  abortGraceMs: number = DEFAULT_ABORT_GRACE_MS,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());

  const now = Date.now();
  let entry = cache.get(key);

  // A settled entry is only reusable inside its TTL. An unsettled one is always
  // reusable — that is the fan-out case, and a slow request should gather
  // callers rather than spawn duplicates of itself.
  if (entry && entry.settled && now - entry.ts >= ttlMs) {
    cache.delete(key);
    entry = undefined;
  }

  if (!entry) {
    // Sweep before inserting: keys embed viewport bounds, so a session of
    // panning would otherwise grow this map without bound.
    for (const [otherKey, other] of cache) {
      if (other.settled && now - other.ts >= ttlMs) cache.delete(otherKey);
    }

    const controller = new AbortController();
    const created: SharedEntry<T> = {
      promise: undefined as unknown as Promise<T>,
      ts: now,
      controller,
      subscribers: 0,
      settled: false,
      abortTimer: null,
    };
    created.promise = work(controller.signal).then(
      (value) => {
        created.settled = true;
        return value;
      },
      (err) => {
        created.settled = true;
        if (cache.get(key) === created) cache.delete(key);
        throw err;
      },
    );
    // Nobody may be awaiting the shared promise directly (every caller awaits
    // its own rejectOnAbort wrapper), so keep it from counting as unhandled.
    created.promise.catch(() => undefined);
    cache.set(key, created);
    entry = created;
  }

  if (!signal) {
    // A caller with no signal never leaves, so the request can never be
    // abandoned out from under it.
    subscribe(entry);
    return entry.promise;
  }

  const joined = entry;
  subscribe(joined);
  const onAbort = () => release(cache, key, joined, abortGraceMs);
  signal.addEventListener('abort', onAbort, { once: true });
  joined.promise.then(
    () => signal.removeEventListener('abort', onAbort),
    () => signal.removeEventListener('abort', onAbort),
  );

  return rejectOnAbort(joined.promise, signal);
}
