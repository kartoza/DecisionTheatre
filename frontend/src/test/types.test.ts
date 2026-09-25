import { describe, it, expect } from 'vitest';
import { SCENARIOS, maxPanesForViewMode, quadRowsForPaneCount } from '../types';
import type { Scenario, ComparisonState } from '../types';

describe('Types', () => {
  it('defines three scenarios', () => {
    expect(SCENARIOS).toHaveLength(3);
  });

  it('has reference, current, and future scenarios', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(ids).toContain('reference');
    expect(ids).toContain('current');
    expect(ids).toContain('future');
  });

  it('each scenario has required fields', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.id).toBeDefined();
      expect(scenario.label).toBeDefined();
      expect(scenario.description).toBeDefined();
      expect(scenario.color).toBeDefined();
      expect(scenario.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('ComparisonState can be created', () => {
    const state: ComparisonState = {
      leftScenario: 'reference',
      rightScenario: 'future',
      attribute: 'soil_moisture',
    };
    expect(state.leftScenario).toBe('reference');
    expect(state.rightScenario).toBe('future');
    expect(state.attribute).toBe('soil_moisture');
  });

  it('Scenario type only allows valid values', () => {
    const validScenarios: Scenario[] = ['reference', 'current', 'future'];
    expect(validScenarios).toHaveLength(3);
  });
});

// #204: the grid is always 3 columns wide. Row count is not a setting --
// it's derived from the pane count. Map, dial and table views stay fixed
// at 2 rows (6 panes), or the grid overflows the viewport. Belt charts are
// small enough to keep growing a row every 3 panes, up to 5 rows (15 panes).
describe('quad row / pane-cap helpers', () => {
  it('caps non-belt views at 6 panes and belt charts at 15', () => {
    expect(maxPanesForViewMode('map')).toBe(6);
    expect(maxPanesForViewMode('dial')).toBe(6);
    expect(maxPanesForViewMode('table')).toBe(6);
    expect(maxPanesForViewMode('chart')).toBe(6);
    expect(maxPanesForViewMode('flat')).toBe(15);
  });

  it('keeps non-belt views fixed at 2 rows regardless of pane count', () => {
    expect(quadRowsForPaneCount(6, 'map')).toBe(2);
    expect(quadRowsForPaneCount(1, 'dial')).toBe(2);
    expect(quadRowsForPaneCount(6, 'table')).toBe(2);
  });

  it('grows belt charts a row every 3 panes, from 2 rows up to 5', () => {
    expect(quadRowsForPaneCount(6, 'flat')).toBe(2);
    expect(quadRowsForPaneCount(7, 'flat')).toBe(3);
    expect(quadRowsForPaneCount(9, 'flat')).toBe(3);
    expect(quadRowsForPaneCount(10, 'flat')).toBe(4);
    expect(quadRowsForPaneCount(13, 'flat')).toBe(5);
  });

  it('never grows belt charts past 5 rows (15 panes), the cap', () => {
    expect(quadRowsForPaneCount(15, 'flat')).toBe(5);
    expect(quadRowsForPaneCount(99, 'flat')).toBe(5);
  });

  it('never drops belt charts below 2 rows, even with fewer panes', () => {
    expect(quadRowsForPaneCount(1, 'flat')).toBe(2);
  });
});
