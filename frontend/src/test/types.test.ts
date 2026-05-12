import { describe, it, expect } from 'vitest';
import { SCENARIOS } from '../types';
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
