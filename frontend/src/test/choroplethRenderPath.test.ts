// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// MapView is far too entangled with WebGL to instantiate in a test, so these are
// source-level guards on the two invariants of the vector-tile render path that
// fail silently rather than loudly: a layer on a vector source without a
// source-layer renders nothing at all, and a viewport change that refetches
// geometry looks correct while undoing the entire point of the change.
//
// Same approach, and the same caveats, as renderCost.test.ts.

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const mapView = readFileSync(join(src, 'components', 'MapView.tsx'), 'utf8');

describe('choropleth vector-tile render path', () => {
  it('sources catchment geometry from the tile pipeline', () => {
    // Split tilesets install the band's own single-zoom source (that
    // per-source maxzoom drives overzoom); the legacy combined tileset
    // remains the fallback spec.
    expect(mapView).toMatch(/map\.addSource\(sourceId, bandSpec \?\? catchmentTileSourceSpec\(/);
  });

  it('gives every layer on the choropleth source its source-layer', () => {
    // Count the layers added onto the choropleth source, and require each to
    // spread the source-layer specification (empty for the GeoJSON fallback,
    // where the property must be absent rather than undefined).
    const addLayerCalls = mapView.match(/map\.addLayer\(\{[\s\S]*?\n {6}\}\);/g) ?? [];
    const onChoroplethSource = addLayerCalls.filter((call) => /source: sourceId,/.test(call));

    expect(onChoroplethSource.length).toBeGreaterThan(0);
    for (const call of onChoroplethSource) {
      expect(call).toMatch(/\.\.\.sourceLayerSpec,/);
    }
  });

  it('fetches values, not geometry, once the tiled zoom range is in use', () => {
    // The request options now carry an AbortSignal, so this no longer asserts
    // the call ends immediately after the URL — only that the URL is the
    // values endpoint and that a signal is threaded through it.
    expect(mapView).toMatch(/fetch\(`\/api\/catchment-values\?\$\{params\}`, \{ signal: requestSignal \}\)/);
    // The values request carries the band's canonical zoom: the tiles hold a
    // different catchment level per zoom band, and the server must serve the
    // level whose HYBAS_IDs match or the feature-state join paints nothing.
    const valuesFetch = mapView.slice(
      mapView.indexOf('async function fetchChoroplethValues('),
      mapView.indexOf('async function fetchChoroplethData('),
    );
    expect(valuesFetch).toMatch(/zoom: zoom\.toString\(\)/);
    expect(mapView).toMatch(/fetchChoroplethValues\(c\.leftScenario, c\.attribute, valueBounds, band\.minzoom/);
  });

  it('renders whichever band covers the zoom, from tiles', () => {
    // Which level the tiles carry at this zoom is bandForZoom's single
    // decision; the GeoJSON path survives only as the fallback for zooms no
    // band covers (a pre-multires datapack, or below the tiled range).
    expect(mapView).toMatch(/bandForZoom\(tileset, currentZoom\)/);
    expect(mapView).toMatch(/kind: 'geojson', data: leftDisplay/);
  });

  it('fetches the right scenario only when a compare map exists', () => {
    // With the swiper off there is nothing to paint the right scenario on,
    // and at low zoom its GeoJSON is the megabyte half of every viewport
    // change. The right-scenario extent stats it used to feed are
    // null-guarded by every consumer.
    expect(mapView).toMatch(/rightMap\s*\n?\s*\? fetchChoroplethValues\(c\.rightScenario/);
    expect(mapView).toMatch(/rightMap\s*\n?\s*\? fetchChoroplethData\(c\.rightScenario/);
  });

  it('highlights the identified catchment by fetching its own lev12 geometry, not by filtering whichever band is rendered', () => {
    // A split-tileset source below detail zoom carries only its own band's
    // source-layer (catchments_lev04/06/08) -- filtering a highlight line
    // against that source by id used to reference a source-layer with no
    // features in it and silently draw nothing. GOLDEN RULE: identify
    // always resolves lev12, so the highlight fetches that one catchment's
    // real geometry directly instead of depending on the active band.
    expect(mapView).toContain("fetch(`/api/catchments/geometry/${catchmentId}`)");
    expect(mapView).toContain('IDENTIFY_HIGHLIGHT_SOURCE');
  });

  it('adds the white catchment outline only in debug-overlay sessions', () => {
    // The outline is a diagnosis aid (band extents, overzoomed geometry);
    // outside dt serve-debug the choropleth must keep its soft, outline-free
    // look exactly as before.
    expect(mapView).toMatch(/if \(isDebugOverlayEnabledRef\.current\) \{[\s\S]{0,200}debugOutlineLayerId/);
  });

  it('adds the joined indicator value to each catchment\'s debug label, not just its level and id', () => {
    // The same number the fill colour is painted from (CHOROPLETH_VALUE_STATE_KEY
    // feature-state), so a label and its colour can be cross-checked by eye --
    // blank rather than "null"/"NaN" before the join completes or when a
    // catchment has no data for the current indicator.
    expect(mapView).toContain("['==', ['feature-state', CHOROPLETH_VALUE_STATE_KEY], null], ''");
    expect(mapView).toContain("'text-field': ['concat', `L${levelDigits} `, ['to-string', ['get', 'HYBAS_ID']], '\\n', debugValueExpression]");
  });

  it('paints when the style is ready, not when the basemap goes idle', () => {
    // 'idle' fires only after every basemap tile has streamed in, which held
    // the choropleth back seconds past its own data being ready. Style-ready
    // is the real precondition for addSource/addLayer: the overlay draws
    // first and the basemap fills in beneath it.
    expect(mapView).toMatch(/whenStyleReady\(map, \(\) => \{/);
    expect(mapView).toMatch(/whenStyleReady\(leftMap, \(\) => \{/);
    expect(mapView).not.toMatch(/once\('idle', apply\)/);
  });

  it('asks for coarse-band values with a stable full-domain bbox', () => {
    // Coarse-band answers are bbox-independent server-side; sending the raw
    // viewport floats instead would give every pan a unique URL and a 0% hit
    // rate on the request memo and the HTTP cache.
    expect(mapView).toMatch(/valueBounds = isDetailBand \? bounds : FULL_DOMAIN_VALUE_BOUNDS/);
  });

  it('tells two bands apart by tilezoom, not sourceLayer alone', () => {
    // Reported: --legacy's two hex tiers (coarse z2-z4, fine z5-z8)
    // deliberately share one sourceLayer (catchments_lev12_hex, via the
    // coarse tileset's own output_layer override) so CATCHMENT_LAYER_PATTERN/
    // isDetailBand only ever need to recognise the one name. This function's
    // own band-change check used to compare sourceLayer alone, so crossing
    // from coarse to fine read as "nothing changed": addSource never reran,
    // and the coarse tier's tile URLs kept being reused all the way to z9 -
    // the fine tier never visibly existed. tilezoom is unique per band by
    // construction (one real tiled zoom each), so keying on sourceLayer +
    // tilezoom together tells any two bands apart, shared sourceLayer or not.
    expect(mapView).toContain("const bandKey = `${source.band.sourceLayer}@${source.band.tilezoom ?? ''}`;");
    expect(mapView).toMatch(/installedBands\?\.\[sourceId\] !== bandKey/);
    expect(mapView).not.toMatch(/installedBands\?\.\[sourceId\] !== source\.band\.sourceLayer/);
  });

  it('repaints the choropleth after resize corrects the map container, not only once a compare map is also ready', () => {
    // Reported: a long pause on load, usually fixed by panning. style.load's
    // own repaint (asserted above) runs before resizeAndRefresh's
    // updateMapSizes/resize/jumpTo have corrected the container's real
    // layout, so its bounds-dependent fetch could be wrong until something
    // else repainted it - previously only a manual pan's own moveend, or a
    // compare map also finishing load, ever did. A single-map view (the
    // default) satisfies neither until the user moves the map themselves.
    // Both load handlers now repaint unconditionally right after their own
    // resizeAndRefresh, not gated on the other side's readiness.
    const leftLoadStart = mapView.indexOf("leftMap.on('load', () => {");
    const leftLoad = mapView.slice(leftLoadStart, leftLoadStart + 1800);
    const leftResizeAt = leftLoad.indexOf('resizeAndRefresh(leftMap);');
    const leftIfAt = leftLoad.indexOf('if (mapsReady.current.right)');
    const leftApplyAt = leftLoad.indexOf('applyColorsRef.current();');
    expect(leftResizeAt).toBeGreaterThan(-1);
    expect(leftIfAt).toBeGreaterThan(leftResizeAt);
    // An applyColorsRef.current() call between the resize and the
    // compare-map gate - unconditional, not inside the if block.
    expect(leftApplyAt).toBeGreaterThan(leftResizeAt);
    expect(leftApplyAt).toBeLessThan(leftIfAt);

    const rightLoadStart = mapView.indexOf("rightMap.on('load', () => {");
    const rightLoad = mapView.slice(rightLoadStart, rightLoadStart + 1400);
    const rightResizeAt = rightLoad.indexOf('resizeAndRefresh(rightMap);');
    const rightIfAt = rightLoad.indexOf('if (mapsReady.current.left)');
    const rightApplyAt = rightLoad.indexOf('applyColorsRef.current();');
    expect(rightResizeAt).toBeGreaterThan(-1);
    expect(rightIfAt).toBeGreaterThan(rightResizeAt);
    expect(rightApplyAt).toBeGreaterThan(rightResizeAt);
    expect(rightApplyAt).toBeLessThan(rightIfAt);
  });
});
