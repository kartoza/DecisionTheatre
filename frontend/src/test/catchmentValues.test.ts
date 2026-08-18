import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ZoneStats } from '../types';
import type { CatchmentValues } from '../lib/catchmentValues';
import {
  aoiWeightedZoneStatsFromSeries,
  applyIdealOverrides,
  filterSeriesByCatchmentIds,
  isCatchmentSeries,
  selectScenario,
  zoneStatsFromSeries,
} from '../lib/catchmentValues';

// `valuesOnly=1` used to answer with a GeoJSON FeatureCollection: one
// {"type":"Feature","id":…,"geometry":null,"properties":{…}} wrapper per
// catchment, 147,837 of them, 16.1 MB, fetched twice concurrently. The wrapper
// is gone; the numbers computed from it must not have moved. These tests build
// both encodings from the same source rows and compare.

interface LegacyFeature {
  type: string;
  id: number;
  geometry: object | null;
  properties: { HYBAS_ID?: number; [key: string]: number | boolean | undefined };
}

interface LegacyCollection {
  type: string;
  features: LegacyFeature[];
  domain_min: number;
  domain_max: number;
}

const ATTRIBUTE = 'NPP_gm2';

/** Rows as the server reads them out of the datapack. */
function sourceRows(count: number): Array<{ id: number; current: number; reference: number }> {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      id: 1121879850 + i,
      // Awkward on purpose: the claim is that only the bytes changed, which is
      // worth asserting on values a careless formatter would round.
      current: 1234.5678901234 + i / 3,
      reference: 987.65432109876 + i / 7,
    });
  }
  return rows;
}

function legacyResponse(rows: ReturnType<typeof sourceRows>, scenario: 'current' | 'reference'): LegacyCollection {
  return {
    type: 'FeatureCollection',
    features: rows.map((row) => ({
      type: 'Feature',
      id: row.id,
      geometry: null,
      properties: { HYBAS_ID: row.id, [ATTRIBUTE]: row[scenario] },
    })),
    domain_min: 0,
    domain_max: 9999,
  };
}

function columnarResponse(rows: ReturnType<typeof sourceRows>): CatchmentValues {
  return {
    type: 'CatchmentValues',
    attribute: ATTRIBUTE,
    scenarios: ['current', 'reference'],
    ids: rows.map((row) => row.id),
    series: {
      current: rows.map((row) => row.current),
      reference: rows.map((row) => row.reference),
    },
    domain_min: 0,
    domain_max: 9999,
  };
}

/**
 * computeZoneStats as it was written for the GeoJSON shape, copied verbatim
 * from MapView.tsx. This is the reference the columnar implementation has to
 * reproduce exactly.
 */
function legacyZoneStats(data: LegacyCollection, attribute: string): ZoneStats | null {
  if (!data.features || data.features.length === 0) return null;

  const values: number[] = [];
  for (const feature of data.features) {
    const val = feature.properties?.[attribute];
    if (typeof val === 'number' && !isNaN(val)) {
      values.push(val);
    }
  }

  if (values.length === 0) return null;

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;

  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }

  return { min, max, mean: sum / values.length, count: values.length };
}

/** filterDatasetByCatchmentIds as it was written for the GeoJSON shape. */
function legacyFilter(data: LegacyCollection, catchmentIds: Set<string>): LegacyCollection {
  if (catchmentIds.size === 0) return data;
  return {
    ...data,
    features: data.features.filter((feature) => {
      const id = feature.properties?.HYBAS_ID;
      return id !== undefined && catchmentIds.has(String(id));
    }),
  };
}

