import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LEGACY_KEY,
  clearSiteStore,
  deleteSite,
  loadSite,
  loadSites,
  migrateLegacyStore,
  normaliseForStorage,
  saveSite,
  saveSites,
} from '../lib/siteStore';
import type { Site } from '../types';

// The three faults this module exists to fix, and what each test here pins:
//
//   one blob per save  -> a save must touch one record, not the whole store
//   the breakdown      -> must never be written; the server recomputes it
//   catchmentIds twice -> must not survive a write, even from an old record

function site(id: string, extra: Record<string, unknown> = {}): Site {
  return {
    id,
    title: `site ${id}`,
    createdAt: '2026-01-01T00:00:00Z',
    ...extra,
  } as unknown as Site;
}

/** Counts writes so "touches one record" can be asserted rather than assumed. */
function countWrites() {
  const keys: string[] = [];
  // Capture the real implementation before replacing it, so writes still land
  // and the test observes a working store rather than a stubbed one.
  const original = Storage.prototype.setItem;
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
    function (this: Storage, k: string, v: string) {
      keys.push(k);
      original.call(this, k, v);
    },
  );
  return { keys, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  window.localStorage.clear();
  clearSiteStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normaliseForStorage', () => {
  it('drops all three names for the per-catchment breakdown', () => {
    const s = site('a', {
      catchments: [{ id: 'c1' }],
      catchmentIndicators: [{ id: 'c1' }],
      catchmentData: [{ id: 'c1' }],
    });
    const out = normaliseForStorage(s) as unknown as Record<string, unknown>;
    expect(out.catchments).toBeUndefined();
    expect(out.catchmentIndicators).toBeUndefined();
    expect(out.catchmentData).toBeUndefined();
  });

  it('drops the duplicated id list inside indicators, keeping the one on the site', () => {
    const s = site('a', {
      catchmentIds: ['c1', 'c2'],
      indicators: { catchmentCount: 2, catchmentIds: ['c1', 'c2'] },
    });
    const out = normaliseForStorage(s) as unknown as Record<string, unknown>;
    const ind = out.indicators as Record<string, unknown>;
    expect(ind.catchmentIds).toBeUndefined();
    expect(ind.catchmentCount).toBe(2);
    expect(out.catchmentIds).toEqual(['c1', 'c2']);
  });

  it('does not mutate its argument', () => {
    // Callers hold these in React state; mutating one would alias silently.
    const s = site('a', { catchments: [{ id: 'c1' }] }) as unknown as Record<string, unknown>;
    normaliseForStorage(s as unknown as Site);
    expect(s.catchments).toEqual([{ id: 'c1' }]);
  });

  it('leaves a site with nothing to strip unchanged', () => {
    const s = site('a', { catchmentIds: ['c1'] });
    expect(normaliseForStorage(s)).toEqual(s);
  });
});

describe('migration from the single blob', () => {
  it('moves records across, indexes them and removes the blob', () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify([site('a'), site('b')]));

    const migrated = migrateLegacyStore();

    expect(migrated?.map((s) => s.id)).toEqual(['a', 'b']);
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(window.localStorage.getItem('dt-site:a')).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem('dt-site-index') as string)).toEqual(['a', 'b']);
  });

  it('strips the breakdown and the duplicate ids on the way through', () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify([
      site('a', {
        catchmentIds: ['c1'],
        catchments: [{ id: 'c1', reference: {}, current: {} }],
        indicators: { catchmentIds: ['c1'], catchmentCount: 1 },
      }),
    ]));

    migrateLegacyStore();

    const stored = JSON.parse(window.localStorage.getItem('dt-site:a') as string);
    expect(stored.catchments).toBeUndefined();
    expect(stored.indicators.catchmentIds).toBeUndefined();
    expect(stored.catchmentIds).toEqual(['c1']);
  });

  it('runs once — a second call has nothing to do', () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify([site('a')]));
    expect(migrateLegacyStore()).not.toBeNull();
    expect(migrateLegacyStore()).toBeNull();
  });

  it('keeps the blob when a record cannot be written, so nothing is lost', () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify([site('a')]));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    migrateLegacyStore();

    vi.restoreAllMocks();
    expect(window.localStorage.getItem(LEGACY_KEY)).not.toBeNull();
  });

  it('leaves an unreadable blob alone rather than destroying it', () => {
    window.localStorage.setItem(LEGACY_KEY, '{not json');
    expect(migrateLegacyStore()).toBeNull();
    expect(window.localStorage.getItem(LEGACY_KEY)).toBe('{not json');
  });

  it('is transparent to a reader', () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify([site('a'), site('b')]));
    expect(loadSites().map((s) => s.id)).toEqual(['a', 'b']);
  });

  // The actual bug: a legacy blob that never fully migrated (a full-quota
  // profile, most likely — the blob itself is a duplicate of everything, so it
  // could easily be *why* the quota was full) survived indefinitely and kept
  // being re-read as authoritative. A site deleted through the per-site store
  // reappeared on every subsequent load because the stale blob still listed
  // it, with no error anywhere to explain why the delete "didn't work".
  it('does not resurrect a site deleted from an already-active per-site store', () => {
    // The per-site store is already live: two sites exist as real records.
    saveSites([site('a'), site('b')]);

    // A legacy blob still lingers from before the per-site store existed,
    // listing a stale version of 'a' plus a site never migrated at all.
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify([
      site('a', { title: 'stale pre-migration copy' }),
      site('zzz'),
    ]));

    expect(deleteSite('a')).toBe(true);

    // Reads after the delete — including a fresh one simulating a page
    // reload — must not see 'a' again, and must not gain 'zzz' either: the
    // blob is stale, not a second source of truth to merge in.
    expect(loadSites().map((s) => s.id)).toEqual(['b']);
    expect(loadSites().map((s) => s.id)).toEqual(['b']);
  });

  it('discards a stale blob outright once the per-site index already exists, even if empty', () => {
    saveSites([site('a')]);
    deleteSite('a'); // index now exists and is empty
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify([site('resurrected')]));

    expect(loadSites()).toEqual([]);
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });
});

