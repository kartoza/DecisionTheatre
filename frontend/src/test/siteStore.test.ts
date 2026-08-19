import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LEGACY_KEY,
  clearSiteStore,
  deleteSite,
  getSiteStoreStats,
  invalidateSiteCache,
  loadSite,
  loadSites,
  migrateLegacyStore,
  normaliseForStorage,
  resetSiteStoreStats,
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
  resetSiteStoreStats();
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


// ---------------------------------------------------------------------------
// The cost of a save
//
// Splitting the blob into one key per site fixed the write but not the work
// around it: the bulk callers still load every site, change one and hand the
// whole list back, so the store parsed N records on the way in and re-serialised
// N on the way out to find the one that differed. These tests count that work,
// because "proportional to what changed" is a claim until it is a number.
// ---------------------------------------------------------------------------

function manySites(n: number): Site[] {
  return Array.from({ length: n }, (_, i) => site(`s${i}`, { title: `site ${i}` }));
}

describe('what a save actually costs', () => {
  it('serialises one site when one site of fifty changed', () => {
    saveSites(manySites(50));
    const loaded = loadSites();

    const changed = [...loaded];
    changed[17] = { ...loaded[17], title: 'edited' } as Site;

    resetSiteStoreStats();
    expect(saveSites(changed)).toBe(true);
    const cost = getSiteStoreStats();

    expect(cost.serialised).toBe(1);
    expect(cost.recordWrites).toBe(1);
    // Membership and order did not change, so the index does not need rewriting.
    expect(cost.indexWrites).toBe(0);
    // And nothing had to be read back to work out which record differed.
    expect(cost.recordReads).toBe(0);
    expect(cost.parsed).toBe(0);
  });

  it('costs the same with fifty sites stored as with five — that is the whole issue', () => {
    function costOfOneEdit(n: number) {
      window.localStorage.clear();
      clearSiteStore();
      saveSites(manySites(n));
      const loaded = loadSites();
      const changed = [...loaded];
      changed[1] = { ...loaded[1], title: 'edited' } as Site;
      resetSiteStoreStats();
      saveSites(changed);
      return getSiteStoreStats();
    }

    expect(costOfOneEdit(50)).toEqual(costOfOneEdit(5));
  });

  it('does no work at all when nothing changed', () => {
    saveSites(manySites(20));
    const loaded = loadSites();

    resetSiteStoreStats();
    expect(saveSites(loaded)).toBe(true);

    expect(getSiteStoreStats()).toMatchObject({
      serialised: 0,
      recordWrites: 0,
      indexWrites: 0,
      parsed: 0,
    });
  });

  it('still recognises an equal site it has never seen the object of', () => {
    // A caller that rebuilt the list from somewhere else gets no identity hit,
    // so the record is serialised — but an identical string must not be written.
    saveSites(manySites(3));
    invalidateSiteCache();

    resetSiteStoreStats();
    saveSites(manySites(3));

    expect(getSiteStoreStats().serialised).toBe(3);
    expect(getSiteStoreStats().recordWrites).toBe(0);
  });

  it('parses each record once however often it is read', () => {
    saveSites(manySites(10));
    invalidateSiteCache();

    resetSiteStoreStats();
    loadSites();
    const first = getSiteStoreStats().parsed;
    loadSites();
    loadSites();
    const total = getSiteStoreStats().parsed;

    expect(first).toBe(10);
    expect(total).toBe(10);
  });

  it('hands out a stable reference, which is what makes the shortcut sound', () => {
    saveSites(manySites(3));
    invalidateSiteCache();

    const a = loadSites();
    const b = loadSites();

    expect(a[0]).toBe(b[0]);
    expect(a[2]).toBe(b[2]);
  });

  it('writes the index only when membership or order changed', () => {
    saveSites(manySites(3));

    resetSiteStoreStats();
    saveSites([...loadSites()].reverse());
    expect(getSiteStoreStats().indexWrites).toBe(1);

    resetSiteStoreStats();
    saveSites(loadSites());
    expect(getSiteStoreStats().indexWrites).toBe(0);

    expect(loadSites().map((s) => s.id)).toEqual(['s2', 's1', 's0']);
  });

  it('an explicit single-site save is never skipped, however unchanged it looks', () => {
    // Durability beats cleverness: a caller reaching for saveSite is asserting
    // the site changed, and a store that argued would lose someone's work.
    const s = site('a');
    saveSite(s);

    resetSiteStoreStats();
    expect(saveSite(s)).toBe(true);

    expect(getSiteStoreStats().recordWrites).toBe(1);
  });
});

