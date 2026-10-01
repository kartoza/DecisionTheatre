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
    expect(MAPVIEW).toContain('fetch(identifyUrl)');
    expect(MAPVIEW).toContain('onIdentifyRef.current({ catchmentID: catchIdStr, granularity, leftLabel, rightLabel, rows });');
  });

  // Below lev12 detail zoom a click lands on a coarse HydroBASINS basin
  // (see the multi-resolution tile bands in choroplethTiles.ts), not a
  // lev12 catchment -- a plain /api/catchment/{id} lookup would 404 against
  // the wrong id namespace and the frontend would silently swallow it,
  // which is exactly what "identify does nothing" looked like below the
  // detail zoom. The level must come from the clicked feature's own
  // sourceLayer, not from recomputing "which band is active" separately --
  // recomputing it can drift from what was actually clicked (a click near a
  // band boundary, or mid-zoom-animation) in a way that reading it off the
  // feature itself cannot.
  it('derives the basin level from the clicked feature, not from a recomputed zoom band', () => {
    expect(MAPVIEW).toContain('const sourceLayer = feature.sourceLayer;');
    expect(MAPVIEW).toMatch(/basinLevel[\s\S]{0,120}sourceLayer\.match\(\/\^catchments_lev\(\\d\+\)\$\/\)/);
    expect(MAPVIEW).toContain('`/api/catchment/${catchIdStr}?level=${basinLevel}`');
  });
});
