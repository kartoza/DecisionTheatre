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
    expect(MAPVIEW).toContain('fetch(`/api/catchment/${catchIdStr}`)');
    expect(MAPVIEW).toContain('onIdentifyRef.current({ catchmentID: catchIdStr, leftLabel, rightLabel, rows });');
  });
});
