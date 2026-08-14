import { useEffect, useRef, useCallback, useState } from 'react';
import { Box, IconButton, Tooltip, Icon, VStack, Button, Flex, Text } from '@chakra-ui/react';
import { FiSliders, FiMap, FiInfo, FiBox, FiTarget, FiPlus, FiMinus, FiColumns, FiTrash2, FiGlobe } from 'react-icons/fi';
import maplibregl from 'maplibre-gl';
import { bbox as turfBbox, featureCollection, union, difference, intersect, area as turfArea, simplify as turfSimplify } from '@turf/turf';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ComparisonState, Scenario, IdentifyResult, MapExtent, MapStatistics, ZoneStats, BoundingBox, DomainRange, ColorScaleMode, ColorScaleType, SiteIndicators } from '../types';
import { SCENARIOS } from '../types';
import { registerMap, unregisterMap } from '../hooks/useMapSync';
import { getSite, getSiteCatchments, getSiteAOIFractions, useAttributeColors, useAttributeDetails, loadLocalSites, saveLocalSites, clearSiteWhiskerCache } from '../hooks/useApi';
import { getAppRuntime } from '../types/runtime';
import { colors } from '../styles/colors';
import { applyZoomOutClipToBounds, fetchCatchmentBounds, fetchTileBounds } from '../lib/mapBounds';

interface MapViewProps {
  comparison: ComparisonState;
  onOpenSettings: () => void;
  onIdentify?: (result: IdentifyResult) => void;
  identifyResult?: IdentifyResult;
  onMapExtentChange?: (extent: MapExtent) => void;
  onStatisticsChange?: (stats: MapStatistics) => void;
  isPanelOpen?: boolean;
  isQuad?: boolean;
  siteId?: string | null;
  siteBounds?: BoundingBox | null;
  isBoundaryEditMode?: boolean;
  siteGeometry?: GeoJSON.Geometry | null;
  onBoundaryUpdate?: (geometry: GeoJSON.Geometry, thumbnail?: string | null) => void;
  isSwiperEnabled?: boolean;
  onSwiperEnabledChange?: (enabled: boolean) => void;
  colorScaleMode: ColorScaleMode;
  colorScaleType: ColorScaleType;
  // Slider position synchronization
  swiperPosition?: number;
  onSwiperPositionChange?: (position: number) => void;
  is3DMode?: boolean;
  on3DModeChange?: (enabled: boolean) => void;
  /** Increment to force a choropleth refresh (e.g. after indicator save). */
  refreshKey?: number;
  /** Called once when both map instances have finished loading. */
  onReady?: () => void;
  siteIndicators?: SiteIndicators | null;
}

// Module-level style cache: fetch style.json exactly once across all MapView instances.
// In quad view this cuts 8 identical HTTP requests down to 1.
// _cachedStyle holds the resolved object so staggered panes can use it synchronously.
let _cachedStyle: maplibregl.StyleSpecification | null = null;
let _stylePromise: Promise<maplibregl.StyleSpecification> | null = null;
function warmStyleCache(url: string): void {
  if (_stylePromise) return;
  _stylePromise = fetch(url)
    .then(r => {
      if (!r.ok) throw new Error(`style.json: ${r.status} ${r.statusText}`);
      return r.json() as Promise<maplibregl.StyleSpecification>;
    })
    .then(s => { _cachedStyle = s; return s; })
    .catch(err => {
      // Reset so the next mount can retry (e.g. after backend starts up).
      _stylePromise = null;
      throw err;
    });
}
function getStyleForMap(url: string): string | maplibregl.StyleSpecification {
  // If the resolved style is already in memory (i.e. a prior pane already fetched it),
  // pass the object directly so MapLibre skips the HTTP request entirely.
  return _cachedStyle ?? url;
}

// Google Maps hybrid satellite raster style (no API key required for tile access)
const GOOGLE_BASEMAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    google: {
      type: 'raster',
      tiles: ['https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'],
      tileSize: 256,
      attribution: '\u00a9 Google Maps',
      maxzoom: 21,
    },
  },
  layers: [{ id: 'google-tiles', type: 'raster', source: 'google' }],
};

// Layer IDs for choropleth
const CHOROPLETH_LAYER_LEFT = 'choropleth-left';
const CHOROPLETH_LAYER_RIGHT = 'choropleth-right';
const CHOROPLETH_3D_LEFT = 'choropleth-left-3d';
const CHOROPLETH_3D_RIGHT = 'choropleth-right-3d';

// Layer IDs for identify highlight (neon glow effect)
const IDENTIFY_HIGHLIGHT_GLOW = 'identify-highlight-glow';
const IDENTIFY_HIGHLIGHT_LINE = 'identify-highlight-line';

// Prism colour gradient for data visualization
// Spectrum: violet -> indigo -> blue -> cyan -> green -> yellow -> orange -> red
const PRISM_STOPS: [number, string][] = [
  [0, '#6a0dad'],       // violet
  [0.143, '#4b0082'],   // indigo
  [0.286, '#0074d9'],   // blue
  [0.429, '#00bcd4'],   // cyan
  [0.571, '#2ecc40'],   // green
  [0.714, '#ffdc00'],   // yellow
  [0.857, '#ff851b'],   // orange
  [1, '#e8003f'],       // red
];

// Steepness (k) of the logistic curve used by the 'logistic' color scale type.
// Higher values sharpen the transition around the domain midpoint.
const LOGISTIC_STEEPNESS = 10;

// Strength (C) of the log1p curve used by the 'logarithmic' color scale type.
// Higher values exaggerate contrast among low values at the expense of high ones.
const LOGARITHMIC_STRENGTH = 9;

// CSS gradient for legend
export const PRISM_CSS_GRADIENT =
  `linear-gradient(to right, ${PRISM_STOPS.map(([, c]) => c).join(', ')})`;

// The property in the vector tiles that identifies each catchment.
const CATCHMENT_ID_PROP = 'HYBAS_ID';

// Minimum zoom level at which catchment choropleth layers are displayed.
// Below the backend's DetailZoomThreshold (internal/geodata/gpkg_store.go),
// requests get a grid-aggregated choropleth instead of per-catchment geometry,
// so the full continent can be shown even at low zoom without a feature-count
// blowup - the actual zoom value is always forwarded, so the crossover is
// controlled entirely on the backend.
const MIN_CATCHMENT_ZOOM = 3;

// Maximum extrusion height in metres for 3D mode
const MAX_EXTRUSION_HEIGHT = 50000;

// Choropleth fill-opacity depends on which basemap is showing beneath it:
// the busier Google satellite imagery needs a touch of transparency to read
// as an overlay, while the flat vector basemap can take full opacity.
const CHOROPLETH_FILL_OPACITY_SATELLITE = 0.80;
const CHOROPLETH_FILL_OPACITY_DEFAULT = 1;
const CHOROPLETH_OUTLINE_COLOR = 'rgba(255, 255, 255, 0.005)';
const CHOROPLETH_EDGE_BLEND_WIDTH = 2.4;
const CHOROPLETH_EDGE_BLEND_BLUR = 3.4;
const CHOROPLETH_EDGE_BLEND_OPACITY = 0.12;
const CATCHMENTS_OUTLINES_LAYER_ID = 'Catchments Outlines';
const CATCHMENTS_OUTLINES_SOFT_OPACITY = 0.03;
const MIN_CATCHMENT_OVERLAP_FRACTION = 0.2;
const catchmentsOutlineOpacityRef = new WeakMap<maplibregl.Map, unknown>();

function isNAValue(value: unknown): boolean {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'n/a' || normalized === 'na' || normalized === 'nan';
  }
  if (typeof value === 'number') {
    return Number.isNaN(value);
  }
  return false;
}

function formatIdentifyValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toFixed(2);
  }
  if (typeof value === 'string') {
    return value;
  }
  return '-';
}

function getNumericIdentifyValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getComparisonTrend(leftValue: number | null, rightValue: number | null): 'up' | 'down' | 'neutral' {
  if (leftValue === null || rightValue === null) return 'neutral';
  const threshold = 0.05; // 5% threshold to match indicator trend behavior
  const change = (rightValue - leftValue) / Math.abs(leftValue || 1);
  if (change > threshold) return 'up';
  if (change < -threshold) return 'down';
  return 'neutral';
}

type PolygonalGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;

