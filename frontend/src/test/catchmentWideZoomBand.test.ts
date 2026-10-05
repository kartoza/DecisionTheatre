// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reported: real lev12 catchments on the "Define Boundary" map only became
 * visible/clickable from z11 (the detail tileset's own tilezoom), which
 * still required zooming in uncomfortably far before any candidate was on
 * screen. A vector tile source can be overzoomed past its own tilezoom
 * (MapLibre reuses the deepest tile it has) but never *underzoomed* below
 * it -- there is no tile data to show, so nothing renders, full stop. The
 * only way to show real boundaries earlier is a second tileset actually
 * tiled at a lower zoom.
 *
 * `catchments-lev12-full` already exists on disk (see
 * datasources/mbtiles-config/layer-treatment.csv's catchments_lev12_full
 * row -- same lev12 geometry as the detail tileset, tiled a second time at
 * z9) and is already servable via the existing generic
 * /tiles/{name}/{z}/{x}/{y}.pbf route (server.go's handleTileRequest), so
 * this needed no new TileJSON endpoint and no mbtiles rebuild: just a
 * second MapLibre source/layer set on this page, active only below the
 * detail band's own minzoom.
 *
 * Deliberately NOT touched: the shared /data/catchments-tiles.json endpoint
 * and catchmentLevelTilesets in server.go, which the main map's choropleth
 * also reads -- its own z9-z10 window intentionally shows coarser lev08
 * basin aggregates there instead of individual lev12 catchments, for
 * legibility/performance reasons unrelated to this page. Wiring the wide
 * band into that shared document would have changed the main map's
 * behaviour too; a second, independent source on this page only does not.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const SRC = readFileSync('src/components/SiteCreationMap.tsx', 'utf8');

describe('SiteCreationMap wide (z9) catchment band', () => {
  it('points the wide band at the already-built catchments-lev12-full tileset via the existing generic tile route', () => {
    expect(SRC).toContain("const CATCHMENTS_WIDE_TILESET_NAME = 'catchments-lev12-full';");
    expect(SRC).toContain('const CATCHMENTS_WIDE_TILEZOOM = 9;');
    expect(SRC).toContain('`${window.location.origin}/tiles/${CATCHMENTS_WIDE_TILESET_NAME}/{z}/{x}/{y}.pbf`');
    // No new TileJSON endpoint -- this is the only place the wide tileset
    // name is referenced, a plain vector source built client-side.
    expect(SRC).not.toMatch(/catchments-boundary-tiles\.json/);
  });

  it('only adds the wide band when the detail band actually leaves a gap below it', () => {
    // Under --legacy the resolved detail band already *is*
    // catchments-lev12-full (both tiled at z9), so layerMinzoom would equal
    // CATCHMENTS_WIDE_TILEZOOM there -- adding a second copy of the same
    // tiles would be redundant, not wrong, but still unwanted.
    expect(SRC).toContain('if (layerMinzoom > CATCHMENTS_WIDE_TILEZOOM) {');
  });

  it('hands the wide band off to the detail band at exactly the detail band\'s own minzoom', () => {
    // maxzoom here is the *style* property passed through to
    // addCatchmentLayerTriple, not the source's -- the two bands must never
    // both render the same catchment at the same zoom.
    expect(SRC).toMatch(/CATCHMENTS_WIDE_TILEZOOM,\s*\n\s*layerMinzoom,\s*\n\s*isGoogleBasemapRef\.current,/);
  });

  it('gives the wide band its own click-detection layer and queries it alongside the detail one', () => {
    expect(SRC).toContain("selectable: 'catchments-selectable-fill-wide'");
    expect(SRC).toContain("['catchments-selectable-fill', 'catchments-selectable-fill-wide']");
    // queryRenderedFeatures throws for a layer id the style doesn't have --
    // the wide layer only exists when the gap above was non-empty, so the
    // query list must be filtered to layers actually present, not assumed.
    expect(SRC).toContain(".filter((id) => map.getLayer(id));");
  });

  it('exempts the wide click-detection layer from both satellite-basemap fill-hiding passes', () => {
    // Same reasoning as the detail layer already had: it's invisible by
    // design (opacity 0) and exists purely so click handlers can query it --
    // the generic "hide every fill layer under satellite" sweep would
    // otherwise silently break catchment selection in that zoom band too.
    expect(SRC).toContain("layer.id === 'catchments-selectable-fill' || layer.id === 'catchments-selectable-fill-wide'");
    expect(SRC).toContain("new Set(['catchments-selectable-fill', 'catchments-selectable-fill-wide', 'site-fill']);");
  });
});
