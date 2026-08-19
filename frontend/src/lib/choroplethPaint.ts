import type maplibregl from 'maplibre-gl';
import type { ColorScaleType, ZoneStats } from '../types';

/**
 * The choropleth's paint expressions, and the colour scale they encode.
 *
 * These live outside MapView because two transports now feed them. The GeoJSON
 * path reads the value from the feature's own properties; the vector-tile path
 * reads it from feature state, because the tiles carry geometry only and the
 * values are joined onto them per attribute. Everything downstream of that one
 * difference - the normalisation curve, the colour ramp, the extrusion height -
 * is identical, and has to stay identical, or the same catchment would be a
 * different colour depending on which zoom range it was viewed at.
 *
 * Colouring stays a data-driven expression evaluated on the GPU either way.
 * Nothing here walks features in JavaScript.
 */

// Prism colour gradient for data visualization
// Spectrum: violet -> indigo -> blue -> cyan -> green -> yellow -> orange -> red
export const PRISM_STOPS: [number, string][] = [
  [0, '#6a0dad'],       // violet
  [0.143, '#4b0082'],   // indigo
  [0.286, '#0074d9'],   // blue
  [0.429, '#00bcd4'],   // cyan
  [0.571, '#2ecc40'],   // green
  [0.714, '#ffdc00'],   // yellow
  [0.857, '#ff851b'],   // orange
  [1, '#e8003f'],       // red
];

// Steepness (k) of the logistic curve used by the 'logistic' color scale type.
// Higher values sharpen the transition around the domain midpoint.
export const LOGISTIC_STEEPNESS = 10;

// Strength (C) of the log1p curve used by the 'logarithmic' color scale type.
// Higher values exaggerate contrast among low values at the expense of high ones.
export const LOGARITHMIC_STRENGTH = 9;

// Maximum extrusion height in metres for 3D mode
export const MAX_EXTRUSION_HEIGHT = 50000;

/**
 * The feature-state key the vector-tile path stores a catchment's value under.
 *
 * Short deliberately: it is repeated once per catchment in the state object,
 * which at the tile pipeline's minimum zoom can hold tens of thousands of
 * entries per map instance, twelve map instances live.
 */
export const CHOROPLETH_VALUE_STATE_KEY = 'v';

/**
 * How a paint expression reaches a catchment's value.
 *
 * `['get', attribute]` for the GeoJSON path, where the value travelled with the
 * geometry; `['feature-state', 'v']` for the vector-tile path, where it was
 * joined on afterwards.
 */
export type ChoroplethValueAccessor = maplibregl.ExpressionSpecification;

/** Reads the value from the feature's own properties (GeoJSON path). */
export function attributeValueAccessor(attribute: string): ChoroplethValueAccessor {
  return ['get', attribute] as maplibregl.ExpressionSpecification;
}

