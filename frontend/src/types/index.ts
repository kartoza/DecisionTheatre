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

export type LayoutMode = 'single' | 'quad';

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

export const SCENARIOS: ScenarioInfo[] = [
  {
    id: 'reference',
    label: 'Ecological Reference',
    description: `Condition compared to scientifically determined optimal standards`,
    color: '#e65100',
  },
  {
    id: 'current',
    label: 'Current State',
    description: 'Current observed conditions',
    color: '#2bb0ed',
  },
  {
    id: 'future',
    label: 'Target State',
    description: 'User-defined target condition they aim to achieve.',
    color: '#4caf50',
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

// SiteIndicators holds aggregated indicator values for a site
// All values are area-weighted aggregations of constituent catchments
export interface SiteIndicators {
  // Reference scenario values (historical baseline)
  reference: Record<string, number>;
  // Current scenario values (current observed conditions)
  current: Record<string, number>;
  // Ideal values (starts as copy of current, user-editable)
  ideal: Record<string, number>;
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
