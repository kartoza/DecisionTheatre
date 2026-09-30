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
});
