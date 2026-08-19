import type maplibregl from 'maplibre-gl';
import { CHOROPLETH_VALUE_STATE_KEY } from './choroplethPaint';

/**
 * The vector-tile transport for the choropleth.
 *
 * The catchment geometry is already in the tile pipeline - `gpkg_to_mbtiles.sh`
 * tiles `catchments_lev12` alongside the basemap layers - but the choropleth
 * was not using it: it fetched the same polygons as GeoJSON on every viewport
 * change, for every map instance, and paid for the parse and the tessellation
 * each time. Sourcing the geometry from tiles means MapLibre fetches and
 * tessellates each tile once and then reuses it for every subsequent pan, zoom
 * and attribute change.
 *
 * What tiles cannot carry is the value being rendered: there are dozens of
 * indicators across three scenarios, and baking them all into the tiles would
 * multiply their size at every zoom level. So the values are fetched separately
 * (`/api/catchment-values`, geometry-free) and joined onto the tiles with
 * feature state, which MapLibre applies to tiles as they load - including tiles
 * loaded long after the state was set. Colouring itself stays exactly what it
 * was: a data-driven paint expression, evaluated on the GPU.
 */

/** The layer name `gpkg_to_mbtiles.sh` gives catchment geometry in the tiles. */
export const CATCHMENT_TILE_SOURCE_LAYER = 'catchments_lev12';

/**
 * The tile attribute holding a catchment's HYBAS_ID, promoted to the feature id
 * so feature state can be keyed by it. MapLibre stringifies both sides of that
 * lookup, so an integer id here matches an integer-valued tile attribute
 * whether the tiles encoded it as a number or as a string - but not one encoded
 * with a decimal part ("1120000010.0"), which would never match.
 */
export const CATCHMENT_TILE_ID_PROPERTY = 'HYBAS_ID';

/** A catchment vector layer found in the served tileset. */
export interface CatchmentTileset {
  sourceLayer: string;
  /** Lowest zoom at which the tiles actually contain catchment geometry. */
  minzoom: number;
  /** Highest zoom generated; MapLibre overzooms beyond it. */
  maxzoom: number;
  /** Tile URL templates, taken from the TileJSON (several, for parallelism). */
  tiles: string[];
}

interface TileJSONVectorLayer {
  id?: unknown;
  minzoom?: unknown;
  maxzoom?: unknown;
}

/**
 * Find the catchment layer in a TileJSON document.
 *
 * Returns null - meaning "fall back to the GeoJSON path" - unless the tileset
 * declares the catchment layer *and* the zoom range it covers. The zoom range is
 * not optional on purpose: catchments are tiled from zoom 8 up, and rendering a
 * tile source below its minimum zoom shows nothing at all. Guessing the range
 * from the tileset-level minzoom would silently blank the choropleth across the
 * low-zoom range that the grid-aggregated GeoJSON path exists to serve.
 */
export function resolveCatchmentTileset(tilejson: unknown): CatchmentTileset | null {
  if (!tilejson || typeof tilejson !== 'object') return null;
  const doc = tilejson as { vector_layers?: unknown; tiles?: unknown };

  const tiles = Array.isArray(doc.tiles)
    ? doc.tiles.filter((t): t is string => typeof t === 'string')
    : [];
  if (tiles.length === 0) return null;

  if (!Array.isArray(doc.vector_layers)) return null;
  for (const raw of doc.vector_layers) {
    const layer = raw as TileJSONVectorLayer;
    if (layer?.id !== CATCHMENT_TILE_SOURCE_LAYER) continue;
    if (typeof layer.minzoom !== 'number' || typeof layer.maxzoom !== 'number') return null;
    return {
      sourceLayer: CATCHMENT_TILE_SOURCE_LAYER,
      minzoom: layer.minzoom,
      maxzoom: layer.maxzoom,
      tiles,
    };
  }
  return null;
}

// Module-level cache: every map instance asks the same question, and in grid
// view there are twelve of them. Mirrors the style cache in MapView.
let _tilesetPromise: Promise<CatchmentTileset | null> | null = null;

/**
 * Resolve (once per page load) whether the served tileset carries catchments.
 *
 * Never rejects: a datapack whose tiles predate catchment tiling, or a tile
 * store that is mid-install, simply means the GeoJSON path stays in use.
 */
