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
    label: 'Reference',
    description: 'Historical baseline conditions',
    color: '#e65100',
  },
  {
    id: 'current',
    label: 'Current',
    description: 'Current observed conditions',
    color: '#2bb0ed',
  },
  {
    id: 'future',
    label: 'Ideal Future',
    description: 'Optimistic future scenario',
    color: '#4caf50',
  },
];

// ============================================================================
// Project Management Types
// ============================================================================

export interface MapExtent {
  center: [number, number]; // [lng, lat]
  zoom: number;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  thumbnail: string | null;
  createdAt: string;
  updatedAt: string;
  paneStates: PaneStates;
  layoutMode: LayoutMode;
  focusedPane: number;
  mapExtent?: MapExtent;
}

// Identify result: scenario -> attribute -> value
export type IdentifyResult = {
  catchmentID: string;
  data: Record<string, Record<string, number>>;
} | null;

export type AppPage = 'landing' | 'about' | 'projects' | 'create' | 'create-site' | 'map' | 'explore';

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

const STORAGE_CURRENT_PROJECT_KEY = 'dt-current-project';
const STORAGE_CURRENT_PAGE_KEY = 'dt-current-page';

export function loadCurrentProject(): string | null {
  try {
    return localStorage.getItem(STORAGE_CURRENT_PROJECT_KEY);
  } catch { return null; }
}

export function saveCurrentProject(projectId: string | null): void {
  try {
    if (projectId) {
      localStorage.setItem(STORAGE_CURRENT_PROJECT_KEY, projectId);
    } else {
      localStorage.removeItem(STORAGE_CURRENT_PROJECT_KEY);
    }
  } catch { /* ignore */ }
}

export function loadCurrentPage(): AppPage {
  try {
    const raw = localStorage.getItem(STORAGE_CURRENT_PAGE_KEY);
    if (raw === 'landing' || raw === 'about' || raw === 'projects' || raw === 'create' || raw === 'create-site' || raw === 'map' || raw === 'explore') {
      return raw;
    }
  } catch { /* default */ }
  return 'landing';
}

export function saveCurrentPage(page: AppPage): void {
  try { localStorage.setItem(STORAGE_CURRENT_PAGE_KEY, page); } catch { /* ignore */ }
}

// ============================================================================
// Site Management Types
// ============================================================================

export type SiteCreationMethod = 'shapefile' | 'geojson' | 'drawn' | 'catchments';

export interface BoundingBox {
  minX: number;  // West
  minY: number;  // South
  maxX: number;  // East
  maxY: number;  // North
}

export interface Site {
  id: string;
  name: string;
  description: string;
  thumbnail: string | null;
  geometry: GeoJSON.Geometry | null;
  boundingBox: BoundingBox | null;
  area: number;  // Area in square kilometers
  creationMethod: SiteCreationMethod;
  catchmentIds: string[];  // If created from catchments
  createdAt: string;
  updatedAt: string;
}

export interface CreateSiteRequest {
  name: string;
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
