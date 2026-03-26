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

export type LayoutMode = 'single' | 'quad';

/** View mode for each pane: map choropleth, line chart, dial gauge, or aggregate table */
export type ViewMode = 'map' | 'chart' | 'dial' | 'table';

/** Range mode for dial chart min/max values */
export type RangeMode = 'domain' | 'extent' | 'site';

/** Per-pane state array (always 4 entries, indexed 0-3) */
export type PaneStates = [ComparisonState, ComparisonState, ComparisonState, ComparisonState];

const STORAGE_KEY = 'dt-pane-states';
const STORAGE_LAYOUT_KEY = 'dt-layout-mode';
const STORAGE_FOCUSED_KEY = 'dt-focused-pane';

export const DEFAULT_PANE_STATES: PaneStates = [
  { leftScenario: 'reference', rightScenario: 'current', attribute: '' },
  { leftScenario: 'current', rightScenario: 'future', attribute: '' },
  { leftScenario: 'reference', rightScenario: 'future', attribute: '' },
  { leftScenario: 'reference', rightScenario: 'current', attribute: '' },
];

export function loadPaneStates(): PaneStates {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length === 4) return parsed as PaneStates;
    }
  } catch { /* use defaults */ }
  return structuredClone(DEFAULT_PANE_STATES);
}

export function savePaneStates(states: PaneStates): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(states)); } catch { /* ignore */ }
}

export function loadLayoutMode(): LayoutMode {
  try {
    const raw = localStorage.getItem(STORAGE_LAYOUT_KEY);
    if (raw === 'single' || raw === 'quad') return raw;
  } catch { /* default */ }
  return 'single';
}

export function saveLayoutMode(mode: LayoutMode): void {
  try { localStorage.setItem(STORAGE_LAYOUT_KEY, mode); } catch { /* ignore */ }
}

export function loadFocusedPane(): number {
  try {
    const raw = localStorage.getItem(STORAGE_FOCUSED_KEY);
    if (raw !== null) {
      const n = parseInt(raw, 10);
      if (n >= 0 && n <= 3) return n;
    }
  } catch { /* default */ }
  return 0;
}

export function saveFocusedPane(index: number): void {
  try { localStorage.setItem(STORAGE_FOCUSED_KEY, String(index)); } catch { /* ignore */ }
}

const STORAGE_RANGE_MODE_KEY = 'dt-range-mode';

export function loadRangeMode(): RangeMode {
  try {
    const raw = localStorage.getItem(STORAGE_RANGE_MODE_KEY);
    if (raw === 'domain' || raw === 'extent' || raw === 'site') return raw;
  } catch { /* default */ }
  return 'domain';
}

export function saveRangeMode(mode: RangeMode): void {
  try { localStorage.setItem(STORAGE_RANGE_MODE_KEY, mode); } catch { /* ignore */ }
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
}

// Identify result: scenario -> attribute -> value
export type IdentifyResult = {
  catchmentID: string;
  data: Record<string, Record<string, number>>;
} | null;

export type AppPage = 'landing' | 'about' | 'sites' | 'create-site' | 'map' | 'explore' | 'indicators';

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
  try {
    if (siteId) {
      localStorage.setItem(STORAGE_CURRENT_SITE_KEY, siteId);
    } else {
      localStorage.removeItem(STORAGE_CURRENT_SITE_KEY);
    }
  } catch { /* ignore */ }
}

export function loadCurrentPage(): AppPage {
  try {
    const raw = localStorage.getItem(STORAGE_CURRENT_PAGE_KEY);
    if (raw === 'landing' || raw === 'about' || raw === 'sites' || raw === 'create-site' || raw === 'map' || raw === 'explore' || raw === 'indicators') {
      return raw;
    }
  } catch { /* default */ }
  return 'landing';
}

export function saveCurrentPage(page: AppPage): void {
  try { localStorage.setItem(STORAGE_CURRENT_PAGE_KEY, page); } catch { /* ignore */ }
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
  // Ideal values (starts as copy of reference mean, user-editable)
  ideal: Record<string, number>;
  // Lower bound of acceptable ideal range (defaults to ideal when not set)
  idealLower?: Record<string, number>;
  // Upper bound of acceptable ideal range (defaults to ideal when not set)
  idealUpper?: Record<string, number>;
  // Metadata about the extraction
  extractedAt: string;      // When indicators were extracted
  catchmentCount: number;   // Number of catchments used
  totalAreaKm2: number;     // Total area in km²
  catchmentIds: string[];   // IDs of catchments used
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
