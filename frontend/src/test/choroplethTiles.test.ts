// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type * as maplibregl from 'maplibre-gl';
import {
  CATCHMENT_TILE_ID_PROPERTY,
  CATCHMENT_TILE_SOURCE_LAYER,
  applyCatchmentValues,
  bandForZoom,
  catchmentBandSourceSpec,
  catchmentTileSourceSpec,
  fetchCatchmentTileset,
  forgetCatchmentValues,
  resetCatchmentTilesetCache,
  resolveCatchmentTileset,
  type CatchmentTileset,
} from '../lib/choroplethTiles';
import { CHOROPLETH_VALUE_STATE_KEY } from '../lib/choroplethPaint';

const TILE_URLS = [
  'http://localhost:8080/tiles/catchments/{z}/{x}/{y}.pbf',
  'http://localhost:8081/tiles/catchments/{z}/{x}/{y}.pbf',
];

// The four bands scripts/gpkg_to_mbtiles.sh tiles (see
// datasources/mbtiles-config/layer-treatment.csv).
const MULTIRES_LAYERS = [
  { id: 'catchments_lev04', minzoom: 2, maxzoom: 5 },
  { id: 'catchments_lev06', minzoom: 6, maxzoom: 8 },
  { id: 'catchments_lev08', minzoom: 9, maxzoom: 10 },
  { id: CATCHMENT_TILE_SOURCE_LAYER, minzoom: 11, maxzoom: 12 },
];

function tilejson(vectorLayers: unknown, tiles: unknown = TILE_URLS) {
  return { tilejson: '2.2.0', name: 'catchments', tiles, vector_layers: vectorLayers };
}

describe('resolveCatchmentTileset', () => {
  it('finds every catchment band and the zoom range each covers', () => {
    const tileset = resolveCatchmentTileset(tilejson([
      { id: 'ne_10m_rivers', minzoom: 6, maxzoom: 15 },
      ...MULTIRES_LAYERS,
    ]));

    expect(tileset).toEqual({
      bands: [
        { sourceLayer: 'catchments_lev04', minzoom: 2, maxzoom: 5 },
        { sourceLayer: 'catchments_lev06', minzoom: 6, maxzoom: 8 },
        { sourceLayer: 'catchments_lev08', minzoom: 9, maxzoom: 10 },
        { sourceLayer: CATCHMENT_TILE_SOURCE_LAYER, minzoom: 11, maxzoom: 12 },
      ],
      minzoom: 2,
      maxzoom: 12,
      tiles: TILE_URLS,
    });
  });

  // A datapack tiled before the multi-resolution levels existed carries only
  // lev12; the tile path must engage across exactly its band, leaving the
  // zooms below to the GeoJSON path as before.
  it('accepts a lev12-only tileset', () => {
    const tileset = resolveCatchmentTileset(tilejson([
      { id: CATCHMENT_TILE_SOURCE_LAYER, minzoom: 8, maxzoom: 15 },
    ]));

    expect(tileset).toEqual({
      bands: [{ sourceLayer: CATCHMENT_TILE_SOURCE_LAYER, minzoom: 8, maxzoom: 15 }],
      minzoom: 8,
      maxzoom: 15,
      tiles: TILE_URLS,
    });
  });

  // A datapack built before catchments were tiled must keep working: the
  // choropleth stays on the GeoJSON path at every zoom rather than rendering
  // nothing.
  it('returns null when the tileset has no catchment layer', () => {
    expect(resolveCatchmentTileset(tilejson([{ id: 'ecoregions', minzoom: 2, maxzoom: 8 }]))).toBeNull();
  });

  // Guessing a missing zoom range would blank the choropleth across whatever
  // range the guess got wrong, which is far worse than not using tiles at all.
  it('refuses to guess a missing zoom range on the detail layer', () => {
    expect(resolveCatchmentTileset(tilejson([{ id: CATCHMENT_TILE_SOURCE_LAYER }]))).toBeNull();
    expect(resolveCatchmentTileset(tilejson([{ id: CATCHMENT_TILE_SOURCE_LAYER, minzoom: 8 }]))).toBeNull();
  });

  // A coarse band missing its zoom range is dropped, not fatal: the zooms it
  // would have covered fall back to the GeoJSON path, everything else tiles.
  it('ignores a coarse band with no zoom range', () => {
    const tileset = resolveCatchmentTileset(tilejson([
      { id: 'catchments_lev04' },
      { id: CATCHMENT_TILE_SOURCE_LAYER, minzoom: 11, maxzoom: 12 },
    ]));

    expect(tileset?.bands).toEqual([
      { sourceLayer: CATCHMENT_TILE_SOURCE_LAYER, minzoom: 11, maxzoom: 12 },
    ]);
  });

  it('returns null without tile URLs or without vector layers', () => {
    expect(resolveCatchmentTileset(tilejson(MULTIRES_LAYERS, []))).toBeNull();
    expect(resolveCatchmentTileset({ tiles: TILE_URLS })).toBeNull();
    expect(resolveCatchmentTileset(null)).toBeNull();
  });
});