export function fetchCatchmentTileset(url = '/data/tiles.json'): Promise<CatchmentTileset | null> {
  if (!_tilesetPromise) {
    _tilesetPromise = fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => resolveCatchmentTileset(doc))
      .catch(() => null);
  }
  return _tilesetPromise;
}

/** Test seam: forget the cached tileset lookup. */
export function resetCatchmentTilesetCache(): void {
  _tilesetPromise = null;
}

/**
 * The vector source specification for the choropleth's own catchment source.
 *
 * Its own source rather than the basemap style's: the satellite basemap
 * replaces the whole style, taking the basemap's vector source with it, and the
 * choropleth has to keep working underneath either one.
 *
 * `tiles` is inlined from the already-fetched TileJSON so MapLibre does not
 * re-request it once per map instance, and minzoom bounds tile requests to the
 * range that actually contains catchments.
 */
export function catchmentTileSourceSpec(tileset: CatchmentTileset): maplibregl.VectorSourceSpecification {
  return {
    type: 'vector',
    tiles: tileset.tiles,
    minzoom: tileset.minzoom,
    maxzoom: tileset.maxzoom,
    promoteId: { [tileset.sourceLayer]: CATCHMENT_TILE_ID_PROPERTY },
  };
}

/**
 * Which catchment ids currently carry a value, per map and source.
 *
 * Kept so that a change of attribute or scenario can clear exactly the ids it
 * previously set. The obvious alternative, `map.removeFeatureState({source,
 * sourceLayer})`, is quadratic: MapLibre marks the whole layer for deletion and
 * then, on *each* subsequent setFeatureState, walks every already-known feature
 * to re-queue its deletion. With tens of thousands of catchments in view that is
 * hundreds of millions of operations on the main thread - the exact cost this
 * whole change exists to remove.
 */
interface AppliedValues {
  /** scenario+attribute the ids were set for. */
  key: string;
  ids: number[];
}
const appliedByMap = new WeakMap<maplibregl.Map, Map<string, AppliedValues>>();

/** How much work applyCatchmentValues did, for the [perf] log. */
export interface ValueApplication {
  set: number;
  cleared: number;
}

/**
 * Join a viewport's attribute values onto the catchment tiles as feature state.
 *
 * `key` identifies what the values mean (scenario and attribute). When it
 * changes, ids set for the previous key are nulled first - feature state
 * survives the switch otherwise, and a catchment that scrolled out of view
 * would keep the previous indicator's colour. When it does not change, nothing
 * is cleared: a catchment's value for a given attribute does not depend on the
 * viewport, so values accumulate as the user pans and re-panning over ground
 * already covered sets nothing new.
 */
export function applyCatchmentValues(
  map: maplibregl.Map,
  sourceId: string,
  sourceLayer: string,
  key: string,
  ids: number[],
  values: number[],
): ValueApplication {
  if (!map.style || !map.getSource(sourceId)) return { set: 0, cleared: 0 };

  let perSource = appliedByMap.get(map);
  if (!perSource) {
    perSource = new Map<string, AppliedValues>();
    appliedByMap.set(map, perSource);
  }

  const previous = perSource.get(sourceId);
  let cleared = 0;
  if (previous && previous.key !== key) {
    // null rather than removeFeatureState: the paint expression coalesces a
    // null value to the domain minimum, which is what an unknown catchment
    // should look like, and it costs one flat pass instead of a quadratic one.
    for (const id of previous.ids) {
      map.setFeatureState({ source: sourceId, sourceLayer, id }, { [CHOROPLETH_VALUE_STATE_KEY]: null });
    }
    cleared = previous.ids.length;
  }

  const applied = new Set<number>(previous && previous.key === key ? previous.ids : []);
  const count = Math.min(ids.length, values.length);
  for (let i = 0; i < count; i++) {
    map.setFeatureState(
      { source: sourceId, sourceLayer, id: ids[i] },
      { [CHOROPLETH_VALUE_STATE_KEY]: values[i] },
    );
    applied.add(ids[i]);
  }

  perSource.set(sourceId, { key, ids: Array.from(applied) });
  return { set: count, cleared };
}

/**
 * Forget what was applied to a source, for when the source itself goes away
 * (feature state is stored on the source, so removing it discards the state).
 */
export function forgetCatchmentValues(map: maplibregl.Map, sourceId: string): void {
  appliedByMap.get(map)?.delete(sourceId);
}
