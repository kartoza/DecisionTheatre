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
  llm_available: boolean;
  nn_available: boolean;
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

export const SCENARIOS: ScenarioInfo[] = [
  {
    id: 'past',
    label: 'Past',
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
