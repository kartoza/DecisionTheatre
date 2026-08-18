import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  STORAGE_WARN_RATIO,
  TYPICAL_QUOTA_CHARS,
  checkStorageHealth,
  estimateStorageChars,
  isQuotaExceededError,
  onStorageFailure,
  resetStorageReporting,
  safeRemoveItem,
  safeSetItem,
} from '../lib/storage';
import { savePaneStates, saveLayoutMode, saveCurrentSite } from '../types';

// Every localStorage write discarded its error, so once the quota was exhausted
// saves appeared to succeed and did not: the user saw the change in React state
// and lost it on reload. That arrives as "the app is flaky", not as a storage
// complaint, and it hid the problem from anyone debugging it.

function quotaError(): DOMException {
  return new DOMException('quota', 'QuotaExceededError');
}

/** Replaces localStorage.setItem with one that always throws. */
function breakStorage(err: unknown) {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw err;
  });
}

describe('isQuotaExceededError', () => {
  it('recognises the standard and Firefox names', () => {
    expect(isQuotaExceededError(quotaError())).toBe(true);
    expect(isQuotaExceededError(new DOMException('q', 'NS_ERROR_DOM_QUOTA_REACHED'))).toBe(true);
  });

  it('does not mistake other failures for a full quota', () => {
    expect(isQuotaExceededError(new DOMException('no', 'SecurityError'))).toBe(false);
    expect(isQuotaExceededError(new Error('boom'))).toBe(false);
    expect(isQuotaExceededError('quota')).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
  });
});

describe('safeSetItem', () => {
  beforeEach(() => {
    resetStorageReporting();
    window.localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('stores a value and reports success', () => {
    expect(safeSetItem('k', 'v')).toBe(true);
    expect(window.localStorage.getItem('k')).toBe('v');
  });

  // The branch the whole issue is about.
  it('returns false when the quota is exceeded, instead of appearing to succeed', () => {
    breakStorage(quotaError());
    expect(safeSetItem('k', 'v')).toBe(false);
  });

  it('notifies a listener, classifying a full quota', () => {
    const seen: string[] = [];
    const off = onStorageFailure((f) => seen.push(f.kind));

    breakStorage(quotaError());
    safeSetItem('k', 'v');
    off();

    expect(seen).toEqual(['quota']);
  });

  it('tells a blocked store apart from a full one', () => {
    const seen: string[] = [];
    const off = onStorageFailure((f) => seen.push(f.kind));

    breakStorage(new DOMException('blocked', 'SecurityError'));
    safeSetItem('k', 'v');
    off();

    expect(seen).toEqual(['unavailable']);
  });

  // Preference writes happen several times a minute. One toast is information;
  // one per pane drag is noise.
  it('notifies once per kind of failure, not once per write', () => {
    let calls = 0;
    const off = onStorageFailure(() => { calls += 1; });

    breakStorage(quotaError());
    for (let i = 0; i < 25; i++) safeSetItem(`k${i}`, 'v');
    off();

    expect(calls).toBe(1);
  });

  // Even with nothing listening, the failure must leave a trace for whoever is
  // debugging "it lost my work" — that log line is what was missing.
  it('always logs, even with no listener', () => {
    breakStorage(quotaError());
    safeSetItem('k', 'v');

    expect(console.warn).toHaveBeenCalled();
  });

  it('reports a different kind separately', () => {
    const seen: string[] = [];
    const off = onStorageFailure((f) => seen.push(f.kind));

    breakStorage(quotaError());
    safeSetItem('a', 'v');
    breakStorage(new DOMException('blocked', 'SecurityError'));
    safeSetItem('b', 'v');
    off();

    expect(seen).toEqual(['quota', 'unavailable']);
  });

  it('names the key that failed, for the log', () => {
    const keys: string[] = [];
    const off = onStorageFailure((f) => keys.push(f.key));

    breakStorage(quotaError());
    safeSetItem('dt-pane-states', 'v');
    off();

    expect(keys).toEqual(['dt-pane-states']);
  });
});

describe('safeRemoveItem', () => {
  beforeEach(() => {
    resetStorageReporting();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('removes a value', () => {
    window.localStorage.setItem('k', 'v');
    expect(safeRemoveItem('k')).toBe(true);
    expect(window.localStorage.getItem('k')).toBeNull();
  });

  it('reports a failure rather than swallowing it', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    let notified = false;
    const off = onStorageFailure(() => { notified = true; });
    expect(safeRemoveItem('k')).toBe(false);
    off();

    expect(notified).toBe(true);
  });
});

describe('storage health', () => {
  beforeEach(() => {
    resetStorageReporting();
    window.localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports an empty store as available and comfortable', () => {
    const health = checkStorageHealth();

    expect(health.available).toBe(true);
    expect(health.nearLimit).toBe(false);
  });

  // A store that merely exists proves nothing: in private mode some browsers
  // expose one whose setItem throws.
  it('detects a store that exists but cannot be written', () => {
    breakStorage(quotaError());

    expect(checkStorageHealth().available).toBe(false);
  });

  it('leaves no probe key behind', () => {
    checkStorageHealth();

    const keys = Object.keys(window.localStorage);
    expect(keys.filter((k) => k.includes('probe'))).toEqual([]);
  });

  it('warns before the ceiling rather than after', () => {
    // Just over the warning ratio, comfortably under the quota — the point is to
    // warn while writes still succeed.
    const size = Math.ceil(TYPICAL_QUOTA_CHARS * STORAGE_WARN_RATIO) + 10;
    window.localStorage.setItem('bulk', 'x'.repeat(size));

    const health = checkStorageHealth();

    expect(health.available).toBe(true);
    expect(health.nearLimit).toBe(true);
    expect(health.usedRatio).toBeGreaterThanOrEqual(STORAGE_WARN_RATIO);
  });

  it('counts keys as well as values', () => {
    window.localStorage.setItem('abc', 'de');

    expect(estimateStorageChars()).toBe(5);
  });
});

// The preference writers are the ones that were silent. They must not throw —
// losing a pane layout should never break the page — but must no longer be quiet.
describe('preference writers', () => {
  beforeEach(() => {
    resetStorageReporting();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('do not throw when storage is full, but do report', () => {
    breakStorage(quotaError());

    let notified = 0;
    const off = onStorageFailure(() => { notified += 1; });

    expect(() => savePaneStates([])).not.toThrow();
    expect(() => saveLayoutMode('single')).not.toThrow();
    expect(() => saveCurrentSite('abc')).not.toThrow();
    off();

    expect(notified).toBe(1);
    expect(console.warn).toHaveBeenCalled();
  });
});
