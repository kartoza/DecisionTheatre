import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const mapView = readFileSync(join(src, 'components', 'MapView.tsx'), 'utf8');
const main = readFileSync(join(src, 'main.tsx'), 'utf8');

// Fragment shading cost scales with the square of the device pixel ratio, and up
// to twelve map instances are live in quad view. Neither map constructor passed
// pixelRatio, so each rendered at the display's native ratio.

describe('map render cost', () => {
  it('clamps the pixel ratio on every map instance', () => {
    const constructors = mapView.match(/new maplibregl\.Map\(\{/g) ?? [];
    const clamped = mapView.match(/pixelRatio: mapPixelRatio\(\)/g) ?? [];

    expect(constructors.length).toBeGreaterThan(0);
    expect(clamped.length).toBe(constructors.length);
  });

  it('keeps the existing fadeDuration choice', () => {
    // An existing, sensible performance setting; the clamp is added beside it,
    // not instead of it.
    expect(mapView).toMatch(/fadeDuration: 0/);
  });

  it('only ever lowers the ratio', () => {
    // Math.min against the real ratio: a 1x display must be untouched.
    expect(mapView).toMatch(/Math\.min\(actual, MAX_MAP_PIXEL_RATIO\)/);
  });
});

// 157 framer-motion call sites across 14 files, none consulting the media query.
describe('reduced motion', () => {
  it('is honoured globally rather than per call site', () => {
    expect(main).toMatch(/<MotionConfig reducedMotion="user">/);
  });

  it('wraps everything that animates', () => {
    // The tours animate too, so the provider has to sit outside them, not inside
    // App.
    const open = main.indexOf('<MotionConfig');
    const close = main.indexOf('</MotionConfig>');
    for (const component of ['<App />', '<TourGuide />', '<AfricaDemoTour />']) {
      const at = main.indexOf(component);
      expect(at).toBeGreaterThan(open);
      expect(at).toBeLessThan(close);
    }
  });
});
