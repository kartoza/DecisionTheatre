// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reported: on the "Define Boundary" catchments-selection map, a click did
 * nothing below the real detail band's minzoom (11 on a default datapack, 9
 * under --legacy) -- the transparent `catchments-selectable-fill` layer
 * MapLibre queries on click simply isn't rendering anything there yet, so
 * `queryRenderedFeatures` always came back empty. A full rendering test of
 * the map would need a real MapLibre GL context (WebGL canvas, tile
 * fetches), which isn't practical here -- this pins the fix at the source
 * level instead, the same way addPaneIndicator.test.ts does for another
 * component that's awkward to mount in jsdom.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const SRC = readFileSync('src/components/SiteCreationMap.tsx', 'utf8');

describe('SiteCreationMap catchment selection at any zoom', () => {
  it('resolves the clicked catchment server-side when nothing is rendered there yet', () => {
    expect(SRC).toContain('const handleClick = async (e: maplibregl.MapMouseEvent) => {');
    expect(SRC).toContain('if (features.length === 0) {');
    expect(SRC).toContain('`/api/catchments/at-point?lng=${e.lngLat.lng}&lat=${e.lngLat.lat}`');
  });

  it('toggles an already-selected catchment off via the same server-resolved id', () => {
    expect(SRC).toContain('if (!prev.has(catchmentId as string)) return prev;');
    expect(SRC).toContain('next.delete(catchmentId as string);');
  });

  it('sizes the catchment layers\' minzoom off the real detail band instead of a hardcoded guess', () => {
    // The old hardcoded `minzoom: 8` asked MapLibre to render a source
    // below its own tiled range -- not an error, just silently blank,
    // since a split-tileset band's source has minzoom = maxzoom = tilezoom
    // (11 on a default datapack, 9 under --legacy; see choroplethTiles.ts).
    // The three layers themselves are added via addCatchmentLayerTriple
    // (see catchmentWideZoomBand.test.ts for that helper's own coverage),
    // which takes minzoom as a parameter rather than a literal.
    expect(SRC).toContain('const layerMinzoom = detailBand?.minzoom ?? 8;');
    expect(SRC).not.toMatch(/minzoom:\s*8,/);
    expect(SRC).toMatch(/addCatchmentLayerTriple\(\s*map,\s*\{[^}]*selectable: 'catchments-selectable-fill'[^}]*\},\s*sourceId,\s*sourceLayer,\s*layerMinzoom,/);
  });
});
