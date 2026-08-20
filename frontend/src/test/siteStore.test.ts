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
  denormaliseFromStorage,
  normaliseForStorage,
  resetSiteStoreStats,
  saveSite,
  saveSites,
} from '../lib/siteStore';
import type { Site, SiteIndicators } from '../types';

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

  // Mirrors 'discards a stale blob outright once the per-site index already
  // exists' above, specifically for a cache that is already warm: the blob is
  // stale by definition once real per-site data exists (see
  // migrateLegacyStore's indexKeyExists check), so it must not resurrect
  // anything even when a prior read has already cached what is really there.
  it('discards a legacy blob that appears after the cache is warm, keeping what is already there', () => {
    saveSites([site('kept')]);
    loadSites();

    window.localStorage.setItem(LEGACY_KEY, JSON.stringify([site('old-a'), site('old-b')]));

    expect(loadSites().map((s) => s.id)).toEqual(['kept']);
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(loadSite('old-a')).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// What ends up in a record
//
// The store's claim is that a record holds the site definition and nothing that
// is either recomputable or already in the same record. These tests measure the
// stored *string*, not the shape of an intermediate object, because the string
// is the thing that has to fit in 5,241,856 characters.
//
// The numbers behind them, from a 200-catchment site built out of the real
// attribute maps in data/walkthroughs/:
//
//   in memory, as the API returns it   11,215,026 chars — 214% of the ceiling
//   breakdown and duplicate ids gone       67,656 chars —   1.3%
//   `ideal` reduced to its difference      46,582 chars —   0.9%
// ---------------------------------------------------------------------------

/** A site's indicators with `n` attributes, `edited` of which the user changed. */
function indicators(n: number, edited = 0) {
  const reference: Record<string, number> = {};
  const current: Record<string, number> = {};
  const ideal: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const key = `attr_${i}`;
    reference[key] = i + 0.125;
    current[key] = i * 2 + 0.5;
    ideal[key] = i < edited ? i * 3 + 0.75 : current[key];
  }
  return {
    reference,
    current,
    ideal,
    extractedAt: '2026-01-01T00:00:00Z',
    catchmentCount: n,
    totalAreaKm2: n * 12.5,
  };
}

function storedRecord(id: string): Record<string, unknown> {
  const raw = window.localStorage.getItem(`dt-site:${id}`);
  expect(raw).not.toBeNull();
  return JSON.parse(raw as string);
}

describe('the duplicated id list (#69)', () => {
  it('is written exactly once, whichever writer put the site there', () => {
    const ids = ['c1', 'c2', 'c3'];
    saveSite(site('a', { catchmentIds: ids, indicators: { catchmentIds: ids, catchmentCount: 3 } }));
    saveSites([
      site('a', { catchmentIds: ids, indicators: { catchmentIds: ids, catchmentCount: 3 } }),
      site('b', { catchmentIds: ids, indicators: { catchmentIds: ids, catchmentCount: 3 } }),
    ]);

    for (const id of ['a', 'b']) {
      const raw = window.localStorage.getItem(`dt-site:${id}`) as string;
      // Counting occurrences rather than asserting on the parsed object: the
      // whole fault was paying for the same array twice in one string.
      expect(raw.split('"c1"').length - 1).toBe(1);
      expect(raw).not.toContain('"catchmentIds":["c1","c2","c3"],"catchmentCount"');
      expect(storedRecord(id).catchmentIds).toEqual(ids);
    }
  });

  it('is gone from a record written before this rule existed, without losing the site', () => {
    // A record exactly as an older build left it: the list on the site and again
    // inside indicators, and a per-catchment breakdown alongside.
    window.localStorage.setItem('dt-site-index', JSON.stringify(['a']));
    window.localStorage.setItem('dt-site:a', JSON.stringify({
      id: 'a',
      title: 'Kruger',
      createdAt: '2026-01-01T00:00:00Z',
      catchmentIds: ['c1', 'c2'],
      catchments: [{ id: 'c1', reference: {}, current: {} }],
      indicators: { catchmentIds: ['c1', 'c2'], catchmentCount: 2, totalAreaKm2: 12 },
    }));

    const loaded = loadSite('a') as Site;
    expect(loaded.title).toBe('Kruger');
    expect(loaded.catchmentIds).toEqual(['c1', 'c2']);
    expect(loaded.indicators?.catchmentCount).toBe(2);
    expect(loaded.indicators?.totalAreaKm2).toBe(12);

    // Reading does not rewrite. The duplicate leaves on the next save, which is
    // the first moment the store is entitled to touch the record.
    invalidateSiteCache();
    expect(saveSite({ ...loaded, title: 'Kruger NP' })).toBe(true);

    const stored = storedRecord('a');
    expect((stored.indicators as Record<string, unknown>).catchmentIds).toBeUndefined();
    expect(stored.catchments).toBeUndefined();
    expect(stored.catchmentIds).toEqual(['c1', 'c2']);
    expect(stored.title).toBe('Kruger NP');
  });

  it('cannot be put back by a caller: the type has no room for it', () => {
    // The realistic way it came back was never a fresh object literal — excess
    // property checking already caught those. It was a value that had been
    // through a variable: an object parsed from a response, or built by
    // spreading one, then assigned somewhere expecting SiteIndicators. A type
    // that merely omits the property is structurally satisfied by one that has
    // it, so this assignment compiled and the duplicate went back in.
    const fromTheWire = { ...indicators(2), catchmentIds: ['c1', 'c2'] };

    // @ts-expect-error `catchmentIds` is declared `never`, so string[] has
    // nowhere to go. If this line ever compiles, the shape has stopped
    // forbidding the duplicate and only the write path is holding it out.
    const assigned: SiteIndicators = fromTheWire;

    // Referenced so the assignment is not dead code; the assertion that matters
    // is the compile error above, which `tsc --noEmit` checks in CI.
    expect(assigned.catchmentCount).toBe(2);
  });
});

describe('the per-catchment breakdown (#68)', () => {
  it('is not handed back by the store either, not just kept out of the record', () => {
    // The record cache used to hold the object the caller passed in, so for the
    // rest of the session `loadSite` returned a site still carrying the
    // breakdown — 27-56 KB per catchment — and anything that re-serialised it
    // (a request body, an export) paid for it. Only a reload cleared it.
    const fat = site('a', {
      catchmentIds: ['c1'],
      catchments: [{ id: 'c1', reference: { x: 1 }, current: { x: 2 } }],
    });
    saveSite(fat);

    const loaded = loadSite('a') as unknown as Record<string, unknown>;
    expect(loaded.catchments).toBeUndefined();
    expect(loaded.catchmentIds).toEqual(['c1']);
    // The caller's own object is untouched — it is still theirs.
    expect((fat as unknown as Record<string, unknown>).catchments).toBeDefined();

    // And through the bulk writer.
    saveSites([site('a', { catchmentIndicators: [{ id: 'c1' }] })]);
    expect((loadSites()[0] as unknown as Record<string, unknown>).catchmentIndicators)
      .toBeUndefined();
  });

  it('still lets an untouched site be recognised for free', () => {
    // The cache now hands out a different object from the one written, so the
    // identity shortcut has to remember both. Without that, every bulk save
    // would re-serialise every site.
    saveSites([site('a'), site('b')]);
    const written = site('c');
    saveSite(written);

    resetSiteStoreStats();
    saveSites([...loadSites().filter((s) => s.id !== 'c'), written]);
    expect(getSiteStoreStats().serialised).toBe(0);
  });
});

describe('targets that are still a copy of current (#68)', () => {
  it('are stored once, and read back whole', () => {
    saveSite(site('a', { indicators: indicators(100, 3) }));

    const stored = storedRecord('a');
    const ind = stored.indicators as Record<string, unknown>;
    expect(ind.ideal).toBeUndefined();
    expect(Object.keys(ind.idealDelta as object)).toEqual(['attr_0', 'attr_1', 'attr_2']);

    invalidateSiteCache();
    const loaded = loadSite('a') as Site;
    expect(loaded.indicators?.ideal).toEqual(indicators(100, 3).ideal);
    expect(Object.keys(loaded.indicators?.ideal ?? {})).toHaveLength(100);
  });

  it('cost less than they did, and the same site comes back', () => {
    const full = site('a', { indicators: indicators(500) });
    const before = JSON.stringify(denormaliseFromStorage(normaliseForStorage(full)));
    const after = JSON.stringify(normaliseForStorage(full));

    expect(after.length).toBeLessThan(before.length * 0.7);
    // Lossless, not merely smaller.
    expect(JSON.parse(JSON.stringify(denormaliseFromStorage(normaliseForStorage(full)))))
      .toEqual(JSON.parse(JSON.stringify(full)));
  });

  it('are read back unchanged from a record written whole by an older build', () => {
    // A half-migrated store: one record in each encoding. Both must read
    // correctly, because a store can sit in this state indefinitely — a site the
    // user has not opened since the upgrade is never rewritten.
    const old = { ...site('old'), indicators: indicators(50, 7) } as Site;
    window.localStorage.setItem('dt-site:old', JSON.stringify(old));
    saveSite(site('new', { indicators: indicators(50, 7) }));
    window.localStorage.setItem('dt-site-index', JSON.stringify(['old', 'new']));
    invalidateSiteCache();

    const loaded = loadSites();
    expect(loaded.map((s) => s.id)).toEqual(['old', 'new']);
    expect(loaded[0].indicators?.ideal).toEqual(indicators(50, 7).ideal);
    expect(loaded[1].indicators?.ideal).toEqual(indicators(50, 7).ideal);
    // Rewriting the old one converts it, still losslessly.
    expect(saveSite(loaded[0])).toBe(true);
    invalidateSiteCache();
    expect((loadSite('old') as Site).indicators?.ideal).toEqual(indicators(50, 7).ideal);
  });

  it('are stored whole when the difference could not be undone exactly', () => {
    // `ideal` is rebuilt from `current`, so a target set that does not cover
    // `current` would silently gain entries. Bytes are not worth that.
    const partial = indicators(10);
    delete (partial.ideal as Record<string, number>).attr_4;
    saveSite(site('a', { indicators: partial }));

    const ind = storedRecord('a').indicators as Record<string, unknown>;
    expect(ind.idealDelta).toBeUndefined();
    expect(Object.keys(ind.ideal as object)).toHaveLength(9);

    invalidateSiteCache();
    expect((loadSite('a') as Site).indicators?.ideal).toEqual(partial.ideal);
  });

  it('leave a site with no indicators alone', () => {
    const s = site('a', { catchmentIds: ['c1'] });
    expect(normaliseForStorage(s)).toEqual(s);
    expect(denormaliseFromStorage(s)).toBe(s);
  });

  it('do not survive a write that failed', () => {
    // The store must never believe a site is stored when it is not, whatever
    // encoding it would have used.
    saveSite(site('a', { indicators: indicators(20, 2) }));
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(saveSite(site('a', { indicators: indicators(20, 9) }))).toBe(false);
    spy.mockRestore();

    // What is read back is what actually reached storage: the earlier version.
    expect((loadSite('a') as Site).indicators?.ideal).toEqual(indicators(20, 2).ideal);
  });
});
