import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { deleteSite, saveLocalSite } from '../hooks/useApi';
import { clearSiteStore } from '../lib/siteStore';
import type { Site } from '../types';

// hooks/useApi.ts's deleteSite used to discard saveLocalSites' success/failure
// result in the browser runtime, so a failed localStorage write was reported to
// the caller (SitesPage.tsx) as a successful delete — the "Site deleted" toast
// fired, and the site reappeared on the next load with no error ever shown.

function site(id: string): Site {
  return {
    id,
    title: `site ${id}`,
    createdAt: '2026-01-01T00:00:00Z',
  } as unknown as Site;
}

beforeEach(() => {
  window.localStorage.clear();
  clearSiteStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deleteSite (browser runtime)', () => {
  it('removes a site that was actually stored', async () => {
    saveLocalSite(site('a'));

    await deleteSite('a');

    expect(window.localStorage.getItem('dt-site:a')).toBeNull();
  });

  it('throws rather than reporting success when the underlying write fails', async () => {
    saveLocalSite(site('a'));

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    await expect(deleteSite('a')).rejects.toThrow();
  });
});
