import type * as maplibregl from 'maplibre-gl';
import type { VectorSourceSpecification } from '@maplibre/maplibre-gl-style-spec';
import { CHOROPLETH_VALUE_STATE_KEY } from './choroplethPaint';

/**
 * The vector-tile transport for the choropleth.
 *
 * The catchment geometry is already in the tile pipeline - `gpkg_to_mbtiles.sh`
 * tiles the multi-resolution HydroBASINS levels (`catchments_lev04/06/08/12`)
 * as one standalone tileset, each level in its own zoom band, so every zoom
 * from the tileset minimum up renders catchments from tiles: the coarse levels
 * cover the low and mid zooms and MapLibre overzooms lev12 past the tiled
 * maximum (see internal/server/server.go's handleCatchmentsTileJSON). Before
 * the bands existed the choropleth fetched megabytes of GeoJSON polygons on
 * every viewport change below the detail zoom, and paid for the parse and the
 * tessellation each time; tiles are fetched and tessellated once and reused
 * for every subsequent pan, zoom and attribute change.
 *
 * What tiles cannot carry is the value being rendered: there are dozens of
 * indicators across three scenarios, and baking them all into the tiles would
 * multiply their size at every zoom level. So the values are fetched separately
 * (`/api/catchment-values`, geometry-free, level-matched via its zoom
 * parameter) and joined onto the tiles with feature state, which MapLibre
 * applies to tiles as they load - including tiles loaded long after the state
 * was set. Colouring itself stays exactly what it was: a data-driven paint
 * expression, evaluated on the GPU.
 */

/** The layer name `gpkg_to_mbtiles.sh` gives full-detail catchment geometry. */
export const CATCHMENT_TILE_SOURCE_LAYER = 'catchments_lev12';

/** Matches every multi-resolution catchment layer in the tileset. */
// _hex matches --legacy's own low-zoom band (catchments_lev12_hex): a
// hexagon per catchment standing in for real boundaries below z9 (see
// generate_catchment_hexagons.py and handleCatchmentsTileJSON) — same id
// namespace as catchments_lev12, different geometry, so it needs to pass
// this same recognition check to be treated as a usable catchment band.
const CATCHMENT_LAYER_PATTERN = /^catchments_lev\d{2}(_hex)?$/;

/**
 * The tile attribute holding a catchment's HYBAS_ID, promoted to the feature id
 * so feature state can be keyed by it. MapLibre stringifies both sides of that
 * lookup, so an integer id here matches an integer-valued tile attribute
 * whether the tiles encoded it as a number or as a string - but not one encoded
 * with a decimal part ("1120000010.0"), which would never match.
 */
export const CATCHMENT_TILE_ID_PROPERTY = 'HYBAS_ID';

/** One catchment level's zoom band within the tileset. */
export interface CatchmentTileBand {
  sourceLayer: string;
  /** Lowest display zoom this band covers. */
  minzoom: number;
  /** Highest display zoom this band covers (the last band is open-ended). */
  maxzoom: number;
  /**
   * Split-tileset form only: this level's own tile URL templates and the
   * single zoom it is tiled at. A band carrying these gets its own MapLibre
   * source with minzoom = maxzoom = tilezoom, which is what makes MapLibre
   * overzoom the level's tiles across the whole display band instead of
   * requesting zooms that were never generated. Absent on the legacy
   * combined tileset, where every band shares one source.
   */
  tiles?: string[];
  tilezoom?: number;
}

