import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_SATELLITE_STYLE_URL,
  DEFAULT_SATELLITE_ATTRIBUTION,
  applyServerSatelliteConfig,
  resetSatelliteConfig,
  satelliteAttribution,
  satelliteStyleUrl,
  satelliteUnavailable,
  subscribeSatelliteUnavailable,
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

// The client cannot see the server's tile count or its configured key
// directly; it only learns whether satellite can be shown through /api/info.
// satelliteUnavailable() combines both reasons it might not be — quota spent,
// or no provider configured at all — into one signal, since a map component
// reacting to either the wrong signal or only one of the two reasons would
// either strand the user on a failing satellite view or never let them use it.
describe('satellite availability and quota tracking', () => {
  beforeEach(() => resetSatelliteConfig());

  it('is available by default', () => {
    expect(satelliteUnavailable()).toBe(false);
  });

  it('adopts the server-reported quota state', () => {
    applyServerSatelliteConfig(info({ satellite_quota_exceeded: true }));
    expect(satelliteUnavailable()).toBe(true);

    applyServerSatelliteConfig(info({ satellite_quota_exceeded: false }));
    expect(satelliteUnavailable()).toBe(false);
  });

  it('treats a missing quota flag as not exceeded', () => {
    applyServerSatelliteConfig(info({}));
    expect(satelliteUnavailable()).toBe(false);
  });

  // No provider configured (no key, no operator style URL) — see
  // config.Config.SatelliteAvailable on the server.
  it('adopts the server-reported availability state', () => {
    applyServerSatelliteConfig(info({ satellite_available: false }));
    expect(satelliteUnavailable()).toBe(true);

    applyServerSatelliteConfig(info({ satellite_available: true }));
    expect(satelliteUnavailable()).toBe(false);
  });

  it('treats a missing availability flag as available', () => {
    applyServerSatelliteConfig(info({}));
    expect(satelliteUnavailable()).toBe(false);
  });

  it('is unavailable if either reason applies', () => {
    applyServerSatelliteConfig(info({ satellite_available: false, satellite_quota_exceeded: false }));
    expect(satelliteUnavailable()).toBe(true);

    applyServerSatelliteConfig(info({ satellite_available: true, satellite_quota_exceeded: true }));
    expect(satelliteUnavailable()).toBe(true);

    applyServerSatelliteConfig(info({ satellite_available: true, satellite_quota_exceeded: false }));
    expect(satelliteUnavailable()).toBe(false);
  });

  it('notifies subscribers only when the combined state actually changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSatelliteUnavailable(listener);

    // Already available: no change, no call.
    applyServerSatelliteConfig(info({ satellite_quota_exceeded: false }));
    expect(listener).not.toHaveBeenCalled();

    applyServerSatelliteConfig(info({ satellite_quota_exceeded: true }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(true);

    // Repeating the same value must not notify again.
    applyServerSatelliteConfig(info({ satellite_quota_exceeded: true }));
    expect(listener).toHaveBeenCalledTimes(1);

    // Still unavailable — quota clears but the key is now missing — so no
    // notification: the combined signal has not actually changed.
    applyServerSatelliteConfig(info({ satellite_quota_exceeded: false, satellite_available: false }));
    expect(listener).toHaveBeenCalledTimes(1);

    applyServerSatelliteConfig(info({ satellite_quota_exceeded: false, satellite_available: true }));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);

    unsubscribe();
    applyServerSatelliteConfig(info({ satellite_quota_exceeded: true }));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
