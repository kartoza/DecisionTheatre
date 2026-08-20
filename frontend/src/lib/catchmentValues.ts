import type { ZoneStats } from '../types';

/**
 * The columnar response `/api/choropleth?valuesOnly=1` returns.
 *
 * It used to return a GeoJSON `FeatureCollection`: 147,837 features, each one
 * a `{"type":"Feature","id":…,"geometry":null,"properties":{…}}` wrapper around
 * one integer and one float — 16.1 MB, fetched twice concurrently, parsed on
 * the main thread. A response with no geometry is not a FeatureCollection, and
 * the wrapper bought nothing: every consumer of it computes statistics.
 *
 * `ids` is shared by every series, which is why both scenarios of a comparison
 * are requested together — the ID column is sent once instead of twice.
 * A series holds `null` where that scenario has no value for a catchment; the
 * scenarios' NULL sets need not agree, and one shared ID array has to be able
 * to say so.
 */
export interface CatchmentValues {
  type: 'CatchmentValues';
  attribute: string;
  scenarios: string[];
  ids: number[];
  /** Present when a single scenario was requested. */
  values?: Array<number | null>;
  /** Present when several scenarios were requested, keyed by scenario name. */
  series?: Record<string, Array<number | null>>;
  domain_min: number;
  domain_max: number;
}

/**
 * One scenario's values from a {@link CatchmentValues} response.
 *
 * `ids` is the response's array by reference, not a copy: selecting the left
 * and right scenario of a comparison costs nothing beyond two small objects.
 */
export interface CatchmentSeries {
  attribute: string;
  scenario: string;
  ids: number[];
  values: Array<number | null>;
}

/**
 * Narrow a fetched dataset to a values series.
 *
 * The discriminant is the presence of `ids`, which the GeoJSON shape never has.
 */
export function isCatchmentSeries(data: unknown): data is CatchmentSeries {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as CatchmentSeries).ids) &&
    Array.isArray((data as CatchmentSeries).values)
  );
}

/**
 * Pick one scenario out of a columnar response.
 *
 * Returns null when the response is missing, or when it does not carry the
 * requested scenario — a single-scenario response answers only for the
 * scenario it was asked about.
 */
export function selectScenario(
  data: CatchmentValues | null | undefined,
  scenario: string,
): CatchmentSeries | null {
  if (!data || !Array.isArray(data.ids)) return null;

  const values = data.series
    ? data.series[scenario]
    : data.scenarios?.includes(scenario)
      ? data.values
      : undefined;
  if (!Array.isArray(values)) return null;

  return { attribute: data.attribute, scenario, ids: data.ids, values };
}

/**
 * min / max / mean / count over a series, skipping nulls and non-finite values.
 *
 * Deliberately identical in arithmetic and iteration order to the GeoJSON path
 * it replaced (`computeZoneStats` in MapView.tsx): the same values are summed
 * in the same order, so the mean is bit-for-bit the same float.
 */
export function zoneStatsFromSeries(series: CatchmentSeries): ZoneStats | null {
  const values: number[] = [];
  for (const value of series.values) {
    if (typeof value === 'number' && !isNaN(value)) {
      values.push(value);
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

  return {
    min,
    max,
    mean: sum / values.length,
    count: values.length,
  };
}

/**
 * Keep only the catchments in `catchmentIds`. An empty set means "no filter",
 * matching the GeoJSON path's behaviour.
 *
 * The result gets its own `ids` array, so filtering one scenario of a shared
 * response cannot disturb the other.
 */
export function filterSeriesByCatchmentIds(
  series: CatchmentSeries,
  catchmentIds: Set<string>,
): CatchmentSeries {
  if (catchmentIds.size === 0) return series;

  const ids: number[] = [];
  const values: Array<number | null> = [];
  for (let i = 0; i < series.ids.length; i += 1) {
    if (catchmentIds.has(String(series.ids[i]))) {
      ids.push(series.ids[i]);
      values.push(series.values[i] ?? null);
    }
  }
  return { attribute: series.attribute, scenario: series.scenario, ids, values };
}

/**
 * AOI-weighted min / max / mean over a series, using pre-computed per-catchment
 * AOI fractions. The GeoJSON equivalent read `properties.HYBAS_ID` to key the
 * fraction lookup; here the ID is already in a parallel array.
 */
export function aoiWeightedZoneStatsFromSeries(
  series: CatchmentSeries,
  fractions: Map<string, { aoiFraction: number; areaKm2: number }>,
): ZoneStats | null {
  if (series.ids.length === 0 || fractions.size === 0) return null;

  let min = Infinity;
  let max = -Infinity;
  let totalValidArea = 0;
  let weightedSum = 0;
  let count = 0;

  for (let i = 0; i < series.ids.length; i += 1) {
    const metricValue = series.values[i];
    if (typeof metricValue !== 'number' || Number.isNaN(metricValue)) continue;

    const f = fractions.get(String(series.ids[i]));
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

/**
 * Overlay a site's edited target values onto the future scenario.
 *
 * The server does this for the WebView runtime, which can read the site store;
 * in the browser runtime the backend never sees the edits, so the same
 * substitution has to happen here. Mutates in place, on a response the caller
 * owns — see the cache rule in fetchCatchmentValues.
 */
export function applyIdealOverrides(
  data: CatchmentValues,
  scenario: string,
  overrides: Map<number, number>,
): void {
  const values = data.series ? data.series[scenario] : data.values;
  if (!Array.isArray(values) || overrides.size === 0) return;

  for (let i = 0; i < data.ids.length; i += 1) {
    const ideal = overrides.get(data.ids[i]);
    if (ideal !== undefined) values[i] = ideal;
  }
}