/** computeAOIWeightedZoneStatsFromFractions as it was written for the GeoJSON shape. */
function legacyAOIWeightedStats(
  data: LegacyCollection,
  attribute: string,
  fractions: Map<string, { aoiFraction: number; areaKm2: number }>,
): ZoneStats | null {
  if (!data.features || data.features.length === 0 || fractions.size === 0) return null;

  let min = Infinity;
  let max = -Infinity;
  let totalValidArea = 0;
  let weightedSum = 0;
  let count = 0;

  for (const feature of data.features) {
    const metricValue = feature.properties?.[attribute];
    if (typeof metricValue !== 'number' || Number.isNaN(metricValue)) continue;

    const featureId = String(feature.properties?.HYBAS_ID ?? '');
    const f = fractions.get(featureId);
    if (!f) continue;

    const frac = Math.max(0, Math.min(1, f.aoiFraction ?? 1));
    const validArea = f.areaKm2 * frac;
    if (validArea <= 0) continue;

    if (metricValue < min) min = metricValue;
    if (metricValue > max) max = metricValue;

    totalValidArea += validArea;
    weightedSum += metricValue * validArea;
    count += 1;
  }

  if (count === 0 || totalValidArea <= 0 || !Number.isFinite(weightedSum)) return null;
  return { min, max, mean: weightedSum / totalValidArea, count };
}

/** Object.is comparison, so a mean that drifted by one ulp is caught. */
function expectIdenticalStats(got: ZoneStats | null, want: ZoneStats | null) {
  expect(got).not.toBeNull();
  expect(want).not.toBeNull();
  expect(Object.is(got!.min, want!.min)).toBe(true);
  expect(Object.is(got!.max, want!.max)).toBe(true);
  expect(Object.is(got!.mean, want!.mean)).toBe(true);
  expect(got!.count).toBe(want!.count);
}

describe('zone statistics are unchanged by the columnar format', () => {
  const rows = sourceRows(5000);
  const columnar = columnarResponse(rows);

  it('computes bit-identical statistics from the two encodings', () => {
    for (const scenario of ['current', 'reference'] as const) {
      const series = selectScenario(columnar, scenario);
      expect(series).not.toBeNull();
      expectIdenticalStats(
        zoneStatsFromSeries(series!),
        legacyZoneStats(legacyResponse(rows, scenario), ATTRIBUTE),
      );
    }
  });

  it('filters to a site\'s catchments identically', () => {
    // Every seventh catchment, plus an id that is in no dataset.
    const ids = new Set(rows.filter((_, i) => i % 7 === 0).map((row) => String(row.id)));
    ids.add('999999999');

    const filteredSeries = filterSeriesByCatchmentIds(selectScenario(columnar, 'current')!, ids);
    const filteredLegacy = legacyFilter(legacyResponse(rows, 'current'), ids);

    expect(filteredSeries.ids).toEqual(filteredLegacy.features.map((f) => f.properties.HYBAS_ID));
    expectIdenticalStats(
      zoneStatsFromSeries(filteredSeries),
      legacyZoneStats(filteredLegacy, ATTRIBUTE),
    );
  });

  it('computes identical AOI-weighted statistics', () => {
    const fractions = new Map<string, { aoiFraction: number; areaKm2: number }>();
    rows.forEach((row, i) => {
      if (i % 3 === 0) return; // some catchments have no fraction at all
      fractions.set(String(row.id), { aoiFraction: (i % 10) / 10, areaKm2: 12.5 + i });
    });

    expectIdenticalStats(
      aoiWeightedZoneStatsFromSeries(selectScenario(columnar, 'current')!, fractions),
      legacyAOIWeightedStats(legacyResponse(rows, 'current'), ATTRIBUTE, fractions),
    );
  });

  it('treats an empty id set as no filter, as the feature path did', () => {
    const series = selectScenario(columnar, 'current')!;
    expect(filterSeriesByCatchmentIds(series, new Set())).toBe(series);
    expect(legacyFilter(legacyResponse(rows, 'current'), new Set()).features).toHaveLength(rows.length);
  });
});

