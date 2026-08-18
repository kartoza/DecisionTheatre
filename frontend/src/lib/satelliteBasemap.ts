import type { ServerInfo } from '../types';

/**
 * The satellite basemap, defined once.
 *
 * The tile URL used to be written out twice — in `MapView.tsx` and in
 * `SiteCreationMap.tsx` — so changing provider meant finding both.
 *
 * The default is still Google's `mt0.google.com/vt` endpoint. That endpoint is
 * undocumented and unauthenticated, which is precisely why it works without a key
 * and precisely why using it sits outside the Google Maps terms of service. It is
 * kept as the default deliberately, as a separate decision from this refactor:
 * the point here is that switching provider is now a configuration change rather
 * than a code change. See issue #65.
 *
 * Supply a replacement at runtime with `--satellite-tile-url` (or
 * `DT_SATELLITE_TILE_URL`) on the server. `/api/info` carries the value to the
 * client, so nothing needs rebuilding to change it — unlike `import.meta.env`,
 * which Vite inlines at build time.
 */
export const DEFAULT_SATELLITE_TILE_URL =
  'https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}';

export const DEFAULT_SATELLITE_ATTRIBUTION = '© Google Maps';

// Module state rather than React state: both call sites read this inside a
// maplibre `addSource` call during map initialisation, not during render, so
// threading it through props would mean restructuring two large components for no
// behavioural gain.
let tileUrl = DEFAULT_SATELLITE_TILE_URL;
let attribution = DEFAULT_SATELLITE_ATTRIBUTION;

/**
 * Adopt the server's configuration. Called once when `/api/info` resolves.
 *
 * A map that initialises before that lands keeps the default, which is the same
 * imagery the application showed before this existed — so the failure mode is
 * "unchanged", not "no basemap".
 */
export function applyServerSatelliteConfig(info: ServerInfo | null | undefined): void {
  if (!info?.satellite_tile_url) return;

  // The two move together. Taking the URL while keeping whatever attribution was
  // already set would credit the previous provider — by default Google — for
  // somebody else's imagery, which is worse than crediting nobody. An empty
  // attribution from the server is a deliberate empty, not a missing value.
  tileUrl = info.satellite_tile_url;
  attribution = info.satellite_attribution ?? '';
}

export function satelliteTileUrl(): string {
  return tileUrl;
}

/**
 * Attribution follows the provider. Hardcoding "© Google Maps" would credit the
 * wrong party the moment someone configures a different endpoint — and for most
 * providers the attribution is a licence condition, not a courtesy.
 */
export function satelliteAttribution(): string {
  return attribution;
}

/** Exported for tests. */
export function resetSatelliteConfig(): void {
  tileUrl = DEFAULT_SATELLITE_TILE_URL;
  attribution = DEFAULT_SATELLITE_ATTRIBUTION;
}