// Deliberately spy-based rather than counter-based, so it says something about
// the store's observable behaviour rather than about its own bookkeeping — and
// so it can be pointed at any implementation. Against the version that compared
// each site to storage, this read fifty records to save one.
describe('what a save touches, observed from outside', () => {
  it('reads no records to save one site out of fifty', () => {
    saveSites(manySites(50));
    const loaded = loadSites();
    const changed = [...loaded];
    changed[7] = { ...loaded[7], title: 'edited' } as Site;

    const reads: string[] = [];
    const writes: string[] = [];
    const realGet = Storage.prototype.getItem;
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
      reads.push(k);
      return realGet.call(this, k);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      writes.push(k);
      realSet.call(this, k, v);
    });

    saveSites(changed);
    vi.restoreAllMocks();

    // The version that compared each site against storage read all fifty here.
    expect(reads.filter((k) => k.startsWith('dt-site:'))).toEqual([]);
    expect(writes).toEqual(['dt-site:s7']);
  });
});

describe('the cache never outlives what it describes', () => {
  it('does not believe a record is stored when the write failed', () => {
    const s = site('a', { title: 'precious' });

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(saveSites([s])).toBe(false);
    vi.restoreAllMocks();

    // Same object, so the identity shortcut would skip it if the failed write
    // had been cached. It must not have been.
    expect(saveSites([s])).toBe(true);
    expect(loadSite('a')?.title).toBe('precious');
  });

  it('surfaces a quota failure from the list path, not just the single path', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(saveSites([site('a')])).toBe(false);
  });

  it('surfaces a failure to write the index', () => {
    saveSites([site('a')]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      k: string,
    ) {
      if (k === 'dt-site-index') throw new DOMException('quota', 'QuotaExceededError');
    });

    // A new site changes membership, so the index must be rewritten.
    expect(saveSite(site('b'))).toBe(false);
  });

  it('re-reads a record another tab replaced', () => {
    saveSites([site('a', { title: 'ours' })]);
    const ours = loadSites();

    // What another tab writing dt-site:a looks like from in here.
    window.localStorage.setItem('dt-site:a', JSON.stringify(site('a', { title: 'theirs' })));
    window.dispatchEvent(new StorageEvent('storage', { key: 'dt-site:a' }));

    expect(loadSite('a')?.title).toBe('theirs');

    // And the stale object we still hold is written back rather than skipped.
    resetSiteStoreStats();
    saveSites(ours);
    expect(getSiteStoreStats().recordWrites).toBe(1);
    expect(loadSite('a')?.title).toBe('ours');
  });

  it('forgets everything when another tab clears storage', () => {
    saveSites([site('a')]);
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));

    expect(loadSites()).toEqual([]);
  });

  it('forgets a deleted site rather than serving it from cache', () => {
    saveSites([site('a'), site('b')]);
    loadSites();
    deleteSite('a');

    expect(loadSite('a')).toBeNull();
    expect(loadSites().map((s) => s.id)).toEqual(['b']);
  });

  it('migrates the legacy blob even with a warm cache, and indexes it', () => {
    saveSites([site('kept')]);
    loadSites();

    window.localStorage.setItem(LEGACY_KEY, JSON.stringify([site('old-a'), site('old-b')]));

    expect(loadSites().map((s) => s.id)).toEqual(['old-a', 'old-b']);
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('dt-site-index') as string)).toEqual([
      'old-a',
      'old-b',
    ]);
    // The migrated records are readable through the cache that was already warm.
    expect(loadSite('old-a')?.title).toBe('site old-a');
  });
});