describe('the columnar shape', () => {
  const rows = sourceRows(4);

  it('sends the id array once for both scenarios of a comparison', () => {
    const columnar = columnarResponse(rows);
    const left = selectScenario(columnar, 'current')!;
    const right = selectScenario(columnar, 'reference')!;

    // Same array by reference: selecting two scenarios copies nothing.
    expect(left.ids).toBe(right.ids);
    expect(left.values).not.toBe(right.values);
    expect(JSON.stringify(columnar).match(/1121879850/g)).toHaveLength(1);
  });

  it('answers only for scenarios the response carries', () => {
    const single: CatchmentValues = {
      type: 'CatchmentValues',
      attribute: ATTRIBUTE,
      scenarios: ['current'],
      ids: rows.map((r) => r.id),
      values: rows.map((r) => r.current),
      domain_min: 0,
      domain_max: 9999,
    };

    expect(selectScenario(single, 'current')?.values).toHaveLength(rows.length);
    expect(selectScenario(single, 'reference')).toBeNull();
    expect(selectScenario(null, 'current')).toBeNull();
  });

  it('skips nulls, which stand for a catchment a scenario has no value for', () => {
    const series = {
      attribute: ATTRIBUTE,
      scenario: 'current',
      ids: [1, 2, 3],
      values: [10, null, 30] as Array<number | null>,
    };

    const stats = zoneStatsFromSeries(series)!;
    expect(stats.count).toBe(2);
    expect(stats.mean).toBe(20);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(30);
  });

  it('filtering one scenario does not disturb the shared id array', () => {
    const columnar = columnarResponse(rows);
    const left = selectScenario(columnar, 'current')!;
    const right = selectScenario(columnar, 'reference')!;

    const filtered = filterSeriesByCatchmentIds(left, new Set([String(rows[0].id)]));
    expect(filtered.ids).toHaveLength(1);
    expect(right.ids).toHaveLength(rows.length);
    expect(columnar.ids).toHaveLength(rows.length);
  });

  it('is distinguishable from a FeatureCollection', () => {
    expect(isCatchmentSeries(selectScenario(columnarResponse(rows), 'current'))).toBe(true);
    expect(isCatchmentSeries(legacyResponse(rows, 'current'))).toBe(false);
    expect(isCatchmentSeries(null)).toBe(false);
  });

  it('overlays browser-runtime ideal values onto the future series only', () => {
    const columnar: CatchmentValues = {
      type: 'CatchmentValues',
      attribute: ATTRIBUTE,
      scenarios: ['current', 'future'],
      ids: rows.map((r) => r.id),
      series: {
        current: rows.map((r) => r.current),
        future: rows.map((r) => r.reference),
      },
      domain_min: 0,
      domain_max: 9999,
    };
    const untouched = [...columnar.series!.current];

    applyIdealOverrides(columnar, 'future', new Map([[rows[1].id, 42]]));

    expect(columnar.series!.future[1]).toBe(42);
    expect(columnar.series!.future[0]).toBe(rows[0].reference);
    expect(columnar.series!.current).toEqual(untouched);
  });
});

// Source-level assertions, in the style of renderCost.test.ts: the statistics
// paths in MapView have no seam a unit test can reach, but the property that
// matters — two concurrent full-dataset fetches became one — is visible in the
// source and would regress silently otherwise.
describe('MapView statistics fetches', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..');
  const mapView = readFileSync(join(src, 'components', 'MapView.tsx'), 'utf8');

  it('asks for both scenarios in one request', () => {
    const calls = mapView.match(/fetchCatchmentValues\(\s*\n?\s*\[c\.leftScenario, c\.rightScenario\]/g) ?? [];
    // The full-dataset stats effect and the site stats effect.
    expect(calls).toHaveLength(2);
  });

  it('never issues a values fetch per scenario', () => {
    // A single-scenario call would take a bare scenario rather than a pair.
    expect(mapView).not.toMatch(/fetchCatchmentValues\(\s*c\.(left|right)Scenario/);
    expect(mapView).not.toMatch(/fetchChoroplethData\([^)]*valuesOnly/);
  });

  it('reads the columnar response directly rather than rebuilding features', () => {
    expect(mapView).toMatch(/import .*selectScenario.* from '\.\.\/lib\/catchmentValues'|selectScenario,/s);
    expect(mapView).toMatch(/isCatchmentSeries\(data\)/);
  });
});