/** Reads the value from feature state (vector-tile path). */
export function featureStateValueAccessor(): ChoroplethValueAccessor {
  return ['feature-state', CHOROPLETH_VALUE_STATE_KEY] as maplibregl.ExpressionSpecification;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = hex.trim().replace('#', '');
  if (normalized.length === 3) {
    const r = parseInt(normalized[0] + normalized[0], 16);
    const g = parseInt(normalized[1] + normalized[1], 16);
    const b = parseInt(normalized[2] + normalized[2], 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : { r, g, b };
  }
  if (normalized.length === 6) {
    const r = parseInt(normalized.slice(0, 2), 16);
    const g = parseInt(normalized.slice(2, 4), 16);
    const b = parseInt(normalized.slice(4, 6), 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : { r, g, b };
  }
  return null;
}

/**
 * Build a MapLibre expression producing the 0-1 normalized position of an
 * attribute's value within [min, max].
 *
 * - 'logistic' passes the linear ratio through a sigmoid centered on the
 *   domain midpoint, which compresses values near the extremes and expands
 *   contrast around the middle of the range - useful when most values
 *   cluster around the mean with a long tail.
 * - 'logarithmic' passes the linear ratio through a log1p curve, which
 *   expands contrast among low values at the expense of high ones - useful
 *   when most values are small with a few large outliers. log1p (rather than
 *   a plain log of the raw value) is used so the domain minimum, which can
 *   legitimately be 0, never hits an undefined log(0).
 *
 * The coalesce to `min` is what makes a catchment with no value for this
 * attribute render as the low end of the scale rather than as a hole. On the
 * vector-tile path it does the same job for a catchment whose feature state has
 * not been set - either because the datapack has no value for it, or because it
 * lies outside the viewport the values were fetched for.
 */
export function buildNormalizedValueExpression(
  value: ChoroplethValueAccessor,
  min: number,
  range: number,
  scaleType: ColorScaleType
): maplibregl.ExpressionSpecification {
  const linearRatio = [
    '/',
    ['-', ['coalesce', value, min], min],
    range,
  ] as maplibregl.ExpressionSpecification;

  if (scaleType === 'linear') {
    return linearRatio;
  }

  if (scaleType === 'logarithmic') {
    return [
      'let',
      't',
      linearRatio,
      [
        '/',
        ['ln', ['+', 1, ['*', LOGARITHMIC_STRENGTH, ['var', 't']]]],
        Math.log(1 + LOGARITHMIC_STRENGTH),
      ],
    ] as maplibregl.ExpressionSpecification;
  }

  return [
    'let',
    't',
    linearRatio,
    [
      '/',
      1,
      ['+', 1, ['^', Math.E, ['*', -LOGISTIC_STEEPNESS, ['-', ['var', 't'], 0.5]]]],
    ],
  ] as maplibregl.ExpressionSpecification;
}

/**
 * Build a MapLibre expression for fill-color based on attribute value and global min/max.
 */
export function buildFillColorExpression(
  value: ChoroplethValueAccessor,
  min: number,
  max: number,
  baseColor?: string | null,
  scaleType: ColorScaleType = 'linear'
): maplibregl.ExpressionSpecification | string {
  // When a metadata base color is provided, blend from white (low values)
  // to the base color (high values) instead of using opacity.
  if (baseColor) {
    const rgb = hexToRgb(baseColor);
    if (!rgb) return baseColor;

    const range = max - min;
    if (range === 0) {
      // Degenerate domain (every visible value equals min) - treat it as the
      // low end of the white-to-baseColor scale rather than the high end.
      return '#FFFFFF';
    }

    return [
      'interpolate',
      ['linear'],
      buildNormalizedValueExpression(value, min, range, scaleType),
      0,
      '#FFFFFF',
      1,
      baseColor,
    ] as maplibregl.ExpressionSpecification;
  }

  const range = max - min;
  if (range === 0) {
    // Single value - use middle color
    return PRISM_STOPS[Math.floor(PRISM_STOPS.length / 2)][1];
  }

  // Build interpolate expression: normalize value to 0-1 then map to colors
  return [
    'interpolate',
    ['linear'],
    buildNormalizedValueExpression(value, min, range, scaleType),
    ...PRISM_STOPS.flatMap(([t, color]) => [t, color]),
  ] as maplibregl.ExpressionSpecification;
}

export function buildOpacityColorExpression(
  value: ChoroplethValueAccessor,
  min: number,
  max: number,
  baseColor: string,
  scaleType: ColorScaleType = 'linear'
): maplibregl.ExpressionSpecification | string {
  // Blend color from white (low values) to the metadata base color
  // (high values). Opacity will be handled separately by layer paint.
  const rgb = hexToRgb(baseColor);
  if (!rgb) return baseColor;

  const range = max - min;
  if (range === 0) {
    // Degenerate domain (every visible value equals min) - treat it as the
    // low end of the white-to-baseColor scale rather than the high end.
    return '#FFFFFF';
  }

  return [
    'interpolate',
    ['linear'],
    buildNormalizedValueExpression(value, min, range, scaleType),
    0,
    '#FFFFFF',
    1,
    baseColor,
  ] as maplibregl.ExpressionSpecification;
}

/**
 * Build a MapLibre expression for fill-extrusion-height based on attribute value.
 */
export function buildExtrusionExpression(
  value: ChoroplethValueAccessor,
  min: number,
  max: number,
  scaleType: ColorScaleType = 'linear'
): maplibregl.ExpressionSpecification | number {
  const range = max - min;
  if (range === 0) {
    return MAX_EXTRUSION_HEIGHT / 2;
  }

  return [
    '*',
    buildNormalizedValueExpression(value, min, range, scaleType),
    MAX_EXTRUSION_HEIGHT,
  ] as maplibregl.ExpressionSpecification;
}

/**
 * Summarise a set of attribute values for the statistics panel.
 *
 * Split out from computeZoneStats so that the vector-tile path, which receives
 * a plain array of values and never materialises a feature per catchment, uses
 * the same arithmetic as the GeoJSON path rather than a parallel copy of it.
 */
export function zoneStatsFromValues(values: number[]): ZoneStats | null {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;

  for (const v of values) {
    // Guard here rather than at each call site: one path reads values out of
    // GeoJSON properties (which can hold booleans and undefined) and the other
    // out of a JSON number array, and neither should be able to turn a single
    // bad entry into a NaN mean for the whole panel.
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count += 1;
  }

  if (count === 0) return null;

  return { min, max, mean: sum / count, count };
}
