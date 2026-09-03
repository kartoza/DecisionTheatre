import { getAppRuntime } from './runtime';
import { safeRemoveItem, safeSetItem } from '../lib/storage';

export type Scenario = 'reference' | 'current' | 'future';

export interface ScenarioInfo {
  id: Scenario;
  label: string;
  description: string;
  color: string;
}

export interface ServerInfo {
  version: string;
  tiles_loaded: boolean;
  geo_loaded: boolean;
  /** Satellite basemap style document. Always this server's own proxy — see
   *  lib/satelliteBasemap.ts for why the browser does not fetch tiles (or the
   *  style itself) from the provider directly. */
  satellite_style_url?: string;
  /** Attribution for the above — a licence condition for most providers. */
  satellite_attribution?: string;
  /** False when no satellite provider is configured at all (no key, no
   *  operator-set style URL) — see config.Config.SatelliteAvailable. The
   *  client should not offer the satellite basemap while this is false. */
  satellite_available?: boolean;
  /** True once this deployment's monthly satellite tile quota is spent. The
   *  client should not offer the satellite basemap while this is true. */
  satellite_quota_exceeded?: boolean;
}

export interface TilesetMetadata {
  name: string;
  format: string;
  description: string;
  minzoom: number;
  maxzoom: number;
  center: string;
  bounds: string;
  type: string;
  json?: string;
}

export interface ComparisonState {
  leftScenario: Scenario;
  rightScenario: Scenario;
  attribute: string;
}

export type ColorScaleMode = 'rainbow' | 'metadata';

/** How raw attribute values are normalized before mapping to the color scale */
export type ColorScaleType = 'linear' | 'logistic' | 'logarithmic';

export type LayoutMode = 'single' | 'quad';

/** View mode for each pane: map choropleth, line chart, dial gauge, or aggregate table */
/**
 * What a pane draws.
 *
 * `flat` and `dial` are two renderings of the same scale — a horizontal band
 * and an arc gauge. They are separate view modes rather than a shape toggle on
 * one, because that is how the user picks them: once for the grid, from the
 * same cluster as the other views, not per widget.
 */
export type ViewMode = 'map' | 'chart' | 'flat' | 'dial' | 'table';

/** Range mode for dial chart min/max values */
export type RangeMode = 'domain' | 'extent' | 'site';

/** Per-pane state array (minimum one entry) */
export type PaneStates = ComparisonState[];

export type QuadColumns = 2 | 3;

const STORAGE_KEY = 'dt-pane-states';
const STORAGE_LAYOUT_KEY = 'dt-layout-mode';
const STORAGE_FOCUSED_KEY = 'dt-focused-pane';
const STORAGE_QUAD_COLUMNS_KEY = 'dt-quad-columns';

export const DEFAULT_PANE_STATES: PaneStates = [
  { leftScenario: 'reference', rightScenario: 'current', attribute: 'lowTC_prop' },
  { leftScenario: 'reference', rightScenario: 'current', attribute: 'percBurned' },
  { leftScenario: 'reference', rightScenario: 'current', attribute: 'CH4_both_kg_km2' },
  { leftScenario: 'reference', rightScenario: 'current', attribute: 'SOC_Mgha_0_30' },
  { leftScenario: 'reference', rightScenario: 'current', attribute: 'herbs_tot_kgkm2' },
  { leftScenario: 'reference', rightScenario: 'current', attribute: 'NPP_gm2' },
];

export function loadPaneStates(): PaneStates {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as PaneStates;
    }
  } catch { /* use defaults */ }
  return structuredClone(DEFAULT_PANE_STATES);
}

export function savePaneStates(states: PaneStates): void {
  safeSetItem(STORAGE_KEY, JSON.stringify(states));
}

export function loadLayoutMode(): LayoutMode {
  try {
    const raw = localStorage.getItem(STORAGE_LAYOUT_KEY);
    if (raw === 'single' || raw === 'quad') return raw;
  } catch { /* default */ }
  return 'single';
}

export function saveLayoutMode(mode: LayoutMode): void {
  safeSetItem(STORAGE_LAYOUT_KEY, mode);
}

export function loadFocusedPane(): number {
  try {
    const raw = localStorage.getItem(STORAGE_FOCUSED_KEY);
    if (raw !== null) {
      const n = parseInt(raw, 10);
      if (n >= 0) return n;
    }
  } catch { /* default */ }
  return 0;
}

export function saveFocusedPane(index: number): void {
  safeSetItem(STORAGE_FOCUSED_KEY, String(index));
}

const STORAGE_RANGE_MODE_KEY = 'dt-range-mode';

export function loadQuadColumns(): QuadColumns {
  try {
    const raw = localStorage.getItem(STORAGE_QUAD_COLUMNS_KEY);
    if (raw === '2' || raw === '3') return Number(raw) as QuadColumns;
  } catch { /* default */ }
  return 2;
}