// The split form: one standalone tileset per level, each tiled at a single
// zoom and overzoomed through its display band.
const SPLIT_TILESETS = [
  { name: 'catchments-lev04', sourceLayer: 'catchments_lev04', tilezoom: 2, tiles: ['http://localhost:8080/tiles/catchments-lev04/{z}/{x}/{y}.pbf'] },
  { name: 'catchments-lev06', sourceLayer: 'catchments_lev06', tilezoom: 6, tiles: ['http://localhost:8080/tiles/catchments-lev06/{z}/{x}/{y}.pbf'] },
  { name: 'catchments-lev08', sourceLayer: 'catchments_lev08', tilezoom: 9, tiles: ['http://localhost:8080/tiles/catchments-lev08/{z}/{x}/{y}.pbf'] },
  { name: 'catchments-lev12', sourceLayer: CATCHMENT_TILE_SOURCE_LAYER, tilezoom: 11, tiles: ['http://localhost:8080/tiles/catchments-lev12/{z}/{x}/{y}.pbf'] },
];

describe('resolveCatchmentTileset (split tilesets)', () => {
  it('derives each band’s display range from the next band’s tilezoom', () => {
    const tileset = resolveCatchmentTileset({ tilejson: '2.2.0', tilesets: SPLIT_TILESETS }) as CatchmentTileset;

    expect(tileset.bands.map((b) => [b.sourceLayer, b.minzoom, b.maxzoom, b.tilezoom])).toEqual([
      ['catchments_lev04', 2, 5, 2],
      ['catchments_lev06', 6, 8, 6],
      ['catchments_lev08', 9, 10, 9],
      [CATCHMENT_TILE_SOURCE_LAYER, 11, 11, 11],
    ]);
    // bandForZoom works identically on split bands, overzoom range included.
    expect(bandForZoom(tileset, 5.9)?.sourceLayer).toBe('catchments_lev04');
    expect(bandForZoom(tileset, 15)?.sourceLayer).toBe(CATCHMENT_TILE_SOURCE_LAYER);
  });

  it('refuses a split document without the detail level', () => {
    expect(resolveCatchmentTileset({ tilesets: SPLIT_TILESETS.slice(0, 3) })).toBeNull();
  });

  it('drops a level with no tile URLs rather than blanking the rest', () => {
    const broken = SPLIT_TILESETS.map((t) => (t.sourceLayer === 'catchments_lev06' ? { ...t, tiles: [] } : t));
    const tileset = resolveCatchmentTileset({ tilesets: broken }) as CatchmentTileset;
    expect(tileset.bands.map((b) => b.sourceLayer)).toEqual([
      'catchments_lev04', 'catchments_lev08', CATCHMENT_TILE_SOURCE_LAYER,
    ]);
  });
});

// --legacy's own two-band split (server.go's legacyCatchmentTilesets): a
// hexagon per catchment below z9 standing in for real boundaries nothing
// could render legibly at that density (see generate_catchment_hexagons.py),
// real lev12 detail from z9. Both carry the lev12 id namespace; only the
// detail band's sourceLayer is the literal CATCHMENT_TILE_SOURCE_LAYER.
const LEGACY_TILESETS = [
  { name: 'catchments-lev12-hex', sourceLayer: 'catchments_lev12_hex', tilezoom: 2, tiles: ['http://localhost:8080/tiles/catchments-lev12-hex/{z}/{x}/{y}.pbf'] },
  { name: 'catchments-lev12-full', sourceLayer: CATCHMENT_TILE_SOURCE_LAYER, tilezoom: 9, tiles: ['http://localhost:8080/tiles/catchments-lev12-full/{z}/{x}/{y}.pbf'] },
];

