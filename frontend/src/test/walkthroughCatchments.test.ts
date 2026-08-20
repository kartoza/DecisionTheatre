import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSiteCatchments, primeSiteCatchmentsFromEmbedded } from '../hooks/useApi';
import { evictExpired } from '../lib/ttlCache';
import type { Site } from '../types';

// A walkthrough's per-catchment breakdown ships inside the walkthrough document.
// The server has never heard of a walkthrough site — GET /api/sites/{id}/catchments
// answers 404, "failed to read site file" — so that embedded copy is the only one
// there is.
//
// It used to be persisted alongside the site in localStorage, so expiry did not
// matter. Since that persistence was removed the copy lives only in the in-memory
// cache, and the cache aged it out after 30 s: the next read refetched, got the
// 404, and returned []. The aggregate table, charts and dials emptied thirty
// seconds after the walkthrough was opened, with nothing in the console but a 404.

const CACHE_TTL_MS = 30_000;

function walkthrough(id: string) {
  return {
    id,
    title: 'Africa',
    createdAt: '2026-01-01T00:00:00Z',
    source: 'walkthrough',
    catchments: [
      { id: 'c1', reference: { NPP_gm2: 1 }, current: { NPP_gm2: 2 } },
      { id: 'c2', reference: { NPP_gm2: 3 }, current: { NPP_gm2: 4 } },
    ],
  } as unknown as Site;
}

beforeEach(() => {
  vi.useFakeTimers();
  // Any refetch must fail exactly as the real server does for a walkthrough.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ error: 'failed to read site file' }),
    { status: 404 },
  )));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a walkthrough breakdown survives, because nothing can refetch it', () => {
  it('is returned immediately after priming', async () => {
    primeSiteCatchmentsFromEmbedded(walkthrough('wt-now'));
    await expect(getSiteCatchments('wt-now')).resolves.toHaveLength(2);
  });

  it('is still returned long after the cache TTL has passed', async () => {
    primeSiteCatchmentsFromEmbedded(walkthrough('wt-old'));

    vi.advanceTimersByTime(CACHE_TTL_MS * 10);

    const got = await getSiteCatchments('wt-old');
    expect(got).toHaveLength(2);
    // The point: it must not have gone to the network for something that 404s.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a site with no embedded breakdown is not made sticky', async () => {
    const bare = { ...walkthrough('wt-bare') } as Record<string, unknown>;
    delete bare.catchments;
    primeSiteCatchmentsFromEmbedded(bare as unknown as Site);

    // Nothing primed, so this falls through to the 404 and yields nothing.
    await expect(getSiteCatchments('wt-bare')).resolves.toEqual([]);
  });
});

describe('evictExpired', () => {
  it('leaves a sticky entry alone however old it is', () => {
    const cache = new Map<string, { ts: number; sticky?: boolean }>([
      ['embedded', { ts: 0, sticky: true }],
      ['fetched', { ts: 0 }],
    ]);
    evictExpired(cache, CACHE_TTL_MS, CACHE_TTL_MS * 100);
    expect([...cache.keys()]).toEqual(['embedded']);
  });

  it('still evicts ordinary stale entries', () => {
    const cache = new Map<string, { ts: number }>([['a', { ts: 0 }], ['b', { ts: 1_000_000 }]]);
    evictExpired(cache, CACHE_TTL_MS, 1_000_000);
    expect([...cache.keys()]).toEqual(['b']);
  });
});
