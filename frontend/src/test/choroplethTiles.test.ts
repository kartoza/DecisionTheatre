import { describe, it, expect, beforeEach, vi } from 'vitest';
import type maplibregl from 'maplibre-gl';
import {
  CATCHMENT_TILE_ID_PROPERTY,
  CATCHMENT_TILE_SOURCE_LAYER,
  applyCatchmentValues,
  catchmentTileSourceSpec,
  fetchCatchmentTileset,
  forgetCatchmentValues,
  resetCatchmentTilesetCache,
  resolveCatchmentTileset,
} from '../lib/choroplethTiles';
import { CHOROPLETH_VALUE_STATE_KEY } from '../lib/choroplethPaint';

const TILE_URLS = [
  'http://localhost:8080/tiles/africa/{z}/{x}/{y}.pbf',
  'http://localhost:8081/tiles/africa/{z}/{x}/{y}.pbf',
];

function tilejson(vectorLayers: unknown, tiles: unknown = TILE_URLS) {
  return { tilejson: '2.2.0', name: 'africa', tiles, vector_layers: vectorLayers };
}

describe('resolveCatchmentTileset', () => {
  it('finds the catchment layer and the zoom range it covers', () => {
    const tileset = resolveCatchmentTileset(tilejson([
      { id: 'ne_10m_rivers', minzoom: 6, maxzoom: 15 },
      { id: CATCHMENT_TILE_SOURCE_LAYER, minzoom: 8, maxzoom: 15 },
    ]));

    expect(tileset).toEqual({
      sourceLayer: CATCHMENT_TILE_SOURCE_LAYER,
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

  // Catchments are tiled from zoom 8 up. Guessing a missing zoom range would
  // blank the choropleth across the low-zoom range the grid-aggregated GeoJSON
  // path exists to serve, which is far worse than not using tiles at all.
  it('refuses to guess a missing zoom range', () => {
    expect(resolveCatchmentTileset(tilejson([{ id: CATCHMENT_TILE_SOURCE_LAYER }]))).toBeNull();
    expect(resolveCatchmentTileset(tilejson([{ id: CATCHMENT_TILE_SOURCE_LAYER, minzoom: 8 }]))).toBeNull();
  });

  it('returns null without tile URLs or without vector layers', () => {
    expect(resolveCatchmentTileset(tilejson([{ id: CATCHMENT_TILE_SOURCE_LAYER, minzoom: 8, maxzoom: 15 }], []))).toBeNull();
    expect(resolveCatchmentTileset({ tiles: TILE_URLS })).toBeNull();
    expect(resolveCatchmentTileset(null)).toBeNull();
  });
});

describe('fetchCatchmentTileset', () => {
  beforeEach(() => {
    resetCatchmentTilesetCache();
  });

  it('asks the server once however many map instances ask it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => tilejson([{ id: CATCHMENT_TILE_SOURCE_LAYER, minzoom: 8, maxzoom: 15 }]),
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all([fetchCatchmentTileset(), fetchCatchmentTileset(), fetchCatchmentTileset()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r?.minzoom === 8)).toBe(true);
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
  it('promotes HYBAS_ID to the feature id so feature state can be keyed by it', () => {
    const spec = catchmentTileSourceSpec({
      sourceLayer: CATCHMENT_TILE_SOURCE_LAYER,
      minzoom: 8,
      maxzoom: 15,
      tiles: TILE_URLS,
    });

    expect(spec.type).toBe('vector');
    expect(spec.promoteId).toEqual({ [CATCHMENT_TILE_SOURCE_LAYER]: CATCHMENT_TILE_ID_PROPERTY });
    // Inlined tile URLs, not a TileJSON url: otherwise every map instance
    // re-fetches the document that has already been read once.
    expect(spec.tiles).toEqual(TILE_URLS);
    expect(spec.url).toBeUndefined();
    // Bounded to the zooms that actually contain catchments, so no tile
    // request is made below the tiled range.
    expect(spec.minzoom).toBe(8);
    expect(spec.maxzoom).toBe(15);
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