describe('reading and writing', () => {
  it('round-trips a site', () => {
    saveSite(site('a', { title: 'Kruger' }));
    expect(loadSite('a')?.title).toBe('Kruger');
    expect(loadSites().map((s) => s.id)).toEqual(['a']);
  });

  it('returns null for a site that is not there', () => {
    expect(loadSite('missing')).toBeNull();
  });

  it('saving one site writes one record, whatever else is stored', () => {
    saveSites([site('a'), site('b'), site('c')]);

    const { keys, restore } = countWrites();
    saveSite(site('b', { title: 'changed' }));
    restore();

    // The record, and nothing else: b is already in the index.
    expect(keys).toEqual(['dt-site:b']);
  });

  it('saving the whole list rewrites only what changed', () => {
    const all = [site('a'), site('b'), site('c')];
    saveSites(all);

    const { keys, restore } = countWrites();
    saveSites([all[0], site('b', { title: 'changed' }), all[2]]);
    restore();

    expect(keys).toContain('dt-site:b');
    expect(keys).not.toContain('dt-site:a');
    expect(keys).not.toContain('dt-site:c');
  });

  it('removes records dropped from the list', () => {
    saveSites([site('a'), site('b')]);
    saveSites([site('a')]);

    expect(loadSites().map((s) => s.id)).toEqual(['a']);
    expect(window.localStorage.getItem('dt-site:b')).toBeNull();
  });

  // A failed removal used to be silently ignored: the index write could still
  // succeed on its own, so saveSites reported success while an orphaned record
  // for the "deleted" site stayed on disk — a delete the caller believed had
  // happened, with no error to tell it otherwise.
  it('reports failure when a dropped record cannot be removed', () => {
    saveSites([site('a'), site('b')]);

    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    expect(saveSites([site('a')])).toBe(false);
  });

  it('never stores the breakdown, however it arrives', () => {
    // Both writers, in one list: saveSites is authoritative about membership, so
    // passing only 'b' here would legitimately delete 'a' — as its own test above
    // asserts — and that is not what this test is about.
    saveSite(site('a', { catchments: [{ id: 'c1' }] }));
    saveSites([
      site('a', { catchments: [{ id: 'c1' }] }),
      site('b', { catchmentData: [{ id: 'c2' }] }),
    ]);

    for (const key of ['dt-site:a', 'dt-site:b']) {
      const raw = window.localStorage.getItem(key);
      expect(raw).not.toBeNull();
      expect(raw).not.toContain('catchments');
      expect(raw).not.toContain('catchmentData');
    }
  });

  it('deletes a site and forgets it', () => {
    saveSites([site('a'), site('b')]);
    expect(deleteSite('a')).toBe(true);
    expect(loadSite('a')).toBeNull();
    expect(loadSites().map((s) => s.id)).toEqual(['b']);
  });

  it('reports failure when the write cannot happen', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(saveSite(site('a'))).toBe(false);
  });

  it('refuses a site with no id rather than writing a broken key', () => {
    expect(saveSite({ title: 'no id' } as unknown as Site)).toBe(false);
  });
});
