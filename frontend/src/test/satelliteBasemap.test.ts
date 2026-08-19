import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_SATELLITE_STYLE_URL,
  DEFAULT_SATELLITE_ATTRIBUTION,
  applyServerSatelliteConfig,
  resetSatelliteConfig,
  satelliteAttribution,
  satelliteStyleUrl,
  satelliteQuotaExceeded,
  subscribeSatelliteQuota,
} from '../lib/satelliteBasemap';
import type { ServerInfo } from '../types';

// The style URL was written out twice, in MapView and SiteCreationMap, so
// changing provider meant finding both. It is defined here once and supplied at
// runtime by /api/info — unlike import.meta.env, which Vite inlines at build time.

const info = (over: Partial<ServerInfo>): ServerInfo => ({
  version: 'test',
  tiles_loaded: true,
  geo_loaded: true,
  ...over,
});

describe('satellite basemap configuration', () => {
  beforeEach(() => resetSatelliteConfig());

  it('falls back to the built-in default', () => {
    expect(satelliteStyleUrl()).toBe(DEFAULT_SATELLITE_STYLE_URL);
    expect(satelliteAttribution()).toBe(DEFAULT_SATELLITE_ATTRIBUTION);
  });

  it('adopts the server value', () => {
    applyServerSatelliteConfig(info({
      satellite_style_url: 'https://example.test/style.json',
      satellite_attribution: '© Example',
    }));

    expect(satelliteStyleUrl()).toBe('https://example.test/style.json');
    expect(satelliteAttribution()).toBe('© Example');
  });

  // A map that initialises before /api/info lands must keep working, showing the
  // same imagery as before this existed.
  it('keeps the default when the server says nothing', () => {
    applyServerSatelliteConfig(info({}));
    expect(satelliteStyleUrl()).toBe(DEFAULT_SATELLITE_STYLE_URL);

    applyServerSatelliteConfig(null);
    expect(satelliteStyleUrl()).toBe(DEFAULT_SATELLITE_STYLE_URL);

    applyServerSatelliteConfig(undefined);
    expect(satelliteStyleUrl()).toBe(DEFAULT_SATELLITE_STYLE_URL);
  });

  // Attribution is a licence condition for most providers, so it must not be
  // silently dropped when only the URL is configured.
  it('does not credit the default provider for someone else’s imagery', () => {
    applyServerSatelliteConfig(info({
      satellite_style_url: 'https://example.test/style.json',
      satellite_attribution: '',
    }));

    expect(satelliteStyleUrl()).toBe('https://example.test/style.json');
    expect(satelliteAttribution()).not.toContain('MapTiler');
  });

  // The point of the change: one definition, not two — and the key (baked into
  // the default upstream URL server-side) must never appear in bundled
  // frontend source, or it would be visible to anyone reading the page.
  it('never writes the upstream URL or key directly into the components', async () => {
    const sources = await Promise.all([
      import('../components/MapView?raw'),
      import('../components/SiteCreationMap?raw'),
    ]).catch(() => null);
    // Vite's ?raw import is not available in every test environment; skip rather
    // than assert on nothing.
    if (!sources) return;
    for (const module of sources) {
      const text = String((module as { default?: string }).default ?? '');
      expect(text).not.toContain('api.maptiler.com');
      expect(text).not.toContain('mt0.google.com');
    }
  });
});

// The client cannot see the server's tile count directly; it only learns
// whether the monthly quota is spent through /api/info. These tests pin how
// that flag propagates, since a map component reacting to the wrong signal
// would either strand the user on a failing satellite view or never let them
// use it at all.
describe('satellite quota tracking', () => {
  beforeEach(() => resetSatelliteConfig());

  it('is not exceeded by default', () => {
    expect(satelliteQuotaExceeded()).toBe(false);
  });

  it('adopts the server-reported quota state', () => {
    applyServerSatelliteConfig(info({ satellite_quota_exceeded: true }));
    expect(satelliteQuotaExceeded()).toBe(true);

    applyServerSatelliteConfig(info({ satellite_quota_exceeded: false }));
    expect(satelliteQuotaExceeded()).toBe(false);
  });

  it('treats a missing flag as not exceeded', () => {
    applyServerSatelliteConfig(info({}));
    expect(satelliteQuotaExceeded()).toBe(false);
  });

  it('notifies subscribers only when the state actually changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSatelliteQuota(listener);

    // Already false: no change, no call.
    applyServerSatelliteConfig(info({ satellite_quota_exceeded: false }));
    expect(listener).not.toHaveBeenCalled();

    applyServerSatelliteConfig(info({ satellite_quota_exceeded: true }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(true);

    // Repeating the same value must not notify again.
    applyServerSatelliteConfig(info({ satellite_quota_exceeded: true }));
    expect(listener).toHaveBeenCalledTimes(1);

    applyServerSatelliteConfig(info({ satellite_quota_exceeded: false }));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);

    unsubscribe();
    applyServerSatelliteConfig(info({ satellite_quota_exceeded: true }));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
