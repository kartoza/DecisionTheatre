// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { choroplethFillOpacity } from '../components/MapView';

// Reported: the transparency slider at 100% didn't make the choropleth fill
// fully opaque. Root cause was a hardcoded 0.80 ceiling applied whenever the
// Google satellite basemap was showing (the default in the browser runtime),
// multiplied into the slider's own fraction rather than being capped by it --
// so slider=100 over satellite rendered at fill-opacity 0.80, not 1.

describe('choroplethFillOpacity', () => {
  it('is fully opaque at 100, regardless of basemap', () => {
    expect(choroplethFillOpacity(100)).toBe(1);
  });

  it('scales linearly with the slider below 100', () => {
    expect(choroplethFillOpacity(50)).toBe(0.5);
    expect(choroplethFillOpacity(0)).toBe(0);
  });

  it('clamps out-of-range input rather than producing an invalid paint value', () => {
    expect(choroplethFillOpacity(150)).toBe(1);
    expect(choroplethFillOpacity(-10)).toBe(0);
  });
});

describe('MapView fill-opacity call sites', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..');
  const mapView = readFileSync(join(src, 'components', 'MapView.tsx'), 'utf8');

  it('has no leftover per-basemap opacity ceiling that could cap it below 1 at slider=100', () => {
    expect(mapView).not.toMatch(/CHOROPLETH_FILL_OPACITY_SATELLITE/);
    expect(mapView).not.toMatch(/baseFillOpacity/);
  });

  it('routes both the initial-paint and live-update call sites through the one shared helper', () => {
    const uses = mapView.match(/choroplethFillOpacity\(/g) ?? [];
    // One function definition/declaration occurrence, plus one call at each
    // of the two sites described in the fix report.
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });
});