describe('resolveCatchmentTileset (--legacy hex + detail split)', () => {
  it('accepts the hex band alongside the detail band', () => {
    const tileset = resolveCatchmentTileset({ tilesets: LEGACY_TILESETS }) as CatchmentTileset;
    expect(tileset).not.toBeNull();
    expect(tileset.bands.map((b) => [b.sourceLayer, b.minzoom, b.maxzoom, b.tilezoom])).toEqual([
      ['catchments_lev12_hex', 2, 8, 2],
      [CATCHMENT_TILE_SOURCE_LAYER, 9, 9, 9],
    ]);
    expect(bandForZoom(tileset, 5)?.sourceLayer).toBe('catchments_lev12_hex');
    expect(bandForZoom(tileset, 10)?.sourceLayer).toBe(CATCHMENT_TILE_SOURCE_LAYER);
  });

  it('still works with only the detail band, if the hex tileset was never built', () => {
    const tileset = resolveCatchmentTileset({ tilesets: [LEGACY_TILESETS[1]] }) as CatchmentTileset;
    expect(tileset.bands.map((b) => b.sourceLayer)).toEqual([CATCHMENT_TILE_SOURCE_LAYER]);
  });
});

describe('catchmentBandSourceSpec', () => {
  it('pins the source to the single tiled zoom so MapLibre overzooms it', () => {
    const tileset = resolveCatchmentTileset({ tilesets: SPLIT_TILESETS }) as CatchmentTileset;
    const lev04 = tileset.bands[0];

    const spec = catchmentBandSourceSpec(lev04);
    expect(spec).toEqual({
      type: 'vector',
      tiles: lev04.tiles,
      minzoom: 2,
      maxzoom: 2,
      promoteId: { catchments_lev04: CATCHMENT_TILE_ID_PROPERTY },
    });
  });

  it('returns null for legacy combined-tileset bands', () => {
    const legacy = resolveCatchmentTileset(tilejson(MULTIRES_LAYERS)) as CatchmentTileset;
    expect(catchmentBandSourceSpec(legacy.bands[0])).toBeNull();
  });
});

describe('bandForZoom', () => {
  const tileset = resolveCatchmentTileset(tilejson(MULTIRES_LAYERS)) as CatchmentTileset;

  it('picks the band whose tiles carry geometry at that zoom', () => {
    expect(bandForZoom(tileset, 2)?.sourceLayer).toBe('catchments_lev04');
    // Display zoom 5.9 renders z5 tiles, which still carry lev04.
    expect(bandForZoom(tileset, 5.9)?.sourceLayer).toBe('catchments_lev04');
    expect(bandForZoom(tileset, 6)?.sourceLayer).toBe('catchments_lev06');
    expect(bandForZoom(tileset, 9.5)?.sourceLayer).toBe('catchments_lev08');
    expect(bandForZoom(tileset, 11)?.sourceLayer).toBe(CATCHMENT_TILE_SOURCE_LAYER);
  });

  // Past the deepest tiled zoom MapLibre overzooms the last band's tiles
  // rather than requesting more; the band therefore keeps winning.
  it('keeps the detail band through the overzoom range', () => {
    expect(bandForZoom(tileset, 15)?.sourceLayer).toBe(CATCHMENT_TILE_SOURCE_LAYER);
  });

  it('returns null below the tiled range', () => {
    expect(bandForZoom(tileset, 1.5)).toBeNull();
  });

  // A gap between bands means the tiles there carry no catchment geometry at
  // all; rendering a band into it would show nothing, so the GeoJSON fallback
  // must take that range.
  it('returns null in a gap between bands', () => {
    const gappy = resolveCatchmentTileset(tilejson([
      { id: 'catchments_lev04', minzoom: 2, maxzoom: 5 },
      { id: CATCHMENT_TILE_SOURCE_LAYER, minzoom: 11, maxzoom: 12 },
    ])) as CatchmentTileset;

    expect(bandForZoom(gappy, 8)).toBeNull();
  });
});