export function saveQuadColumns(cols: QuadColumns): void {
  safeSetItem(STORAGE_QUAD_COLUMNS_KEY, String(cols));
}

export function loadRangeMode(): RangeMode {
  try {
    const raw = localStorage.getItem(STORAGE_RANGE_MODE_KEY);
    if (raw === 'domain' || raw === 'extent' || raw === 'site') return raw;
  } catch { /* default */ }
  return 'domain';
}

export function saveRangeMode(mode: RangeMode): void {
  safeSetItem(STORAGE_RANGE_MODE_KEY, mode);
}

export const SCENARIOS: ScenarioInfo[] = [
  {
    id: 'reference',
    label: 'Ecological Reference',
    description: `Condition compared to scientifically determined optimal standards`,
    color: '#f6b07c',
  },
  {
    id: 'current',
    label: 'Current State',
    description: 'Current observed conditions',
    color: '#8ccde1',
  },
  {
    id: 'future',
    label: 'Target State',
    description: 'User-defined target condition with aim to achieve.',
    color: '#9ecb9e',
  },
];

// ============================================================================
// Site Management Types
// ============================================================================

export interface MapExtent {
  center: [number, number]; // [lng, lat]
  zoom: number;
  bounds?: [number, number, number, number]; // [minX, minY, maxX, maxY]
}

// Identify result: scenario -> attribute -> value
export type IdentifyResult = {
  catchmentID: string;
  data: Record<string, Record<string, number>>;
} | null;

export type AppPage = 'landing' | 'about' | 'partnership' | 'sites' | 'create-site' | 'map' | 'explore' | 'indicators' | 'download' | 'setup';

// Statistics for the visible zone (viewport)
export interface ZoneStats {
  min: number;
  max: number;
  mean: number;
  count: number;
}

// Domain range for color scaling (global min/max across all scenarios)
export interface DomainRange {
  min: number;
  max: number;
}

// Combined statistics from MapView
export interface MapStatistics {
  domainRange: DomainRange | null;
  leftStats: ZoneStats | null;
  rightStats: ZoneStats | null;
  fullStats?: { left: ZoneStats | null; right: ZoneStats | null } | null;
  siteStats?: { left: ZoneStats | null; right: ZoneStats | null } | null;
}

const STORAGE_CURRENT_SITE_KEY = 'dt-current-site';
const STORAGE_CURRENT_PAGE_KEY = 'dt-current-page';

export function loadCurrentSite(): string | null {
  try {
    return localStorage.getItem(STORAGE_CURRENT_SITE_KEY);
  } catch { return null; }
}

export function saveCurrentSite(siteId: string | null): void {
  if (siteId) {
    safeSetItem(STORAGE_CURRENT_SITE_KEY, siteId);
  } else {
    safeRemoveItem(STORAGE_CURRENT_SITE_KEY);
  }
}

export function loadCurrentPage(): AppPage {
  if (typeof window !== 'undefined' && window.__DECISION_THEATRE_WEBVIEW__ === true) {
    return 'landing';
  }
  try {
    const raw = localStorage.getItem(STORAGE_CURRENT_PAGE_KEY);
    if (raw === 'landing' || raw === 'about' || raw === 'sites' || raw === 'create-site' || raw === 'map' || raw === 'explore' || raw === 'indicators') {
      return raw;
    }
  } catch { /* default */ }
  return 'landing';
}

export function saveCurrentPage(page: AppPage): void {
  safeSetItem(STORAGE_CURRENT_PAGE_KEY, page);
}

// sessionStorage is cleared when a browser tab closes but survives a same-tab
// refresh, so it's the signal used to tell "reopened the tab" apart from
// "reloaded the page" for the resume-session prompt below.
const STORAGE_SESSION_ACTIVE_KEY = 'dt-session-active';

export function markSessionActive(): void {
  safeSetItem(STORAGE_SESSION_ACTIVE_KEY, '1', 'session');
}

// Whether to ask the user "resume where you left off, or go home?" on load.
// Only makes sense in the browser (the desktop webview always starts fresh
// on 'landing'), only fires for a brand-new tab session, and only when
// there's actually something worth resuming.
export function shouldPromptResumeSession(): boolean {
  if (getAppRuntime() !== 'browser') return false;
  try {
    if (sessionStorage.getItem(STORAGE_SESSION_ACTIVE_KEY)) return false;
  } catch {
    return false;
  }
  return loadCurrentPage() !== 'landing' || Boolean(loadCurrentSite());
}

