export type Scenario = 'past' | 'present' | 'future';

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
  { leftScenario: 'past', rightScenario: 'present', attribute: '' },
  { leftScenario: 'present', rightScenario: 'future', attribute: '' },
  { leftScenario: 'past', rightScenario: 'future', attribute: '' },
  { leftScenario: 'past', rightScenario: 'present', attribute: '' },
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
    id: 'past',
    label: 'Reference',
    description: 'Historical baseline conditions',
    color: '#e65100',
  },
  {
    id: 'present',
    label: 'Present',
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
