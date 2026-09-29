/**
 * Timing for fetch() calls to the Go server, so a slow response surfaces as a
 * toast instead of the app just looking frozen — in both the browser and
 * webview runtimes, since both talk to the server over the same relative
 * `/api` paths (see types/runtime.ts).
 *
 * There are 40+ fetch() call sites for `/api/*` scattered across
 * hooks/useApi.ts and several components, with no shared request wrapper to
 * hook into. Wrapping `window.fetch` once at startup covers all of them,
 * including any added later, without touching each call site.
 *
 * Concurrent slow requests collapse into one notification: a count of
 * "currently slow" requests only reports on the 0→1 and 1→0 transitions, so a
 * burst of related calls (e.g. loading a site's indicators and catchments
 * together) still produces a single toast rather than one per request.
 */

/** How long a request runs before it counts as slow. */
const SLOW_REQUEST_THRESHOLD_MS = 5000;

type Listener = (slow: boolean) => void;

const listeners = new Set<Listener>();
let slowCount = 0;
let installed = false;

function notify(slow: boolean): void {
  for (const listener of listeners) listener(slow);
}

/**
 * Subscribe to the app-wide "is a request to the server currently slow"
 * state. Fires `true` when the first request crosses the threshold and
 * `false` once none remain. Returns an unsubscribe function.
 */
export function onSlowNetwork(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isGoServerRequest(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  try {
    return new URL(url, window.location.origin).pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/**
 * Wrap `window.fetch` with the timing above. Idempotent — safe to call more
 * than once (React StrictMode, hot reload) since only the first call takes
 * effect.
 */
export function installSlowNetworkMonitor(): void {
  if (installed) return;
  installed = true;

  const nativeFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isGoServerRequest(input)) {
      return nativeFetch(input, init);
    }

    let becameSlow = false;
    const timer = setTimeout(() => {
      becameSlow = true;
      slowCount += 1;
      if (slowCount === 1) notify(true);
    }, SLOW_REQUEST_THRESHOLD_MS);

    const settle = () => {
      clearTimeout(timer);
      if (!becameSlow) return;
      slowCount -= 1;
      if (slowCount === 0) notify(false);
    };

    const result = nativeFetch(input, init);
    result.then(settle, settle);
    return result;
  };
}
