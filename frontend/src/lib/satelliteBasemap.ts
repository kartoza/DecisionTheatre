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
 * `/api/info` carries the value (and availability/quota status) to the
 * client, so nothing needs rebuilding to change it — unlike `import.meta.env`,
 * which Vite inlines at build time.
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
// Optimistic default: unknown until /api/info resolves, and "assume it works"
// is the same failure mode applyServerSatelliteConfig's own doc comment
// already accepts for the rest of this module — a map that initialises before
// the first response keeps trying, rather than never offering satellite at
// all while a perfectly good key is loading.
let available = true;

type UnavailableListener = (unavailable: boolean) => void;
const unavailableListeners = new Set<UnavailableListener>();

/** Combines the two reasons satellite might not be usable right now. */
function unavailable(): boolean {
  return quotaExceeded || !available;
}

/**
 * Adopt the server's configuration. Called each time `/api/info` resolves —
 * see useApi.ts's useServerInfo, which polls it so quota being spent, or a
 * deployment with no provider key, is noticed without a page reload.
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

  const wasUnavailable = unavailable();

  quotaExceeded = info?.satellite_quota_exceeded ?? false;
  // Missing field (an older server, or a response that raced applyServer-
  // SatelliteConfig before /api/info finished) defaults to available: the
  // same "assume it works" the module-level default above already commits to.
  available = info?.satellite_available ?? true;

  if (unavailable() !== wasUnavailable) {
    for (const listener of unavailableListeners) listener(unavailable());
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

/**
 * Whether the satellite basemap can be shown right now — either this month's
 * quota is spent, or no provider is configured (no key, and no operator-set
 * style URL; see config.Config.SatelliteAvailable on the server). Either way
 * the answer for the client is the same: don't offer it, and if it's already
 * showing, fall back.
 */
export function satelliteUnavailable(): boolean {
  return unavailable();
}

/**
 * Notify a listener whenever satelliteUnavailable's value changes (in either
 * direction — a new calendar month un-exceeds the quota, or a key gets
 * configured and the server restarts). Used by the map components to revert
 * to the built-in basemap and warn the user without polling themselves.
 * Returns an unsubscribe function.
 */
export function subscribeSatelliteUnavailable(listener: UnavailableListener): () => void {
  unavailableListeners.add(listener);
  return () => unavailableListeners.delete(listener);
}

/** Exported for tests. */
export function resetSatelliteConfig(): void {
  styleUrl = DEFAULT_SATELLITE_STYLE_URL;
  attribution = DEFAULT_SATELLITE_ATTRIBUTION;
  quotaExceeded = false;
  available = true;
}