function isPolygonalGeometry(geometry: GeoJSON.Geometry | null | undefined): geometry is PolygonalGeometry {
  return Boolean(geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon'));
}

function geometryToPolygonFeature(
  geometry: GeoJSON.Geometry | null | undefined,
): GeoJSON.Feature<PolygonalGeometry> | null {
  if (!isPolygonalGeometry(geometry)) {
    return null;
  }

  return {
    type: 'Feature',
    properties: {},
    geometry,
  };
}

function stripInteriorRings(geometry: GeoJSON.Geometry): GeoJSON.Geometry {
  if (geometry.type === 'Polygon') {
    const outerRing = geometry.coordinates[0] ? [geometry.coordinates[0]] : [];
    return { type: 'Polygon', coordinates: outerRing };
  }

  if (geometry.type === 'MultiPolygon') {
    const cleaned = geometry.coordinates.map((polygon) => (polygon[0] ? [polygon[0]] : []));
    return { type: 'MultiPolygon', coordinates: cleaned };
  }

  return geometry;
}

function normalizeBoundaryGeometry(geometry: GeoJSON.Geometry): GeoJSON.Geometry {
  const stripped = stripInteriorRings(geometry);

  if (stripped.type === 'MultiPolygon') {
    let largestRing: number[][] | null = null;
    let largestArea = -Infinity;

    for (const polygon of stripped.coordinates) {
      const ring = polygon[0];
      if (!ring || ring.length < 3) continue;
      const candidate = { type: 'Polygon', coordinates: [ring] } as GeoJSON.Polygon;
      const area = turfArea(candidate as GeoJSON.Geometry);
      if (area > largestArea) {
        largestArea = area;
        largestRing = ring;
      }
    }

    if (largestRing) {
      return { type: 'Polygon', coordinates: [largestRing] };
    }
  }

  return stripped;
}

function padBoundsForFit(bounds: BoundingBox): [[number, number], [number, number]] {
  const dx = (bounds.maxX - bounds.minX) * 0.1;
  const dy = (bounds.maxY - bounds.minY) * 0.1;
  return [
    [bounds.minX - dx, bounds.minY - dy],
    [bounds.maxX + dx, bounds.maxY + dy],
  ];
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = hex.trim().replace('#', '');
  if (normalized.length === 3) {
    const r = parseInt(normalized[0] + normalized[0], 16);
    const g = parseInt(normalized[1] + normalized[1], 16);
    const b = parseInt(normalized[2] + normalized[2], 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : { r, g, b };
  }
  if (normalized.length === 6) {
    const r = parseInt(normalized.slice(0, 2), 16);
    const g = parseInt(normalized.slice(2, 4), 16);
    const b = parseInt(normalized.slice(4, 6), 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : { r, g, b };
  }
  return null;
}

// Debounce delay for fetching choropleth data on map move (ms)
const FETCH_DEBOUNCE_MS = 300;

// Extra margin around the site boundary used to include nearby catchments
const BOUNDARY_NEARBY_PADDING_RATIO = 0.15;

interface ChoroplethData {
  type: string;
  features: Array<{
    type: string;
    id: number;
    // null for valuesOnly (stats) fetches - see QueryCatchmentValues in gpkg_store.go.
    geometry: object | null;
    properties: {
      // Absent on grid-aggregated features (continent-scale zoom, see
      // DetailZoomThreshold in gpkg_store.go), which represent a cell
      // spanning many catchments rather than a single one.
      HYBAS_ID?: number;
      [key: string]: number | boolean | undefined;
    };
  }>;
  // Domain min/max values for consistent color scaling across scenarios
  domain_min: number;
  domain_max: number;
}

/**
 * Compute statistics (min, max, mean) for the visible zone features.
 */
function computeZoneStats(data: ChoroplethData, attribute: string): ZoneStats | null {
  if (!data.features || data.features.length === 0) return null;

  const values: number[] = [];
  for (const feature of data.features) {
    const val = feature.properties?.[attribute];
    if (typeof val === 'number' && !isNaN(val)) {
      values.push(val);
    }
  }

  if (values.length === 0) return null;

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;

  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }

  return {
    min,
    max,
    mean: sum / values.length,
    count: values.length,
  };
}

function simplifyBoundaryForComputation(geometry: GeoJSON.Geometry): GeoJSON.Geometry {
  try {
    const feat: GeoJSON.Feature = { type: 'Feature', properties: {}, geometry };
    return turfSimplify(feat, { tolerance: 0.001, highQuality: false }).geometry;
  } catch {
    return geometry;
  }
}

/**
 * Fast AOI-weighted zone stats using pre-computed per-catchment AOI fractions.
 * Avoids polygon intersection entirely — O(n) dictionary lookup instead of
 * O(n × polygon_complexity) turf.intersect calls that block the main thread.
 *
 * fractions: Map<catchmentId → { aoiFraction, areaKm2 }> from getSiteAOIFractions.
 */
function computeAOIWeightedZoneStatsFromFractions(
  data: ChoroplethData,
  attribute: string,
  fractions: Map<string, { aoiFraction: number; areaKm2: number }>,
): ZoneStats | null {
  if (!data.features || data.features.length === 0 || fractions.size === 0) return null;

  let min = Infinity;
  let max = -Infinity;
  let totalValidArea = 0;
  let weightedSum = 0;
  let count = 0;

  for (const feature of data.features) {
    const metricValue = feature.properties?.[attribute];
    if (typeof metricValue !== 'number' || Number.isNaN(metricValue)) continue;

    const featureId = String(feature.properties?.HYBAS_ID ?? '');
    const f = fractions.get(featureId);
    if (!f) continue;

    const frac = Math.max(0, Math.min(1, f.aoiFraction ?? 1));
    const validArea = f.areaKm2 * frac;
    if (validArea <= 0) continue;

    if (metricValue < min) min = metricValue;
    if (metricValue > max) max = metricValue;

    totalValidArea += validArea;
    weightedSum += metricValue * validArea;
    count += 1;
  }

  if (count === 0 || totalValidArea <= 0 || !Number.isFinite(weightedSum)) return null;
  return { min, max, mean: weightedSum / totalValidArea, count };
}

/**
 * Compute AOI-weighted statistics via polygon intersection.
 * Only used as a fallback when pre-computed fractions are unavailable.
 * Avoid calling this with more than ~50 features — each iteration runs
 * a synchronous turf.intersect that blocks the JS main thread.
 */
function computeAOIWeightedZoneStats(
  data: ChoroplethData,
  attribute: string,
  boundaryGeometry: GeoJSON.Geometry,
): ZoneStats | null {
  if (!data.features || data.features.length === 0) return null;

  const boundaryFeature = geometryToPolygonFeature(simplifyBoundaryForComputation(boundaryGeometry));
  if (!boundaryFeature) return null;

  let min = Infinity;
  let max = -Infinity;
  let totalValidArea = 0;
  let weightedSum = 0;
  let count = 0;

  for (const feature of data.features) {
    const metricValue = feature.properties?.[attribute];
    if (typeof metricValue !== 'number' || Number.isNaN(metricValue)) continue;

    const catchmentGeometry = feature.geometry as GeoJSON.Geometry | null;
    const catchmentFeature = geometryToPolygonFeature(catchmentGeometry);
    if (!catchmentFeature) continue;

    let catchmentArea = 0;
    let overlapArea = 0;
    try {
      catchmentArea = turfArea(catchmentFeature.geometry);
      if (catchmentArea <= 0) continue;

      const overlap = intersect(featureCollection([catchmentFeature, boundaryFeature]));
      if (!overlap?.geometry) continue;
      overlapArea = turfArea(overlap.geometry);
      if (overlapArea <= 0) continue;
    } catch {
      continue;
    }

    const frac = Math.max(0, Math.min(1, overlapArea / catchmentArea));
    const validArea = catchmentArea * frac;
    if (validArea <= 0) continue;

    if (metricValue < min) min = metricValue;
    if (metricValue > max) max = metricValue;

    totalValidArea += validArea;
    weightedSum += metricValue * validArea;
    count += 1;
  }

  if (count === 0 || totalValidArea <= 0 || !Number.isFinite(weightedSum)) return null;
  return { min, max, mean: weightedSum / totalValidArea, count };
}

function filterDatasetByCatchmentIds(data: ChoroplethData | null, catchmentIds: Set<string>): ChoroplethData | null {
  if (!data) return null;
  if (catchmentIds.size === 0) return data;

  return {
    ...data,
    features: data.features.filter((feature) => {
      const id = feature.properties?.HYBAS_ID;
      return id !== undefined && catchmentIds.has(String(id));
    }),
  };
}

function extractBoundaryGeometryFromStyleSource(
  source: maplibregl.SourceSpecification | undefined,
): GeoJSON.Geometry | null {
  if (!source || source.type !== 'geojson') return null;

  const data = source.data;
  if (!data || typeof data === 'string') return null;

  if (data.type === 'Feature') {
    return data.geometry ?? null;
  }

  if (data.type === 'FeatureCollection') {
    const firstFeature = data.features?.[0];
    return firstFeature?.geometry ?? null;
  }

  if (data.type === 'Polygon' || data.type === 'MultiPolygon') {
    return data as GeoJSON.Geometry;
  }

  return null;
}

function inferCatchmentIdsFromBoundary(
  datasets: Array<ChoroplethData | null>,
  boundaryGeometry: GeoJSON.Geometry | null,
): Set<string> {
  const inferredIds = new Set<string>();
  if (!boundaryGeometry) return inferredIds;

  const boundaryFeature = geometryToPolygonFeature(simplifyBoundaryForComputation(boundaryGeometry));
  if (!boundaryFeature) return inferredIds;

  for (const dataset of datasets) {
    if (!dataset?.features?.length) continue;

    for (const feature of dataset.features) {
      const featureId = feature.properties?.HYBAS_ID;
      if (featureId === undefined) continue;

      const featureGeometry = feature.geometry as GeoJSON.Geometry | null;
      const catchmentFeature = geometryToPolygonFeature(featureGeometry);
      if (!catchmentFeature) continue;

      try {
        const catchmentArea = turfArea(catchmentFeature.geometry);
        if (!Number.isFinite(catchmentArea) || catchmentArea <= 0) continue;

        const overlap = intersect(featureCollection([catchmentFeature, boundaryFeature]));
        if (!overlap?.geometry) continue;

        const overlapArea = turfArea(overlap.geometry);
        if (!Number.isFinite(overlapArea) || overlapArea <= 0) continue;

        const overlapFraction = Math.max(0, Math.min(1, overlapArea / catchmentArea));
        if (overlapFraction >= MIN_CATCHMENT_OVERLAP_FRACTION) {
          inferredIds.add(String(featureId));
        }
      } catch {
        // Ignore invalid geometry pairs
      }
    }
  }

  return inferredIds;
}

function expandBbox(
  [minX, minY, maxX, maxY]: [number, number, number, number],
  ratio: number,
): [number, number, number, number] {
  const width = maxX - minX;
  const height = maxY - minY;
  const padX = Math.max(width * ratio, 0.0001);
  const padY = Math.max(height * ratio, 0.0001);
  return [minX - padX, minY - padY, maxX + padX, maxY + padY];
}

function inferNearbyCatchmentIdsFromBoundary(
  datasets: Array<ChoroplethData | null>,
  boundaryGeometry: GeoJSON.Geometry | null,
  paddingRatio = BOUNDARY_NEARBY_PADDING_RATIO,
): Set<string> {
  const nearbyIds = new Set<string>();
  if (!boundaryGeometry) return nearbyIds;

  let expandedBoundaryBbox: [number, number, number, number];
  try {
    const boundaryBbox = turfBbox({
      type: 'Feature',
      properties: {},
      geometry: boundaryGeometry,
    } as GeoJSON.Feature) as [number, number, number, number];
    expandedBoundaryBbox = expandBbox(boundaryBbox, paddingRatio);
  } catch {
    return nearbyIds;
  }

  const [expandedMinX, expandedMinY, expandedMaxX, expandedMaxY] = expandedBoundaryBbox;

  for (const dataset of datasets) {
    if (!dataset?.features?.length) continue;

    for (const feature of dataset.features) {
      const featureId = feature.properties?.HYBAS_ID;
      if (featureId === undefined) continue;

      const featureGeometry = feature.geometry as GeoJSON.Geometry | null;
      if (!featureGeometry) continue;

      try {
        const [minX, minY, maxX, maxY] = turfBbox({
          type: 'Feature',
          properties: {},
          geometry: featureGeometry,
        } as GeoJSON.Feature) as [number, number, number, number];
        const intersectsExpandedBoundary =
          maxX >= expandedMinX
          && minX <= expandedMaxX
          && maxY >= expandedMinY
          && minY <= expandedMaxY;

        if (intersectsExpandedBoundary) {
          nearbyIds.add(String(featureId));
        }
      } catch {
        // Ignore invalid feature geometries
      }
    }
  }

  return nearbyIds;
}

/**
 * Format a number for display (compact notation for large numbers).
 */
export function formatNumber(n: number): string {
  if (n === 0) return '0';
  if (Math.abs(n) < 0.01) return n.toExponential(1);
  if (Math.abs(n) < 1) return n.toFixed(2);
  if (Math.abs(n) < 100) return n.toFixed(1);
  if (Math.abs(n) < 10000) return n.toFixed(0);
  return n.toLocaleString('en-US', { maximumFractionDigits: 0, notation: 'compact' });
}

// Module-level cache for pure (no site overrides) choropleth requests.
// Multiple panes requesting the same scenario+attribute+bbox share one in-flight
// fetch instead of firing N identical HTTP requests simultaneously.
const _choroplethCache = new Map<string, { promise: Promise<ChoroplethData | null>; ts: number }>();
const CHOROPLETH_CACHE_TTL_MS = 60_000;

// Module-level caches for the two expensive synchronous intersection routines.
// inferCatchmentIdsFromBoundary / inferNearbyCatchmentIdsFromBoundary each do an
// O(n_catchments × poly_complexity) turf.intersect loop on the main thread.
// In quad view 12 map instances (6 panes × 2 maps) all call these independently,
// serialising up to 24 × ~500 ms = 12 s of blocking computation.
// Caching by siteId means only the FIRST instance computes; the rest read from
// memory with zero blocking time.  Caches are cleared whenever the site or its
// boundary geometry changes (see clearSiteComputationCaches below).
const _inferredIdsSiteCache = new Map<string, Set<string>>();
const _nearbyIdsSiteCache = new Map<string, Set<string>>();

function clearSiteComputationCaches(siteId: string): void {
  _inferredIdsSiteCache.delete(siteId);
  _nearbyIdsSiteCache.delete(siteId);
}

/**
 * Fetch choropleth GeoJSON data for the current viewport.
 */
async function fetchChoroplethData(
  scenario: Scenario,
  attribute: string,
  bounds: maplibregl.LngLatBounds,
  zoom: number,
  siteId?: string | null,
  idealOverrides?: Map<number, number>,
  valuesOnly = false
): Promise<ChoroplethData | null> {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();

  const params = new URLSearchParams({
    scenario,
    attribute,
    minx: sw.lng.toString(),
    miny: sw.lat.toString(),
    maxx: ne.lng.toString(),
    maxy: ne.lat.toString(),
    zoom: zoom.toString(),
  });

  // valuesOnly bypasses zoom-based aggregation/truncation server-side entirely -
  // used for stats that need every real catchment value and HYBAS_ID (e.g. site
  // stats filter by catchment ID), not a render-sized sample.
  if (valuesOnly) {
    params.set('valuesOnly', '1');
  }

  const hasSiteOverride = siteId && scenario === 'future';
  if (hasSiteOverride) {
    params.set('siteId', siteId);
  }

  // Deduplicate concurrent requests for pure (non-site-specific) fetches.
  const canCache = !hasSiteOverride && (!idealOverrides || idealOverrides.size === 0);
  if (canCache) {
    const key = params.toString();
    const now = Date.now();
    const hit = _choroplethCache.get(key);
    if (hit && now - hit.ts < CHOROPLETH_CACHE_TTL_MS) return hit.promise;

    const promise = (async (): Promise<ChoroplethData | null> => {
      try {
        const resp = await fetch(`/api/choropleth?${params}`);
        if (!resp.ok) return null;
        return await resp.json() as ChoroplethData;
      } catch (err) {
        console.error('Failed to fetch choropleth data:', err);
        return null;
      }
    })();

    promise.catch(() => _choroplethCache.delete(key));
    _choroplethCache.set(key, { promise, ts: now });
    return promise;
  }

  try {
    const resp = await fetch(`/api/choropleth?${params}`);
    if (!resp.ok) return null;
    const data: ChoroplethData = await resp.json();

    // In browser mode the backend store is never updated, so apply per-catchment
    // ideal overrides client-side for the future scenario.
    if (scenario === 'future' && idealOverrides && idealOverrides.size > 0) {
      for (const feature of data.features) {
        if (feature.properties.HYBAS_ID === undefined) continue;
        const val = idealOverrides.get(feature.properties.HYBAS_ID);
        if (val !== undefined) {
          feature.properties[attribute] = val;
        }
      }
    }

    return data;
  } catch (err) {
    console.error('Failed to fetch choropleth data:', err);
    return null;
  }
}

/**
 * Build a MapLibre expression producing the 0-1 normalized position of an
 * attribute's value within [min, max].
 *
 * - 'logistic' passes the linear ratio through a sigmoid centered on the
 *   domain midpoint, which compresses values near the extremes and expands
 *   contrast around the middle of the range - useful when most values
 *   cluster around the mean with a long tail.
 * - 'logarithmic' passes the linear ratio through a log1p curve, which
 *   expands contrast among low values at the expense of high ones - useful
 *   when most values are small with a few large outliers. log1p (rather than
 *   a plain log of the raw value) is used so the domain minimum, which can
 *   legitimately be 0, never hits an undefined log(0).
 */
function buildNormalizedValueExpression(
  attribute: string,
  min: number,
  range: number,
  scaleType: ColorScaleType
): maplibregl.ExpressionSpecification {
  const linearRatio = [
    '/',
    ['-', ['coalesce', ['get', attribute], min], min],
    range,
  ] as maplibregl.ExpressionSpecification;

  if (scaleType === 'linear') {
    return linearRatio;
  }

  if (scaleType === 'logarithmic') {
    return [
      'let',
      't',
      linearRatio,
      [
        '/',
        ['ln', ['+', 1, ['*', LOGARITHMIC_STRENGTH, ['var', 't']]]],
        Math.log(1 + LOGARITHMIC_STRENGTH),
      ],
    ] as maplibregl.ExpressionSpecification;
  }

  return [
    'let',
    't',
    linearRatio,
    [
      '/',
      1,
      ['+', 1, ['^', Math.E, ['*', -LOGISTIC_STEEPNESS, ['-', ['var', 't'], 0.5]]]],
    ],
  ] as maplibregl.ExpressionSpecification;
}

/**
 * Build a MapLibre expression for fill-color based on attribute value and global min/max.
 */
function buildFillColorExpression(
  attribute: string,
  min: number,
  max: number,
  baseColor?: string | null,
  scaleType: ColorScaleType = 'linear'
): maplibregl.ExpressionSpecification | string {
  // When a metadata base color is provided, blend from white (low values)
  // to the base color (high values) instead of using opacity.
  if (baseColor) {
    const rgb = hexToRgb(baseColor);
    if (!rgb) return baseColor;

    const range = max - min;
    if (range === 0) {
      // Degenerate domain (every visible value equals min) - treat it as the
      // low end of the white-to-baseColor scale rather than the high end.
      return '#FFFFFF';
    }

    return [
      'interpolate',
      ['linear'],
      buildNormalizedValueExpression(attribute, min, range, scaleType),
      0,
      '#FFFFFF',
      1,
      baseColor,
    ] as maplibregl.ExpressionSpecification;
  }

  const range = max - min;
  if (range === 0) {
    // Single value - use middle color
    return PRISM_STOPS[Math.floor(PRISM_STOPS.length / 2)][1];
  }

  // Build interpolate expression: normalize value to 0-1 then map to colors
  return [
    'interpolate',
    ['linear'],
    buildNormalizedValueExpression(attribute, min, range, scaleType),
    ...PRISM_STOPS.flatMap(([t, color]) => [t, color]),
  ] as maplibregl.ExpressionSpecification;
}

function buildOpacityColorExpression(
  attribute: string,
  min: number,
  max: number,
  baseColor: string,
  scaleType: ColorScaleType = 'linear'
): maplibregl.ExpressionSpecification | string {
  // Blend color from white (low values) to the metadata base color
  // (high values). Opacity will be handled separately by layer paint.
  const rgb = hexToRgb(baseColor);
  if (!rgb) return baseColor;

  const range = max - min;
  if (range === 0) {
    // Degenerate domain (every visible value equals min) - treat it as the
    // low end of the white-to-baseColor scale rather than the high end.
    return '#FFFFFF';
  }

  return [
    'interpolate',
    ['linear'],
    buildNormalizedValueExpression(attribute, min, range, scaleType),
    0,
    '#FFFFFF',
    1,
    baseColor,
  ] as maplibregl.ExpressionSpecification;
}

/**
 * Build a MapLibre expression for fill-extrusion-height based on attribute value.
 */
function buildExtrusionExpression(
  attribute: string,
  min: number,
  max: number,
  scaleType: ColorScaleType = 'linear'
): maplibregl.ExpressionSpecification | number {
  const range = max - min;
  if (range === 0) {
    return MAX_EXTRUSION_HEIGHT / 2;
  }

  return [
    '*',
    buildNormalizedValueExpression(attribute, min, range, scaleType),
    MAX_EXTRUSION_HEIGHT,
  ] as maplibregl.ExpressionSpecification;
}

function setCatchmentOutlinesSoftness(map: maplibregl.Map, soften: boolean) {
  if (!map.getLayer(CATCHMENTS_OUTLINES_LAYER_ID)) return;

  if (soften) {
    if (!catchmentsOutlineOpacityRef.has(map)) {
      catchmentsOutlineOpacityRef.set(map, map.getPaintProperty(CATCHMENTS_OUTLINES_LAYER_ID, 'line-opacity'));
    }
    map.setPaintProperty(CATCHMENTS_OUTLINES_LAYER_ID, 'line-opacity', CATCHMENTS_OUTLINES_SOFT_OPACITY);
    return;
  }

  if (!catchmentsOutlineOpacityRef.has(map)) return;
  const originalOpacity = catchmentsOutlineOpacityRef.get(map);
  if (originalOpacity !== undefined) {
    map.setPaintProperty(CATCHMENTS_OUTLINES_LAYER_ID, 'line-opacity', originalOpacity as maplibregl.ExpressionSpecification | number);
  }
  catchmentsOutlineOpacityRef.delete(map);
}

// Layer IDs for site boundary
const SITE_BOUNDARY_SOURCE = 'site-boundary-source';
const SITE_BOUNDARY_OFFWHITE = 'site-boundary-offwhite';
const SITE_BOUNDARY_GLOW_OUTER = 'site-boundary-glow-outer';
const SITE_BOUNDARY_GLOW_MIDDLE = 'site-boundary-glow-middle';
const SITE_BOUNDARY_LINE = 'site-boundary-line';

// Layer IDs for boundary editing vertices
const EDIT_VERTICES_SOURCE = 'edit-vertices-source';
const EDIT_VERTICES_GLOW = 'edit-vertices-glow';
const EDIT_VERTICES_OUTER = 'edit-vertices-outer';
const EDIT_VERTICES_INNER = 'edit-vertices-inner';

function MapView({ comparison, onOpenSettings, onIdentify, identifyResult, onMapExtentChange, onStatisticsChange, isPanelOpen, isQuad, siteId, siteBounds, isBoundaryEditMode, siteGeometry, onBoundaryUpdate, isSwiperEnabled: isSwiperEnabledProp, onSwiperEnabledChange, colorScaleMode, colorScaleType, swiperPosition, onSwiperPositionChange, is3DMode: is3DModeProp, on3DModeChange, refreshKey, onReady, siteIndicators }: MapViewProps) {
  const { colors: attributeColors, loading: attributeColorsLoading } = useAttributeColors();
  const { details: attributeDetails } = useAttributeDetails();
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const leftMapRef = useRef<maplibregl.Map | null>(null);
  const rightMapRef = useRef<maplibregl.Map | null>(null);
  const viewportBoundsRef = useRef<maplibregl.LngLatBoundsLike | null>(null);
  const leftClipContainerRef = useRef<HTMLDivElement | null>(null);
  const compareContainerRef = useRef<HTMLDivElement | null>(null);
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const sliderHandleRef = useRef<HTMLDivElement | null>(null);
  const sliderDockedRef = useRef<'left' | 'right' | null>(null);
  const isDragging = useRef(false);
  const mapsReady = useRef<{ left: boolean; right: boolean }>({ left: false, right: false });
  const resizeFrameRef = useRef<number | null>(null);

  // Compare swiper state (split-screen on/off)
  const [internalSwiperEnabled, setInternalSwiperEnabled] = useState(true);
  const isSwiperEnabled = isSwiperEnabledProp ?? internalSwiperEnabled;
  const isSwiperEnabledRef = useRef(isSwiperEnabled);
  isSwiperEnabledRef.current = isSwiperEnabled;

  // Identify mode state
  const [isIdentifyMode, setIsIdentifyMode] = useState(false);

  // Choropleth layer visibility state
  const [isChoroplethEnabled, setIsChoroplethEnabled] = useState(true);
  const isChoroplethEnabledRef = useRef(isChoroplethEnabled);
  isChoroplethEnabledRef.current = isChoroplethEnabled;

  // Maps ready state - triggers re-render when maps finish loading
  const [areMapsReady, setAreMapsReady] = useState(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  // Fired once when the first map fires its 'load' event — not tied to areMapsReady
  // because on Windows the left map starts in a width:0% container and ANGLE
  // (WebGL→Direct3D) may refuse to create a zero-size context, permanently
  // blocking that map's 'load' event. areMapsReady stays gated on both maps
  // for its existing choropleth/boundary guards; onReady only needs one.
  const onReadyFiredRef = useRef(false);

  // 3D mode state
  const [internal3DMode, setInternal3DMode] = useState(false);
  const is3DMode = is3DModeProp ?? internal3DMode;
  const is3DModeRef = useRef(is3DMode);

  // Store latest comparison in a ref so async callbacks see current values
  const comparisonRef = useRef(comparison);
  comparisonRef.current = comparison;

  const attributeColorsRef = useRef(attributeColors);
  attributeColorsRef.current = attributeColors;
  const attributeColorsLoadingRef = useRef(attributeColorsLoading);
  attributeColorsLoadingRef.current = attributeColorsLoading;
  const attributeDetailsRef = useRef(attributeDetails);
  attributeDetailsRef.current = attributeDetails;
  const siteIndicatorsRef = useRef(siteIndicators);
  siteIndicatorsRef.current = siteIndicators;

  // Store identify mode and callback in refs for event handlers
  const isIdentifyModeRef = useRef(isIdentifyMode);
  isIdentifyModeRef.current = isIdentifyMode;
  const onIdentifyRef = useRef(onIdentify);
  onIdentifyRef.current = onIdentify;

  // Store map extent change callback in ref
  const onMapExtentChangeRef = useRef(onMapExtentChange);
  onMapExtentChangeRef.current = onMapExtentChange;

  // Store statistics change callback in ref
  const onStatisticsChangeRef = useRef(onStatisticsChange);
  onStatisticsChangeRef.current = onStatisticsChange;

  const siteZoneStatsRef = useRef<{ left: ZoneStats | null; right: ZoneStats | null } | null>(null);
  const fullZoneStatsRef = useRef<{ left: ZoneStats | null; right: ZoneStats | null } | null>(null);
  const extentZoneStatsRef = useRef<{ left: ZoneStats | null; right: ZoneStats | null } | null>(null);
  const lastDomainRangeRef = useRef<DomainRange | null>(null);
  const siteCatchmentIdsRef = useRef<Set<string> | null>(null);
  const boundaryGeometryRef = useRef<GeoJSON.Geometry | null>(siteGeometry ?? null);
  // Sync only when the prop itself changes value, not on every render — a
  // render triggered by exiting edit mode (isBoundaryEditMode flipping)
  // happens before the parent's async geometry update has propagated back
  // down as a new `siteGeometry` prop, and blindly resyncing here would
  // stomp the live-edited geometry already applied via updateBoundaryDisplay.
  useEffect(() => {
    boundaryGeometryRef.current = siteGeometry ?? null;
    if (!siteGeometry) return;
    // Final authoritative re-sync once the saved geometry round-trips back
    // as a prop: setData()-only (no remove/recreate) so it's cheap and
    // can't disturb layer state, but it corrects either map if its last
    // live-drag setData() call during the edit didn't land.
    const geometry = normalizeBoundaryGeometry(siteGeometry);
    for (const map of [leftMapRef.current, rightMapRef.current]) {
      const source = map?.getSource(SITE_BOUNDARY_SOURCE) as maplibregl.GeoJSONSource | undefined;
      source?.setData({ type: 'Feature', properties: {}, geometry });
    }
  }, [siteGeometry]);
  const identifyOverlayRef = useRef<HTMLDivElement | null>(null);
  const identifyOverlayLngLatRef = useRef<[number, number] | null>(null);

  const removeIdentifyOverlay = useCallback((clearIdentify: boolean) => {
    if (identifyOverlayRef.current) {
      identifyOverlayRef.current.remove();
      identifyOverlayRef.current = null;
    }
    identifyOverlayLngLatRef.current = null;

    if (clearIdentify) {
      onIdentifyRef.current?.(null);
    }
  }, []);

  const updateIdentifyOverlayPosition = useCallback(() => {
    const overlay = identifyOverlayRef.current;
    const lngLat = identifyOverlayLngLatRef.current;
    const leftMap = leftMapRef.current;
    const mapContainer = mapContainerRef.current;

    if (!overlay || !lngLat || !leftMap || !mapContainer) return;

    const projected = leftMap.project({ lng: lngLat[0], lat: lngLat[1] });
    overlay.style.left = `${projected.x}px`;
    overlay.style.top = `${projected.y}px`;

    // Clamp the overlay so it always stays fully within the map container,
    // even when the click point is near an edge (the overlay is centered
    // above the point via a CSS transform, so it can otherwise overflow).
    const margin = 8;
    const containerWidth = mapContainer.clientWidth;
    const containerHeight = mapContainer.clientHeight;
    const containerRect = mapContainer.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();

    const overlayLeft = overlayRect.left - containerRect.left;
    const overlayRight = overlayRect.right - containerRect.left;
    const overlayTop = overlayRect.top - containerRect.top;
    const overlayBottom = overlayRect.bottom - containerRect.top;

    let offsetX = 0;
    let offsetY = 0;

    if (overlayLeft < margin) {
      offsetX = margin - overlayLeft;
    } else if (overlayRight > containerWidth - margin) {
      offsetX = containerWidth - margin - overlayRight;
    }

    if (overlayTop < margin) {
      offsetY = margin - overlayTop;
    } else if (overlayBottom > containerHeight - margin) {
      offsetY = containerHeight - margin - overlayBottom;
    }

    if (offsetX !== 0 || offsetY !== 0) {
      overlay.style.left = `${projected.x + offsetX}px`;
      overlay.style.top = `${projected.y + offsetY}px`;
    }
  }, []);

  // Debounce timer for choropleth fetching
  const fetchTimerRef = useRef<number | null>(null);

  /** Fetch and apply choropleth data to both maps based on current viewport.
   *  Only shown when zoomed in past MIN_CATCHMENT_ZOOM. */
  const applyColors = useCallback(async () => {
    const c = comparisonRef.current;
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;

    if (!leftMap || !rightMap) return;
    if (!mapsReady.current.left || !mapsReady.current.right) return;

    if (!isChoroplethEnabledRef.current) {
      removeChoroplethLayers(leftMap, 'left');
      removeChoroplethLayers(rightMap, 'right');
      extentZoneStatsRef.current = null;
      if (onStatisticsChangeRef.current) {
        onStatisticsChangeRef.current({
          domainRange: null,
          leftStats: null,
          rightStats: null,
          fullStats: fullZoneStatsRef.current,
          siteStats: siteZoneStatsRef.current,
        });
      }
      return;
    }

    // Clear existing choropleth layers if no attribute selected
    if (!c.attribute) {
      removeChoroplethLayers(leftMap, 'left');
      removeChoroplethLayers(rightMap, 'right');
      fullZoneStatsRef.current = null;
      extentZoneStatsRef.current = null;
      if (onStatisticsChangeRef.current) {
        onStatisticsChangeRef.current({
          domainRange: null,
          leftStats: null,
          rightStats: null,
          fullStats: null,
          siteStats: null,
        });
      }
      return;
    }

    // In metadata color-scale mode, wait for the metadata colors to finish
    // their initial fetch before rendering anything. Painting while
    // attributeColorsRef is still the empty `{}` it starts as would make
    // every attribute look like it has no defined color and fall back to
    // the rainbow scale (see applyChoroplethLayer's
    // `useOpacityScale = Boolean(attributeColor)`), which then gets
    // replaced by the correct single color a moment later - a visible
    // flash of the wrong scale on every fresh mount (e.g. switching into
    // quad view, which mounts a new MapView per pane). Skipping here means
    // nothing renders until we know the real answer; the effect below
    // re-invokes applyColors once attributeColors finishes loading.
    if (colorScaleMode === 'metadata' && attributeColorsLoadingRef.current) {
      return;
    }

    // Check zoom — hide catchment layers when zoomed out
    const currentZoom = leftMap.getZoom();
    if (currentZoom < MIN_CATCHMENT_ZOOM) {
      removeChoroplethLayers(leftMap, 'left');
      removeChoroplethLayers(rightMap, 'right');
      extentZoneStatsRef.current = null;
      if (onStatisticsChangeRef.current) {
        onStatisticsChangeRef.current({
          domainRange: null,
          leftStats: null,
          rightStats: null,
          fullStats: fullZoneStatsRef.current,
          siteStats: siteZoneStatsRef.current,
        });
      }
      return;
    }

    const extruded = is3DModeRef.current;
    const bounds = leftMap.getBounds();

    // In browser mode the backend store is never updated with ideal values, so we
    // load per-catchment ideal overrides from localStorage and apply them client-side.
    let browserIdealOverrides: Map<number, number> | undefined;
    if (getAppRuntime() === 'browser' && siteId &&
        (c.leftScenario === 'future' || c.rightScenario === 'future')) {
      const catchments = await getSiteCatchments(siteId).catch(() => []);
      if (catchments.length > 0 && c.attribute) {
        browserIdealOverrides = new Map();
        for (const cat of catchments) {
          const val = cat.ideal?.[c.attribute];
          if (val !== undefined) {
            const numId = Math.round(parseFloat(cat.id));
            if (!isNaN(numId)) browserIdealOverrides.set(numId, val);
          }
        }
      }
    }

    try {
      // Fetch data for both scenarios in parallel
      const [leftData, rightData] = await Promise.all([
        fetchChoroplethData(c.leftScenario, c.attribute, bounds, currentZoom, siteId, browserIdealOverrides),
        fetchChoroplethData(c.rightScenario, c.attribute, bounds, currentZoom, siteId, browserIdealOverrides),
      ]);

      let siteCatchmentIds = siteId ? siteCatchmentIdsRef.current : null;

      if (siteId && (!siteCatchmentIds || siteCatchmentIds.size === 0)) {
        const liveBoundarySource = leftMap.getSource(SITE_BOUNDARY_SOURCE) as (maplibregl.GeoJSONSource & {
          serialize?: () => maplibregl.SourceSpecification;
        }) | undefined;

        const serializedBoundarySource = liveBoundarySource?.serialize ? liveBoundarySource.serialize() : undefined;

        const boundaryGeometry =
          boundaryGeometryRef.current
          ?? extractBoundaryGeometryFromStyleSource(serializedBoundarySource)
          ?? extractBoundaryGeometryFromStyleSource(leftMap.getStyle()?.sources?.[SITE_BOUNDARY_SOURCE]);

        // Check module-level cache first — avoids recomputing for every map instance
        // in quad view (12 instances would otherwise each run the full turf loop).
        // Skip entirely for large datasets — the stats block populates siteCatchmentIdsRef
        // shortly via getSiteAOIFractions, avoiding the expensive intersection loop.
        const cachedInferred = _inferredIdsSiteCache.get(siteId);
        const colorTotalFeatures = (leftData?.features?.length ?? 0) + (rightData?.features?.length ?? 0);
        const inferredIds = cachedInferred
          ?? (colorTotalFeatures <= 50 && boundaryGeometry
              ? inferCatchmentIdsFromBoundary([leftData, rightData], boundaryGeometry)
              : new Set<string>());
        if (!cachedInferred && inferredIds.size > 0) _inferredIdsSiteCache.set(siteId, inferredIds);

        if (inferredIds.size > 0) {
          siteCatchmentIds = inferredIds;
          siteCatchmentIdsRef.current = inferredIds;
        }
      }

      if (siteId) {
        const liveBoundarySource = leftMap.getSource(SITE_BOUNDARY_SOURCE) as (maplibregl.GeoJSONSource & {
          serialize?: () => maplibregl.SourceSpecification;
        }) | undefined;

        const serializedBoundarySource = liveBoundarySource?.serialize ? liveBoundarySource.serialize() : undefined;

        const boundaryGeometry =
          boundaryGeometryRef.current
          ?? extractBoundaryGeometryFromStyleSource(serializedBoundarySource)
          ?? extractBoundaryGeometryFromStyleSource(leftMap.getStyle()?.sources?.[SITE_BOUNDARY_SOURCE]);

        const cachedNearby = _nearbyIdsSiteCache.get(siteId);
        const nearbyIds = cachedNearby ?? inferNearbyCatchmentIdsFromBoundary([leftData, rightData], boundaryGeometry);
        if (!cachedNearby && nearbyIds.size > 0) _nearbyIdsSiteCache.set(siteId, nearbyIds);

        if (nearbyIds.size > 0) {
          const mergedIds = new Set<string>(siteCatchmentIds ? Array.from(siteCatchmentIds) : []);
          for (const id of nearbyIds) mergedIds.add(id);
          siteCatchmentIds = mergedIds;
          siteCatchmentIdsRef.current = mergedIds;
        }
      }

      // const leftFiltered = (siteCatchmentIds && siteCatchmentIds.size > 0)
      //   ? filterDatasetByCatchmentIds(leftData, siteCatchmentIds)
      //   : leftData;
      // const rightFiltered = (siteCatchmentIds && siteCatchmentIds.size > 0)
      //   ? filterDatasetByCatchmentIds(rightData, siteCatchmentIds)
      //   : rightData;
      const leftDisplay = leftData;
      const rightDisplay = rightData;

      // Color scale always uses the attribute's global domain across every
      // catchment, independent of the selected zone range (Full/Extent/Site).
      // The backend's max is now scenario-specific (metadata.csv's curated
      // maxval_curr/maxval_ref rather than a scan of every catchment), so the
      // two sides can disagree when comparing reference against current —
      // take the larger of the two so neither side's colors get clipped, and
      // the result doesn't depend on which scenario happens to be on the left.
      let min = 0;
      let max = 1;
      const domainMins: number[] = [];
      const domainMaxes: number[] = [];
      if (leftData && leftData.domain_min !== undefined && leftData.domain_max !== undefined) {
        domainMins.push(leftData.domain_min);
        domainMaxes.push(leftData.domain_max);
      }
      if (rightData && rightData.domain_min !== undefined && rightData.domain_max !== undefined) {
        domainMins.push(rightData.domain_min);
        domainMaxes.push(rightData.domain_max);
      }
      if (domainMins.length > 0) min = Math.min(...domainMins);
      if (domainMaxes.length > 0) max = Math.max(...domainMaxes);
      lastDomainRangeRef.current = { min, max };

      // Extent-based stats are always derived from the current viewport.
      const leftExtentStats = leftData ? computeZoneStats(leftData, c.attribute) : null;
      const rightExtentStats = rightData ? computeZoneStats(rightData, c.attribute) : null;
      extentZoneStatsRef.current = { left: leftExtentStats, right: rightExtentStats };

      if (onStatisticsChangeRef.current) {
        onStatisticsChangeRef.current({
          domainRange: { min, max },
          leftStats: leftExtentStats,
          rightStats: rightExtentStats,
          fullStats: fullZoneStatsRef.current,
          siteStats: siteZoneStatsRef.current,
        });
      }

      const attributeColor = colorScaleMode === 'metadata'
        ? attributeColorsRef.current?.[c.attribute]
        : undefined;

      // Apply to left map - verify the map is ready
      if (leftDisplay && leftDisplay.features.length > 0) {
        if (leftMap.loaded()) {
          applyChoroplethLayer(leftMap, 'left', leftDisplay, c.attribute, min, max, extruded, attributeColor, colorScaleType);
        } else {
          leftMap.once('idle', () => {
            applyChoroplethLayer(leftMap, 'left', leftDisplay, c.attribute, min, max, extruded, attributeColor, colorScaleType);
          });
        }
      } else {
        removeChoroplethLayers(leftMap, 'left');
      }

      // Apply to right map - verify the map is ready
      if (rightDisplay && rightDisplay.features.length > 0) {
        if (rightMap.loaded()) {
          applyChoroplethLayer(rightMap, 'right', rightDisplay, c.attribute, min, max, extruded, attributeColor, colorScaleType);
        } else {
          rightMap.once('idle', () => {
            applyChoroplethLayer(rightMap, 'right', rightDisplay, c.attribute, min, max, extruded, attributeColor, colorScaleType);
          });
        }
      } else {
        removeChoroplethLayers(rightMap, 'right');
      }
    } catch (err) {
      console.error('Failed to apply choropleth:', err);
    }
  }, [colorScaleMode, colorScaleType]);

  const applyColorsRef = useRef(applyColors);
  useEffect(() => {
    applyColorsRef.current = applyColors;
  }, [applyColors]);

  // Reset site stats when boundary geometry changes so stats recompute.
  useEffect(() => {
    if (!siteId) return;
    siteCatchmentIdsRef.current = null;
    siteZoneStatsRef.current = null;
    // Invalidate module-level caches so the new boundary is re-inferred by the
    // first instance to run; subsequent instances will read the fresh result.
    clearSiteComputationCaches(siteId);
    // Whisker bounds are area-weighted over the site's catchments, so a
    // boundary change invalidates them too (see useApi.ts).
    clearSiteWhiskerCache(siteId);
    applyColorsRef.current();
  }, [siteId, siteGeometry]);

  // Re-fetch choropleth after indicator save so ideal overrides appear on the map.
  const isFirstRefreshKeyRender = useRef(true);
  useEffect(() => {
    if (isFirstRefreshKeyRender.current) {
      isFirstRefreshKeyRender.current = false;
      return;
    }
    applyColorsRef.current();
  }, [refreshKey]);

  // Compute full-dataset stats so "Full" range has stable values.
  useEffect(() => {
    let cancelled = false;
    const c = comparisonRef.current;

    if (!c.attribute) {
      fullZoneStatsRef.current = null;
      return () => {
        cancelled = true;
      };
    }

    const fullBounds = new maplibregl.LngLatBounds([-180, -90], [180, 90]);

    const fetchFullStats = async () => {
      try {
        // These stats must reflect the true full dataset, not a render-sized
        // sample/aggregate, so fetch every catchment's raw value regardless of
        // viewport zoom (zoom argument is ignored server-side in this mode).
        const [leftData, rightData] = await Promise.all([
          fetchChoroplethData(c.leftScenario, c.attribute, fullBounds, 0, undefined, undefined, true),
          fetchChoroplethData(c.rightScenario, c.attribute, fullBounds, 0, undefined, undefined, true),
        ]);

        if (cancelled) return;

        const leftFullStats = leftData ? computeZoneStats(leftData, c.attribute) : null;
        const rightFullStats = rightData ? computeZoneStats(rightData, c.attribute) : null;
        fullZoneStatsRef.current = { left: leftFullStats, right: rightFullStats };

        if (onStatisticsChangeRef.current) {
          onStatisticsChangeRef.current({
            domainRange: lastDomainRangeRef.current,
            leftStats: extentZoneStatsRef.current?.left ?? null,
            rightStats: extentZoneStatsRef.current?.right ?? null,
            fullStats: fullZoneStatsRef.current,
            siteStats: siteZoneStatsRef.current,
          });
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to compute full zone statistics:', err);
        }
      }
    };

    fetchFullStats();

    return () => {
      cancelled = true;
    };
  }, [comparison.leftScenario, comparison.rightScenario, comparison.attribute]);

  // Clear stale choropleth layers immediately when comparison changes
  useEffect(() => {
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;

    if (!leftMap || !rightMap || !mapsReady.current.left || !mapsReady.current.right) return;

    removeChoroplethLayers(leftMap, 'left');
    removeChoroplethLayers(rightMap, 'right');
    applyColorsRef.current();
  }, [comparison.leftScenario, comparison.rightScenario, comparison.attribute]);

  const addBoundaryLayersIfMissing = (map: maplibregl.Map, geometry: GeoJSON.Geometry) => {
    if (!map.isStyleLoaded()) return;

    const normalized = normalizeBoundaryGeometry(geometry);
    const source = map.getSource(SITE_BOUNDARY_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData({
        type: 'Feature',
        properties: {},
        geometry: normalized,
      });
    } else {
      map.addSource(SITE_BOUNDARY_SOURCE, {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: normalized,
        },
      });
    }

    if (!map.getLayer(SITE_BOUNDARY_GLOW_OUTER)) {
      map.addLayer({
        id: SITE_BOUNDARY_GLOW_OUTER,
        type: 'fill',
        source: SITE_BOUNDARY_SOURCE,
        paint: {
          'fill-color': '#FF00FF',
          'fill-opacity': 0,
        },
      });
    }

    if (!map.getLayer(SITE_BOUNDARY_OFFWHITE)) {
      map.addLayer({
        id: SITE_BOUNDARY_OFFWHITE,
        type: 'line',
        source: SITE_BOUNDARY_SOURCE,
        paint: {
          'line-color': '#F5F5F0',
          'line-width': 20,
          'line-opacity': 0.6,
        },
      });
    }

    if (!map.getLayer(SITE_BOUNDARY_GLOW_MIDDLE)) {
      map.addLayer({
        id: SITE_BOUNDARY_GLOW_MIDDLE,
        type: 'line',
        source: SITE_BOUNDARY_SOURCE,
        paint: {
          'line-color': '#FF00FF',
          'line-width': 14,
          'line-opacity': 0.5,
          'line-blur': 8,
        },
      });
    }

    if (!map.getLayer(SITE_BOUNDARY_LINE)) {
      map.addLayer({
        id: SITE_BOUNDARY_LINE,
        type: 'line',
        source: SITE_BOUNDARY_SOURCE,
        paint: {
          'line-color': '#FF00FF',
          'line-width': 4,
          'line-opacity': 1,
        },
      });
    }

    moveSiteBoundaryToTop(map);
    map.triggerRepaint();
  };

  const reapplyBoundaryLayers = useCallback(() => {
    const geometry = boundaryGeometryRef.current;
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;
    if (!geometry || !leftMap || !rightMap) return;

    const applyToMap = (map: maplibregl.Map) => {
      if (map.isStyleLoaded()) {
        addBoundaryLayersIfMissing(map, geometry);
        return;
      }
      const onStyleData = () => {
        if (!map.isStyleLoaded()) return;
        map.off('styledata', onStyleData);
        // Re-read the ref instead of using the geometry captured above: this
        // listener can sit armed for a long time (e.g. registered on initial
        // mount before the style has settled) and fire much later, after
        // further edits — applying the stale closure value would silently
        // revert any edits made in the meantime.
        const latestGeometry = boundaryGeometryRef.current;
        if (!latestGeometry) return;
        addBoundaryLayersIfMissing(map, latestGeometry);
      };
      map.on('styledata', onStyleData);
    };

    applyToMap(leftMap);
    applyToMap(rightMap);
  }, []);

  // Compute a site-scoped domain range (min/max) so color scale is based on the site,
  // not on global dataset extrema, once a site exists.
  useEffect(() => {
    let cancelled = false;

    const updateSiteDomainRange = async () => {
      const c = comparisonRef.current;
      if (!siteId || !c.attribute) {
        siteZoneStatsRef.current = null;
        siteCatchmentIdsRef.current = null;
        applyColors();
        return;
      }

      let bounds = siteBounds;
      let catchmentIds: string[] = [];
      let siteGeometryFromApi: GeoJSON.Geometry | null = null;
      const deriveBoundsFromGeometry = (geometry: GeoJSON.Geometry | null): BoundingBox | null => {
        if (!geometry) return null;
        try {
          const [minX, minY, maxX, maxY] = turfBbox({
            type: 'Feature',
            properties: {},
            geometry,
          } as GeoJSON.Feature) as [number, number, number, number];
          return { minX, minY, maxX, maxY };
        } catch {
          return null;
        }
      };
      try {
        const site = await getSite(siteId);
        if (!bounds) {
          bounds = site?.boundingBox ?? null;
        }
        catchmentIds = Array.isArray(site?.catchmentIds)
          ? site.catchmentIds.map((id: unknown) => String(id))
          : [];
        siteGeometryFromApi = site?.geometry ?? null;
      } catch (err) {
        console.error('Failed to fetch site data for domain scaling:', err);
      }

      const mergeBounds = (a: BoundingBox, b: BoundingBox): BoundingBox => ({
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY),
      });

      const liveBoundarySource = leftMapRef.current?.getSource(SITE_BOUNDARY_SOURCE) as (maplibregl.GeoJSONSource & {
        serialize?: () => maplibregl.SourceSpecification;
      }) | undefined;
      const serializedBoundarySource = liveBoundarySource?.serialize ? liveBoundarySource.serialize() : undefined;
      const boundaryGeometry =
        boundaryGeometryRef.current
        ?? extractBoundaryGeometryFromStyleSource(serializedBoundarySource)
        ?? extractBoundaryGeometryFromStyleSource(leftMapRef.current?.getStyle()?.sources?.[SITE_BOUNDARY_SOURCE])
        ?? siteGeometryFromApi;
      const boundaryBounds = deriveBoundsFromGeometry(boundaryGeometry);
      if (boundaryBounds) {
        bounds = bounds ? mergeBounds(bounds, boundaryBounds) : boundaryBounds;
      }

      if (!bounds) {
        bounds = deriveBoundsFromGeometry(siteGeometryFromApi);
      }

      if (!bounds) {
        siteZoneStatsRef.current = null;
        applyColors();
        return;
      }

      const siteBoundsLL = new maplibregl.LngLatBounds(
        [bounds.minX, bounds.minY],
        [bounds.maxX, bounds.maxY],
      );

      let siteIdealOverrides: Map<number, number> | undefined;
      if (getAppRuntime() === 'browser' && (c.leftScenario === 'future' || c.rightScenario === 'future')) {
        const catchments = await getSiteCatchments(siteId).catch(() => []);
        if (catchments.length > 0 && c.attribute) {
          siteIdealOverrides = new Map();
          for (const cat of catchments) {
            const val = cat.ideal?.[c.attribute];
            if (val !== undefined) {
              const numId = Math.round(parseFloat(cat.id));
              if (!isNaN(numId)) siteIdealOverrides.set(numId, val);
            }
          }
        }
      }

      try {
        // filterDatasetByCatchmentIds below needs a real HYBAS_ID per feature,
        // and the AOI-weighted stats need every matching catchment's raw value -
        // the grid-aggregated render path can supply neither, so fetch true
        // per-catchment values regardless of viewport zoom.
        const [leftData, rightData, siteCatchments] = await Promise.all([
          fetchChoroplethData(c.leftScenario, c.attribute, siteBoundsLL, 0, siteId, siteIdealOverrides, true),
          fetchChoroplethData(c.rightScenario, c.attribute, siteBoundsLL, 0, siteId, siteIdealOverrides, true),
          getSiteAOIFractions(siteId).catch(() => []),
        ]);

        if (cancelled) return;

        // Build the authoritative ID set from siteCatchments, keeping only those with
        // meaningful AOI overlap (aoiFraction > 0). Catchments that intersect the bounding
        // box but lie outside the drawn boundary get aoiFraction ≈ 0 via ApplyAOIFractions
        // on the server and should be excluded from site zone statistics.
        let apiCatchmentIds: Set<string> | null = null;
        if (Array.isArray(siteCatchments) && siteCatchments.length > 0) {
          const overlapping = (siteCatchments as Array<{ id: string; aoiFraction?: number }>)
            .filter(c => (c.aoiFraction ?? 1.0) > 0);
          const source = overlapping.length > 0 ? overlapping : (siteCatchments as Array<{ id: string }>);
          apiCatchmentIds = new Set(source.map(c => String(c.id)));
        }

        const explicitCatchmentIds = new Set(catchmentIds);
        const liveBoundarySource = leftMapRef.current?.getSource(SITE_BOUNDARY_SOURCE) as (maplibregl.GeoJSONSource & {
          serialize?: () => maplibregl.SourceSpecification;
        }) | undefined;
        const serializedBoundarySource = liveBoundarySource?.serialize ? liveBoundarySource.serialize() : undefined;
        const boundaryGeometry =
          boundaryGeometryRef.current
          ?? extractBoundaryGeometryFromStyleSource(serializedBoundarySource)
          ?? extractBoundaryGeometryFromStyleSource(leftMapRef.current?.getStyle()?.sources?.[SITE_BOUNDARY_SOURCE])
          ?? siteGeometryFromApi;
        // Skip inferCatchmentIdsFromBoundary when API fractions or explicit IDs are available —
        // the intersection-based fallback is only safe for small datasets (≤50 features).
        const cachedInferredStat = _inferredIdsSiteCache.get(siteId);
        const totalFeatures = (leftData?.features?.length ?? 0) + (rightData?.features?.length ?? 0);
        const canInfer = !apiCatchmentIds && explicitCatchmentIds.size === 0 && totalFeatures <= 50;
        const inferredCatchmentIds = cachedInferredStat
          ?? (canInfer && boundaryGeometry ? inferCatchmentIdsFromBoundary([leftData, rightData], boundaryGeometry) : new Set<string>());
        if (!cachedInferredStat && inferredCatchmentIds.size > 0) _inferredIdsSiteCache.set(siteId, inferredCatchmentIds);
        // Prefer API-provided AOI-filtered IDs, then explicit stored IDs, then geometry inference
        const statsCatchmentIds = apiCatchmentIds
          ?? (explicitCatchmentIds.size > 0 ? explicitCatchmentIds : inferredCatchmentIds);
        siteCatchmentIdsRef.current = statsCatchmentIds;
        const leftFiltered = filterDatasetByCatchmentIds(leftData, statsCatchmentIds);
        const rightFiltered = filterDatasetByCatchmentIds(rightData, statsCatchmentIds);

        // Build fraction lookup from slim siteCatchments for fast AOI-weighted stats.
        // This replaces expensive per-catchment turfIntersect calls with O(1) lookups.
        const catchmentFractionMap = new Map<string, { aoiFraction: number; areaKm2: number }>();
        if (Array.isArray(siteCatchments)) {
          for (const sc of siteCatchments as Array<{ id: string; aoiFraction?: number; areaKm2: number }>) {
            catchmentFractionMap.set(String(sc.id), { aoiFraction: sc.aoiFraction ?? 1, areaKm2: sc.areaKm2 });
          }
        }

        const leftSiteStats = leftFiltered
          ? (catchmentFractionMap.size > 0
              ? computeAOIWeightedZoneStatsFromFractions(leftFiltered, c.attribute, catchmentFractionMap)
                ?? computeZoneStats(leftFiltered, c.attribute)
              : (boundaryGeometry && (leftFiltered.features?.length ?? 0) <= 50
                  ? computeAOIWeightedZoneStats(leftFiltered, c.attribute, boundaryGeometry)
                    ?? computeZoneStats(leftFiltered, c.attribute)
                  : computeZoneStats(leftFiltered, c.attribute)))
          : null;
        const rightSiteStats = rightFiltered
          ? (catchmentFractionMap.size > 0
              ? computeAOIWeightedZoneStatsFromFractions(rightFiltered, c.attribute, catchmentFractionMap)
                ?? computeZoneStats(rightFiltered, c.attribute)
              : (boundaryGeometry && (rightFiltered.features?.length ?? 0) <= 50
                  ? computeAOIWeightedZoneStats(rightFiltered, c.attribute, boundaryGeometry)
                    ?? computeZoneStats(rightFiltered, c.attribute)
                  : computeZoneStats(rightFiltered, c.attribute)))
          : null;

        // Use pre-computed aggregate indicators for the weighted mean so it matches
        // the aggregate table without needing full per-catchment indicator data.
        if (Array.isArray(siteCatchments) && siteCatchments.length > 0) {
          const si = siteIndicatorsRef.current;
          if (si && c.attribute) {
            const leftScenarioKey = c.leftScenario === 'reference' ? 'reference' : c.leftScenario === 'future' ? 'ideal' : 'current';
            const rightScenarioKey = c.rightScenario === 'reference' ? 'reference' : c.rightScenario === 'future' ? 'ideal' : 'current';
            const leftMap = si[leftScenarioKey as keyof typeof si] as Record<string, number> | undefined;
            const rightMap = si[rightScenarioKey as keyof typeof si] as Record<string, number> | undefined;
            const weightedLeftMean = leftMap?.[c.attribute];
            const weightedRightMean = rightMap?.[c.attribute];

            if (leftSiteStats && typeof weightedLeftMean === 'number' && Number.isFinite(weightedLeftMean)
                && weightedLeftMean >= leftSiteStats.min && weightedLeftMean <= leftSiteStats.max) {
              leftSiteStats.mean = weightedLeftMean;
            }
            if (rightSiteStats && typeof weightedRightMean === 'number' && Number.isFinite(weightedRightMean)
                && weightedRightMean >= rightSiteStats.min && weightedRightMean <= rightSiteStats.max) {
              rightSiteStats.mean = weightedRightMean;
            }
          }

          // Override count using catchment count from slim fractions data.
          if (leftSiteStats) leftSiteStats.count = siteCatchments.length;
          if (rightSiteStats) rightSiteStats.count = siteCatchments.length;
        }

        siteZoneStatsRef.current = { left: leftSiteStats, right: rightSiteStats };
        if (onStatisticsChangeRef.current) {
          onStatisticsChangeRef.current({
            domainRange: lastDomainRangeRef.current,
            leftStats: extentZoneStatsRef.current?.left ?? null,
            rightStats: extentZoneStatsRef.current?.right ?? null,
            fullStats: fullZoneStatsRef.current,
            siteStats: siteZoneStatsRef.current,
          });
        }
        applyColors();
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to compute site zone stats:', err);
          siteZoneStatsRef.current = null;
          siteCatchmentIdsRef.current = null;
          applyColors();
        }
      }
    };

    updateSiteDomainRange();

    return () => {
      cancelled = true;
    };
  }, [siteId, siteBounds, siteGeometry, comparison.leftScenario, comparison.rightScenario, comparison.attribute, applyColors, refreshKey]);

  /**
   * Remove choropleth layers from a map.
   */
  function removeChoroplethLayers(map: maplibregl.Map, side: string) {
    // Safety check: map.style is undefined after map.remove() is called
    if (!map.style) return;

    const layerId = `choropleth-${side}`;
    const edgeBlendLayerId = `${layerId}-edge-blend`;
    const sourceId = `choropleth-source-${side}`;

    if (map.getLayer(edgeBlendLayerId)) {
      map.removeLayer(edgeBlendLayerId);
    }
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
    if (map.getLayer(`${layerId}-3d`)) {
      map.removeLayer(`${layerId}-3d`);
    }
    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
    }

    setCatchmentOutlinesSoftness(map, false);
  }

  /**
   * Apply choropleth layer to a map with GeoJSON data.
   */
  function applyChoroplethLayer(
    map: maplibregl.Map,
    side: string,
    data: ChoroplethData,
    attribute: string,
    min: number,
    max: number,
    extruded: boolean,
    attributeColor?: string | null,
    scaleType: ColorScaleType = 'linear'
  ) {
    const layerId = `choropleth-${side}`;
    const layer3dId = `${layerId}-3d`;
    const edgeBlendLayerId = `${layerId}-edge-blend`;
    const sourceId = `choropleth-source-${side}`;

    try {
      const useOpacityScale = Boolean(attributeColor);
      const fillOpacity = isGoogleBasemapRef.current
        ? CHOROPLETH_FILL_OPACITY_SATELLITE
        : CHOROPLETH_FILL_OPACITY_DEFAULT;

      const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(data as unknown as GeoJSON.FeatureCollection);
      } else {
        map.addSource(sourceId, {
          type: 'geojson',
          data: data as unknown as GeoJSON.FeatureCollection,
        });
      }

      setCatchmentOutlinesSoftness(map, true);

      if (extruded) {
        if (map.getLayer(edgeBlendLayerId)) {
          map.removeLayer(edgeBlendLayerId);
        }
        if (map.getLayer(layerId)) {
          map.removeLayer(layerId);
        }

        if (!map.getLayer(layer3dId)) {
          map.addLayer({
            id: layer3dId,
            type: 'fill-extrusion',
            source: sourceId,
            paint: {
              'fill-extrusion-color': useOpacityScale && attributeColor
                ? buildOpacityColorExpression(attribute, min, max, attributeColor, scaleType)
                : buildFillColorExpression(attribute, min, max, attributeColor, scaleType),
              'fill-extrusion-height': buildExtrusionExpression(attribute, min, max, scaleType),
              'fill-extrusion-base': 0,
              'fill-extrusion-opacity': fillOpacity,
            },
          });
        } else {
          map.setPaintProperty(
            layer3dId,
            'fill-extrusion-color',
            useOpacityScale && attributeColor
              ? buildOpacityColorExpression(attribute, min, max, attributeColor, scaleType)
              : buildFillColorExpression(attribute, min, max, attributeColor, scaleType),
          );
          map.setPaintProperty(
            layer3dId,
            'fill-extrusion-height',
            buildExtrusionExpression(attribute, min, max, scaleType),
          );
          map.setPaintProperty(layer3dId, 'fill-extrusion-opacity', fillOpacity);
        }
      } else {
        if (map.getLayer(layer3dId)) {
          map.removeLayer(layer3dId);
        }

        if (!map.getLayer(layerId)) {
          map.addLayer({
            id: layerId,
            type: 'fill',
            source: sourceId,
            paint: {
              'fill-color': buildFillColorExpression(attribute, min, max, attributeColor, scaleType),
              // Keep boundaries soft so adjacent catchments blend visually.
              'fill-outline-color': CHOROPLETH_OUTLINE_COLOR,
              'fill-opacity': fillOpacity,
            },
          });
        } else {
          map.setPaintProperty(
            layerId,
            'fill-color',
            buildFillColorExpression(attribute, min, max, attributeColor, scaleType),
          );
          map.setPaintProperty(layerId, 'fill-outline-color', CHOROPLETH_OUTLINE_COLOR);
          map.setPaintProperty(layerId, 'fill-opacity', fillOpacity);
        }

        const edgeColorExpression = useOpacityScale && attributeColor
          ? buildOpacityColorExpression(attribute, min, max, attributeColor, scaleType)
          : buildFillColorExpression(attribute, min, max, attributeColor, scaleType);

        if (!map.getLayer(edgeBlendLayerId)) {
          map.addLayer({
            id: edgeBlendLayerId,
            type: 'line',
            source: sourceId,
            paint: {
              'line-color': edgeColorExpression,
              'line-width': CHOROPLETH_EDGE_BLEND_WIDTH,
              'line-blur': CHOROPLETH_EDGE_BLEND_BLUR,
              'line-opacity': CHOROPLETH_EDGE_BLEND_OPACITY,
            },
          });
        } else {
          map.setPaintProperty(edgeBlendLayerId, 'line-color', edgeColorExpression);
          map.setPaintProperty(edgeBlendLayerId, 'line-width', CHOROPLETH_EDGE_BLEND_WIDTH);
          map.setPaintProperty(edgeBlendLayerId, 'line-blur', CHOROPLETH_EDGE_BLEND_BLUR);
          map.setPaintProperty(edgeBlendLayerId, 'line-opacity', CHOROPLETH_EDGE_BLEND_OPACITY);
        }
      }

      moveSiteBoundaryToTop(map);
      map.triggerRepaint();
    } catch (err) {
      console.error(`Error adding choropleth layer for ${side}:`, err);
    }
  }

  /**
   * Move site boundary layers to top of layer stack
   */
  function moveSiteBoundaryToTop(map: maplibregl.Map) {
    // Re-add site boundary layers on top by removing and re-adding them
    if (!map.getSource(SITE_BOUNDARY_SOURCE)) {
      return; // No boundary source, nothing to move
    }

    try {
      if (map.getLayer(SITE_BOUNDARY_GLOW_OUTER)) {
        map.moveLayer(SITE_BOUNDARY_GLOW_OUTER);
      }
      if (map.getLayer(SITE_BOUNDARY_OFFWHITE)) {
        map.moveLayer(SITE_BOUNDARY_OFFWHITE);
      }
      if (map.getLayer(SITE_BOUNDARY_GLOW_MIDDLE)) {
        map.moveLayer(SITE_BOUNDARY_GLOW_MIDDLE);
      }
      if (map.getLayer(SITE_BOUNDARY_LINE)) {
        map.moveLayer(SITE_BOUNDARY_LINE);
      }
    } catch (err) {
      console.error('Error moving site boundary to top:', err);
    }
  }

  /**
   * Debounced version of applyColors for map move events.
   */
  const debouncedApplyColors = useCallback(() => {
    if (fetchTimerRef.current) {
      clearTimeout(fetchTimerRef.current);
    }
    fetchTimerRef.current = window.setTimeout(() => {
      applyColorsRef.current();
    }, FETCH_DEBOUNCE_MS);
  }, []);

  // Toggle identify mode
  const toggleIdentifyMode = useCallback(() => {
    setIsIdentifyMode(prev => !prev);
  }, []);

  const toggleChoropleth = useCallback(() => {
    setIsChoroplethEnabled((prev) => !prev);
  }, []);

  // Google basemap toggle state. Defaults on for the browser runtime.
  const [isGoogleBasemap, setIsGoogleBasemap] = useState(() => getAppRuntime() === 'browser');
  const isGoogleBasemapRef = useRef(getAppRuntime() === 'browser');

  const toggleGoogleBasemap = useCallback(() => {
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;
    if (!leftMap || !rightMap) return;

    const nextVal = !isGoogleBasemapRef.current;
    isGoogleBasemapRef.current = nextVal;
    setIsGoogleBasemap(nextVal);

    const newStyle: maplibregl.StyleSpecification | string = nextVal
      ? GOOGLE_BASEMAP_STYLE
      : (window.location.origin + '/data/style.json');

    const reapplyAfterStyleLoad = (map: maplibregl.Map) => {
      const onStyleData = () => {
        if (!map.isStyleLoaded()) return;
        map.off('styledata', onStyleData);
        // Viewport clipping persists through setStyle, but re-apply to be safe
        const bounds = viewportBoundsRef.current;
        if (bounds) applyZoomOutClipToBounds(map, bounds);
      };
      map.on('styledata', onStyleData);
    };

    reapplyAfterStyleLoad(leftMap);
    reapplyAfterStyleLoad(rightMap);

    leftMap.setStyle(newStyle);
    rightMap.setStyle(newStyle);

    // Re-apply boundary and choropleth layers after styles settle
    window.setTimeout(() => {
      reapplyBoundaryLayers();
      applyColorsRef.current();
    }, 400);
  }, [reapplyBoundaryLayers]);

  // Toggle split-screen swiper on/off
  const toggleSwiper = useCallback(() => {
    const next = !isSwiperEnabled;
    if (isSwiperEnabledProp === undefined) {
      setInternalSwiperEnabled(next);
    }
    onSwiperEnabledChange?.(next);
  }, [isSwiperEnabled, isSwiperEnabledProp, onSwiperEnabledChange]);

  const deriveBoundsFromGeometry = useCallback((geometry: GeoJSON.Geometry | null): BoundingBox | null => {
    if (!geometry) return null;

    try {
      const [minX, minY, maxX, maxY] = turfBbox({
        type: 'Feature',
        properties: {},
        geometry,
      } as GeoJSON.Feature) as [number, number, number, number];

      return { minX, minY, maxX, maxY };
    } catch (err) {
      console.error('Failed to derive site bounds from geometry:', err);
      return null;
    }
  }, []);

  const resolveSiteBounds = useCallback(async (): Promise<BoundingBox | null> => {
    if (siteBounds) return siteBounds;

    const geometryBounds = deriveBoundsFromGeometry(siteGeometryRef.current ?? null);
    if (geometryBounds) return geometryBounds;

    if (!siteId) return null;

    try {
      const site = await getSite(siteId);
      if (site?.boundingBox) return site.boundingBox;
      return deriveBoundsFromGeometry(site?.geometry ?? null);
    } catch (err) {
      console.error('Failed to fetch site bounds:', err);
      return null;
    }
  }, [siteBounds, siteId, deriveBoundsFromGeometry]);

  // Zoom to site bounds with 10% padding
  const zoomToSite = useCallback(async (extraOptions?: Partial<maplibregl.FitBoundsOptions>) => {
    if (!leftMapRef.current) return;

    const resolvedBounds = await resolveSiteBounds();
    if (!resolvedBounds) return;

    const fit = () => {
      const map = leftMapRef.current;
      if (!map) return;
      // Sync the canvas to the container's current size first: the site-open
      // action that triggers this zoom also opens the control panel (0.3s
      // transition), and switching layout mode (e.g. single -> quad) resizes
      // this map's own container via the 0.6s grid-template-columns
      // transition in ContentArea. If the container is still mid-transition,
      // fitBounds below would target the pre-transition size.
      map.resize();
      map.fitBounds(padBoundsForFit(resolvedBounds), {
        padding: 50,
        duration: 1000,
        maxZoom: 14,
        ...extraOptions,
      });
    };

    fit();
    // Re-fit once the slower of the two transitions above (the 0.6s quad
    // grid layout change) has settled, correcting any mis-fit from measuring
    // the container mid-transition. 400ms was long enough for the 0.3s panel
    // transition alone but fired before a 0.6s grid transition finished,
    // leaving the zoom stuck at whatever intermediate size it measured -
    // matches the resize effect's own 650ms buffer for this same transition.
    window.setTimeout(fit, 650);
  }, [resolveSiteBounds]);

  // Toggle 3D mode - smoothly ease pitch between 0 and 60 degrees
  // and rebuild layers with/without extrusion
  const apply3DMode = useCallback((nextMode: boolean) => {
    const targetPitch = nextMode ? 60 : 0;
    if (leftMapRef.current) {
      leftMapRef.current.easeTo({ pitch: targetPitch, duration: 800 });
    }
    if (rightMapRef.current) {
      rightMapRef.current.easeTo({ pitch: targetPitch, duration: 800 });
    }

    // Update the ref immediately so applyColors reads the new value
    is3DModeRef.current = nextMode;
    // Rebuild layers with extrusion toggled
    applyColors();
  }, [applyColors]);

  const toggle3DMode = useCallback(() => {
    const nextMode = !is3DModeRef.current;
    if (is3DModeProp === undefined) {
      setInternal3DMode(nextMode);
    }
    on3DModeChange?.(nextMode);
    apply3DMode(nextMode);
  }, [apply3DMode, is3DModeProp, on3DModeChange]);

  useEffect(() => {
    if (is3DModeRef.current === is3DMode) return;
    apply3DMode(is3DMode);
  }, [apply3DMode, is3DMode]);

  // Update cursor when identify mode changes
  useEffect(() => {
    const cursor = isIdentifyMode ? 'crosshair' : '';
    if (leftMapRef.current) {
      leftMapRef.current.getCanvas().style.cursor = cursor;
    }
    if (rightMapRef.current) {
      rightMapRef.current.getCanvas().style.cursor = cursor;
    }
  }, [isIdentifyMode]);

  // Handle identify click via MapLibre queryRenderedFeatures
  const handleIdentifyClick = useCallback((map: maplibregl.Map, e: maplibregl.MapMouseEvent, side: 'left' | 'right') => {
    if (!isIdentifyModeRef.current || !onIdentifyRef.current) return;

    // Check for site boundary line click first — show site indicators popup if hit
    const siteBoundaryLayers: string[] = [];
    if (map.getLayer(SITE_BOUNDARY_LINE)) siteBoundaryLayers.push(SITE_BOUNDARY_LINE);
    if (map.getLayer(SITE_BOUNDARY_OFFWHITE)) siteBoundaryLayers.push(SITE_BOUNDARY_OFFWHITE);

    if (siteBoundaryLayers.length > 0) {
      const siteFeatures = map.queryRenderedFeatures(e.point, { layers: siteBoundaryLayers });
      const currentSiteIndicators = siteIndicatorsRef.current;
      if (siteFeatures.length > 0 && currentSiteIndicators) {
        const details = attributeDetailsRef.current;
        const allKeys = new Set<string>([
          ...Object.keys(currentSiteIndicators.reference ?? {}),
          ...Object.keys(currentSiteIndicators.current ?? {}),
        ]);

        const rows = Array.from(allKeys)
          .sort()
          .map((key) => {
            const refVal = currentSiteIndicators.reference?.[key];
            const curVal = currentSiteIndicators.current?.[key];
            const refNumeric = getNumericIdentifyValue(refVal);
            const curNumeric = getNumericIdentifyValue(curVal);
            if (refNumeric === null && curNumeric === null) return null;
            const trend = getComparisonTrend(refNumeric, curNumeric);
            const delta = refNumeric === null || curNumeric === null ? null : curNumeric - refNumeric;
            const referenceMagnitude = refNumeric === null ? 1 : Math.abs(refNumeric) || 1;
            const trendRatio = delta === null ? 0 : Math.min(1, Math.abs(delta) / referenceMagnitude);
            const trendWidthPx = delta === null ? 0 : Math.max(2, trendRatio * 26);
            return {
              label: details[key] ?? key,
              ref: formatIdentifyValue(refVal),
              cur: formatIdentifyValue(curVal),
              trend,
              delta,
              trendWidthPx,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);

        const popupContainer = document.createElement('div');
        popupContainer.style.cssText = `
          position:absolute;z-index:20;transform:translate(-50%,calc(-100% - 12px));
          min-width:300px;max-height:340px;overflow-y:auto;
          font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
          background:#1A202C;color:#E2E8F0;padding:8px;border-radius:8px;
        `.trim().replace(/\n\s+/g, '');

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;';

        const title = document.createElement('div');
        title.style.cssText = 'font-weight:700;color:#F7FAFC;font-size:13px;';
        title.textContent = 'Site Indicators';

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.textContent = 'x';
        closeButton.style.cssText = 'background:transparent;border:1px solid #4A5568;color:#E2E8F0;border-radius:4px;width:22px;height:22px;cursor:pointer;line-height:18px;font-weight:700;';

        header.appendChild(title);
        header.appendChild(closeButton);
        popupContainer.appendChild(header);

        if (rows.length === 0) {
          const empty = document.createElement('div');
          empty.style.cssText = 'font-size:12px;color:#A0AEC0;';
          empty.textContent = 'No indicator values available.';
          popupContainer.appendChild(empty);
        } else {
          const table = document.createElement('table');
          table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;';

          const headerRow = document.createElement('tr');
          for (const [text, align] of [['Attribute', 'left'], ['Reference', 'right'], ['Current', 'right'], ['Departure from ref.', 'left']] as const) {
            const th = document.createElement('th');
            th.textContent = text;
            th.style.cssText = `text-align:${align};padding:4px 6px;color:#CBD5E0;position:sticky;top:0;background:#1A202C;z-index:1;`;
            headerRow.appendChild(th);
          }
          table.appendChild(headerRow);

          for (const row of rows) {
            const tr = document.createElement('tr');

            const attrCell = document.createElement('td');
            attrCell.textContent = row.label;
            attrCell.style.cssText = 'padding:3px 6px;border-top:1px solid #4A5568;';

            const refCell = document.createElement('td');
            refCell.textContent = row.ref;
            refCell.style.cssText = 'padding:3px 6px;text-align:right;border-top:1px solid #4A5568;';

            const curCell = document.createElement('td');
            curCell.textContent = row.cur;
            curCell.style.cssText = 'padding:3px 6px;text-align:right;border-top:1px solid #4A5568;';

            const trendCell = document.createElement('td');
            trendCell.style.cssText = 'padding:3px 6px;border-top:1px solid #4A5568;min-width:72px;';

            const trendChart = document.createElement('div');
            trendChart.style.cssText = 'position:relative;width:68px;height:12px;';

            const refLine = document.createElement('div');
            refLine.style.cssText = 'position:absolute;left:50%;top:1px;bottom:1px;width:2px;transform:translateX(-1px);border-radius:9999px;background:#A0AEC0;';
            trendChart.appendChild(refLine);

            if (row.delta === null) {
              const dot = document.createElement('div');
              dot.style.cssText = 'position:absolute;left:50%;top:4px;width:4px;height:4px;transform:translateX(-2px);border-radius:9999px;background:#718096;';
              trendChart.appendChild(dot);
            } else if (row.delta === 0) {
              const dot = document.createElement('div');
              dot.style.cssText = 'position:absolute;left:50%;top:4px;width:4px;height:4px;transform:translateX(-2px);border-radius:9999px;background:#A0AEC0;';
              trendChart.appendChild(dot);
            } else {
              const bar = document.createElement('div');
              const leftPos = row.delta > 0 ? 'calc(50% + 1px)' : `calc(50% - ${row.trendWidthPx + 1}px)`;
              bar.style.cssText = `position:absolute;top:5px;height:2px;width:${row.trendWidthPx}px;border-radius:9999px;background:${row.trend === 'up' ? '#FC8181' : '#63B3ED'};left:${leftPos};`;
              trendChart.appendChild(bar);
            }

            trendCell.appendChild(trendChart);
            tr.appendChild(attrCell);
            tr.appendChild(refCell);
            tr.appendChild(curCell);
            tr.appendChild(trendCell);
            table.appendChild(tr);
          }
          popupContainer.appendChild(table);
        }

        const pointer = document.createElement('div');
        pointer.style.cssText = 'position:absolute;left:50%;bottom:-8px;width:12px;height:12px;transform:translateX(-50%) rotate(45deg);background:#1A202C;';
        popupContainer.appendChild(pointer);

        removeIdentifyOverlay(false);
        const mapContainer = mapContainerRef.current;
        if (!mapContainer) return;

        identifyOverlayRef.current = popupContainer;
        identifyOverlayLngLatRef.current = [e.lngLat.lng, e.lngLat.lat];
        mapContainer.appendChild(popupContainer);
        updateIdentifyOverlayPosition();

        closeButton.onclick = () => { removeIdentifyOverlay(true); };
        return;
      }
    }

    // Build list of layers to query - include choropleth layers if they exist
    const layersToQuery: string[] = [];

    // Always try the catchments outline layer
    if (map.getLayer('Catchments Outlines')) {
      layersToQuery.push('Catchments Outlines');
    }

    // Add choropleth layers based on which side was clicked
    const choroplethLayer = side === 'left' ? CHOROPLETH_LAYER_LEFT : CHOROPLETH_LAYER_RIGHT;
    const choropleth3dLayer = side === 'left' ? CHOROPLETH_3D_LEFT : CHOROPLETH_3D_RIGHT;

    if (map.getLayer(choroplethLayer)) {
      layersToQuery.push(choroplethLayer);
    }
    if (map.getLayer(choropleth3dLayer)) {
      layersToQuery.push(choropleth3dLayer);
    }

    if (layersToQuery.length === 0) return;

    // Query for features at the click point
    const features = map.queryRenderedFeatures(e.point, {
      layers: layersToQuery,
    });

    if (features.length === 0) return;

    const feature = features[0];
    const catchId = feature.properties?.[CATCHMENT_ID_PROP];
    if (catchId == null) return;

    const catchIdStr = String(catchId);

    // Fetch full attributes from API
    fetch(`/api/catchment/${catchIdStr}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && onIdentifyRef.current) {
          onIdentifyRef.current({ catchmentID: catchIdStr, data });

          const currentComparison = comparisonRef.current;
          const leftScenario = currentComparison.leftScenario;
          const rightScenario = currentComparison.rightScenario;
          const leftLabel = SCENARIOS.find((entry) => entry.id === leftScenario)?.label || leftScenario;
          const rightLabel = SCENARIOS.find((entry) => entry.id === rightScenario)?.label || rightScenario;
          const details = attributeDetailsRef.current;

          const scenarioData = data as Record<string, Record<string, unknown>>;
          const allAttributes = new Set<string>();
          for (const values of Object.values(scenarioData)) {
            for (const attr of Object.keys(values)) {
              allAttributes.add(attr);
            }
          }

          const rows = Array.from(allAttributes)
            .sort()
            .map((attr) => {
              const leftValue = scenarioData[leftScenario]?.[attr];
              const rightValue = scenarioData[rightScenario]?.[attr];

              if (isNAValue(leftValue) || isNAValue(rightValue)) {
                return null;
              }

              const leftNumeric = getNumericIdentifyValue(leftValue);
              const rightNumeric = getNumericIdentifyValue(rightValue);
              if (leftNumeric === 0 && rightNumeric === 0) {
                return null;
              }
              const trend = getComparisonTrend(leftNumeric, rightNumeric);
              const delta = leftNumeric === null || rightNumeric === null
                ? null
                : rightNumeric - leftNumeric;
              const referenceMagnitude = leftNumeric === null ? 1 : Math.abs(leftNumeric) || 1;
              const trendRatio = delta === null ? 0 : Math.min(1, Math.abs(delta) / referenceMagnitude);
              const trendWidthPx = delta === null ? 0 : Math.max(2, trendRatio * 26);

              return {
                label: details[attr] ?? attr,
                left: formatIdentifyValue(leftValue),
                right: formatIdentifyValue(rightValue),
                trend,
                delta,
                trendWidthPx,
              };
            })
            .filter((row): row is { label: string; left: string; right: string; trend: 'up' | 'down' | 'neutral'; delta: number | null; trendWidthPx: number } => row !== null);

          const popupContainer = document.createElement('div');
          popupContainer.style.position = 'absolute';
          popupContainer.style.zIndex = '20';
          popupContainer.style.transform = 'translate(-50%, calc(-100% - 12px))';
          popupContainer.style.minWidth = '280px';
          popupContainer.style.maxHeight = '300px';
          popupContainer.style.overflowY = 'auto';
          popupContainer.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
          popupContainer.style.background = '#1A202C';
          popupContainer.style.color = '#E2E8F0';
          popupContainer.style.padding = '8px';
          popupContainer.style.borderRadius = '8px';

          const header = document.createElement('div');
          header.style.display = 'flex';
          header.style.alignItems = 'center';
          header.style.justifyContent = 'space-between';
          header.style.marginBottom = '8px';

          const title = document.createElement('div');
          title.style.fontWeight = '700';
          title.style.color = '#F7FAFC';
          title.textContent = `Catchment ${catchIdStr}`;

          const closeButton = document.createElement('button');
          closeButton.type = 'button';
          closeButton.textContent = 'x';
          closeButton.style.background = 'transparent';
          closeButton.style.border = '1px solid #4A5568';
          closeButton.style.color = '#E2E8F0';
          closeButton.style.borderRadius = '4px';
          closeButton.style.width = '22px';
          closeButton.style.height = '22px';
          closeButton.style.cursor = 'pointer';
          closeButton.style.lineHeight = '18px';
          closeButton.style.fontWeight = '700';

          header.appendChild(title);
          header.appendChild(closeButton);
          popupContainer.appendChild(header);

          const table = document.createElement('table');
          table.style.width = '100%';
          table.style.borderCollapse = 'collapse';
          table.style.fontSize = '12px';

          const headerRow = document.createElement('tr');
          const attrHead = document.createElement('th');
          attrHead.textContent = 'Attribute';
          attrHead.style.textAlign = 'left';
          attrHead.style.padding = '4px 6px';
          attrHead.style.color = '#CBD5E0';
          attrHead.style.position = 'sticky';
          attrHead.style.top = '0';
          attrHead.style.background = '#1A202C';
          attrHead.style.zIndex = '1';

          const leftHead = document.createElement('th');
          leftHead.textContent = leftLabel;
          leftHead.style.textAlign = 'right';
          leftHead.style.padding = '4px 6px';
          leftHead.style.color = '#CBD5E0';
          leftHead.style.position = 'sticky';
          leftHead.style.top = '0';
          leftHead.style.background = '#1A202C';
          leftHead.style.zIndex = '1';

          const rightHead = document.createElement('th');
          rightHead.textContent = rightLabel;
          rightHead.style.textAlign = 'right';
          rightHead.style.padding = '4px 6px';
          rightHead.style.color = '#CBD5E0';
          rightHead.style.position = 'sticky';
          rightHead.style.top = '0';
          rightHead.style.background = '#1A202C';
          rightHead.style.zIndex = '1';

          const trendHead = document.createElement('th');
          trendHead.textContent = 'Departure from reference';
          trendHead.style.textAlign = 'left';
          trendHead.style.padding = '4px 6px';
          trendHead.style.color = '#CBD5E0';
          trendHead.style.position = 'sticky';
          trendHead.style.top = '0';
          trendHead.style.background = '#1A202C';
          trendHead.style.zIndex = '1';

          headerRow.appendChild(attrHead);
          headerRow.appendChild(leftHead);
          headerRow.appendChild(rightHead);
          headerRow.appendChild(trendHead);
          table.appendChild(headerRow);

          for (const row of rows) {
            const tr = document.createElement('tr');

            const attrCell = document.createElement('td');
            attrCell.textContent = row.label;
            attrCell.style.padding = '3px 6px';
            attrCell.style.borderTop = '1px solid #4A5568';

            const leftCell = document.createElement('td');
            leftCell.textContent = row.left;
            leftCell.style.padding = '3px 6px';
            leftCell.style.textAlign = 'right';
            leftCell.style.borderTop = '1px solid #4A5568';

            const rightCell = document.createElement('td');
            rightCell.textContent = row.right;
            rightCell.style.padding = '3px 6px';
            rightCell.style.textAlign = 'right';
            rightCell.style.borderTop = '1px solid #4A5568';

            const trendCell = document.createElement('td');
            trendCell.style.padding = '3px 6px';
            trendCell.style.borderTop = '1px solid #4A5568';
            trendCell.style.minWidth = '72px';

            const trendChart = document.createElement('div');
            trendChart.style.position = 'relative';
            trendChart.style.width = '68px';
            trendChart.style.height = '12px';

            const referenceLine = document.createElement('div');
            referenceLine.style.position = 'absolute';
            referenceLine.style.left = '50%';
            referenceLine.style.top = '1px';
            referenceLine.style.bottom = '1px';
            referenceLine.style.width = '2px';
            referenceLine.style.transform = 'translateX(-1px)';
            referenceLine.style.borderRadius = '9999px';
            referenceLine.style.background = '#A0AEC0';
            trendChart.appendChild(referenceLine);

            if (row.delta === null) {
              const naDot = document.createElement('div');
              naDot.style.position = 'absolute';
              naDot.style.left = '50%';
              naDot.style.top = '4px';
              naDot.style.width = '4px';
              naDot.style.height = '4px';
              naDot.style.transform = 'translateX(-2px)';
              naDot.style.borderRadius = '9999px';
              naDot.style.background = '#718096';
              trendChart.appendChild(naDot);
            } else if (row.delta === 0) {
              const neutralDot = document.createElement('div');
              neutralDot.style.position = 'absolute';
              neutralDot.style.left = '50%';
              neutralDot.style.top = '4px';
              neutralDot.style.width = '4px';
              neutralDot.style.height = '4px';
              neutralDot.style.transform = 'translateX(-2px)';
              neutralDot.style.borderRadius = '9999px';
              neutralDot.style.background = '#A0AEC0';
              trendChart.appendChild(neutralDot);
            } else {
              const deltaBar = document.createElement('div');
              deltaBar.style.position = 'absolute';
              deltaBar.style.top = '5px';
              deltaBar.style.height = '2px';
              deltaBar.style.width = `${row.trendWidthPx}px`;
              deltaBar.style.borderRadius = '9999px';
              deltaBar.style.background = row.trend === 'up' ? '#FC8181' : '#63B3ED';
              deltaBar.style.left = row.delta > 0
                ? 'calc(50% + 1px)'
                : `calc(50% - ${row.trendWidthPx + 1}px)`;
              trendChart.appendChild(deltaBar);
            }

            trendCell.appendChild(trendChart);

            tr.appendChild(attrCell);
            tr.appendChild(leftCell);
            tr.appendChild(rightCell);
            tr.appendChild(trendCell);
            table.appendChild(tr);
          }

          if (rows.length === 0) {
            const empty = document.createElement('div');
            empty.style.fontSize = '12px';
            empty.style.color = '#A0AEC0';
            empty.textContent = 'No comparable values available.';
            popupContainer.appendChild(empty);
          } else {
            popupContainer.appendChild(table);
          }

          const pointer = document.createElement('div');
          pointer.style.position = 'absolute';
          pointer.style.left = '50%';
          pointer.style.bottom = '-8px';
          pointer.style.width = '12px';
          pointer.style.height = '12px';
          pointer.style.transform = 'translateX(-50%) rotate(45deg)';
          pointer.style.background = '#1A202C';
          popupContainer.appendChild(pointer);

          removeIdentifyOverlay(false);

          const mapContainer = mapContainerRef.current;
          if (!mapContainer) {
            return;
          }

          identifyOverlayRef.current = popupContainer;
          identifyOverlayLngLatRef.current = [e.lngLat.lng, e.lngLat.lat];
          mapContainer.appendChild(popupContainer);
          updateIdentifyOverlayPosition();

          closeButton.onclick = () => {
            removeIdentifyOverlay(true);
          };
        }
      })
      .catch((err) => console.error('Identify error:', err));
  }, [removeIdentifyOverlay, updateIdentifyOverlayPosition]);

  // Initialize the two maps and the compare slider
  useEffect(() => {
    if (!mapContainerRef.current) return;

    const container = mapContainerRef.current;

    // Create the left and right map containers
    // Left container - clips at the slider position
    // Use z-index:2 so it renders above any React overlay elements
    const leftClipContainer = document.createElement('div');
    leftClipContainer.style.cssText = 'position:absolute;top:0;left:0;width:0%;height:100%;overflow:hidden;z-index:2;';
    leftClipContainer.id = 'map-left-clip';

    const leftContainer = document.createElement('div');
    leftContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
    leftContainer.id = 'map-left';

    // Right container - clips at the slider position
    // Use z-index:2 so it renders above any React overlay elements (same level as left)
    const rightClipContainer = document.createElement('div');
    rightClipContainer.style.cssText = 'position:absolute;top:0;right:0;width:100%;height:100%;overflow:hidden;z-index:2;';
    rightClipContainer.id = 'map-right-clip';

    const rightContainer = document.createElement('div');
    rightContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
    rightContainer.id = 'map-right';

    // Append containers
    leftClipContainer.appendChild(leftContainer);
    rightClipContainer.appendChild(rightContainer);

    // Size both maps to match the full parent width, with proper offsets
    function updateMapSizes() {
      const parentWidth = container.offsetWidth;
      const rightClipWidth = rightClipContainer.offsetWidth;

      // Left map: full width, positioned at 0
      leftContainer.style.width = parentWidth + 'px';

      // Right map: full width, offset to align with visible portion
      rightContainer.style.width = parentWidth + 'px';
      rightContainer.style.left = -(parentWidth - rightClipWidth) + 'px';
    }

    container.appendChild(leftClipContainer);
    container.appendChild(rightClipContainer);

    // Create the slider with touch-action to prevent browser gestures
    const slider = document.createElement('div');
    slider.style.cssText = `
      position:absolute;
      top:0;
      left:0%;
      width:12px;
      height:100%;
      background:white;
      z-index:10;
      cursor:ew-resize;
      box-shadow:0 0 8px rgba(0,0,0,0.4);
      transform:translateX(-50%);
      touch-action:none;
      transition:background 0.2s ease, box-shadow 0.2s ease, width 0.2s ease;
    `;

    // Slider handle
    const handle = document.createElement('div');
    handle.id = 'tour-map-swiper';
    handle.style.cssText = `
      position:absolute;
      top:50%;
      left:50%;
      transform:translate(-50%,-50%);
      width:40px;
      height:40px;
      border-radius:50%;
      background:white;
      box-shadow:0 2px 12px rgba(0,0,0,0.3);
      display:flex;
      align-items:center;
      justify-content:center;
      cursor:ew-resize;
      transition:border-radius 0.2s ease, left 0.2s ease, transform 0.2s ease;
    `;

    // SVG icons for different states
    const ARROWS_BOTH = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 4L3 10L7 16" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 4L17 10L13 16" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const ARROW_RIGHT = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 4L16 10L10 16" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const ARROW_LEFT = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 4L4 10L10 16" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    handle.innerHTML = ARROWS_BOTH;

    // Docking threshold (percentage from edge to trigger dock)
    const DOCK_THRESHOLD = 3;

    // Update slider visuals based on docked state
    function updateSliderVisuals(docked: 'left' | 'right' | null) {
      if (docked === sliderDockedRef.current) return;
      sliderDockedRef.current = docked;

      if (docked === 'left') {
        // Docked left - half circle on right side
        slider.style.background = 'transparent';
        slider.style.boxShadow = 'none';
        slider.style.width = '6px';
        handle.style.borderRadius = '0 50% 50% 0';
        handle.style.left = '100%';
        handle.style.transform = 'translate(0, -50%)';
        handle.innerHTML = ARROW_RIGHT;
      } else if (docked === 'right') {
        // Docked right - half circle on left side
        slider.style.background = 'transparent';
        slider.style.boxShadow = 'none';
        slider.style.width = '6px';
        handle.style.borderRadius = '50% 0 0 50%';
        handle.style.left = '0';
        handle.style.transform = 'translate(-100%, -50%)';
        handle.innerHTML = ARROW_LEFT;
      } else {
        // Undocked - normal state
        slider.style.background = 'white';
        slider.style.boxShadow = '0 0 8px rgba(0,0,0,0.4)';
        slider.style.width = '12px';
        handle.style.borderRadius = '50%';
        handle.style.left = '50%';
        handle.style.transform = 'translate(-50%, -50%)';
        handle.innerHTML = ARROWS_BOTH;
      }
    }

    slider.appendChild(handle);
    container.appendChild(slider);
    sliderRef.current = slider;
    sliderHandleRef.current = handle;
    leftClipContainerRef.current = leftClipContainer;
    compareContainerRef.current = rightClipContainer;

    // Scenario labels on each side
    const leftLabel = document.createElement('div');
    leftLabel.id = 'left-label';
    leftLabel.style.cssText = `
      position:absolute;
      top:12px;
      left:12px;
      z-index:5;
      background:rgba(0,0,0,0.7);
      color:white;
      padding:6px 14px;
      border-radius:20px;
      font-size:13px;
      font-weight:600;
      letter-spacing:0.5px;
      backdrop-filter:blur(8px);
    `;
    container.appendChild(leftLabel);

    const rightLabel = document.createElement('div');
    rightLabel.id = 'right-label';
    rightLabel.style.cssText = `
      position:absolute;
      top:12px;
      right:12px;
      z-index:5;
      background:rgba(0,0,0,0.7);
      color:white;
      padding:6px 14px;
      border-radius:20px;
      font-size:13px;
      font-weight:600;
      letter-spacing:0.5px;
      backdrop-filter:blur(8px);
    `;
    container.appendChild(rightLabel);

    // Indicator label (centered over split line)
    const indicatorLabel = document.createElement('div');
    indicatorLabel.id = 'indicator-label';
    indicatorLabel.style.cssText = `
      position:absolute;
      top:12px;
      left:50%;
      transform:translateX(-50%);
      z-index:15;
      background:rgba(0,0,0,0.85);
      color:white;
      padding:8px 20px;
      border-radius:20px;
      font-size:14px;
      font-weight:600;
      letter-spacing:0.5px;
      backdrop-filter:blur(8px);
      white-space:nowrap;
      max-width:60%;
      overflow:hidden;
      text-overflow:ellipsis;
    `;
    container.appendChild(indicatorLabel);

    // Load style from server (mbtiles base layers)
    const styleUrl = window.location.origin + '/data/style.json';
    // Kick off the style fetch (no-op if another pane already started it) so
    // it's warm and ready the moment the user toggles off the Google basemap.
    warmStyleCache(styleUrl);
    // Use the cached object if available (staggered panes will find it ready),
    // otherwise fall back to the URL so MapLibre fetches it normally. Browser
    // runtime starts on the Google basemap (see isGoogleBasemapRef default).
    const mapStyle = isGoogleBasemapRef.current ? GOOGLE_BASEMAP_STYLE : getStyleForMap(styleUrl);

    // Set initial sizes BEFORE creating maps so they initialize with correct dimensions
    updateMapSizes();

    // Create left map with all interactions enabled
    const leftMap = new maplibregl.Map({
      container: leftContainer,
      style: mapStyle,
      center: [20, 0],
      zoom: 3,
      pitch: is3DModeRef.current ? 60 : 0,
      attributionControl: false,
      fadeDuration: 0,
      scrollZoom: true,
      dragPan: true,
      dragRotate: true,
      doubleClickZoom: true,
      boxZoom: true,
      keyboard: true,
      touchZoomRotate: true,
      touchPitch: true,
    });
    leftMap.addControl(new maplibregl.NavigationControl(), 'bottom-left');

    // Create right map with all interactions enabled
    const rightMap = new maplibregl.Map({
      container: rightContainer,
      style: mapStyle,
      center: [20, 0],
      zoom: 3,
      pitch: is3DModeRef.current ? 60 : 0,
      attributionControl: false,
      fadeDuration: 0,
      scrollZoom: true,
      dragPan: true,
      dragRotate: true,
      doubleClickZoom: true,
      boxZoom: true,
      keyboard: true,
      touchZoomRotate: true,
      touchPitch: true,
    });
    rightMap.addControl(new maplibregl.NavigationControl(), 'bottom-left');

    const applyViewportLimits = () => {
      const bounds = viewportBoundsRef.current;
      if (!bounds) return;
      applyZoomOutClipToBounds(leftMap, bounds);
      applyZoomOutClipToBounds(rightMap, bounds);
    };

    void (async () => {
      const bounds = await fetchCatchmentBounds() ?? await fetchTileBounds();
      if (!bounds) return;
      viewportBoundsRef.current = bounds;
      applyViewportLimits();
    })();

    // Initial sizing of map containers
    updateMapSizes();

    // Sync the two maps
    let syncing = false;
    function syncMaps(source: maplibregl.Map, target: maplibregl.Map) {
      if (syncing) return;
      syncing = true;
      target.jumpTo({
        center: source.getCenter(),
        zoom: source.getZoom(),
        bearing: source.getBearing(),
        pitch: source.getPitch(),
      });
      syncing = false;
    }

    leftMap.on('move', () => {
      syncMaps(leftMap, rightMap);
      updateIdentifyOverlayPosition();
    });
    rightMap.on('move', () => syncMaps(rightMap, leftMap));

    // Identify click handlers - pass side info for correct layer querying
    leftMap.on('click', (e) => handleIdentifyClick(leftMap, e, 'left'));
    rightMap.on('click', (e) => handleIdentifyClick(rightMap, e, 'right'));

    // Fetch new choropleth data when map moves (debounced)
    leftMap.on('moveend', () => {
      debouncedApplyColors();
      // Report map extent changes
      if (onMapExtentChangeRef.current) {
        const center = leftMap.getCenter();
        const bounds = leftMap.getBounds();
        onMapExtentChangeRef.current({
          center: [center.lng, center.lat],
          zoom: leftMap.getZoom(),
          bounds: [
            bounds.getWest(),
            bounds.getSouth(),
            bounds.getEast(),
            bounds.getNorth(),
          ],
        });
      }
    });
    leftMap.on('zoomend', () => debouncedApplyColors());

    // When maps are loaded, mark ready, resize, and apply initial colours.
    // setAreMapsReady is called only once BOTH maps have loaded so the boundary
    // effect always runs with both maps in a fully styled state.
    // reapplyBoundaryLayers() is also called directly here to avoid relying on
    // the React effect cycle, which can be delayed for freshly-mounted panes
    // (e.g. panes 1-3 when switching from single to quad view).
    // Force tile re-evaluation after resize — resize() alone doesn't always
    // trigger maplibre to re-request tiles for a newly-sized viewport.
    function resizeAndRefresh(map: maplibregl.Map) {
      updateMapSizes();
      map.resize();
      map.jumpTo({ center: map.getCenter(), zoom: map.getZoom() });
      const bounds = viewportBoundsRef.current;
      if (bounds) {
        applyZoomOutClipToBounds(map, bounds);
      }
    }

    const signalReady = () => {
      if (!onReadyFiredRef.current) {
        onReadyFiredRef.current = true;
        onReadyRef.current?.();
      }
    };

    leftMap.on('load', () => {
      mapsReady.current.left = true;
      signalReady();
      resizeAndRefresh(leftMap);
      if (mapsReady.current.right) {
        resizeAndRefresh(rightMap);
        applyColorsRef.current();
        setAreMapsReady(true);
        reapplyBoundaryLayers();
        // Deferred retry: ensures boundary is on top after applyColors async
        // continuation and React boundary effect have both completed.
        requestAnimationFrame(() => reapplyBoundaryLayers());
      }
    });
    rightMap.on('load', () => {
      mapsReady.current.right = true;
      signalReady();
      resizeAndRefresh(rightMap);
      if (mapsReady.current.left) {
        resizeAndRefresh(leftMap);
        applyColorsRef.current();
        setAreMapsReady(true);
        reapplyBoundaryLayers();
        // Deferred retry: ensures boundary is on top after applyColors async
        // continuation and React boundary effect have both completed.
        requestAnimationFrame(() => reapplyBoundaryLayers());
      }
    });

    // Safety-net: if neither map fires 'load' within 15 s, dismiss the spinner
    // anyway so the app isn't permanently unusable. This guards against rare
    // fatal MapLibre errors (bad style, WebGL context loss) that skip 'load'.
    const readyTimeoutId = setTimeout(signalReady, 15_000);

    leftMapRef.current = leftMap;
    rightMapRef.current = rightMap;

    // Register the left map for cross-pane sync
    const syncId = registerMap(leftMap);

    // Slider drag handling with proper isolation from map events
    let sliderPointerId: number | null = null;

    function onSliderPointerDown(e: PointerEvent) {
      if (!isSwiperEnabledRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      isDragging.current = true;
      sliderPointerId = e.pointerId;
      slider.setPointerCapture(e.pointerId);
      // Disable map interactions while dragging slider
      leftMap.dragPan.disable();
      rightMap.dragPan.disable();
    }

    function onSliderPointerMove(e: PointerEvent) {
      if (!isDragging.current || e.pointerId !== sliderPointerId) return;
      e.preventDefault();

      const rect = container.getBoundingClientRect();
      // Allow slider to reach edges (0 to 100%)
      const rawX = e.clientX - rect.left;
      const rawPercent = (rawX / rect.width) * 100;

      // Determine if we should dock
      let percent: number;
      let newDockedState: 'left' | 'right' | null = null;

      if (rawPercent <= DOCK_THRESHOLD) {
        // Dock to left edge
        percent = 0;
        newDockedState = 'left';
      } else if (rawPercent >= 100 - DOCK_THRESHOLD) {
        // Dock to right edge
        percent = 100;
        newDockedState = 'right';
      } else {
        // Normal undocked state - keep some margin for handle visibility
        const x = Math.max(20, Math.min(rawX, rect.width - 20));
        percent = (x / rect.width) * 100;
        newDockedState = null;
      }

      // Update slider position
      slider.style.left = `${percent}%`;

      // Update visuals for docked state
      updateSliderVisuals(newDockedState);

      // Update both clip containers
      leftClipContainer.style.width = `${percent}%`;
      rightClipContainer.style.width = `${100 - percent}%`;

      // Update clip-related sizing without resizing maps mid-drag
      if (resizeFrameRef.current === null) {
        resizeFrameRef.current = requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          updateMapSizes();
          updateIdentifyOverlayPosition();
        });
      }

      // Notify parent of position change for synchronization
      if (onSwiperPositionChange) {
        onSwiperPositionChange(percent);
      }
    }

    function onSliderPointerUp(e: PointerEvent) {
      if (e.pointerId !== sliderPointerId) return;
      isDragging.current = false;
      sliderPointerId = null;
      // Re-enable map interactions
      leftMap.dragPan.enable();
      rightMap.dragPan.enable();

      // Ensure a final resize after drag ends; add a tiny delay for layout settle
      window.setTimeout(() => {
        if (resizeFrameRef.current === null) {
          resizeFrameRef.current = requestAnimationFrame(() => {
            resizeFrameRef.current = null;
            updateMapSizes();
            leftMap.resize();
            rightMap.resize();
            updateIdentifyOverlayPosition();
          });
        }
      }, 80);
    }

    slider.addEventListener('pointerdown', onSliderPointerDown);
    slider.addEventListener('pointermove', onSliderPointerMove);
    slider.addEventListener('pointerup', onSliderPointerUp);
    slider.addEventListener('pointercancel', onSliderPointerUp);

    return () => {
      clearTimeout(readyTimeoutId);
      mapsReady.current = { left: false, right: false };
      onReadyFiredRef.current = false;
      setAreMapsReady(false);
      if (fetchTimerRef.current) {
        clearTimeout(fetchTimerRef.current);
      }
      unregisterMap(syncId);
      slider.removeEventListener('pointerdown', onSliderPointerDown);
      slider.removeEventListener('pointermove', onSliderPointerMove);
      slider.removeEventListener('pointerup', onSliderPointerUp);
      slider.removeEventListener('pointercancel', onSliderPointerUp);
      // Clear refs BEFORE removing maps to prevent other cleanup effects from
      // trying to access destroyed map instances
      leftMapRef.current = null;
      rightMapRef.current = null;
      removeIdentifyOverlay(false);
      leftMap.remove();
      rightMap.remove();
      leftClipContainerRef.current = null;
      compareContainerRef.current = null;
      sliderRef.current = null;
      sliderHandleRef.current = null;
      sliderDockedRef.current = null;
      indicatorLabel.remove();
      rightLabel.remove();
      leftLabel.remove();
      slider.remove();
      rightClipContainer.remove();
      leftClipContainer.remove();
    };
  }, [debouncedApplyColors, handleIdentifyClick, removeIdentifyOverlay, updateIdentifyOverlayPosition]);

  // Resize maps when layout changes or container size updates
  useEffect(() => {
    const container = mapContainerRef.current;
    const leftClipContainer = leftClipContainerRef.current;
    const rightClipContainer = compareContainerRef.current;
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;

    if (!container || !leftClipContainer || !rightClipContainer || !leftMap || !rightMap) {
      return;
    }

    const leftContainer = container.querySelector('#map-left') as HTMLDivElement | null;
    const rightContainer = container.querySelector('#map-right') as HTMLDivElement | null;
    if (!leftContainer || !rightContainer) return;

    const updateSizes = () => {
      const parentWidth = container.offsetWidth;
      const rightClipWidth = rightClipContainer.offsetWidth;
      leftContainer.style.width = `${parentWidth}px`;
      rightContainer.style.width = `${parentWidth}px`;
      rightContainer.style.left = `${-(parentWidth - rightClipWidth)}px`;
      leftMap.resize();
      rightMap.resize();

      const bounds = viewportBoundsRef.current;
      if (bounds) {
        applyZoomOutClipToBounds(leftMap, bounds);
        applyZoomOutClipToBounds(rightMap, bounds);
      }

      if (siteId) {
        reapplyBoundaryLayers();
      }
    };

    const scheduleResize = () => {
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        updateSizes();
      });
    };

    scheduleResize();

    const observer = new ResizeObserver(() => {
      scheduleResize();
    });
    observer.observe(container);

    const transitionTimer = window.setTimeout(updateSizes, 650);

    return () => {
      observer.disconnect();
      window.clearTimeout(transitionTimer);
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, [siteId, reapplyBoundaryLayers]);

  // Toggle split-screen layout and slider visibility
  useEffect(() => {
    const container = mapContainerRef.current;
    const leftClipContainer = leftClipContainerRef.current;
    const rightClipContainer = compareContainerRef.current;
    const slider = sliderRef.current;
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;

    if (!container || !leftClipContainer || !rightClipContainer || !slider || !leftMap || !rightMap) {
      return;
    }

    const leftContainer = container.querySelector('#map-left') as HTMLDivElement | null;
    const rightContainer = container.querySelector('#map-right') as HTMLDivElement | null;
    const rightLabel = container.querySelector('#right-label') as HTMLElement | null;

    if (!leftContainer || !rightContainer) return;

    if (isSwiperEnabled) {
      slider.style.display = 'block';
      slider.style.left = '0%';
      leftClipContainer.style.width = '0%';
      rightClipContainer.style.display = 'block';
      rightClipContainer.style.width = '100%';
      if (rightLabel) rightLabel.style.display = 'block';
    } else {
      slider.style.display = 'none';
      leftClipContainer.style.width = '100%';
      rightClipContainer.style.display = 'none';
      rightClipContainer.style.width = '0%';
      if (rightLabel) rightLabel.style.display = 'none';
    }

    const parentWidth = container.offsetWidth;
    const rightClipWidth = rightClipContainer.offsetWidth;
    leftContainer.style.width = `${parentWidth}px`;
    rightContainer.style.width = `${parentWidth}px`;
    rightContainer.style.left = `${-(parentWidth - rightClipWidth)}px`;

    leftMap.resize();
    rightMap.resize();
  }, [isSwiperEnabled]);

  // Synchronize slider position when prop changes (from another pane)
  useEffect(() => {
    if (swiperPosition === undefined || !isSwiperEnabled) return;

    const container = mapContainerRef.current;
    const slider = sliderRef.current;
    const handle = sliderHandleRef.current;
    const leftClipContainer = leftClipContainerRef.current;
    const rightClipContainer = compareContainerRef.current;
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;

    if (!container || !slider || !handle || !leftClipContainer || !rightClipContainer || !leftMap || !rightMap) return;

    // Don't update if we're currently dragging (to avoid feedback loop)
    if (isDragging.current) return;

    const leftContainer = container.querySelector('#map-left') as HTMLDivElement | null;
    const rightContainer = container.querySelector('#map-right') as HTMLDivElement | null;
    if (!leftContainer || !rightContainer) return;

    slider.style.left = `${swiperPosition}%`;
    leftClipContainer.style.width = `${swiperPosition}%`;
    rightClipContainer.style.width = `${100 - swiperPosition}%`;

    // Update docked state based on position
    const DOCK_THRESHOLD = 3;
    const ARROWS_BOTH = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 4L3 10L7 16" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 4L17 10L13 16" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const ARROW_RIGHT = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 4L16 10L10 16" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const ARROW_LEFT = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 4L4 10L10 16" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    let newDockedState: 'left' | 'right' | null = null;
    if (swiperPosition <= DOCK_THRESHOLD) {
      newDockedState = 'left';
    } else if (swiperPosition >= 100 - DOCK_THRESHOLD) {
      newDockedState = 'right';
    }

    if (newDockedState !== sliderDockedRef.current) {
      sliderDockedRef.current = newDockedState;

      if (newDockedState === 'left') {
        slider.style.background = 'transparent';
        slider.style.boxShadow = 'none';
        slider.style.width = '6px';
        handle.style.borderRadius = '0 50% 50% 0';
        handle.style.left = '100%';
        handle.style.transform = 'translate(0, -50%)';
        handle.innerHTML = ARROW_RIGHT;
      } else if (newDockedState === 'right') {
        slider.style.background = 'transparent';
        slider.style.boxShadow = 'none';
        slider.style.width = '6px';
        handle.style.borderRadius = '50% 0 0 50%';
        handle.style.left = '0';
        handle.style.transform = 'translate(-100%, -50%)';
        handle.innerHTML = ARROW_LEFT;
      } else {
        slider.style.background = 'white';
        slider.style.boxShadow = '0 0 8px rgba(0,0,0,0.4)';
        slider.style.width = '12px';
        handle.style.borderRadius = '50%';
        handle.style.left = '50%';
        handle.style.transform = 'translate(-50%, -50%)';
        handle.innerHTML = ARROWS_BOTH;
      }
    }

    // Update map sizes
    const parentWidth = container.offsetWidth;
    const rightClipWidth = rightClipContainer.offsetWidth;
    leftContainer.style.width = `${parentWidth}px`;
    rightContainer.style.width = `${parentWidth}px`;
    rightContainer.style.left = `${-(parentWidth - rightClipWidth)}px`;

    leftMap.resize();
    rightMap.resize();
  }, [swiperPosition, isSwiperEnabled]);

  useEffect(() => {
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;
    if (!leftMap || !rightMap || !mapsReady.current.left || !mapsReady.current.right) return;

    if (isChoroplethEnabled) {
      applyColorsRef.current();
      return;
    }

    removeChoroplethLayers(leftMap, 'left');
    removeChoroplethLayers(rightMap, 'right');
    extentZoneStatsRef.current = null;
    if (onStatisticsChangeRef.current) {
      onStatisticsChangeRef.current({
        domainRange: null,
        leftStats: null,
        rightStats: null,
        fullStats: fullZoneStatsRef.current,
        siteStats: siteZoneStatsRef.current,
      });
    }
  }, [isChoroplethEnabled]);

  // Update labels and colours when comparison changes
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    const leftLabel = container.querySelector('#left-label') as HTMLElement;
    const rightLabel = container.querySelector('#right-label') as HTMLElement;
    const indicatorLabel = container.querySelector('#indicator-label') as HTMLElement;

    if (leftLabel) {
      const leftInfo = SCENARIOS.find((s) => s.id === comparison.leftScenario);
      leftLabel.textContent = leftInfo?.label || comparison.leftScenario;
      leftLabel.style.borderLeft = `3px solid ${leftInfo?.color || '#fff'}`;
    }

    if (rightLabel) {
      const rightInfo = SCENARIOS.find((s) => s.id === comparison.rightScenario);
      rightLabel.textContent = rightInfo?.label || comparison.rightScenario;
      rightLabel.style.borderLeft = `3px solid ${rightInfo?.color || '#fff'}`;
      rightLabel.style.display = isSwiperEnabled ? 'block' : 'none';
    }

    if (indicatorLabel) {
      const friendlyAttribute = comparison.attribute
        ? attributeDetails[comparison.attribute]
          ?? comparison.attribute
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase())
        : '';
      indicatorLabel.textContent = friendlyAttribute;
      indicatorLabel.style.display = comparison.attribute ? 'block' : 'none';
    }

    // Apply scenario-specific colours
    applyColors();
  }, [comparison, applyColors, isSwiperEnabled, colorScaleMode, colorScaleType, attributeColors, attributeDetails]);

  // Highlight identified catchment with neon yellow glow effect
  useEffect(() => {
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;

    if (!leftMap || !rightMap) return;
    if (!mapsReady.current.left || !mapsReady.current.right) return;

    // Helper to remove highlight layers from a map
    const removeHighlight = (map: maplibregl.Map) => {
      // Safety check: map.style is undefined after map.remove() is called
      if (!map.style) return;
      if (map.getLayer(IDENTIFY_HIGHLIGHT_LINE)) map.removeLayer(IDENTIFY_HIGHLIGHT_LINE);
      if (map.getLayer(IDENTIFY_HIGHLIGHT_GLOW)) map.removeLayer(IDENTIFY_HIGHLIGHT_GLOW);
    };

    // Helper to add neon blue glow highlight to a catchment
    const addHighlight = (map: maplibregl.Map, side: 'left' | 'right', catchmentId: string) => {
      removeHighlight(map);

      // Use the same per-side choropleth GeoJSON source the color layer already
      // renders from (always present once a choropleth is showing) rather than
      // the base style's "UoW Tiles" vector source, which doesn't exist at all
      // when the Google satellite basemap is active — the default for browser
      // runtime — leaving the highlight silently missing.
      const sourceId = `choropleth-source-${side}`;

      // Check if the source exists
      if (!map.getSource(sourceId)) {
        console.warn('Identify highlight: source not found:', sourceId);
        return;
      }

      // Parse catchmentId as number for filtering (HYBAS_ID is numeric)
      const catchmentIdNum = parseInt(catchmentId, 10);

      // Add outer glow layer (neon blue)
      map.addLayer({
        id: IDENTIFY_HIGHLIGHT_GLOW,
        type: 'line',
        source: sourceId,
        filter: ['==', ['get', CATCHMENT_ID_PROP], catchmentIdNum],
        paint: {
          'line-color': '#00BFFF',  // Bright blue
          'line-width': 12,
          'line-blur': 8,
          'line-opacity': 0.7,
        },
      });

      // Add inner bright line (pale blue)
      map.addLayer({
        id: IDENTIFY_HIGHLIGHT_LINE,
        type: 'line',
        source: sourceId,
        filter: ['==', ['get', CATCHMENT_ID_PROP], catchmentIdNum],
        paint: {
          'line-color': '#AEEFFF',  // Pale blue
          'line-width': 4,
          'line-opacity': 1,
        },
      });
    };

    // Remove existing highlights
    removeHighlight(leftMap);
    removeHighlight(rightMap);

    // Add highlight if there's an identify result
    if (identifyResult?.catchmentID) {
      addHighlight(leftMap, 'left', identifyResult.catchmentID);
      addHighlight(rightMap, 'right', identifyResult.catchmentID);
    }
  }, [identifyResult]);

  // Fetch and display site boundary when siteId changes or maps become ready
  useEffect(() => {
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;

    // Wait until maps are ready (state-based trigger ensures re-run)
    if (!leftMap || !rightMap || !areMapsReady) return;

    // Helper to remove site boundary layers from a map
    const removeSiteBoundary = (map: maplibregl.Map) => {
      // Safety check: map.style is undefined after map.remove() is called
      if (!map.style) return;
      if (map.getLayer(SITE_BOUNDARY_LINE)) map.removeLayer(SITE_BOUNDARY_LINE);
      if (map.getLayer(SITE_BOUNDARY_GLOW_MIDDLE)) map.removeLayer(SITE_BOUNDARY_GLOW_MIDDLE);
      if (map.getLayer(SITE_BOUNDARY_OFFWHITE)) map.removeLayer(SITE_BOUNDARY_OFFWHITE);
      if (map.getLayer(SITE_BOUNDARY_GLOW_OUTER)) map.removeLayer(SITE_BOUNDARY_GLOW_OUTER);
      if (map.getSource(SITE_BOUNDARY_SOURCE)) map.removeSource(SITE_BOUNDARY_SOURCE);
    };

    // Helper to add glowing neon boundary layers with off-white backing
    const addSiteBoundary = (map: maplibregl.Map, geometry: GeoJSON.Geometry) => {
      const normalized = normalizeBoundaryGeometry(geometry);
      boundaryGeometryRef.current = normalized;
      addBoundaryLayersIfMissing(map, normalized);
    };

    const addSiteBoundaryWhenReady = (map: maplibregl.Map, geometry: GeoJSON.Geometry) => {
      if (map.style) {
        addSiteBoundary(map, geometry);
        moveSiteBoundaryToTop(map);
        return;
      }

      const onStyleData = () => {
        if (!map.isStyleLoaded()) return;
        map.off('styledata', onStyleData);
        if (!map.style) return;
        addSiteBoundary(map, geometry);
        moveSiteBoundaryToTop(map);
      };
      map.on('styledata', onStyleData);
    };

    const ensureBoundaryLayers = (map: maplibregl.Map) => {
      const geometry = boundaryGeometryRef.current;
      if (!geometry) return;
      if (map.getLayer(SITE_BOUNDARY_LINE) && map.getSource(SITE_BOUNDARY_SOURCE)) return;

      addSiteBoundaryWhenReady(map, geometry);
    };

    const updateSiteBoundarySource = (map: maplibregl.Map, geometry: GeoJSON.Geometry): boolean => {
      if (!map.style) return false;
      const source = map.getSource(SITE_BOUNDARY_SOURCE) as maplibregl.GeoJSONSource;
      if (!source) return false;

      const normalized = normalizeBoundaryGeometry(geometry);

      source.setData({
        type: 'Feature',
        properties: {},
        geometry: normalized,
      });
      map.triggerRepaint();
      return true;
    };

    // If no site, remove boundaries
    if (!siteId) {
      siteCatchmentIdsRef.current = null;
      removeSiteBoundary(leftMap);
      removeSiteBoundary(rightMap);
      return;
    }

    // Prefer the latest geometry from props to avoid missing boundaries
    if (siteGeometry) {
      boundaryGeometryRef.current = siteGeometry;
      const leftUpdated = updateSiteBoundarySource(leftMap, siteGeometry);
      const rightUpdated = updateSiteBoundarySource(rightMap, siteGeometry);
      if (!leftUpdated) addSiteBoundaryWhenReady(leftMap, siteGeometry);
      if (!rightUpdated) addSiteBoundaryWhenReady(rightMap, siteGeometry);
    }

    // Fetch site data and add boundary
    getSite(siteId)
      .then((site) => {
        const catchmentIds = Array.isArray(site?.catchmentIds)
          ? site.catchmentIds.map((id: unknown) => String(id))
          : [];
        siteCatchmentIdsRef.current = new Set(catchmentIds);

        const zoomToLoadedSiteBounds = () => {
          if (isBoundaryEditModeRef.current) return;
          const bounds = site?.boundingBox;
          if (!bounds) return;

          leftMap.resize();
          leftMap.fitBounds(padBoundsForFit(bounds), {
            padding: 50,
            duration: 1000,
            maxZoom: 14,
          });
          // Re-fit once the slower of the panel-open (0.3s) and quad grid
          // layout (0.6s, see ContentArea) transitions has settled,
          // correcting any mis-fit from measuring the container
          // mid-transition - see the matching fix in zoomToSite.
          window.setTimeout(() => {
            if (isBoundaryEditModeRef.current) return;
            leftMapRef.current?.resize();
            leftMapRef.current?.fitBounds(padBoundsForFit(bounds), {
              padding: 50,
              duration: 1000,
              maxZoom: 14,
            });
          }, 650);
        };

        const geometry = site?.geometry;
        if (geometry && !siteGeometry) {
          boundaryGeometryRef.current = geometry;
          // Wait for maps to be idle before adding layers
          const addToMaps = () => {
            const leftUpdated = updateSiteBoundarySource(leftMap, geometry);
            const rightUpdated = updateSiteBoundarySource(rightMap, geometry);
            if (!leftUpdated) addSiteBoundaryWhenReady(leftMap, geometry);
            if (!rightUpdated) addSiteBoundaryWhenReady(rightMap, geometry);
            zoomToLoadedSiteBounds();
          };

          if (leftMap.loaded() && rightMap.loaded()) {
            addToMaps();
          } else {
            // Wait for both maps to be ready
            const checkAndAdd = () => {
              if (leftMap.loaded() && rightMap.loaded()) {
                addToMaps();
              }
            };
            leftMap.once('idle', checkAndAdd);
            rightMap.once('idle', checkAndAdd);
          }
        } else {
          zoomToLoadedSiteBounds();
        }
      })
      .catch((err) => console.error('Failed to fetch site boundary:', err));

    const handleLeftStyleData = () => ensureBoundaryLayers(leftMap);
    const handleRightStyleData = () => ensureBoundaryLayers(rightMap);

    leftMap.on('styledata', handleLeftStyleData);
    rightMap.on('styledata', handleRightStyleData);

    // Cleanup on unmount or siteId change
    return () => {
      siteCatchmentIdsRef.current = null;
      leftMap.off('styledata', handleLeftStyleData);
      rightMap.off('styledata', handleRightStyleData);
      if (leftMapRef.current) removeSiteBoundary(leftMapRef.current);
      if (rightMapRef.current) removeSiteBoundary(rightMapRef.current);
    };
    // siteGeometry intentionally excluded: this effect tears down and
    // recreates the entire boundary source/layers on every dependency
    // change (see cleanup above). Including siteGeometry here made that
    // full destroy+recreate cycle run on every single boundary edit —
    // instead of the cheap setData()-only path in updateBoundaryDisplay/
    // updateBoundarySource — which was causing the right map's edit
    // vertices to render stale after exiting edit mode with the compare
    // swiper enabled. Geometry edits are already kept in sync by those
    // lighter-weight paths; this effect only needs to (re)run on site
    // switches or initial mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, areMapsReady]);

  useEffect(() => {
    if (!siteId) return;
    const timer = window.setTimeout(() => {
      reapplyBoundaryLayers();
    }, 700);

    return () => {
      window.clearTimeout(timer);
    };
  }, [siteId, reapplyBoundaryLayers]);

  // Zoom to site bounds when siteBounds changes (with 10% padding)
  useEffect(() => {
    if (!siteBounds || isBoundaryEditModeRef.current) return;

    const zoomToBounds = () => {
      const leftMap = leftMapRef.current;
      if (!leftMap) return;
      // Sync the canvas to the container's current size first: opening a
      // site also opens the control panel (0.3s transition), and switching
      // layout mode (e.g. single -> quad) resizes this map's own container
      // via the 0.6s grid-template-columns transition in ContentArea. If
      // still mid-transition, fitBounds below would target the pre-transition
      // size and under/over-zoom.
      leftMap.resize();
      leftMap.fitBounds(padBoundsForFit(siteBounds), {
        padding: 50,
        duration: 1000,
        maxZoom: 14,
      });
    };

    const cleanups: Array<() => void> = [];

    // If map is ready, zoom immediately; otherwise wait for load event
    const leftMap = leftMapRef.current;
    if (leftMap && mapsReady.current.left) {
      zoomToBounds();
    } else if (leftMap) {
      leftMap.once('load', zoomToBounds);
      cleanups.push(() => leftMap.off('load', zoomToBounds));
    } else {
      // Map not created yet, use a short delay
      const timer = setTimeout(zoomToBounds, 500);
      cleanups.push(() => clearTimeout(timer));
    }

    // Re-fit once the slower of the two transitions above (the 0.6s quad
    // grid layout change) has settled, correcting any mis-fit from measuring
    // the container mid-transition - see the matching fix in zoomToSite.
    const settleTimer = window.setTimeout(zoomToBounds, 650);
    cleanups.push(() => window.clearTimeout(settleTimer));

    return () => cleanups.forEach((cleanup) => cleanup());
  }, [siteBounds]);

  // Store edit mode refs for event handlers
  const isBoundaryEditModeRef = useRef(isBoundaryEditMode);
  isBoundaryEditModeRef.current = isBoundaryEditMode;
  const siteGeometryRef = useRef(siteGeometry);
  siteGeometryRef.current = siteGeometry;
  const siteBoundsRef = useRef(siteBounds);
  siteBoundsRef.current = siteBounds;
  const zoomToSiteRef = useRef(zoomToSite);
  zoomToSiteRef.current = zoomToSite;

  // Flag set by the guided tour event; cleared once the zoom executes.
  const tourZoomPendingRef = useRef(false);

  // When the tour requests a zoom, execute immediately if everything is ready,
  // otherwise set the pending flag so the reactive effect below handles it.
  useEffect(() => {
    const handler = () => {
      if (leftMapRef.current && mapsReady.current.left && siteBoundsRef.current) {
        void zoomToSiteRef.current();
      } else {
        tourZoomPendingRef.current = true;
      }
    };
    window.addEventListener('dt:tour-zoom-to-site', handler);
    return () => window.removeEventListener('dt:tour-zoom-to-site', handler);
  }, []);

  // Deferred tour zoom: executes once both maps are ready and siteBounds is
  // available, covering the common case where the event fires before the
  // MapLibre instance or site state has fully initialised.
  useEffect(() => {
    if (!areMapsReady || !siteBounds || !tourZoomPendingRef.current) return;
    tourZoomPendingRef.current = false;
    void zoomToSite();
  }, [areMapsReady, siteBounds, zoomToSite]);

  const onBoundaryUpdateRef = useRef(onBoundaryUpdate);
  onBoundaryUpdateRef.current = onBoundaryUpdate;
  const editVerticesRef = useRef<[number, number][]>([]);
  const draggingVertexIndexRef = useRef<number | null>(null);

  // Catchment edit mode: 'add' or 'remove' or null
  const [catchmentEditMode, setCatchmentEditMode] = useState<'add' | 'remove' | null>(null);
  const catchmentEditModeRef = useRef(catchmentEditMode);
  catchmentEditModeRef.current = catchmentEditMode;

  const [vertexEditMode, setVertexEditMode] = useState<'delete' | 'add' | null>(null);
  const vertexEditModeRef = useRef(vertexEditMode);
  vertexEditModeRef.current = vertexEditMode;

  const ADD_CATCHMENT_CURSOR =
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none' stroke='black' stroke-width='3'><circle cx='12' cy='12' r='9'/><line x1='12' y1='7' x2='12' y2='17'/><line x1='7' y1='12' x2='17' y2='12'/></svg>\") 12 12, copy";
  const REMOVE_CATCHMENT_CURSOR =
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none' stroke='black' stroke-width='3'><circle cx='12' cy='12' r='9'/><line x1='7' y1='12' x2='17' y2='12'/></svg>\") 12 12, not-allowed";
  const DELETE_VERTEX_CURSOR = REMOVE_CATCHMENT_CURSOR;
  const ADD_VERTEX_CURSOR = ADD_CATCHMENT_CURSOR;

  const insertVertexAtClosestSegment = useCallback((
    vertices: [number, number][],
    point: [number, number],
  ): [number, number][] => {
    if (vertices.length < 2) return [...vertices, point];

    let closestIndex = 0;
    let closestDistance = Infinity;

    for (let i = 0; i < vertices.length; i += 1) {
      const start = vertices[i];
      const end = vertices[(i + 1) % vertices.length];

      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const lengthSq = dx * dx + dy * dy;
      if (lengthSq === 0) continue;

      const t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSq;
      const clamped = Math.max(0, Math.min(1, t));
      const projX = start[0] + clamped * dx;
      const projY = start[1] + clamped * dy;
      const distSq = (point[0] - projX) * (point[0] - projX) + (point[1] - projY) * (point[1] - projY);

      if (distSq < closestDistance) {
        closestDistance = distSq;
        closestIndex = i;
      }
    }

    const nextVertices = [...vertices];
    nextVertices.splice(closestIndex + 1, 0, point);
    return nextVertices;
  }, []);

  const updateBoundarySource = useCallback((geometry: GeoJSON.Geometry) => {
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;
    const normalized = normalizeBoundaryGeometry(geometry);

    const updateMap = (map: maplibregl.Map) => {
      if (!map.style) return;
      const source = map.getSource(SITE_BOUNDARY_SOURCE) as maplibregl.GeoJSONSource;
      if (!source) return;

      source.setData({
        type: 'Feature',
        properties: {},
        geometry: normalized,
      });
      map.triggerRepaint();
    };

    if (leftMap) updateMap(leftMap);
    if (rightMap) updateMap(rightMap);

    boundaryGeometryRef.current = normalized;
    if (siteId) {
      siteCatchmentIdsRef.current = null;
      siteZoneStatsRef.current = null;
    }
    applyColorsRef.current();

    return normalized;
  }, [siteId]);

  // Capture a thumbnail from the left map canvas
  const captureMapThumbnail = useCallback((): string | null => {
    const leftMap = leftMapRef.current;
    if (!leftMap) return null;
    try {
      const canvas = leftMap.getCanvas();
      const maxWidth = 400;
      const scale = Math.min(maxWidth / canvas.width, 1);
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = canvas.width * scale;
      thumbCanvas.height = canvas.height * scale;
      const ctx = thumbCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
        return thumbCanvas.toDataURL('image/jpeg', 0.85);
      }
    } catch {
      // ignore
    }
    return null;
  }, []);

  // Notify parent of a boundary update, capturing a thumbnail after the next map render
  const notifyBoundaryUpdate = useCallback((geometry: GeoJSON.Geometry) => {
    const leftMap = leftMapRef.current;
    if (!onBoundaryUpdateRef.current) return;
    if (leftMap) {
      leftMap.once('render', () => {
        const thumbnail = captureMapThumbnail();
        onBoundaryUpdateRef.current?.(geometry, thumbnail);
      });
      // By the time an edit finishes (e.g. mouseup), the map has usually
      // already painted the last live-drag frame and gone idle, so nothing
      // would ever trigger the 'render' event above without this — leaving
      // the listener (and the save it guards) pending forever.
      leftMap.triggerRepaint();
    } else {
      onBoundaryUpdateRef.current(geometry);
    }
  }, [captureMapThumbnail]);

  const applyLocalBoundaryOperation = useCallback(
    (
      operation: 'union' | 'difference',
      catchmentGeometry: GeoJSON.Geometry,
      catchmentId: string,
    ) => {
      if (!siteGeometryRef.current || !onBoundaryUpdateRef.current) return;

      const siteFeature = geometryToPolygonFeature(siteGeometryRef.current);
      const catchmentFeature = geometryToPolygonFeature(catchmentGeometry);
      if (!siteFeature || !catchmentFeature) return;

      const result =
        operation === 'union'
          ? union(featureCollection([siteFeature, catchmentFeature]))
          : difference(featureCollection([siteFeature, catchmentFeature]));

      if (result?.geometry) {
        const normalized = updateBoundarySource(result.geometry);

        // Maintain catchmentIds explicitly (add/remove the clicked ID) rather than
        // re-deriving from geometry, which fails for edge-sharing catchments in a union.
        if (siteId) {
          const sites = loadLocalSites();
          const siteIndex = sites.findIndex(s => s.id === siteId);
          if (siteIndex >= 0) {
            const existing = sites[siteIndex];
            const existingIds = Array.isArray(existing.catchmentIds)
              ? existing.catchmentIds.map(String)
              : [];
            const newIds = operation === 'union'
              ? (existingIds.includes(catchmentId) ? existingIds : [...existingIds, catchmentId])
              : existingIds.filter(id => id !== catchmentId);
            // Also clear cached per-catchment data so AggregateTable re-fetches with the new IDs
            const {
              catchments: _c,
              catchmentIndicators: _ci,
              catchmentData: _cd,
              ...rest
            } = existing as typeof existing & {
              catchments?: unknown;
              catchmentIndicators?: unknown;
              catchmentData?: unknown;
            };
            sites[siteIndex] = { ...rest, catchmentIds: newIds } as typeof existing;
            saveLocalSites(sites);
          }
        }

        notifyBoundaryUpdate(normalized);
      }
    },
    [updateBoundarySource, notifyBoundaryUpdate, siteId],
  );

  // Handle adding a catchment to the site boundary
  const handleAddCatchment = useCallback(async (catchmentId: string, catchmentGeometry?: GeoJSON.Geometry) => {
    if (!siteGeometryRef.current || !onBoundaryUpdateRef.current || !siteId) return;

    if (getAppRuntime() === 'browser') {
      if (catchmentGeometry) {
        applyLocalBoundaryOperation('union', catchmentGeometry, catchmentId);
      }
      return;
    }

    try {
      // Use the union API endpoint to merge the catchment with the site
      const response = await fetch(`/api/sites/${siteId}/boundary/union/${catchmentId}`, {
        method: 'POST',
      });

      if (response.ok) {
        const result = await response.json();
        if (result.geometry) {
          const normalized = updateBoundarySource(result.geometry);
          notifyBoundaryUpdate(normalized);
        }
      } else {
        console.error('Failed to add catchment to boundary');
      }
    } catch (err) {
      console.error('Error adding catchment:', err);
    }
  }, [applyLocalBoundaryOperation, notifyBoundaryUpdate, siteId]);

  // Handle removing a catchment from the site boundary
  const handleRemoveCatchment = useCallback(async (catchmentId: string, catchmentGeometry?: GeoJSON.Geometry) => {
    if (!siteGeometryRef.current || !onBoundaryUpdateRef.current || !siteId) return;

    if (getAppRuntime() === 'browser') {
      if (catchmentGeometry) {
        applyLocalBoundaryOperation('difference', catchmentGeometry, catchmentId);
      }
      return;
    }

    try {
      // Use the difference API endpoint to remove the catchment from the site
      const response = await fetch(`/api/sites/${siteId}/boundary/difference/${catchmentId}`, {
        method: 'POST',
      });

      if (response.ok) {
        const result = await response.json();
        if (result.geometry) {
          const normalized = updateBoundarySource(result.geometry);
          notifyBoundaryUpdate(normalized);
        }
      } else {
        console.error('Failed to remove catchment from boundary');
      }
    } catch (err) {
      console.error('Error removing catchment:', err);
    }
  }, [applyLocalBoundaryOperation, notifyBoundaryUpdate, siteId]);

  // Handle catchment click in add/remove mode
  const handleCatchmentEditClick = useCallback((map: maplibregl.Map, e: maplibregl.MapMouseEvent) => {
    if (!catchmentEditModeRef.current) return;

    // Query for catchment features at the click point
    const layersToQuery: string[] = [];
    if (map.getLayer('Catchments Outlines')) {
      layersToQuery.push('Catchments Outlines');
    }
    // Also check choropleth layers
    if (map.getLayer(CHOROPLETH_LAYER_LEFT)) layersToQuery.push(CHOROPLETH_LAYER_LEFT);
    if (map.getLayer(CHOROPLETH_LAYER_RIGHT)) layersToQuery.push(CHOROPLETH_LAYER_RIGHT);
    if (map.getLayer(CHOROPLETH_3D_LEFT)) layersToQuery.push(CHOROPLETH_3D_LEFT);
    if (map.getLayer(CHOROPLETH_3D_RIGHT)) layersToQuery.push(CHOROPLETH_3D_RIGHT);

    if (layersToQuery.length === 0) return;

    const features = map.queryRenderedFeatures(e.point, { layers: layersToQuery });
    if (features.length === 0) return;

    const catchmentId = features[0].properties?.[CATCHMENT_ID_PROP];
    if (!catchmentId) return;

    const catchmentIdStr = String(catchmentId);
    const catchmentGeometry = features[0].geometry;

    if (catchmentEditModeRef.current === 'add') {
      handleAddCatchment(catchmentIdStr, catchmentGeometry);
    } else if (catchmentEditModeRef.current === 'remove') {
      handleRemoveCatchment(catchmentIdStr, catchmentGeometry);
    }

    map.getCanvas().style.cursor =
      catchmentEditModeRef.current === 'add' ? ADD_CATCHMENT_CURSOR : REMOVE_CATCHMENT_CURSOR;
  }, [handleAddCatchment, handleRemoveCatchment]);

  // Extract vertices from geometry
  const extractVertices = useCallback((geometry: GeoJSON.Geometry | null | undefined): [number, number][] => {
    if (!geometry) return [];

    if (geometry.type === 'Polygon') {
      // Return all vertices except the closing one (which duplicates the first)
      const ring = geometry.coordinates[0];
      return ring.slice(0, -1) as [number, number][];
    } else if (geometry.type === 'MultiPolygon') {
      // Flatten all rings from all polygons
      const vertices: [number, number][] = [];
      for (const polygon of geometry.coordinates) {
        const ring = polygon[0];
        vertices.push(...(ring.slice(0, -1) as [number, number][]));
      }
      return vertices;
    }
    return [];
  }, []);

  // Build geometry from vertices
  const buildGeometryFromVertices = useCallback((vertices: [number, number][], originalGeometry: GeoJSON.Geometry): GeoJSON.Geometry => {
    if (originalGeometry.type === 'Polygon') {
      // Close the polygon by adding the first vertex at the end
      const closedRing = [...vertices, vertices[0]];
      return {
        type: 'Polygon',
        coordinates: [closedRing],
      };
    }
    // For MultiPolygon, we'd need more complex logic - for now just handle Polygon
    return originalGeometry;
  }, []);

  // Update edit vertices layer on both maps
  const updateEditVerticesLayer = useCallback((vertices: [number, number][]) => {
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;
    if (!leftMap || !rightMap) return;

    const updateMapVertices = (map: maplibregl.Map) => {
      // Safety check: map.style is undefined after map.remove() is called
      if (!map.style) return;

      // Create feature collection for vertices
      const features: GeoJSON.Feature[] = vertices.map((coord, idx) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [coord[0], coord[1]] },
        properties: { index: idx },
      }));

      const source = map.getSource(EDIT_VERTICES_SOURCE) as maplibregl.GeoJSONSource;
      if (source) {
        source.setData({ type: 'FeatureCollection', features });
        // Force repaint to show updated vertex positions immediately
        map.triggerRepaint();
      } else {
        // Add source and layers
        map.addSource(EDIT_VERTICES_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features },
        });

        // Outer glow (animated pulsing effect via CSS)
        map.addLayer({
          id: EDIT_VERTICES_GLOW,
          type: 'circle',
          source: EDIT_VERTICES_SOURCE,
          paint: {
            'circle-radius': 20,
            'circle-color': '#00FFFF',
            'circle-opacity': 0.3,
            'circle-blur': 1,
          },
        });

        // Middle ring
        map.addLayer({
          id: EDIT_VERTICES_OUTER,
          type: 'circle',
          source: EDIT_VERTICES_SOURCE,
          paint: {
            'circle-radius': 12,
            'circle-color': '#00FFFF',
            'circle-opacity': 0.6,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#FFFFFF',
          },
        });

        // Inner bright dot
        map.addLayer({
          id: EDIT_VERTICES_INNER,
          type: 'circle',
          source: EDIT_VERTICES_SOURCE,
          paint: {
            'circle-radius': 6,
            'circle-color': '#FFFFFF',
            'circle-opacity': 1,
          },
        });
      }
    };

    if (leftMap.style) updateMapVertices(leftMap);
    if (rightMap.style) updateMapVertices(rightMap);
  }, []);

  // Remove edit vertices layers
  const removeEditVerticesLayers = useCallback(() => {
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;

    const removeLayers = (map: maplibregl.Map) => {
      // Safety check: map.style is undefined after map.remove() is called
      if (!map.style) return;
      if (map.getLayer(EDIT_VERTICES_INNER)) map.removeLayer(EDIT_VERTICES_INNER);
      if (map.getLayer(EDIT_VERTICES_OUTER)) map.removeLayer(EDIT_VERTICES_OUTER);
      if (map.getLayer(EDIT_VERTICES_GLOW)) map.removeLayer(EDIT_VERTICES_GLOW);
      if (map.getSource(EDIT_VERTICES_SOURCE)) map.removeSource(EDIT_VERTICES_SOURCE);
    };

    if (leftMap) removeLayers(leftMap);
    if (rightMap) removeLayers(rightMap);
  }, []);

  // Update site boundary display with new vertices
  const updateBoundaryDisplay = useCallback((vertices: [number, number][]) => {
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;
    if (!leftMap || !rightMap || !siteGeometryRef.current) return;

    const newGeometry = buildGeometryFromVertices(vertices, siteGeometryRef.current);

    const updateSource = (map: maplibregl.Map) => {
      // Safety check: map.style is undefined after map.remove() is called
      if (!map.style) return;
      const source = map.getSource(SITE_BOUNDARY_SOURCE) as maplibregl.GeoJSONSource;
      if (source) {
        source.setData({
          type: 'Feature',
          properties: {},
          geometry: newGeometry,
        });
        // Force repaint to show updated geometry immediately
        map.triggerRepaint();
      }
    };

    updateSource(leftMap);
    updateSource(rightMap);

    // Keep the ref in sync so any style/resize-triggered re-apply of the
    // boundary layers (e.g. reapplyBoundaryLayers) uses the live-edited
    // geometry instead of stale data from before this edit.
    boundaryGeometryRef.current = newGeometry;
  }, [buildGeometryFromVertices]);

  // Handle boundary edit mode changes
  useEffect(() => {
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;

    if (!leftMap || !rightMap || !mapsReady.current.left || !mapsReady.current.right) {
      return;
    }

    if (isBoundaryEditMode && siteGeometryRef.current) {
      // Enter edit mode
      const vertices = extractVertices(siteGeometryRef.current);
      editVerticesRef.current = vertices;
      updateEditVerticesLayer(vertices);

      // Zoom to site bounds so the user can see the boundary to edit, and flatten pitch
      zoomToSiteRef.current({ pitch: 0 });

      // Change cursor to indicate draggable points
      leftMap.getCanvas().style.cursor = 'grab';
      rightMap.getCanvas().style.cursor = 'grab';

      // Set up drag handlers
      const handleMouseDown = (e: maplibregl.MapMouseEvent, map: maplibregl.Map) => {
        if (vertexEditModeRef.current) return;
        // Query for vertex points
        const features = map.queryRenderedFeatures(e.point, {
          layers: [EDIT_VERTICES_INNER, EDIT_VERTICES_OUTER, EDIT_VERTICES_GLOW],
        });

        if (features.length > 0) {
          const rawVertexIndex = features[0].properties?.index;
          const parsedVertexIndex =
            typeof rawVertexIndex === 'number'
              ? rawVertexIndex
              : Number.parseInt(String(rawVertexIndex), 10);

          if (
            Number.isInteger(parsedVertexIndex)
            && parsedVertexIndex >= 0
            && parsedVertexIndex < editVerticesRef.current.length
          ) {
            draggingVertexIndexRef.current = parsedVertexIndex;
            map.getCanvas().style.cursor = 'grabbing';
            // Disable map dragging while we drag the vertex
            map.dragPan.disable();
            e.preventDefault();
          }
        }
      };

      const handleMouseMove = (e: maplibregl.MapMouseEvent) => {
        if (draggingVertexIndexRef.current !== null) {
          const idx = draggingVertexIndexRef.current;
          const newCoord: [number, number] = [e.lngLat.lng, e.lngLat.lat];
          const nextVertices = [...editVerticesRef.current];
          nextVertices[idx] = newCoord;
          editVerticesRef.current = nextVertices;
          updateEditVerticesLayer(nextVertices);
          updateBoundaryDisplay(nextVertices);
        }
      };

      const handleMouseUp = () => {
        if (draggingVertexIndexRef.current !== null) {
          draggingVertexIndexRef.current = null;
          leftMap.getCanvas().style.cursor = 'grab';
          rightMap.getCanvas().style.cursor = 'grab';
          leftMap.dragPan.enable();
          rightMap.dragPan.enable();

          // Notify parent of the updated geometry
          if (onBoundaryUpdateRef.current && siteGeometryRef.current) {
            const newGeometry = buildGeometryFromVertices(editVerticesRef.current, siteGeometryRef.current);
            notifyBoundaryUpdate(newGeometry);
          }
        }
      };

      const onLeftMouseDown = (e: maplibregl.MapMouseEvent) => handleMouseDown(e, leftMap);
      const onRightMouseDown = (e: maplibregl.MapMouseEvent) => handleMouseDown(e, rightMap);

      leftMap.on('mousedown', onLeftMouseDown);
      rightMap.on('mousedown', onRightMouseDown);
      leftMap.on('mousemove', handleMouseMove);
      rightMap.on('mousemove', handleMouseMove);
      leftMap.on('mouseup', handleMouseUp);
      rightMap.on('mouseup', handleMouseUp);

      return () => {
        leftMap.off('mousedown', onLeftMouseDown);
        rightMap.off('mousedown', onRightMouseDown);
        leftMap.off('mousemove', handleMouseMove);
        rightMap.off('mousemove', handleMouseMove);
        leftMap.off('mouseup', handleMouseUp);
        rightMap.off('mouseup', handleMouseUp);
        leftMap.getCanvas().style.cursor = '';
        rightMap.getCanvas().style.cursor = '';
      };
    } else {
      // Exit edit mode
      removeEditVerticesLayers();
      editVerticesRef.current = [];
      draggingVertexIndexRef.current = null;
      leftMap.getCanvas().style.cursor = '';
      rightMap.getCanvas().style.cursor = '';
    }
    // siteGeometry intentionally excluded: this effect sets up/tears down
    // the vertex-drag handlers for entering/exiting edit mode. It read
    // siteGeometry directly before, so saving an edit (which updates the
    // siteGeometry prop) re-ran this effect mid-drag-session — tearing
    // down and re-registering the mouse handlers and re-zooming the map —
    // which raced with the in-flight edit and left the right map's
    // (swiper-compare) boundary reverted to the pre-edit geometry after
    // exiting edit mode. siteGeometryRef.current is used instead so this
    // only reacts to isBoundaryEditMode transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBoundaryEditMode, extractVertices, updateEditVerticesLayer, removeEditVerticesLayers, updateBoundaryDisplay, buildGeometryFromVertices]);

  // Handle catchment add/remove click events
  useEffect(() => {
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;

    if (!leftMap || !rightMap || !isBoundaryEditMode || !catchmentEditMode) {
      return;
    }

    if (vertexEditModeRef.current) {
      setVertexEditMode(null);
    }

    // Change cursor based on mode
    const cursor = catchmentEditMode === 'add' ? ADD_CATCHMENT_CURSOR : REMOVE_CATCHMENT_CURSOR;
    leftMap.getCanvas().style.cursor = cursor;
    rightMap.getCanvas().style.cursor = cursor;

    // Prevent drag-pan from stealing the click for catchment edits
    leftMap.dragPan.disable();
    rightMap.dragPan.disable();

    const onLeftClick = (e: maplibregl.MapMouseEvent) => handleCatchmentEditClick(leftMap, e);
    const onRightClick = (e: maplibregl.MapMouseEvent) => handleCatchmentEditClick(rightMap, e);
    const onLeftMove = () => {
      leftMap.getCanvas().style.cursor = cursor;
    };
    const onRightMove = () => {
      rightMap.getCanvas().style.cursor = cursor;
    };

    leftMap.on('click', onLeftClick);
    rightMap.on('click', onRightClick);
    leftMap.on('mousemove', onLeftMove);
    rightMap.on('mousemove', onRightMove);

    return () => {
      leftMap.off('click', onLeftClick);
      rightMap.off('click', onRightClick);
      leftMap.off('mousemove', onLeftMove);
      rightMap.off('mousemove', onRightMove);
      leftMap.dragPan.enable();
      rightMap.dragPan.enable();
      // Restore cursor based on whether we're still in edit mode
      if (isBoundaryEditModeRef.current) {
        leftMap.getCanvas().style.cursor = 'grab';
        rightMap.getCanvas().style.cursor = 'grab';
      }
    };
  }, [isBoundaryEditMode, catchmentEditMode, handleCatchmentEditClick]);

  // Handle vertex delete/add mode
  useEffect(() => {
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;

    if (!leftMap || !rightMap || !isBoundaryEditMode || !vertexEditMode) {
      return;
    }

    if (catchmentEditModeRef.current) {
      setCatchmentEditMode(null);
    }

    const cursor = vertexEditMode === 'delete' ? DELETE_VERTEX_CURSOR : ADD_VERTEX_CURSOR;
    leftMap.getCanvas().style.cursor = cursor;
    rightMap.getCanvas().style.cursor = cursor;

    const handleVertexDelete = (map: maplibregl.Map, e: maplibregl.MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, {
        layers: [EDIT_VERTICES_INNER, EDIT_VERTICES_OUTER, EDIT_VERTICES_GLOW],
      });

      if (features.length === 0) return;

      const rawVertexIndex = features[0].properties?.index;
      const parsedVertexIndex =
        typeof rawVertexIndex === 'number'
          ? rawVertexIndex
          : Number.parseInt(String(rawVertexIndex), 10);

      if (!Number.isInteger(parsedVertexIndex)) return;

      const currentVertices = editVerticesRef.current;
      if (currentVertices.length <= 3) return;

      const nextVertices = currentVertices.filter((_, idx) => idx !== parsedVertexIndex);
      editVerticesRef.current = nextVertices;
      updateEditVerticesLayer(nextVertices);
      updateBoundaryDisplay(nextVertices);

      if (onBoundaryUpdateRef.current && siteGeometryRef.current) {
        const newGeometry = buildGeometryFromVertices(nextVertices, siteGeometryRef.current);
        notifyBoundaryUpdate(newGeometry);
      }
    };

    const handleVertexAdd = (e: maplibregl.MapMouseEvent) => {
      const currentVertices = editVerticesRef.current;
      if (currentVertices.length < 3) return;

      const point: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      const nextVertices = insertVertexAtClosestSegment(currentVertices, point);
      editVerticesRef.current = nextVertices;
      updateEditVerticesLayer(nextVertices);
      updateBoundaryDisplay(nextVertices);

      if (onBoundaryUpdateRef.current && siteGeometryRef.current) {
        const newGeometry = buildGeometryFromVertices(nextVertices, siteGeometryRef.current);
        notifyBoundaryUpdate(newGeometry);
      }
    };

    const onLeftClick = (e: maplibregl.MapMouseEvent) => {
      if (vertexEditMode === 'delete') {
        handleVertexDelete(leftMap, e);
      } else {
        handleVertexAdd(e);
      }
    };
    const onRightClick = (e: maplibregl.MapMouseEvent) => {
      if (vertexEditMode === 'delete') {
        handleVertexDelete(rightMap, e);
      } else {
        handleVertexAdd(e);
      }
    };
    const onLeftMove = () => {
      leftMap.getCanvas().style.cursor = cursor;
    };
    const onRightMove = () => {
      rightMap.getCanvas().style.cursor = cursor;
    };

    leftMap.on('click', onLeftClick);
    rightMap.on('click', onRightClick);
    leftMap.on('mousemove', onLeftMove);
    rightMap.on('mousemove', onRightMove);

    return () => {
      leftMap.off('click', onLeftClick);
      rightMap.off('click', onRightClick);
      leftMap.off('mousemove', onLeftMove);
      rightMap.off('mousemove', onRightMove);
      if (isBoundaryEditModeRef.current) {
        leftMap.getCanvas().style.cursor = 'grab';
        rightMap.getCanvas().style.cursor = 'grab';
      }
    };
  }, [isBoundaryEditMode, vertexEditMode, updateEditVerticesLayer, updateBoundaryDisplay, buildGeometryFromVertices, insertVertexAtClosestSegment]);

  // Reset catchment edit mode when boundary edit mode is disabled
  useEffect(() => {
    if (!isBoundaryEditMode) {
      setCatchmentEditMode(null);
      setVertexEditMode(null);
    }
  }, [isBoundaryEditMode]);

  // Check if panel is unconfigured (no indicator selected)
  const isUnconfigured = !comparison.attribute;
  const canZoomToSite = Boolean(siteBounds || siteGeometry || siteId);

  return (
    <Box
      ref={mapContainerRef}
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      overflow="hidden"
    >
      {/* Unconfigured Panel Overlay */}
      {isUnconfigured && (
        <Flex
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          zIndex={20}
          bg="linear-gradient(135deg, rgba(15, 23, 42, 0.92) 0%, rgba(30, 41, 59, 0.88) 50%, rgba(15, 23, 42, 0.92) 100%)"
          backdropFilter="blur(8px)"
          align="center"
          justify="center"
          flexDirection="column"
          pointerEvents="none"
        >
          <VStack spacing={6} maxW="400px" textAlign="center" px={8} pointerEvents="auto">
            {/* Decorative icon */}
            <Flex
              w="80px"
              h="80px"
              borderRadius="full"
              bg="linear-gradient(135deg, #3182ce 0%, #63b3ed 100%)"
              align="center"
              justify="center"
              boxShadow="0 8px 32px rgba(49, 130, 206, 0.4)"
            >
              <Icon as={FiMap} boxSize={10} color="white" />
            </Flex>

            {/* Title */}
            <Text
              fontSize="2xl"
              fontWeight="bold"
              color="white"
              lineHeight="shorter"
            >
              Configure Your View
            </Text>

            {/* Description */}
            <Text
              fontSize="md"
              color="gray.300"
              lineHeight="tall"
            >
              {isPanelOpen
                ? 'Select a factor from the panel on the right to visualize catchment data and compare scenarios.'
                : 'Select an indicator from the sidebar to visualize catchment data and compare scenarios across Africa\'s river basins.'}
            </Text>

            {/* Call to action button - only show when panel is NOT open */}
            {!isPanelOpen && (
              <Button
                leftIcon={<FiSliders />}
                bg={colors.blue}
                size="lg"
                onClick={onOpenSettings}
                _hover={{ transform: 'translateY(-2px)', boxShadow: 'lg' }}
                transition="all 0.2s"
              >
                Open Settings
              </Button>
            )}

            {/* Subtle animated dots */}
            <Flex gap={2} mt={2}>
              <Box
                w={2}
                h={2}
                borderRadius="full"
                bg="blue.400"
                animation="pulse 2s infinite"
                sx={{
                  '@keyframes pulse': {
                    '0%, 100%': { opacity: 0.4 },
                    '50%': { opacity: 1 },
                  },
                }}
              />
              <Box
                w={2}
                h={2}
                borderRadius="full"
                bg="blue.400"
                animation="pulse 2s infinite 0.3s"
                sx={{
                  '@keyframes pulse': {
                    '0%, 100%': { opacity: 0.4 },
                    '50%': { opacity: 1 },
                  },
                }}
              />
              <Box
                w={2}
                h={2}
                borderRadius="full"
                bg="blue.400"
                animation="pulse 2s infinite 0.6s"
                sx={{
                  '@keyframes pulse': {
                    '0%, 100%': { opacity: 0.4 },
                    '50%': { opacity: 1 },
                  },
                }}
              />
            </Flex>
          </VStack>
        </Flex>
      )}

      {/* Tool buttons - only show when configured */}
      {!isUnconfigured && (
        <VStack
          position="absolute"
          bottom="120px"
          left="10px"
          zIndex={10}
          spacing={1}
        >
          {/* 3D toggle button */}
          <Tooltip label={is3DMode ? "Switch to 2D" : "Switch to 3D"} placement="right">
            <IconButton
              aria-label="Toggle 3D view"
              icon={<FiBox />}
              size="sm"
              colorScheme={is3DMode ? "blue" : "gray"}
              variant="solid"
              bg={is3DMode ? colors.blue : "white"}
              color={is3DMode ? "white" : "gray.700"}
              onClick={toggle3DMode}
              boxShadow="md"
              _hover={{
                bg: is3DMode ? "blue.600" : "gray.100"
              }}
            />
          </Tooltip>

          <Tooltip label={isChoroplethEnabled ? "Hide choropleth" : "Show choropleth"} placement="right">
            <IconButton
              aria-label="Toggle choropleth layer"
              icon={<FiMap />}
              size="sm"
              colorScheme={isChoroplethEnabled ? "blue" : "gray"}
              variant="solid"
              bg={isChoroplethEnabled ? colors.blue : "white"}
              color={isChoroplethEnabled ? "white" : "gray.700"}
              onClick={toggleChoropleth}
              boxShadow="md"
              _hover={{
                bg: isChoroplethEnabled ? "blue.600" : "gray.100"
              }}
            />
          </Tooltip>

          {/* Identify button */}
          {!isQuad && (
            <Tooltip label={isIdentifyMode ? "Disable Identify" : "Identify Catchment"} placement="right">
              <IconButton
                aria-label="Toggle identify mode"
                icon={<FiInfo />}
                size="sm"
                colorScheme={isIdentifyMode ? "blue" : "gray"}
                variant="solid"
                bg={isIdentifyMode ? colors.blue: "white"}
                color={isIdentifyMode ? "white" : "gray.700"}
                onClick={toggleIdentifyMode}
                boxShadow="md"
                _hover={{
                  bg: isIdentifyMode ? "blue.600" : "gray.100"
                }}
              />
            </Tooltip>
          )}

          {/* Google basemap toggle */}
          <Tooltip label={isGoogleBasemap ? "Switch to default basemap" : "Switch to Google satellite"} placement="right">
            <IconButton
              aria-label="Toggle Google basemap"
              icon={<FiGlobe />}
              size="sm"
              colorScheme={isGoogleBasemap ? "blue" : "gray"}
              variant="solid"
              bg={isGoogleBasemap ? colors.blue : "white"}
              color={isGoogleBasemap ? "white" : "gray.700"}
              onClick={toggleGoogleBasemap}
              boxShadow="md"
              _hover={{
                bg: isGoogleBasemap ? "blue.600" : "gray.100"
              }}
            />
          </Tooltip>

          {/* Swiper toggle button */}
          <Tooltip label={isSwiperEnabled ? "Disable map swiper" : "Enable map swiper"} placement="right">
            <IconButton
              aria-label="Toggle map swiper"
              icon={<FiColumns />}
              size="sm"
              colorScheme={isSwiperEnabled ? "blue" : "gray"}
              variant="solid"
              bg={isSwiperEnabled ? colors.blue: "white"}
              color={isSwiperEnabled ? "white" : "gray.700"}
              onClick={toggleSwiper}
              boxShadow="md"
              _hover={{
                bg: isSwiperEnabled ? "blue.600" : "gray.100"
              }}
            />
          </Tooltip>

          {/* Zoom to Site button - only show when site bounds are available */}
          {canZoomToSite && (
            <Tooltip label="Zoom to Site" placement="right">
              <IconButton
                aria-label="Zoom to site"
                icon={<FiTarget />}
                size="sm"
                variant="solid"
                bg="white"
                color="gray.700"
                onClick={() => {
                  void zoomToSite();
                }}
                boxShadow="md"
                _hover={{
                  bg: "gray.100"
                }}
              />
            </Tooltip>
          )}
        </VStack>
      )}

      {/* Boundary Edit Mode Overlay */}
      {isBoundaryEditMode && siteGeometry && isPolygonalGeometry(siteGeometry) && (
        <>
          {/* Edit mode banner */}
          <Flex
            position="absolute"
            top="60px"
            left="50%"
            transform="translateX(-50%)"
            zIndex={15}
            bg="rgba(0, 255, 255, 0.9)"
            backdropFilter="blur(8px)"
            px={6}
            py={3}
            borderRadius="full"
            boxShadow="0 4px 20px rgba(0, 255, 255, 0.4)"
            align="center"
            gap={3}
          >
            <Box
              w={3}
              h={3}
              borderRadius="full"
              bg="white"
              animation="pulse 1.5s infinite"
              sx={{
                '@keyframes pulse': {
                  '0%, 100%': { opacity: 0.6, transform: 'scale(1)' },
                  '50%': { opacity: 1, transform: 'scale(1.2)' },
                },
              }}
            />
            <Text color="gray.900" fontWeight="bold" fontSize="sm">
              {vertexEditMode === 'delete'
                ? 'Click vertices to DELETE from boundary'
                : vertexEditMode === 'add'
                ? 'Click boundary to ADD vertices'
                : catchmentEditMode === 'add'
                ? 'Click catchments to ADD to boundary'
                : catchmentEditMode === 'remove'
                ? 'Click catchments to REMOVE from boundary'
                : 'Edit Mode: Drag vertices to reshape boundary'}
            </Text>
          </Flex>

          {/* Edit tools panel */}
          <VStack
            position="absolute"
            top="120px"
            right="10px"
            zIndex={15}
            spacing={2}
            bg="rgba(0, 0, 0, 0.8)"
            backdropFilter="blur(10px)"
            p={3}
            borderRadius="xl"
            boxShadow="0 4px 20px rgba(0, 0, 0, 0.4)"
          >
            <Text fontSize="xs" fontWeight="bold" color="cyan.300" letterSpacing="wider">
              CATCHMENTS
            </Text>
            <Tooltip label={catchmentEditMode === 'add' ? "Cancel adding" : "Add catchments to boundary"} placement="left">
              <IconButton
                aria-label="Add catchments"
                icon={<FiPlus />}
                size="sm"
                variant="solid"
                bg={catchmentEditMode === 'add' ? "cyan.400" : "green.500"}
                color="white"
                onClick={() => {
                  setVertexEditMode(null);
                  setCatchmentEditMode(prev => prev === 'add' ? null : 'add');
                }}
                _hover={{ bg: catchmentEditMode === 'add' ? "cyan.300" : "green.400", transform: "scale(1.05)" }}
                transition="all 0.2s"
                boxShadow={catchmentEditMode === 'add' ? "0 0 12px rgba(0, 255, 255, 0.6)" : undefined}
              />
            </Tooltip>
            <Tooltip label={catchmentEditMode === 'remove' ? "Cancel removing" : "Remove catchments from boundary"} placement="left">
              <IconButton
                aria-label="Remove catchments"
                icon={<FiMinus />}
                size="sm"
                variant="solid"
                bg={catchmentEditMode === 'remove' ? "cyan.400" : "red.500"}
                color="white"
                onClick={() => {
                  setVertexEditMode(null);
                  setCatchmentEditMode(prev => prev === 'remove' ? null : 'remove');
                }}
                _hover={{ bg: catchmentEditMode === 'remove' ? "cyan.300" : "red.400", transform: "scale(1.05)" }}
                transition="all 0.2s"
                boxShadow={catchmentEditMode === 'remove' ? "0 0 12px rgba(0, 255, 255, 0.6)" : undefined}
              />
            </Tooltip>
            <Box w="100%" h="1px" bg="whiteAlpha.300" />
            <Text fontSize="xs" fontWeight="bold" color="cyan.300" letterSpacing="wider">
              VERTICES
            </Text>
            <Tooltip label={vertexEditMode === 'add' ? "Cancel add" : "Add vertices"} placement="left">
              <IconButton
                aria-label="Add vertices"
                icon={<FiPlus />}
                size="sm"
                variant="solid"
                bg={vertexEditMode === 'add' ? "cyan.400" : "blue.500"}
                color="white"
                onClick={() => {
                  setCatchmentEditMode(null);
                  setVertexEditMode(prev => prev === 'add' ? null : 'add');
                }}
                _hover={{ bg: vertexEditMode === 'add' ? "cyan.300" : "blue.400", transform: "scale(1.05)" }}
                transition="all 0.2s"
                boxShadow={vertexEditMode === 'add' ? "0 0 12px rgba(0, 255, 255, 0.6)" : undefined}
              />
            </Tooltip>
            <Tooltip label={vertexEditMode === 'delete' ? "Cancel delete" : "Delete vertices"} placement="left">
              <IconButton
                aria-label="Delete vertices"
                icon={<FiTrash2 />}
                size="sm"
                variant="solid"
                bg={vertexEditMode === 'delete' ? "cyan.400" : "orange.500"}
                color="white"
                onClick={() => {
                  setCatchmentEditMode(null);
                  setVertexEditMode(prev => prev === 'delete' ? null : 'delete');
                }}
                _hover={{ bg: vertexEditMode === 'delete' ? "cyan.300" : "orange.400", transform: "scale(1.05)" }}
                transition="all 0.2s"
                boxShadow={vertexEditMode === 'delete' ? "0 0 12px rgba(0, 255, 255, 0.6)" : undefined}
              />
            </Tooltip>
          </VStack>
        </>
      )}

    </Box>
  );
}

export default MapView;
