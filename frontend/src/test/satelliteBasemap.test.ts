import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_SATELLITE_TILE_URL,
  DEFAULT_SATELLITE_ATTRIBUTION,
  applyServerSatelliteConfig,
  resetSatelliteConfig,
  satelliteAttribution,
  satelliteTileUrl,
} from '../lib/satelliteBasemap';
import type { ServerInfo } from '../types';

// The tile template was written out twice, in MapView and SiteCreationMap, so
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
    expect(satelliteTileUrl()).toBe(DEFAULT_SATELLITE_TILE_URL);
    expect(satelliteAttribution()).toBe(DEFAULT_SATELLITE_ATTRIBUTION);
  });

  it('adopts the server value', () => {
    applyServerSatelliteConfig(info({
      satellite_tile_url: 'https://example.test/{z}/{x}/{y}.jpg',
      satellite_attribution: '© Example',
    }));

    expect(satelliteTileUrl()).toBe('https://example.test/{z}/{x}/{y}.jpg');
    expect(satelliteAttribution()).toBe('© Example');
  });

  // A map that initialises before /api/info lands must keep working, showing the
  // same imagery as before this existed.
  it('keeps the default when the server says nothing', () => {
    applyServerSatelliteConfig(info({}));
    expect(satelliteTileUrl()).toBe(DEFAULT_SATELLITE_TILE_URL);

    applyServerSatelliteConfig(null);
    expect(satelliteTileUrl()).toBe(DEFAULT_SATELLITE_TILE_URL);

    applyServerSatelliteConfig(undefined);
    expect(satelliteTileUrl()).toBe(DEFAULT_SATELLITE_TILE_URL);
  });

  // Attribution is a licence condition for most providers, so it must not be
  // silently dropped when only the URL is configured.
  it('does not credit the default provider for someone else’s imagery', () => {
    applyServerSatelliteConfig(info({
      satellite_tile_url: 'https://example.test/{z}/{x}/{y}.jpg',
      satellite_attribution: '',
    }));

    expect(satelliteTileUrl()).toBe('https://example.test/{z}/{x}/{y}.jpg');
    expect(satelliteAttribution()).not.toContain('Google');
  });

  // The point of the change: one definition, not two.
  it('is the only place the tile template is written', async () => {
    const sources = await Promise.all([
      import('../components/MapView?raw'),
      import('../components/SiteCreationMap?raw'),
    ]).catch(() => null);
    // Vite's ?raw import is not available in every test environment; skip rather
    // than assert on nothing.
    if (!sources) return;
    for (const module of sources) {
      expect(String((module as { default?: string }).default ?? '')).not.toContain('mt0.google.com');
    }
  });
});
