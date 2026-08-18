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
    expect(mapView).toMatch(/map\.addSource\(sourceId, catchmentTileSourceSpec\(/);
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
    expect(mapView).toMatch(/fetch\(`\/api\/catchment-values\?\$\{params\}`\)/);
    // The values request carries no zoom: the server's detailed-vs-aggregated
    // choice does not apply when geometry comes from tiles.
    const valuesFetch = mapView.slice(
      mapView.indexOf('async function fetchChoroplethValues('),
      mapView.indexOf('async function fetchChoroplethData('),
    );
    expect(valuesFetch).not.toMatch(/zoom:/);
  });

  it('keeps the GeoJSON path for the zoom range the tiles do not cover', () => {
    // Catchments are tiled from zoom 8 up; below that the backend serves
    // grid-aggregated cells, which have no tiled equivalent.
    expect(mapView).toMatch(/currentZoom >= tileset\.minzoom/);
    expect(mapView).toMatch(/kind: 'geojson', data: leftDisplay/);
  });
});
