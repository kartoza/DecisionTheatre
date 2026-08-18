import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getSite,
  setSessionSite,
  clearSessionSites,
  loadLocalSites,
  loadDemoSiteForTour,
} from '../hooks/useApi';
import { AFRICA_SITE_ID, SHAI_HILLS_SITE_ID } from '../constants/walkthroughSites';
import type { Site } from '../types';

// Starting a demo tour reset the walkthrough's ideal targets to current and then
// wrote the whole site into the `dt-sites` localStorage key "so it is available
// for the rest of the session". The Africa walkthrough is 4,026,496 characters —
// roughly 7.7 MB in UTF-16 against a typical 5 MB quota — so the write could
// never succeed, and it happened on a fresh profile before the user had created
// anything of their own.
//
// The reset is presentation state for the current session, so it now lives in
// memory. These tests pin the two halves of that: nothing is written to
// localStorage, and a demo site is still resolvable afterwards — which matters,
// because getSite used to find it only because the tour had persisted it.

const SITE_KEY = 'dt-sites';

function walkthroughJSON(): Record<string, unknown> {
  return {
    id: AFRICA_SITE_ID,
    title: 'Africa walkthrough',
    indicators: {
      current: { NPP_gm2: 400 },
      ideal: { NPP_gm2: 999 },
    },
  };
}

describe('session-scoped demo sites', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSessionSites();
    delete window.__DECISION_THEATRE_WEBVIEW__; // browser runtime
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/data/walkthroughs/${AFRICA_SITE_ID}.json`)) {
          return new Response(JSON.stringify(walkthroughJSON()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSessionSites();
    window.localStorage.clear();
  });

  // The reason the old write existed. If this fails, removing it broke the tour.
  it('resolves a walkthrough site with nothing in localStorage', async () => {
    expect(loadLocalSites()).toEqual([]);

    const site = await getSite(AFRICA_SITE_ID);

    expect(site).not.toBeNull();
    expect(site?.id).toBe(AFRICA_SITE_ID);
  });

  it('does not write the site to localStorage when resolving it', async () => {
    await getSite(AFRICA_SITE_ID);

    expect(window.localStorage.getItem(SITE_KEY)).toBeNull();
    expect(loadLocalSites()).toEqual([]);
  });

  it('returns the session override in preference to the static file', async () => {
    const reset = {
      ...walkthroughJSON(),
      indicators: { current: { NPP_gm2: 400 }, ideal: { NPP_gm2: 400 } },
    } as unknown as Site;

    setSessionSite(reset);
    const site = await getSite(AFRICA_SITE_ID);

    // The tour's reset — ideal equal to current — rather than the baked 999.
    expect(site?.indicators?.ideal).toEqual({ NPP_gm2: 400 });
  });

  it('keeps the override out of localStorage', () => {
    setSessionSite(walkthroughJSON() as unknown as Site);

    expect(window.localStorage.getItem(SITE_KEY)).toBeNull();
  });

  // A session store that outlived the session would be a cache with no
  // invalidation, and the tour resets the targets on every run anyway.
  it('forgets overrides once cleared, as a reload would', async () => {
    setSessionSite({
      ...walkthroughJSON(),
      indicators: { current: { NPP_gm2: 400 }, ideal: { NPP_gm2: 1 } },
    } as unknown as Site);
    clearSessionSites();

    const site = await getSite(AFRICA_SITE_ID);

    // Back to the file's own values.
    expect(site?.indicators?.ideal).toEqual({ NPP_gm2: 999 });
  });

  // A real site the user deleted must not cost a 404 on every lookup.
  it('does not fetch a walkthrough file for an unknown site id', async () => {
    const site = await getSite('11111111-2222-3333-4444-555555555555');

    expect(site).toBeNull();
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const walkthroughFetches = calls.filter((c) => String(c[0]).includes('/data/walkthroughs/'));
    expect(walkthroughFetches).toEqual([]);
  });

  // A site the user really owns still comes from localStorage, unchanged.
  it('prefers a stored real site over everything else', async () => {
    const own = { id: 'own-site', title: 'Mine' } as unknown as Site;
    window.localStorage.setItem(SITE_KEY, JSON.stringify([own]));

    const site = await getSite('own-site');

    expect(site?.title).toBe('Mine');
  });
});

// The tour's own load path — the thing that actually blew the quota. It used to
// live inline in DemoTour, where it could only be reached by rendering the whole
// component and driving it to the right step.
describe('loadDemoSiteForTour', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSessionSites();
    delete window.__DECISION_THEATRE_WEBVIEW__;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes(`/data/walkthroughs/${AFRICA_SITE_ID}.json`)) {
          return new Response(JSON.stringify(walkthroughJSON()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSessionSites();
    window.localStorage.clear();
  });

  it('writes nothing to localStorage', async () => {
    await loadDemoSiteForTour(AFRICA_SITE_ID);

    expect(window.localStorage.getItem(SITE_KEY)).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it('resets ideal targets to current, so a previous run does not carry over', async () => {
    const site = await loadDemoSiteForTour(AFRICA_SITE_ID);

    // The file bakes ideal at 999; the tour must start from current.
    expect(site.indicators?.ideal).toEqual({ NPP_gm2: 400 });
  });

  it('makes the reset visible to the rest of the session', async () => {
    await loadDemoSiteForTour(AFRICA_SITE_ID);

    const later = await getSite(AFRICA_SITE_ID);
    expect(later?.indicators?.ideal).toEqual({ NPP_gm2: 400 });
  });

  it('throws when the walkthrough file is missing, rather than resolving null', async () => {
    await expect(loadDemoSiteForTour(SHAI_HILLS_SITE_ID)).rejects.toThrow(
      /Walkthrough site data not found/,
    );
  });
});