/** The catchment vector layers found in the served tileset. */
export interface CatchmentTileset {
  /** Every catchment level band, sorted by minzoom. */
  bands: CatchmentTileBand[];
  /** Lowest zoom any band covers - below it, the GeoJSON fallback applies. */
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
 * Find the catchment zoom bands in a TileJSON document.
 *
 * Returns null - meaning "fall back to the GeoJSON path" - unless the tileset
 * declares the full-detail catchment layer *and* the zoom range it covers. The
 * zoom range is not optional on purpose: rendering a tile source below its
 * minimum zoom shows nothing at all, and guessing would silently blank the
 * choropleth across whatever range the guess got wrong. Coarser level bands
 * (lev04/06/08) are included when declared with their zoom ranges; a datapack
 * tiled before they existed simply yields a lev12-only tileset, and every
 * zoom below its band stays on the GeoJSON path exactly as before.
 */
export function resolveCatchmentTileset(tilejson: unknown): CatchmentTileset | null {
  if (!tilejson || typeof tilejson !== 'object') return null;
  const doc = tilejson as { vector_layers?: unknown; tiles?: unknown; tilesets?: unknown };

  // Split form: one standalone tileset per level, each tiled at a single
  // zoom (tilezoom) and overzoomed through its display band. Preferred over
  // the legacy vector_layers form when the server offers it.
  if (Array.isArray(doc.tilesets)) {
    const bands: CatchmentTileBand[] = [];
    for (const raw of doc.tilesets) {
      const t = raw as { sourceLayer?: unknown; tilezoom?: unknown; tiles?: unknown };
      if (typeof t?.sourceLayer !== 'string' || !CATCHMENT_LAYER_PATTERN.test(t.sourceLayer)) continue;
      if (typeof t.tilezoom !== 'number') continue;
      const bandTiles = Array.isArray(t.tiles)
        ? t.tiles.filter((u): u is string => typeof u === 'string')
        : [];
      if (bandTiles.length === 0) continue;
      bands.push({
        sourceLayer: t.sourceLayer,
        minzoom: t.tilezoom,
        maxzoom: t.tilezoom,
        tiles: bandTiles,
        tilezoom: t.tilezoom,
      });
    }
    if (!bands.some((b) => b.sourceLayer === CATCHMENT_TILE_SOURCE_LAYER)) return null;
    bands.sort((a, b) => a.minzoom - b.minzoom);
    // Each band's display range runs to the next band's start (bandForZoom
    // treats maxzoom + 1 as exclusive; the last band is open-ended anyway).
    for (let i = 0; i < bands.length - 1; i++) {
      bands[i].maxzoom = bands[i + 1].minzoom - 1;
    }
    return {
      bands,
      minzoom: bands[0].minzoom,
      maxzoom: Math.max(...bands.map((b) => b.tilezoom ?? b.maxzoom)),
      tiles: [],
    };
  }

  const tiles = Array.isArray(doc.tiles)
    ? doc.tiles.filter((t): t is string => typeof t === 'string')
    : [];
  if (tiles.length === 0) return null;

  if (!Array.isArray(doc.vector_layers)) return null;
  const bands: CatchmentTileBand[] = [];
  for (const raw of doc.vector_layers) {
    const layer = raw as TileJSONVectorLayer;
    if (typeof layer?.id !== 'string' || !CATCHMENT_LAYER_PATTERN.test(layer.id)) continue;
    if (typeof layer.minzoom !== 'number' || typeof layer.maxzoom !== 'number') {
      // A catchment layer with no usable zoom range: unusable if it is the
      // detail layer, ignorable otherwise.
      if (layer.id === CATCHMENT_TILE_SOURCE_LAYER) return null;
      continue;
    }
    bands.push({ sourceLayer: layer.id, minzoom: layer.minzoom, maxzoom: layer.maxzoom });
  }

  if (!bands.some((b) => b.sourceLayer === CATCHMENT_TILE_SOURCE_LAYER)) return null;
  bands.sort((a, b) => a.minzoom - b.minzoom);

  return {
    bands,
    minzoom: bands[0].minzoom,
    maxzoom: Math.max(...bands.map((b) => b.maxzoom)),
    tiles,
  };
}

/**
 * The band whose geometry the tiles carry at this zoom, or null when no band
 * covers it (below the tiled range, or in a gap between bands - either way
 * the GeoJSON fallback applies there). Past the last band's maxzoom the last
 * band keeps winning: that is the overzoom range, where MapLibre reuses its
 * deepest tiles rather than requesting more.
 */
export function bandForZoom(tileset: CatchmentTileset, zoom: number): CatchmentTileBand | null {
  const last = tileset.bands[tileset.bands.length - 1];
  if (zoom >= last.minzoom) return last;
  for (const band of tileset.bands) {
    // maxzoom + 1 exclusive: a display zoom of 5.9 renders z5 tiles, which
    // carry the band whose maxzoom is 5.
    if (zoom >= band.minzoom && zoom < band.maxzoom + 1) return band;
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
export function fetchCatchmentTileset(url = '/data/catchments-tiles.json'): Promise<CatchmentTileset | null> {
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
 * re-request it once per map instance. minzoom/maxzoom span the banded range:
 * no tile request below the lowest band, and past the highest band MapLibre
 * overzooms rather than requesting deeper tiles. Every band's layer promotes
 * HYBAS_ID so feature state can be keyed by it at any zoom.
 */
/**
 * The vector source specification for one split-form band, or null when the
 * band belongs to a legacy combined tileset (use catchmentTileSourceSpec).
 *
 * minzoom = maxzoom = tilezoom is the whole mechanism: the level is tiled at
 * exactly one zoom, and declaring that zoom as the source's maximum makes
 * MapLibre overzoom those tiles across the band's entire display range
 * instead of requesting zooms that were never generated.
 */
export function catchmentBandSourceSpec(band: CatchmentTileBand): VectorSourceSpecification | null {
  if (!band.tiles || band.tilezoom === undefined) return null;
  return {
    type: 'vector',
    tiles: band.tiles,
    minzoom: band.tilezoom,
    maxzoom: band.tilezoom,
    promoteId: { [band.sourceLayer]: CATCHMENT_TILE_ID_PROPERTY },
  };
}

export function catchmentTileSourceSpec(tileset: CatchmentTileset): VectorSourceSpecification {
  const promoteId: Record<string, string> = {};
  for (const band of tileset.bands) {
    promoteId[band.sourceLayer] = CATCHMENT_TILE_ID_PROPERTY;
  }
  return {
    type: 'vector',
    tiles: tileset.tiles,
    minzoom: tileset.minzoom,
    maxzoom: tileset.maxzoom,
    promoteId,
  };
}

/**
 * Which catchment ids currently carry a value, per map and source.
 *
 * Kept so that a change of attribute, scenario or zoom band can clear exactly
 * the ids it previously set, on the source layer it set them on. The obvious
 * alternative, `map.removeFeatureState({source, sourceLayer})`, is quadratic:
 * MapLibre marks the whole layer for deletion and then, on *each* subsequent
 * setFeatureState, walks every already-known feature to re-queue its deletion.
 * With tens of thousands of catchments in view that is hundreds of millions of
 * operations on the main thread - the exact cost this whole change exists to
 * remove.
 */
interface AppliedValues {
  /** scenario+attribute+band the ids were set for. */
  key: string;
  /** The source layer they were set on - clearing must target the same one. */
  sourceLayer: string;
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
 * `key` identifies what the values mean (scenario, attribute and zoom band).
 * When it changes, ids set for the previous key are nulled first - feature
 * state survives the switch otherwise, and a catchment that scrolled out of
 * view would keep the previous indicator's colour. When it does not change,
 * nothing is cleared: a catchment's value for a given attribute does not depend
 * on the viewport, so values accumulate as the user pans and re-panning over
 * ground already covered sets nothing new.
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
    // Cleared on the layer the ids were set on - after a zoom band switch that
    // is not the layer being set now.
    for (const id of previous.ids) {
      map.setFeatureState(
        { source: sourceId, sourceLayer: previous.sourceLayer, id },
        { [CHOROPLETH_VALUE_STATE_KEY]: null },
      );
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

  perSource.set(sourceId, { key, sourceLayer, ids: Array.from(applied) });
  return { set: count, cleared };
}

/**
 * Forget what was applied to a source, for when the source itself goes away
 * (feature state is stored on the source, so removing it discards the state).
 */
export function forgetCatchmentValues(map: maplibregl.Map, sourceId: string): void {
  appliedByMap.get(map)?.delete(sourceId);
}
