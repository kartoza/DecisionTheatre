/**
 * Regression guard: the identify results used to be built as raw DOM
 * (document.createElement, position:absolute popups reprojected on every
 * map move) directly inside MapView.tsx. That's now IdentifyPanel/
 * IdentifyDock in the right-hand dock -- this pins that the old
 * map-anchored-popup machinery doesn't come back.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const MAPVIEW = readFileSync('src/components/MapView.tsx', 'utf8');

describe('MapView identify cleanup', () => {
  it('no longer builds a popup DOM element for identify results', () => {
    expect(MAPVIEW).not.toContain('identifyOverlayRef');
    expect(MAPVIEW).not.toContain('identifyOverlayLngLatRef');
    expect(MAPVIEW).not.toContain('removeIdentifyOverlay');
    expect(MAPVIEW).not.toContain('updateIdentifyOverlayPosition');
  });

  it('reports the site-boundary click through a callback instead', () => {
    expect(MAPVIEW).toContain('onSiteIdentifyRef');
    expect(MAPVIEW).toMatch(/onSiteIdentifyRef\.current\?\.\(\{\s*leftLabel:\s*'Reference',\s*rightLabel:\s*'Current',\s*rows\s*\}\)/);
  });

  it('still fetches per-catchment data and reports it through onIdentify', () => {
    expect(MAPVIEW).toContain('onIdentifyRef.current({ catchmentID: catchIdStr, leftLabel, rightLabel, rows });');
  });

  // The identify click used to read a catchment id and its multi-resolution
  // level straight off whichever feature queryRenderedFeatures hit, which
  // meant a click at a coarse zoom resolved to a basin, not the lev12
  // catchment actually under the cursor. GOLDEN RULE: identification always
  // reads lev12, resolved server-side from the click's own coordinates for
  // every multi-resolution band (lev04/06/08/12), so the result can never
  // depend on which coarser band happens to be on screen.
  it('resolves the clicked point against lev12 regardless of the rendered multi-resolution band', () => {
    expect(MAPVIEW).not.toContain('const basinLevel');
    expect(MAPVIEW).toContain('const { lng, lat } = e.lngLat;');
    expect(MAPVIEW).toContain('/api/catchments/at-point?lng=${lng}&lat=${lat}');
    expect(MAPVIEW).toContain('fetch(`/api/catchment/${catchIdStr}`)');
  });

  // --legacy's hex band is the one deliberate exception: its cells already
  // carry their own representative catchment's real lev12 HYBAS_ID as a
  // tile property (see generate_catchment_hexagons.py), the same one the
  // choropleth's own feature-state join reads. A hex cell's shape is a
  // stylised stand-in, not the real catchment boundary, so the point-in-
  // polygon lookup above can miss real geometry that doesn't reach every
  // corner of the hex cell drawn over it (reported: clicking a hex cell did
  // nothing). Reading the id directly off the clicked feature is also
  // simply correct, not just a workaround: a hex cell should always
  // identify the catchment it represents.
  it('reads the hex band catchment id directly off the clicked feature instead of a point lookup', () => {
    expect(MAPVIEW).toContain('f.sourceLayer === `${CATCHMENT_TILE_SOURCE_LAYER}_hex`');
    expect(MAPVIEW).toContain('hexFeature?.properties?.[CATCHMENT_TILE_ID_PROPERTY]');
  });
});