describe('fetchCatchmentTileset', () => {
  beforeEach(() => {
    resetCatchmentTilesetCache();
  });

  it('asks the server once however many map instances ask it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => tilejson(MULTIRES_LAYERS),
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all([fetchCatchmentTileset(), fetchCatchmentTileset(), fetchCatchmentTileset()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r?.minzoom === 2)).toBe(true);
    vi.unstubAllGlobals();
  });

  // A tile store that is mid-install answers with an error. That must mean
  // "use the GeoJSON path", never an unhandled rejection.
  it('resolves to null when the tileset cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unavailable')));
    await expect(fetchCatchmentTileset()).resolves.toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('catchmentTileSourceSpec', () => {
  it('promotes HYBAS_ID on every band so feature state can be keyed by it', () => {
    const spec = catchmentTileSourceSpec(
      resolveCatchmentTileset(tilejson(MULTIRES_LAYERS)) as CatchmentTileset,
    );

    expect(spec.type).toBe('vector');
    expect(spec.promoteId).toEqual({
      catchments_lev04: CATCHMENT_TILE_ID_PROPERTY,
      catchments_lev06: CATCHMENT_TILE_ID_PROPERTY,
      catchments_lev08: CATCHMENT_TILE_ID_PROPERTY,
      [CATCHMENT_TILE_SOURCE_LAYER]: CATCHMENT_TILE_ID_PROPERTY,
    });
    // Inlined tile URLs, not a TileJSON url: otherwise every map instance
    // re-fetches the document that has already been read once.
    expect(spec.tiles).toEqual(TILE_URLS);
    expect(spec.url).toBeUndefined();
    // Bounded to the zooms that actually contain catchments: no request below
    // the lowest band, overzoom (not deeper requests) past the highest.
    expect(spec.minzoom).toBe(2);
    expect(spec.maxzoom).toBe(12);
  });
});

interface FakeMap {
  map: maplibregl.Map;
  state: Map<string, Record<string, unknown>>;
  setCalls: number;
  removeFeatureState: ReturnType<typeof vi.fn>;
}

function fakeMap(sourceIds: string[] = ['choropleth-source-left']): FakeMap {
  const state = new Map<string, Record<string, unknown>>();
  const removeFeatureState = vi.fn();
  const fake = {
    state,
    setCalls: 0,
    removeFeatureState,
  } as unknown as FakeMap;

  const map = {
    style: {},
    getSource: (id: string) => (sourceIds.includes(id) ? { type: 'vector' } : undefined),
    setFeatureState: (target: { source: string; sourceLayer: string; id: number }, values: Record<string, unknown>) => {
      fake.setCalls += 1;
      state.set(`${target.source}/${target.sourceLayer}/${target.id}`, { ...state.get(`${target.source}/${target.sourceLayer}/${target.id}`), ...values });
    },
    removeFeatureState,
  } as unknown as maplibregl.Map;

  fake.map = map;
  fake.state = state;
  return fake;
}

const SOURCE = 'choropleth-source-left';

