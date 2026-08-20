/**
 * Shared, cancellable requests (issue #60).
 *
 * The three behaviours the map's interaction path depends on, and which the
 * plain promise caches it replaces got only partly right:
 *
 *   - twelve panes asking the same question make one request,
 *   - a superseded request is really cancelled, not merely ignored,
 *   - and one caller losing interest never cancels a request the others are
 *     still waiting for.
 *
 * The third is the one that makes the first two safe to combine, and is the
 * easiest to break by accident.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sharedRequest, isAbortError, type SharedCache } from '../lib/sharedRequest';

const TTL = 10_000;
const GRACE = 50;

/** A request whose completion the test controls. */
function deferredWork() {
  const signals: AbortSignal[] = [];
  const resolvers: Array<(value: string) => void> = [];
  const rejecters: Array<(err: unknown) => void> = [];

  const work = (signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<string>((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  };

  return {
    work,
    signals,
    calls: () => signals.length,
    resolve: (value: string, index = 0) => resolvers[index](value),
    reject: (err: unknown, index = 0) => rejecters[index](err),
  };
}

let cache: SharedCache<string>;

beforeEach(() => {
  cache = new Map();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('request sharing', () => {
  it('makes one request for callers that ask the same question at once', async () => {
    const w = deferredWork();
    const controllers = Array.from({ length: 12 }, () => new AbortController());

    const promises = controllers.map((c) =>
      sharedRequest(cache, 'viewport-a', TTL, w.work, c.signal, GRACE));

    expect(w.calls()).toBe(1);

    w.resolve('values');
    await expect(Promise.all(promises)).resolves.toEqual(Array(12).fill('values'));
    expect(w.calls()).toBe(1);
  });

  it('asks separately for different questions', () => {
    const w = deferredWork();
    void sharedRequest(cache, 'viewport-a', TTL, w.work, undefined, GRACE);
    void sharedRequest(cache, 'viewport-b', TTL, w.work, undefined, GRACE);
    expect(w.calls()).toBe(2);
  });

  it('serves a settled result from cache inside its TTL, and refetches after', async () => {
    const w = deferredWork();
    const first = sharedRequest(cache, 'k', TTL, w.work, undefined, GRACE);
    w.resolve('one');
    await expect(first).resolves.toBe('one');

    vi.advanceTimersByTime(TTL - 1);
    await expect(sharedRequest(cache, 'k', TTL, w.work, undefined, GRACE)).resolves.toBe('one');
    expect(w.calls()).toBe(1);

    vi.advanceTimersByTime(2);
    void sharedRequest(cache, 'k', TTL, w.work, undefined, GRACE);
    expect(w.calls()).toBe(2);
  });

  it('does not cache a failure', async () => {
    const w = deferredWork();
    const first = sharedRequest(cache, 'k', TTL, w.work, undefined, GRACE);
    w.reject(new Error('HTTP 500'));
    await expect(first).rejects.toThrow('HTTP 500');

    void sharedRequest(cache, 'k', TTL, w.work, undefined, GRACE);
    expect(w.calls()).toBe(2);
  });
});

describe('cancellation', () => {
  it('aborts the request once the last caller has gone', async () => {
    const w = deferredWork();
    const caller = new AbortController();
    const promise = sharedRequest(cache, 'k', TTL, w.work, caller.signal, GRACE);

    caller.abort();
    await expect(promise).rejects.toSatisfy(isAbortError);
    expect(w.signals[0].aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(GRACE + 1);
    expect(w.signals[0].aborted).toBe(true);
  });

  it('keeps the request alive for the callers that remain', async () => {
    const w = deferredWork();
    const leaving = new AbortController();
    const staying = new AbortController();

    const leavingPromise = sharedRequest(cache, 'k', TTL, w.work, leaving.signal, GRACE);
    const stayingPromise = sharedRequest(cache, 'k', TTL, w.work, staying.signal, GRACE);
    expect(w.calls()).toBe(1);

    leaving.abort();
    await expect(leavingPromise).rejects.toSatisfy(isAbortError);

    await vi.advanceTimersByTimeAsync(GRACE + 1);
    expect(w.signals[0].aborted).toBe(false);

    w.resolve('values');
    await expect(stayingPromise).resolves.toBe('values');
  });

  it('never abandons a caller that gave no signal', async () => {
    const w = deferredWork();
    const promise = sharedRequest(cache, 'k', TTL, w.work, undefined, GRACE);
    const leaving = new AbortController();
    void sharedRequest(cache, 'k', TTL, w.work, leaving.signal, GRACE).catch(() => undefined);

    leaving.abort();
    await vi.advanceTimersByTimeAsync(GRACE + 1);

    expect(w.signals[0].aborted).toBe(false);
    w.resolve('values');
    await expect(promise).resolves.toBe('values');
  });

  it('does not cancel a request the next tick asks for again', async () => {
    // applyColors supersedes its own previous run before it knows whether the
    // parameters changed. Cancelling on the spot would throw away a request
    // that is about to be wanted back, and cost a second round trip.
    const w = deferredWork();
    const first = new AbortController();
    void sharedRequest(cache, 'k', TTL, w.work, first.signal, GRACE).catch(() => undefined);

    first.abort();
    const second = new AbortController();
    const promise = sharedRequest(cache, 'k', TTL, w.work, second.signal, GRACE);

    await vi.advanceTimersByTimeAsync(GRACE + 1);
    expect(w.calls()).toBe(1);
    expect(w.signals[0].aborted).toBe(false);

    w.resolve('values');
    await expect(promise).resolves.toBe('values');
  });

  it('rejects immediately for a caller whose signal is already aborted', async () => {
    const w = deferredWork();
    const controller = new AbortController();
    controller.abort();

    await expect(sharedRequest(cache, 'k', TTL, w.work, controller.signal, GRACE))
      .rejects.toSatisfy(isAbortError);
    expect(w.calls()).toBe(0);
  });
});

describe('bookkeeping', () => {
  it('drops expired entries rather than growing for the life of the tab', async () => {
    // Keys embed the viewport bounds, so a minute of panning is a new key per
    // moveend.
    for (let i = 0; i < 5; i++) {
      const w = deferredWork();
      const p = sharedRequest(cache, `viewport-${i}`, TTL, w.work, undefined, GRACE);
      w.resolve('v');
      await p;
    }
    expect(cache.size).toBe(5);

    vi.advanceTimersByTime(TTL + 1);
    const w = deferredWork();
    void sharedRequest(cache, 'viewport-new', TTL, w.work, undefined, GRACE);
    expect(cache.size).toBe(1);
  });

  it('recognises an abort rejection in either shape', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