// Resets transient display/session state stored in this browser. Deliberately
// excludes 'dt-sites': in the browser runtime that's the only copy of the
// user's saved sites (there's no server-side persistence to fall back on),
// not a cache, so a "clear cache" action must leave it alone.
export function clearBrowserAppCache(): void {
  // No try/catch: safeRemoveItem reports its own failures rather than throwing,
  // so a blocked store no longer makes this a silent no-op.
  [
    STORAGE_KEY,
    STORAGE_LAYOUT_KEY,
    STORAGE_FOCUSED_KEY,
    STORAGE_QUAD_COLUMNS_KEY,
    STORAGE_RANGE_MODE_KEY,
    STORAGE_CURRENT_SITE_KEY,
    STORAGE_CURRENT_PAGE_KEY,
    'dt-tour-seen', // must match TourGuide.tsx's TOUR_SEEN_KEY
  ].forEach((key) => safeRemoveItem(key));
  safeRemoveItem(STORAGE_SESSION_ACTIVE_KEY, 'session');
}

export type SiteCreationMethod = 'shapefile' | 'geojson' | 'drawn' | 'catchments';

export interface BoundingBox {
  minX: number;  // West
  minY: number;  // South
  maxX: number;  // East
  maxY: number;  // North
}

// CatchmentIndicators holds per-catchment indicator values
// Used for displaying the breakdown in the aggregate table
export interface CatchmentIndicators {
  id: string;
  areaKm2: number;
  reference: Record<string, number>;
  current: Record<string, number>;
  ideal?: Record<string, number>;
  aoiFraction?: number;
}

// SiteIndicators holds aggregated indicator values for a site
// All values are area-weighted aggregations of constituent catchments
export interface SiteIndicators {
  // Reference scenario values (historical baseline)
  reference: Record<string, number>;
  // Lower bound of reference range (defaults to reference when not set)
  referenceLower?: Record<string, number>;
  // Upper bound of reference range (defaults to reference when not set)
  referenceUpper?: Record<string, number>;
  // Current scenario values (current observed conditions)
  current: Record<string, number>;
  // Lower bound of current range (defaults to current when not set)
  currentLower?: Record<string, number>;
  // Upper bound of current range (defaults to current when not set)
  currentUpper?: Record<string, number>;
  // Ideal values (starts as copy of current mean, user-editable)
  ideal: Record<string, number>;
  // Lower bound of acceptable ideal range (defaults to ideal when not set)
  idealLower?: Record<string, number>;
  // Upper bound of acceptable ideal range (defaults to ideal when not set)
  idealUpper?: Record<string, number>;
  // Metadata about the extraction
  extractedAt: string;      // When indicators were extracted
  catchmentCount: number;   // Number of catchments used
  totalAreaKm2: number;     // Total area in km²
  warnings?: string[];

  /**
   * The id list does not live here. It is on `Site`, and it used to be on both:
   * for the Africa walkthrough that was the same 147,837-element array written
   * twice — 3.84 MB of a 4.0 MB document. Nothing ever read this copy; the three
   * places that mentioned it only carried it along. Read `site.catchmentIds`.
   *
   * Declared as `never` rather than simply left out. Omitting it stopped the
   * duplicate being *written* by a fresh object literal, but a structural type
   * with a property missing is still satisfied by an object that has it, so
   * `{ ...serverIndicators }` or a cast put it back with nothing to complain.
   * `never` makes the property unassignable, so the duplicate is unrepresentable
   * rather than merely undocumented — the only value it accepts is `undefined`,
   * which `JSON.stringify` does not emit.
   */
  catchmentIds?: never;
}

// Site represents a saved site with its boundary and map state
export interface Site {
  id: string;
  title: string;
  description: string;
  thumbnail: string | null;
  appRuntime?: 'browser' | 'webview';
  createdAt: string;
  updatedAt: string;

  // Map state
  paneStates?: PaneStates;
  layoutMode?: LayoutMode;
  quadColumns?: QuadColumns;
  focusedPane?: number;
  mapExtent?: MapExtent;

  // Site boundary (geometry)
  geometry?: GeoJSON.Geometry | null;
  boundingBox?: BoundingBox | null;
  area?: number;  // Area in square kilometers
  creationMethod?: SiteCreationMethod;
  catchmentIds?: string[];  // If created from catchments

  // Site indicators (aggregated from catchments)
  indicators?: SiteIndicators;

  // Set to 'walkthrough' for built-in demo sites; these are read-only
  source?: 'walkthrough';
}

export interface CreateSiteRequest {
  title: string;
  description?: string;
  thumbnail?: string | null;
  geometry: GeoJSON.Geometry;
  creationMethod: SiteCreationMethod;
  catchmentIds?: string[];
}

// ============================================================================
// Shapefile/GeoJSON Upload Types
// ============================================================================

export interface UploadedGeometry {
  type: 'FeatureCollection' | 'Feature' | 'Geometry';
  geometry: GeoJSON.Geometry;
  boundingBox: BoundingBox;
  featureCount: number;
}
