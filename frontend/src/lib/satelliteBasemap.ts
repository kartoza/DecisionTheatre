import type { ServerInfo } from '../types';

/**
 * The satellite basemap, defined once.
 *
 * The style URL used to be written out twice — in `MapView.tsx` and in
 * `SiteCreationMap.tsx` — so changing provider meant finding both.
 *
 * Every tile the style references is fetched through this server's own proxy
 * (`/api/satellite-style.json` and friends), not the upstream provider
 * directly: see internal/server/satellite.go for why — in short, a keyed
 * provider's key can never reach browser JavaScript, and a provider's free
 * tier is usually conditioned on a monthly tile count that the browser
 * fetching tiles directly would make invisible to the one process able to
 * enforce it. `DEFAULT_SATELLITE_STYLE_URL` here is therefore always a local,
 * relative path; the actual imagery provider is an upstream-only server
 * concern (`--satellite-style-url`), configurable without a rebuild. See
 * issue #65.
 *
 * `/api/info` carries the value (and the quota status) to the client, so
 * nothing needs rebuilding to change it — unlike `import.meta.env`, which Vite
 * inlines at build time.
 */
export const DEFAULT_SATELLITE_STYLE_URL = '/api/satellite-style.json';

export const DEFAULT_SATELLITE_ATTRIBUTION =
  '<a href="https://www.maptiler.com/copyright/" target="_blank">© MapTiler</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>';

// Module state rather than React state: both call sites read this inside a
// maplibre call during map initialisation, not during render, so threading it
// through props would mean restructuring two large components for no
// behavioural gain.
let styleUrl = DEFAULT_SATELLITE_STYLE_URL;
let attribution = DEFAULT_SATELLITE_ATTRIBUTION;
let quotaExceeded = false;

type QuotaListener = (exceeded: boolean) => void;
const quotaListeners = new Set<QuotaListener>();

/**
 * Adopt the server's configuration. Called each time `/api/info` resolves —
 * see useApi.ts's useServerInfo, which polls it so a quota that becomes
 * exceeded mid-session is noticed without a page reload.
 *
 * A map that initialises before the first response lands keeps the default,
 * which is the same imagery the application showed before this existed — so
 * the failure mode is "unchanged", not "no basemap".
 */
export function applyServerSatelliteConfig(info: ServerInfo | null | undefined): void {
  if (info?.satellite_style_url) {
    // The two move together. Taking the URL while keeping whatever attribution
    // was already set would credit the previous provider for somebody else's
    // imagery, which is worse than crediting nobody. An empty attribution from
    // the server is a deliberate empty, not a missing value.
    styleUrl = info.satellite_style_url;
    attribution = info.satellite_attribution ?? '';
  }

  const exceeded = info?.satellite_quota_exceeded ?? false;
  if (exceeded !== quotaExceeded) {
    quotaExceeded = exceeded;
    for (const listener of quotaListeners) listener(quotaExceeded);
  }
}

/** The (local, proxied) style URL to pass to maplibre. */
export function satelliteStyleUrl(): string {
  return styleUrl;
}

/**
 * Attribution follows the provider. Hardcoding a fixed string would credit the
 * wrong party the moment someone configures a different endpoint — and for most
 * providers the attribution is a licence condition, not a courtesy.
 *
 * In practice the fetched style already carries correct attribution on its own
 * sources, which MapLibre's attribution control reads directly — this getter
 * exists for SiteCreationMap.tsx, which merges the style's layers into an
 * existing map rather than loading it wholesale, and so needs to add the
 * attribution itself.
 */
export function satelliteAttribution(): string {
  return attribution;
}

/** Whether this deployment's monthly satellite tile quota is currently spent. */
export function satelliteQuotaExceeded(): boolean {
  return quotaExceeded;
}

/**
 * Notify a listener whenever the quota-exceeded state changes (in either
 * direction — a new calendar month un-exceeds it). Used by the map components
 * to revert to the built-in basemap and warn the user without polling
 * themselves. Returns an unsubscribe function.
 */
export function subscribeSatelliteQuota(listener: QuotaListener): () => void {
  quotaListeners.add(listener);
  return () => quotaListeners.delete(listener);
}

/** Exported for tests. */
export function resetSatelliteConfig(): void {
  styleUrl = DEFAULT_SATELLITE_STYLE_URL;
  attribution = DEFAULT_SATELLITE_ATTRIBUTION;
  quotaExceeded = false;
}
