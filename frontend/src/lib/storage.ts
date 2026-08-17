/**
 * localStorage writes that do not fail silently.
 *
 * Every write path used to discard its error in an empty catch block, so once the
 * quota was exhausted, saves appeared to succeed and did not. The
 * user saw the change reflected in React state and lost it on reload. That reaches
 * us as "the app is flaky" or "it lost my work", not as a storage complaint, and it
 * hides the underlying problem from anyone debugging it.
 *
 * Two kinds of write share this module, and they deserve different treatment:
 *
 *   - **The user's work** — sites and their indicators. Losing one of these is
 *     losing something they made. `saveLocalSites` in hooks/useApi.ts already
 *     reports its failure so the caller can tell them.
 *
 *   - **Interface preferences** — pane layout, focused pane, current page. Losing
 *     one is losing a preference. Raising a toast per failed write would be noise,
 *     several times a minute, about something the user cannot act on per-write.
 *
 * So preference writes report through `onStorageFailure`, which fires **once per
 * kind of failure per session**. The user is told once that their layout will not
 * be remembered and why; they are not told again on every pane drag.
 */

/** What went wrong, as far as it can be told apart. */
export type StorageFailureKind =
  /** The origin's storage quota is full. Actionable: delete something. */
  | 'quota'
  /** localStorage is not usable at all — private mode, or blocked by policy. */
  | 'unavailable'
  /** Something else. Reported so it cannot hide, even without specific advice. */
  | 'unknown';

export interface StorageFailure {
  kind: StorageFailureKind;
  /** The key being written when it failed, for a developer reading a log. */
  key: string;
  error: unknown;
}

/**
 * A quota error, under either name browsers use for it.
 *
 * Firefox reports `NS_ERROR_DOM_QUOTA_REACHED`; everyone else uses the standard
 * name. Some older browsers set only the legacy numeric code.
 */
export function isQuotaExceededError(err: unknown): boolean {
  if (!(err instanceof DOMException)) return false;
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014
  );
}

function classify(err: unknown): StorageFailureKind {
  if (isQuotaExceededError(err)) return 'quota';
  // A SecurityError, or localStorage missing entirely, means storage is not
  // available rather than full — private browsing, or a blocking policy.
  if (err instanceof DOMException && err.name === 'SecurityError') return 'unavailable';
  if (err instanceof ReferenceError || err instanceof TypeError) return 'unavailable';
  return 'unknown';
}

type Listener = (failure: StorageFailure) => void;

const listeners = new Set<Listener>();
const reported = new Set<StorageFailureKind>();

/**
 * Subscribe to storage failures. The callback fires at most once per kind of
 * failure per session — see the note above on why per-write would be noise.
 *
 * Returns an unsubscribe function.
 */
export function onStorageFailure(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function report(failure: StorageFailure): void {
  // Always log: a developer chasing "it lost my work" needs the signal even when
  // nothing is listening, and this is the line that was missing.
  console.warn(
    `localStorage write failed (${failure.kind}) for key "${failure.key}"`,
    failure.error,
  );

  if (reported.has(failure.kind)) return;
  reported.add(failure.kind);
  for (const listener of listeners) listener(failure);
}

/**
 * Which of the two Web Storage areas to use.
 *
 * A parameter rather than two copies of each function: both throw the same errors
 * for the same reasons, and sessionStorage is just as capable of failing silently
 * in private mode.
 */
export type StorageArea = 'local' | 'session';

function area(which: StorageArea): Storage {
  return which === 'session' ? window.sessionStorage : window.localStorage;
}

/**
 * Write, reporting failure rather than swallowing it.
 *
 * Returns whether the value was actually stored, so a caller that can do
 * something better than the default has the option.
 */
export function safeSetItem(key: string, value: string, which: StorageArea = 'local'): boolean {
  try {
    area(which).setItem(key, value);
    return true;
  } catch (err) {
    report({ kind: classify(err), key, error: err });
    return false;
  }
}

/** Remove, with the same reporting. Removal can fail when storage is blocked. */
export function safeRemoveItem(key: string, which: StorageArea = 'local'): boolean {
  try {
    area(which).removeItem(key);
    return true;
  } catch (err) {
    report({ kind: classify(err), key, error: err });
    return false;
  }
}

/**
 * Roughly how much of the origin's localStorage this application is using, in
 * UTF-16 code units — the unit browsers actually count.
 *
 * Approximate on purpose: the exact accounting (whether keys count, per-entry
 * overhead) is not specified and differs between browsers. It is good enough to
 * tell "comfortable" from "about to fail", which is all it is used for.
 */
export function estimateStorageChars(): number {
  try {
    let total = 0;
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key === null) continue;
      total += key.length + (window.localStorage.getItem(key)?.length ?? 0);
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * The per-origin quota browsers converge on, in UTF-16 code units.
 *
 * Not a specification, an observation: 5 MB is the common figure and is counted
 * in code units rather than bytes, which is why a 4,026,496-character site is
 * roughly 7.7 MB against it.
 */
export const TYPICAL_QUOTA_CHARS = 5 * 1024 * 1024;

/**
 * Warn at four fifths. Far enough ahead that the user can act — the next site
 * they create is what would fail — and not so eager that it cries wolf.
 */
export const STORAGE_WARN_RATIO = 0.8;

export interface StorageHealth {
  /** False when localStorage cannot be used at all. */
  available: boolean;
  usedChars: number;
  /** usedChars as a fraction of the typical quota. */
  usedRatio: number;
  /** True when close enough to the ceiling that the next write may fail. */
  nearLimit: boolean;
}

/**
 * Check on startup, so the user is warned before hitting the ceiling rather than
 * after losing something.
 *
 * Availability is probed with a real write-read-remove round trip: in private
 * mode some browsers expose a `localStorage` object whose `setItem` throws, so
 * merely testing that the object exists proves nothing.
 */
export function checkStorageHealth(): StorageHealth {
  const probeKey = '__dt_storage_probe__';
  let available = false;
  try {
    window.localStorage.setItem(probeKey, 'x');
    available = window.localStorage.getItem(probeKey) === 'x';
    window.localStorage.removeItem(probeKey);
  } catch {
    available = false;
  }

  const usedChars = available ? estimateStorageChars() : 0;
  const usedRatio = usedChars / TYPICAL_QUOTA_CHARS;

  return {
    available,
    usedChars,
    usedRatio,
    nearLimit: available && usedRatio >= STORAGE_WARN_RATIO,
  };
}

/** Exported for tests: forget which failures have already been reported. */
export function resetStorageReporting(): void {
  reported.clear();
}