describe('applyCatchmentValues', () => {
  it('joins each value onto its catchment as feature state', () => {
    const f = fakeMap();

    const applied = applyCatchmentValues(f.map, SOURCE, CATCHMENT_TILE_SOURCE_LAYER, 'current|rain', [11, 22], [1.5, 2.5]);

    expect(applied).toEqual({ set: 2, cleared: 0 });
    expect(f.state.get(`${SOURCE}/${CATCHMENT_TILE_SOURCE_LAYER}/11`)).toEqual({ [CHOROPLETH_VALUE_STATE_KEY]: 1.5 });
    expect(f.state.get(`${SOURCE}/${CATCHMENT_TILE_SOURCE_LAYER}/22`)).toEqual({ [CHOROPLETH_VALUE_STATE_KEY]: 2.5 });
  });

  // A catchment's value for a given attribute does not depend on the viewport,
  // so panning must not throw away what is already joined - that is what makes
  // re-panning over covered ground cost nothing.
  it('accumulates across viewports while the attribute is unchanged', () => {
    const f = fakeMap();

    applyCatchmentValues(f.map, SOURCE, CATCHMENT_TILE_SOURCE_LAYER, 'current|rain', [11], [1]);
    const second = applyCatchmentValues(f.map, SOURCE, CATCHMENT_TILE_SOURCE_LAYER, 'current|rain', [22], [2]);

    expect(second.cleared).toBe(0);
    expect(f.state.get(`${SOURCE}/${CATCHMENT_TILE_SOURCE_LAYER}/11`)).toEqual({ [CHOROPLETH_VALUE_STATE_KEY]: 1 });
    expect(f.state.get(`${SOURCE}/${CATCHMENT_TILE_SOURCE_LAYER}/22`)).toEqual({ [CHOROPLETH_VALUE_STATE_KEY]: 2 });
  });

  // Feature state outlives the viewport it was set for, so a catchment left
  // holding the previous indicator's value would paint with it the moment it
  // scrolled back into view.
  it('clears the previous attribute’s values when the attribute changes', () => {
    const f = fakeMap();

    applyCatchmentValues(f.map, SOURCE, CATCHMENT_TILE_SOURCE_LAYER, 'current|rain', [11, 22], [1, 2]);
    const second = applyCatchmentValues(f.map, SOURCE, CATCHMENT_TILE_SOURCE_LAYER, 'current|runoff', [22], [9]);

    expect(second).toEqual({ set: 1, cleared: 2 });
    // 11 is not in the new viewport's values, so it must be left with no value
    // at all rather than the old attribute's.
    expect(f.state.get(`${SOURCE}/${CATCHMENT_TILE_SOURCE_LAYER}/11`)).toEqual({ [CHOROPLETH_VALUE_STATE_KEY]: null });
    expect(f.state.get(`${SOURCE}/${CATCHMENT_TILE_SOURCE_LAYER}/22`)).toEqual({ [CHOROPLETH_VALUE_STATE_KEY]: 9 });
  });

  // Crossing a zoom band boundary changes which source layer the ids live on.
  // The previous band's state must be cleared on the layer it was set on -
  // clearing on the new layer would leave lev06 basins painted with stale
  // values the moment the user zooms back out.
  it('clears the previous band’s values on the previous band’s layer', () => {
    const f = fakeMap();

    applyCatchmentValues(f.map, SOURCE, 'catchments_lev06', 'current|rain|catchments_lev06', [61], [6]);
    const second = applyCatchmentValues(f.map, SOURCE, CATCHMENT_TILE_SOURCE_LAYER, 'current|rain|catchments_lev12', [121], [12]);

    expect(second).toEqual({ set: 1, cleared: 1 });
    expect(f.state.get(`${SOURCE}/catchments_lev06/61`)).toEqual({ [CHOROPLETH_VALUE_STATE_KEY]: null });
    expect(f.state.get(`${SOURCE}/${CATCHMENT_TILE_SOURCE_LAYER}/121`)).toEqual({ [CHOROPLETH_VALUE_STATE_KEY]: 12 });
  });

  // map.removeFeatureState({source, sourceLayer}) marks the whole layer for
  // deletion, after which MapLibre walks every known feature on each subsequent
  // setFeatureState call - quadratic in the number of catchments in view, which
  // at the tiled minimum zoom is tens of thousands.
  it('never clears by removing the whole source layer', () => {
    const f = fakeMap();

    applyCatchmentValues(f.map, SOURCE, CATCHMENT_TILE_SOURCE_LAYER, 'current|rain', [11], [1]);
    applyCatchmentValues(f.map, SOURCE, CATCHMENT_TILE_SOURCE_LAYER, 'current|runoff', [11], [2]);

    expect(f.removeFeatureState).not.toHaveBeenCalled();
  });

  it('does nothing when the source is not on the map', () => {
    const f = fakeMap([]);

    expect(applyCatchmentValues(f.map, SOURCE, CATCHMENT_TILE_SOURCE_LAYER, 'current|rain', [11], [1]))
      .toEqual({ set: 0, cleared: 0 });
    expect(f.setCalls).toBe(0);
  });

  // Feature state is stored on the source, so once the source goes the join
  // goes with it; a stale record of what was applied would make the next
  // application skip the clearing it still owes.
  it('forgets what was applied once the source is removed', () => {
    const f = fakeMap();

    applyCatchmentValues(f.map, SOURCE, CATCHMENT_TILE_SOURCE_LAYER, 'current|rain', [11], [1]);
    forgetCatchmentValues(f.map, SOURCE);
    const after = applyCatchmentValues(f.map, SOURCE, CATCHMENT_TILE_SOURCE_LAYER, 'current|runoff', [11], [2]);

    expect(after.cleared).toBe(0);
  });
});
