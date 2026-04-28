import type maplibregl from 'maplibre-gl';

type TileJSONResponse = {
  bounds?: unknown;
};

type CatchmentsBoundsResponse = {
  minX?: unknown;
  minY?: unknown;
  maxX?: unknown;
  maxY?: unknown;
};

export type BoundsTuple = [[number, number], [number, number]];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export async function fetchTileBounds(tileJsonUrl = '/data/tiles.json'): Promise<BoundsTuple | null> {
  try {
    const response = await fetch(tileJsonUrl);
    if (!response.ok) return null;

    const tileJson = await response.json() as TileJSONResponse;
    if (!Array.isArray(tileJson.bounds) || tileJson.bounds.length !== 4) {
      return null;
    }

    const [west, south, east, north] = tileJson.bounds;
    if (![west, south, east, north].every(isFiniteNumber)) {
      return null;
    }

    if (west >= east || south >= north) {
      return null;
    }

    return [[west, south], [east, north]];
  } catch {
    return null;
  }
}

export async function fetchCatchmentBounds(catchmentsBoundsUrl = '/api/catchments/bounds'): Promise<BoundsTuple | null> {
  try {
    const response = await fetch(catchmentsBoundsUrl);
    if (!response.ok) return null;

    const bounds = await response.json() as CatchmentsBoundsResponse;
    const west = bounds.minX;
    const south = bounds.minY;
    const east = bounds.maxX;
    const north = bounds.maxY;

    if (![west, south, east, north].every(isFiniteNumber)) {
      return null;
    }

    if (west >= east || south >= north) {
      return null;
    }

    return [[west, south], [east, north]];
  } catch {
    return null;
  }
}

// Prefer strict catchment coverage; fall back to tile bounds only when catchment bounds are unavailable.
export function combineCatchmentAndTileBounds(
  catchmentBounds: BoundsTuple | null,
  tileBounds: BoundsTuple | null,
): BoundsTuple | null {
  return catchmentBounds ?? tileBounds;
}

export function applyZoomOutClipToBounds(
  map: maplibregl.Map,
  bounds: maplibregl.LngLatBoundsLike,
  minZoomFloor?: number,
) {
  map.setMaxBounds(bounds);

  const camera = map.cameraForBounds(bounds, {
    padding: 0,
    bearing: 0,
    pitch: 0,
  });

  if (!camera || typeof camera.zoom !== 'number' || !Number.isFinite(camera.zoom)) {
    return;
  }

  const effectiveMinZoom = isFiniteNumber(minZoomFloor)
    ? Math.max(camera.zoom, minZoomFloor)
    : camera.zoom;

  map.setMinZoom(effectiveMinZoom);
  if (map.getZoom() < effectiveMinZoom) {
    map.setZoom(effectiveMinZoom);
  }
}