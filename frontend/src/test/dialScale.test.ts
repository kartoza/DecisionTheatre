/**
 * The scale both dials read.
 *
 * The arc gauge and the flat band are two drawings of one scale. These tests
 * are on the scale, not on either drawing — they are what stops the two
 * renderings disagreeing about where a value sits or which band it falls in,
 * which is the failure mode that made extracting this worthwhile.
 */
import { describe, it, expect } from 'vitest';
import {
  bandGradientStops,
  formatValue,
  greenZoneCenter,
  normalize,
  attributeSpread,
  capRange,
  hasDeclaredMax,
  hasDeclaredMin,
  tickValues,
} from '../lib/dialScale';

describe('normalize', () => {
  it('maps the ends and the middle', () => {
    expect(normalize(0, 0, 10)).toBe(0);
    expect(normalize(5, 0, 10)).toBe(0.5);
    expect(normalize(10, 0, 10)).toBe(1);
  });

  it('clamps rather than running off the scale', () => {
    // A marker outside the range has to be drawn somewhere; the end of the
    // band is the only honest place for it.
    expect(normalize(-5, 0, 10)).toBe(0);
    expect(normalize(50, 0, 10)).toBe(1);
  });

  it('handles a negative range, which several factors have', () => {
    expect(normalize(0, -100, 100)).toBe(0.5);
    expect(normalize(-100, -100, 100)).toBe(0);
  });

  it('does not divide by zero on a degenerate range', () => {
    expect(normalize(5, 5, 5)).toBe(0.5);
  });
});

describe('the condition band', () => {
  it('centres its green on the reference, not on the midpoint', () => {
    // "Good" is defined by the ecological reference. A reference near the top
    // of the range must put the green near the top of the band.
    const stops = bandGradientStops(0, 100, 80);
    const greenest = stops.reduce((a, b) => (b.color === '#2ecc40' ? b : a));
    expect(greenest.offset).toBeGreaterThan(0.7);
    expect(greenest.offset).toBeLessThan(0.9);
  });

  it('moves the green when the reference moves', () => {
    const low = bandGradientStops(0, 100, 20).find((s) => s.color === '#2ecc40');
    const high = bandGradientStops(0, 100, 80).find((s) => s.color === '#2ecc40');
    expect(low!.offset).toBeLessThan(high!.offset);
  });

  it('runs red at both extremes, not just one', () => {
    const stops = bandGradientStops(0, 100, 50);
    expect(stops[0].color).toBe('#ff4136');
    expect(stops[stops.length - 1].color).toBe('#e8003f');
  });

  it('emits offsets in ascending order, which SVG requires', () => {
    for (const ref of [0, 5, 50, 95, 100]) {
      const offsets = bandGradientStops(0, 100, ref).map((s) => s.offset);
      const sorted = [...offsets].sort((a, b) => a - b);
      expect(offsets).toEqual(sorted);
    }
  });

  it('shows magnitude only when there is no reference to judge against', () => {
    const stops = bandGradientStops(0, 100, undefined);
    expect(stops.some((s) => s.color === '#2ecc40')).toBe(false);
  });
});

describe('greenZoneCenter', () => {
  it('is null without a reference, so a marker cannot align to nothing', () => {
    expect(greenZoneCenter(0, 100, undefined)).toBeNull();
  });

  it('tracks the reference', () => {
    expect(greenZoneCenter(0, 100, 50)).toBeCloseTo(0.5, 5);
    expect(greenZoneCenter(0, 100, 25)).toBeCloseTo(0.25, 5);
  });

  it('stays inside the band when the reference sits on an end', () => {
    const atMax = greenZoneCenter(0, 100, 100)!;
    expect(atMax).toBeGreaterThan(0);
    expect(atMax).toBeLessThanOrEqual(1);
  });
});

