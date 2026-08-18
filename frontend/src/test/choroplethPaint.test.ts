import { describe, it, expect } from 'vitest';
import {
  PRISM_STOPS,
  MAX_EXTRUSION_HEIGHT,
  CHOROPLETH_VALUE_STATE_KEY,
  attributeValueAccessor,
  featureStateValueAccessor,
  buildFillColorExpression,
  buildOpacityColorExpression,
  buildExtrusionExpression,
  zoneStatsFromValues,
} from '../lib/choroplethPaint';

// The choropleth's colouring is a data-driven paint expression evaluated on the
// GPU. Moving the geometry onto vector tiles changes only where the expression
// reads a catchment's value from; the expression itself has to be preserved, or
// the same value would render as a different colour depending on the zoom range
// it was viewed at.

/** Replace every occurrence of `from` inside a nested expression with `to`. */
function substitute(expr: unknown, from: unknown, to: unknown): unknown {
  const fromJSON = JSON.stringify(from);
  if (JSON.stringify(expr) === fromJSON) return to;
  if (Array.isArray(expr)) return expr.map((e) => substitute(e, from, to));
  return expr;
}

describe('choropleth paint expressions', () => {
  const attribute = 'rainfall_mm';
  const propertyAccess = attributeValueAccessor(attribute);
  const stateAccess = featureStateValueAccessor();

  it('reads a value from properties on the GeoJSON path and feature state on the tile path', () => {
    expect(propertyAccess).toEqual(['get', attribute]);
    expect(stateAccess).toEqual(['feature-state', CHOROPLETH_VALUE_STATE_KEY]);
  });

  it('produces the same fill-color expression on both paths bar the value accessor', () => {
    for (const scaleType of ['linear', 'logistic', 'logarithmic'] as const) {
      const fromProperties = buildFillColorExpression(propertyAccess, 0, 100, null, scaleType);
      const fromState = buildFillColorExpression(stateAccess, 0, 100, null, scaleType);
      expect(substitute(fromState, stateAccess, propertyAccess)).toEqual(fromProperties);
    }
  });

  it('produces the same extrusion and metadata-colour expressions on both paths', () => {
    expect(substitute(buildExtrusionExpression(stateAccess, 0, 100), stateAccess, propertyAccess))
      .toEqual(buildExtrusionExpression(propertyAccess, 0, 100));
    expect(substitute(buildOpacityColorExpression(stateAccess, 0, 100, '#00bcd4'), stateAccess, propertyAccess))
      .toEqual(buildOpacityColorExpression(propertyAccess, 0, 100, '#00bcd4'));
  });

  it('interpolates the full prism ramp against the normalised value', () => {
    const expr = buildFillColorExpression(propertyAccess, 10, 110, null, 'linear') as unknown[];

    expect(expr[0]).toBe('interpolate');
    expect(expr[1]).toEqual(['linear']);
    // A ratio of the value's distance above the domain minimum, with a
    // coalesce so a catchment with no value renders as the low end of the
    // scale rather than as a hole.
    expect(expr[2]).toEqual(['/', ['-', ['coalesce', propertyAccess, 10], 10], 100]);
    expect(expr.slice(3)).toEqual(PRISM_STOPS.flatMap(([t, color]) => [t, color]));
  });

  it('falls back to a flat colour on a degenerate domain', () => {
    expect(buildFillColorExpression(propertyAccess, 5, 5)).toBe(PRISM_STOPS[PRISM_STOPS.length / 2][1]);
    expect(buildFillColorExpression(propertyAccess, 5, 5, '#00bcd4')).toBe('#FFFFFF');
    expect(buildExtrusionExpression(propertyAccess, 5, 5)).toBe(MAX_EXTRUSION_HEIGHT / 2);
  });

  it('wraps the linear ratio in the documented curve for the non-linear scales', () => {
    const logarithmic = buildFillColorExpression(propertyAccess, 0, 1, null, 'logarithmic') as unknown[];
    expect((logarithmic[2] as unknown[])[0]).toBe('let');
    expect(JSON.stringify(logarithmic[2])).toContain('"ln"');

    const logistic = buildFillColorExpression(propertyAccess, 0, 1, null, 'logistic') as unknown[];
    expect((logistic[2] as unknown[])[0]).toBe('let');
    expect(JSON.stringify(logistic[2])).toContain('"^"');
  });
});

describe('zoneStatsFromValues', () => {
  it('summarises a set of values', () => {
    expect(zoneStatsFromValues([1, 2, 6])).toEqual({ min: 1, max: 6, mean: 3, count: 3 });
  });

  it('returns null when there is nothing to summarise', () => {
    expect(zoneStatsFromValues([])).toBeNull();
  });

  // Both callers feed this from loosely typed sources - GeoJSON properties on
  // one path, a parsed JSON array on the other - and a single bad entry must
  // not turn the whole panel's mean into NaN.
  it('ignores entries that are not finite numbers', () => {
    const values = [1, NaN, 3, Infinity, 5] as number[];
    expect(zoneStatsFromValues(values)).toEqual({ min: 1, max: 5, mean: 3, count: 3 });
  });
});
