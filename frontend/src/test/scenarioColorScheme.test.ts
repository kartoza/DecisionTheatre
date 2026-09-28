/**
 * One colour vocabulary for reference/current/target, everywhere it appears.
 *
 * Reported: the circular dial used green for both reference and target
 * (indistinguishable), the belt dial used a red reference line next to a
 * green reference bar (disagreeing with itself), and neither dial agreed
 * with the other. `DialChart` also hardcoded its own reference greens
 * instead of reading `SCENARIO_COLORS.reference`, and `ChartView` carried a
 * second, independently hardcoded copy of the same three colours -- so
 * fixing the shared constant alone would not have fixed the chart view.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { SCENARIO_COLORS } from '../lib/dialScale';
import { SCENARIOS } from '../types';

const DIALCHART = readFileSync('src/components/DialChart.tsx', 'utf8');
const CHARTVIEW = readFileSync('src/components/ChartView.tsx', 'utf8');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// useApi's metadata fetch is deduped per URL in module-level state, so a
// fresh module (via resetModules + dynamic import) is needed per test --
// otherwise the second test's fetch stub is never actually called, and it
// silently observes the first test's cached response instead.
async function renderScenarioColors() {
  vi.resetModules();
  const { useScenarioColors } = await import('../hooks/useApi');
  return renderHook(() => useScenarioColors());
}

describe('SCENARIO_COLORS', () => {
  it('is green for reference, blue for current, pink for target', () => {
    expect(SCENARIO_COLORS.reference).toBe('#4caf50');
    expect(SCENARIO_COLORS.current).toBe('#2bb0ed');
    expect(SCENARIO_COLORS.future).toBe('#d946ef');
  });

  it('gives every role a distinct colour', () => {
    const values = Object.values(SCENARIO_COLORS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('does not make the target green, which is reserved for reference', () => {
    expect(SCENARIO_COLORS.future).not.toBe(SCENARIO_COLORS.reference);
  });

  it('does not make the target red, which reads as "bad" on the standard scale', () => {
    expect(SCENARIO_COLORS.future.toLowerCase()).not.toMatch(/^#(e8003f|ff4136|f56565)/);
  });
});

describe('DialChart reference colour', () => {
  it('has no leftover hardcoded reference green -- reads SCENARIO_COLORS.reference throughout', () => {
    expect(DIALCHART).not.toContain('#7ddc7a');
    expect(DIALCHART).not.toContain('#d9f99d');
    expect(DIALCHART).not.toContain('#2ecc40');
  });
});

describe('SCENARIOS (corner-label / accent pastels)', () => {
  // These are the map corner labels' side accents, the swiper divider, the
  // scenario picker's focus ring, and the landing page legend -- a softened
  // pastel tint of SCENARIO_COLORS, not the saturated marker colours
  // themselves, so this checks they moved off the old palette rather than
  // asserting the exact new hex (which isn't a fixed function of the other).
  const byId = (id: string) => SCENARIOS.find((s) => s.id === id)?.color;

  it('is no longer the old orange/blue/green palette', () => {
    expect(byId('reference')).not.toBe('#f6b07c');
    expect(byId('future')).not.toBe('#9ecb9e');
  });

  it('gives every role a distinct colour', () => {
    const values = SCENARIOS.map((s) => s.color);
    expect(new Set(values).size).toBe(values.length);
  });

  it('does not make the target green, which is reserved for reference here too', () => {
    expect(byId('future')).not.toBe(byId('reference'));
  });
});

describe('ChartView series colours', () => {
  it('derives its Reference/Current/Target colours from useScenarioColors, not a second hardcoded copy', () => {
    // Computed inside the component (from the live, overridable colours),
    // not a module-level constant -- colours.json's overrides only resolve
    // after mount, so a module-level snapshot could never reflect them.
    expect(CHARTVIEW).toMatch(/import\s*{[^}]*useScenarioColors[^}]*}\s*from\s*'..\/hooks\/useApi'/);
    const seriesColors = CHARTVIEW.slice(
      CHARTVIEW.indexOf('const SERIES_COLORS'),
      CHARTVIEW.indexOf(';', CHARTVIEW.indexOf('const SERIES_COLORS')),
    );
    expect(seriesColors).toContain('scenarioColors.reference');
    expect(seriesColors).toContain('scenarioColors.current');
    expect(seriesColors).toContain('scenarioColors.future');
    // The old hardcoded values must not still be sitting there alongside it.
    expect(seriesColors).not.toContain('#e65100');
    expect(seriesColors).not.toContain('#4caf50');
  });
});

describe('useScenarioColors', () => {
  it('uses the server response when the datapack overrides all three colours', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ reference: '#111111', current: '#222222', target: '#333333' }),
      { headers: { 'content-type': 'application/json' } },
    )));
    const { result } = await renderScenarioColors();
    await waitFor(() => {
      expect(result.current.colors).toEqual({ reference: '#111111', current: '#222222', future: '#333333' });
    });
  });

  it('falls back to the client-side defaults on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const { result } = await renderScenarioColors();
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.colors).toEqual(SCENARIO_COLORS);
  });

  it('falls back to the client-side defaults when the server response is empty', async () => {
    // The datapack has no colours.json -- the backend's own default merge
    // already covers this in practice, but the frontend must not crash or
    // show a blank colour if it ever received an empty object.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{}',
      { headers: { 'content-type': 'application/json' } },
    )));
    const { result } = await renderScenarioColors();
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.colors).toEqual(SCENARIO_COLORS);
  });
});