describe('formatValue', () => {
  it('abbreviates magnitudes that would otherwise not fit a tick', () => {
    expect(formatValue(1500)).toBe('1.5K');
    expect(formatValue(2500000)).toBe('2.5M');
  });

  it('keeps two decimals where the difference is the whole story', () => {
    // Proportions live in 0..1; one decimal would collapse distinct values.
    expect(formatValue(0.31)).toBe('0.31');
  });

  it('formats negatives, which deltaSOC and similar factors produce', () => {
    expect(formatValue(-580)).toBe('-580.0');
    expect(formatValue(-1500)).toBe('-1.5K');
  });
});

describe('tickValues', () => {
  it('spans the range end to end', () => {
    const ticks = tickValues(0, 100, 11);
    expect(ticks).toHaveLength(11);
    expect(ticks[0].value).toBe(0);
    expect(ticks[10].value).toBe(100);
  });

  it('marks every other tick major, so labels do not collide', () => {
    const ticks = tickValues(0, 100, 11);
    expect(ticks.filter((t) => t.isMajor)).toHaveLength(6);
  });
});

describe('metadata scale bounds', () => {
  it('leaves a range alone when no bound is declared', () => {
    expect(capRange({ min: -500, max: 5000 })).toEqual({ min: -500, max: 5000 });
    expect(capRange({ min: -500, max: 5000 }, {})).toEqual({ min: -500, max: 5000 });
  });

  it('uses a declared bound even when the data is well inside it', () => {
    // The reported case: Percent burned declares 0..100 and the site spans
    // 45..97.5. It is a percentage — its scale is 0..100 whatever this site
    // happens to cover, or two sites cannot be compared by eye.
    expect(capRange({ min: 45, max: 97.5 }, { min: 0, max: 100 }))
      .toEqual({ min: 0, max: 100 });
  });

  it('uses a declared bound when the data overshoots it', () => {
    expect(capRange({ min: -580, max: 4000 }, { min: 0, max: 1000 }))
      .toEqual({ min: 0, max: 1000 });
  });

  it('replaces only the end that is declared', () => {
    expect(capRange({ min: 45, max: 4000 }, { min: 0, max: null }))
      .toEqual({ min: 0, max: 4000 });
    expect(capRange({ min: 45, max: 4000 }, { min: null, max: 1000 }))
      .toEqual({ min: 45, max: 1000 });
  });

  it('keeps a signed factor signed', () => {
    // deltaSOC declares Target_min -10; the bound must not floor it at zero.
    expect(capRange({ min: -70, max: 70 }, { min: -10, max: 10 }))
      .toEqual({ min: -10, max: 10 });
  });

  it('refuses to collapse the scale', () => {
    // Bounds that cross over describe no scale at all.
    expect(capRange({ min: 500, max: 900 }, { min: 100, max: 0 }))
      .toEqual({ min: 500, max: 900 });
  });

  it('reports which ends are pinned', () => {
    expect(hasDeclaredMin({ min: 0, max: null })).toBe(true);
    expect(hasDeclaredMax({ min: 0, max: null })).toBe(false);
    expect(hasDeclaredMin(undefined)).toBe(false);
  });
});

describe('the site spread', () => {
  const c = (ref: number, cur: number) => ({ reference: { npp: ref }, current: { npp: cur } });

  it('spans the lowest and highest catchment values, across both scenarios', () => {
    expect(attributeSpread([c(10, 20), c(5, 60), c(30, 40)], 'npp')).toEqual({ min: 5, max: 60 });
  });

  it('ignores catchments with no value for the attribute', () => {
    const partial = [{ reference: {}, current: {} }, c(10, 20)];
    expect(attributeSpread(partial, 'npp')).toEqual({ min: 10, max: 20 });
  });

  it('is null when there is no spread to speak of', () => {
    expect(attributeSpread([], 'npp')).toBeNull();
    // Every catchment identical: a zero-width scale is not a scale.
    expect(attributeSpread([c(7, 7), c(7, 7)], 'npp')).toBeNull();
  });

  it('does not move when a target moves, which is the whole reason for it', () => {
    // The spread is taken from observations only. A target is not in it, so
    // editing one cannot change the axis.
    const catchments = [c(10, 20), c(5, 60)];
    expect(attributeSpread(catchments, 'npp')).toEqual({ min: 5, max: 60 });
  });
});
