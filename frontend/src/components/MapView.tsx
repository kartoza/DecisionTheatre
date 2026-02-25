import { useEffect, useRef, useCallback, useState } from 'react';
import { Box, IconButton, Tooltip, Icon, VStack, Button, Flex, Text } from '@chakra-ui/react';
import { FiSliders, FiMap, FiInfo, FiBox, FiTarget, FiPlus, FiMinus, FiColumns } from 'react-icons/fi';
import maplibregl from 'maplibre-gl';
import { booleanIntersects, bbox as turfBbox } from '@turf/turf';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ComparisonState, Scenario, IdentifyResult, MapExtent, MapStatistics, ZoneStats, BoundingBox, DomainRange } from '../types';
import { SCENARIOS } from '../types';
import { registerMap, unregisterMap } from '../hooks/useMapSync';
import { getSite } from '../hooks/useApi';

interface MapViewProps {
  comparison: ComparisonState;
  onOpenSettings: () => void;
  onIdentify?: (result: IdentifyResult) => void;
  identifyResult?: IdentifyResult;
  onMapExtentChange?: (extent: MapExtent) => void;
  onStatisticsChange?: (stats: MapStatistics) => void;
  isPanelOpen?: boolean;
  siteId?: string | null;
  siteBounds?: BoundingBox | null;
  isBoundaryEditMode?: boolean;
  siteGeometry?: GeoJSON.Geometry | null;
  onBoundaryUpdate?: (geometry: GeoJSON.Geometry) => void;
  isSwiperEnabled?: boolean;
  onSwiperEnabledChange?: (enabled: boolean) => void;
}

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

// CSS gradient for legend
export const PRISM_CSS_GRADIENT =
  `linear-gradient(to right, ${PRISM_STOPS.map(([, c]) => c).join(', ')})`;

// The property in the vector tiles that identifies each catchment.
const CATCHMENT_ID_PROP = 'HYBAS_ID';

// Minimum zoom level at which catchment choropleth layers are displayed.
// Set to 7 to ensure reasonable performance - lower zooms fetch too many features.
const MIN_CATCHMENT_ZOOM = 7;

// Maximum extrusion height in metres for 3D mode
const MAX_EXTRUSION_HEIGHT = 50000;

// Debounce delay for fetching choropleth data on map move (ms)
const FETCH_DEBOUNCE_MS = 300;

// Extra margin around the site boundary used to include nearby catchments
const BOUNDARY_NEARBY_PADDING_RATIO = 0.15;

interface ChoroplethData {
  type: string;
  features: Array<{
    type: string;
    id: number;
    geometry: object;
    properties: {
      HYBAS_ID: number;
      [key: string]: number;
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

function computeDomainRangeFromDatasets(
  datasets: Array<ChoroplethData | null>,
  attribute: string
): DomainRange | null {
  let min = Infinity;
  let max = -Infinity;
  let found = false;

  for (const dataset of datasets) {
    if (!dataset?.features?.length) continue;

    for (const feature of dataset.features) {
      const value = feature.properties?.[attribute];
      if (typeof value !== 'number' || Number.isNaN(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
      found = true;
    }
  }

  if (!found) return null;
  return { min, max };
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

  for (const dataset of datasets) {
    if (!dataset?.features?.length) continue;

    for (const feature of dataset.features) {
      const featureId = feature.properties?.HYBAS_ID;
      if (featureId === undefined) continue;

      const featureGeometry = feature.geometry as GeoJSON.Geometry | null;
      if (!featureGeometry) continue;

      try {
        if (booleanIntersects(featureGeometry, boundaryGeometry)) {
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

/**
 * Fetch choropleth GeoJSON data for the current viewport.
 */
async function fetchChoroplethData(
  scenario: Scenario,
  attribute: string,
  bounds: maplibregl.LngLatBounds
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
  });

  try {
    const resp = await fetch(`/api/choropleth?${params}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (err) {
    console.error('Failed to fetch choropleth data:', err);
    return null;
  }
}

/**
 * Build a MapLibre expression for fill-color based on attribute value and global min/max.
 */
function buildFillColorExpression(
  attribute: string,
  min: number,
  max: number
): maplibregl.ExpressionSpecification | string {
  const range = max - min;
  if (range === 0) {
    // Single value - use middle color
    return PRISM_STOPS[Math.floor(PRISM_STOPS.length / 2)][1];
  }

  // Build interpolate expression: normalize value to 0-1 then map to colors
  return [
    'interpolate',
    ['linear'],
    ['/', ['-', ['coalesce', ['get', attribute], min], min], range],
    ...PRISM_STOPS.flatMap(([t, color]) => [t, color]),
  ] as maplibregl.ExpressionSpecification;
}

/**
 * Build a MapLibre expression for fill-extrusion-height based on attribute value.
 */
function buildExtrusionExpression(
  attribute: string,
  min: number,
  max: number
): maplibregl.ExpressionSpecification | number {
  const range = max - min;
  if (range === 0) {
    return MAX_EXTRUSION_HEIGHT / 2;
  }

  return [
    '*',
    ['/', ['-', ['coalesce', ['get', attribute], min], min], range],
    MAX_EXTRUSION_HEIGHT,
  ] as maplibregl.ExpressionSpecification;
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

function MapView({ comparison, onOpenSettings, onIdentify, identifyResult, onMapExtentChange, onStatisticsChange, isPanelOpen, siteId, siteBounds, isBoundaryEditMode, siteGeometry, onBoundaryUpdate, isSwiperEnabled: isSwiperEnabledProp, onSwiperEnabledChange }: MapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const leftMapRef = useRef<maplibregl.Map | null>(null);
  const rightMapRef = useRef<maplibregl.Map | null>(null);
  const leftClipContainerRef = useRef<HTMLDivElement | null>(null);
  const compareContainerRef = useRef<HTMLDivElement | null>(null);
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const isDragging = useRef(false);
  const mapsReady = useRef<{ left: boolean; right: boolean }>({ left: false, right: false });

  // Compare swiper state (split-screen on/off)
  const [internalSwiperEnabled, setInternalSwiperEnabled] = useState(true);
  const isSwiperEnabled = isSwiperEnabledProp ?? internalSwiperEnabled;
  const isSwiperEnabledRef = useRef(isSwiperEnabled);
  isSwiperEnabledRef.current = isSwiperEnabled;

  // Identify mode state
  const [isIdentifyMode, setIsIdentifyMode] = useState(false);

  // Maps ready state - triggers re-render when maps finish loading
  const [areMapsReady, setAreMapsReady] = useState(false);

  // 3D mode state
  const [is3DMode, setIs3DMode] = useState(false);
  const is3DModeRef = useRef(is3DMode);
  is3DModeRef.current = is3DMode;

  // Store latest comparison in a ref so async callbacks see current values
  const comparisonRef = useRef(comparison);
  comparisonRef.current = comparison;

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

  // Site-scoped domain range cache (used for color scaling when a site is established)
  const siteDomainRangeRef = useRef<DomainRange | null>(null);
  const siteZoneStatsRef = useRef<{ left: ZoneStats | null; right: ZoneStats | null } | null>(null);
  const siteCatchmentIdsRef = useRef<Set<string> | null>(null);
  const boundaryGeometryRef = useRef<GeoJSON.Geometry | null>(siteGeometry ?? null);
  boundaryGeometryRef.current = siteGeometry ?? null;

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

    // Clear existing choropleth layers if no attribute selected
    if (!c.attribute) {
      removeChoroplethLayers(leftMap, 'left');
      removeChoroplethLayers(rightMap, 'right');
      if (onStatisticsChangeRef.current) {
        onStatisticsChangeRef.current({ domainRange: null, leftStats: null, rightStats: null });
      }
      return;
    }

    // Check zoom — hide catchment layers when zoomed out
    const currentZoom = leftMap.getZoom();
    if (currentZoom < MIN_CATCHMENT_ZOOM) {
      removeChoroplethLayers(leftMap, 'left');
      removeChoroplethLayers(rightMap, 'right');
      if (onStatisticsChangeRef.current) {
        onStatisticsChangeRef.current({ domainRange: null, leftStats: null, rightStats: null });
      }
      return;
    }

    const extruded = is3DModeRef.current;
    const bounds = leftMap.getBounds();

    try {
      // Fetch data for both scenarios in parallel
      const [leftData, rightData] = await Promise.all([
        fetchChoroplethData(c.leftScenario, c.attribute, bounds),
        fetchChoroplethData(c.rightScenario, c.attribute, bounds),
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
        const inferredIds = inferCatchmentIdsFromBoundary([leftData, rightData], boundaryGeometry);

        if (inferredIds.size > 0) {
          siteCatchmentIds = inferredIds;
          siteCatchmentIdsRef.current = inferredIds;
          console.log(`[Site Boundary] Inferred ${inferredIds.size} catchments from drawn geometry`);
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

        const nearbyIds = inferNearbyCatchmentIdsFromBoundary([leftData, rightData], boundaryGeometry);
        if (nearbyIds.size > 0) {
          const mergedIds = new Set<string>(siteCatchmentIds ? Array.from(siteCatchmentIds) : []);
          for (const id of nearbyIds) mergedIds.add(id);
          siteCatchmentIds = mergedIds;
          siteCatchmentIdsRef.current = mergedIds;
          console.log(`[Site Boundary] Expanded with ${nearbyIds.size} nearby catchments`);
        }
      }

      console.log('Applying choropleth with site catchment filter:', siteCatchmentIds);
      const leftFiltered = (siteCatchmentIds && siteCatchmentIds.size > 0)
        ? filterDatasetByCatchmentIds(leftData, siteCatchmentIds)
        : leftData;
      const rightFiltered = (siteCatchmentIds && siteCatchmentIds.size > 0)
        ? filterDatasetByCatchmentIds(rightData, siteCatchmentIds)
        : rightData;

      // Use site-scoped domain once a site is established; fall back to API global domain.
      let min = 0;
      let max = 1;
      if (siteId && siteDomainRangeRef.current) {
        min = siteDomainRangeRef.current.min;
        max = siteDomainRangeRef.current.max;
      } else if (leftData && leftData.domain_min !== undefined && leftData.domain_max !== undefined) {
        min = leftData.domain_min;
        max = leftData.domain_max;
      } else if (rightData && rightData.domain_min !== undefined && rightData.domain_max !== undefined) {
        min = rightData.domain_min;
        max = rightData.domain_max;
      }

      // Compute zone statistics. For an established site, use site-specific stats
      // (based on selected site catchments) instead of viewport-only stats.
      const leftStatsComputed = (siteId && siteZoneStatsRef.current)
        ? siteZoneStatsRef.current.left
        : (leftFiltered ? computeZoneStats(leftFiltered, c.attribute) : null);
      const rightStatsComputed = (siteId && siteZoneStatsRef.current)
        ? siteZoneStatsRef.current.right
        : (rightFiltered ? computeZoneStats(rightFiltered, c.attribute) : null);

      if (onStatisticsChangeRef.current) {
        onStatisticsChangeRef.current({
          domainRange: { min, max },
          leftStats: leftStatsComputed,
          rightStats: rightStatsComputed,
        });
      }

      // Apply to left map - verify the map is ready
      if (leftFiltered && leftFiltered.features.length > 0) {
        if (leftMap.loaded()) {
          applyChoroplethLayer(leftMap, 'left', leftFiltered, c.attribute, min, max, extruded);
        } else {
          leftMap.once('idle', () => {
            applyChoroplethLayer(leftMap, 'left', leftFiltered, c.attribute, min, max, extruded);
          });
        }
      } else {
        removeChoroplethLayers(leftMap, 'left');
      }

      // Apply to right map - verify the map is ready
      if (rightFiltered && rightFiltered.features.length > 0) {
        if (rightMap.loaded()) {
          applyChoroplethLayer(rightMap, 'right', rightFiltered, c.attribute, min, max, extruded);
        } else {
          rightMap.once('idle', () => {
            applyChoroplethLayer(rightMap, 'right', rightFiltered, c.attribute, min, max, extruded);
          });
        }
      } else {
        removeChoroplethLayers(rightMap, 'right');
      }
    } catch (err) {
      console.error('Failed to apply choropleth:', err);
    }
  }, []);

  // Compute a site-scoped domain range (min/max) so color scale is based on the site,
  // not on global dataset extrema, once a site exists.
  useEffect(() => {
    let cancelled = false;

    const updateSiteDomainRange = async () => {
      const c = comparisonRef.current;
      if (!siteId || !c.attribute) {
        siteDomainRangeRef.current = null;
        siteZoneStatsRef.current = null;
        siteCatchmentIdsRef.current = null;
        applyColors();
        return;
      }

      let bounds = siteBounds;
      let catchmentIds: string[] = [];
      let siteGeometryFromApi: GeoJSON.Geometry | null = null;
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

      if (!bounds) {
        siteDomainRangeRef.current = null;
        siteZoneStatsRef.current = null;
        applyColors();
        return;
      }

      const siteBoundsLL = new maplibregl.LngLatBounds(
        [bounds.minX, bounds.minY],
        [bounds.maxX, bounds.maxY],
      );

      try {
        const [leftData, rightData] = await Promise.all([
          fetchChoroplethData(c.leftScenario, c.attribute, siteBoundsLL),
          fetchChoroplethData(c.rightScenario, c.attribute, siteBoundsLL),
        ]);

        if (cancelled) return;

        const catchmentIdSet = new Set(catchmentIds);
        const nearbyCatchmentIds = inferNearbyCatchmentIdsFromBoundary([leftData, rightData], boundaryGeometryRef.current ?? siteGeometryFromApi);
        for (const id of nearbyCatchmentIds) {
          catchmentIdSet.add(id);
        }
        siteCatchmentIdsRef.current = catchmentIdSet;
        const leftFiltered = filterDatasetByCatchmentIds(leftData, catchmentIdSet);
        const rightFiltered = filterDatasetByCatchmentIds(rightData, catchmentIdSet);

        const siteDomainRange = computeDomainRangeFromDatasets([leftFiltered, rightFiltered], c.attribute);
        const leftSiteStats = leftFiltered ? computeZoneStats(leftFiltered, c.attribute) : null;
        const rightSiteStats = rightFiltered ? computeZoneStats(rightFiltered, c.attribute) : null;

        siteDomainRangeRef.current = siteDomainRange;
        siteZoneStatsRef.current = { left: leftSiteStats, right: rightSiteStats };
        applyColors();
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to compute site domain range:', err);
          siteDomainRangeRef.current = null;
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
  }, [siteId, siteBounds, comparison.leftScenario, comparison.rightScenario, comparison.attribute, applyColors]);

  /**
   * Remove choropleth layers from a map.
   */
  function removeChoroplethLayers(map: maplibregl.Map, side: string) {
    // Safety check: map.style is undefined after map.remove() is called
    if (!map.style) return;

    const layerId = `choropleth-${side}`;
    const sourceId = `choropleth-source-${side}`;

    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
    if (map.getLayer(`${layerId}-3d`)) {
      map.removeLayer(`${layerId}-3d`);
    }
    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
    }
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
    extruded: boolean
  ) {
    const layerId = `choropleth-${side}`;
    const layer3dId = `${layerId}-3d`;
    const sourceId = `choropleth-source-${side}`;

    // Remove existing layers and source
    removeChoroplethLayers(map, side);

    try {
      // Add the GeoJSON source
      map.addSource(sourceId, {
        type: 'geojson',
        data: data as unknown as GeoJSON.FeatureCollection,
      });

      if (extruded) {
        // 3D fill-extrusion layer
        map.addLayer({
          id: layer3dId,
          type: 'fill-extrusion',
          source: sourceId,
          paint: {
            'fill-extrusion-color': buildFillColorExpression(attribute, min, max),
            'fill-extrusion-height': buildExtrusionExpression(attribute, min, max),
            'fill-extrusion-base': 0,
            'fill-extrusion-opacity': 0.8,
          },
        });
      } else {
        // 2D fill layer
        map.addLayer({
          id: layerId,
          type: 'fill',
          source: sourceId,
          paint: {
            'fill-color': buildFillColorExpression(attribute, min, max),
            'fill-opacity': 0.75,
          },
        });
      }

      // Move site boundary layers to top if they exist
      moveSiteBoundaryToTop(map);

      // Force a re-render to ensure the layer is drawn
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
      // Remove existing layers (not source)
      if (map.getLayer(SITE_BOUNDARY_LINE)) map.removeLayer(SITE_BOUNDARY_LINE);
      if (map.getLayer(SITE_BOUNDARY_GLOW_MIDDLE)) map.removeLayer(SITE_BOUNDARY_GLOW_MIDDLE);
      if (map.getLayer(SITE_BOUNDARY_GLOW_OUTER)) map.removeLayer(SITE_BOUNDARY_GLOW_OUTER);
      if (map.getLayer(SITE_BOUNDARY_OFFWHITE)) map.removeLayer(SITE_BOUNDARY_OFFWHITE);

      // Re-add layers (they'll be on top now)
      // Fully transparent fill (outline only)
      map.addLayer({
        id: SITE_BOUNDARY_GLOW_OUTER,
        type: 'fill',
        source: SITE_BOUNDARY_SOURCE,
        paint: {
          'fill-color': '#FF00FF',
          'fill-opacity': 0,
        },
      });

      // Thick semi-transparent off-white border (below the neon glow)
      map.addLayer({
        id: SITE_BOUNDARY_OFFWHITE,
        type: 'line',
        source: SITE_BOUNDARY_SOURCE,
        paint: {
          'line-color': '#F5F5F0',  // Off-white
          'line-width': 20,
          'line-opacity': 0.6,
        },
      });

      // Neon glow line around boundary
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

      // Core solid neon line
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

      console.log('Site boundary moved to top');
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
      applyColors();
    }, FETCH_DEBOUNCE_MS);
  }, [applyColors]);

  // Toggle identify mode
  const toggleIdentifyMode = useCallback(() => {
    setIsIdentifyMode(prev => !prev);
  }, []);

  // Toggle split-screen swiper on/off
  const toggleSwiper = useCallback(() => {
    const next = !isSwiperEnabled;
    if (isSwiperEnabledProp === undefined) {
      setInternalSwiperEnabled(next);
    }
    onSwiperEnabledChange?.(next);
  }, [isSwiperEnabled, isSwiperEnabledProp, onSwiperEnabledChange]);

  // Zoom to site bounds with 10% padding
  const zoomToSite = useCallback(() => {
    const leftMap = leftMapRef.current;
    if (!leftMap || !siteBounds) return;

    // Add 10% padding to bounds
    const dx = (siteBounds.maxX - siteBounds.minX) * 0.1;
    const dy = (siteBounds.maxY - siteBounds.minY) * 0.1;

    const paddedBounds: [[number, number], [number, number]] = [
      [siteBounds.minX - dx, siteBounds.minY - dy],
      [siteBounds.maxX + dx, siteBounds.maxY + dy],
    ];

    leftMap.fitBounds(paddedBounds, {
      padding: 50,
      duration: 1000,
      maxZoom: 14,
    });
  }, [siteBounds]);

  // Toggle 3D mode - smoothly ease pitch between 0 and 60 degrees
  // and rebuild layers with/without extrusion
  const toggle3DMode = useCallback(() => {
    setIs3DMode(prev => {
      const newMode = !prev;
      const targetPitch = newMode ? 60 : 0;

      if (leftMapRef.current) {
        leftMapRef.current.easeTo({ pitch: targetPitch, duration: 800 });
      }
      if (rightMapRef.current) {
        rightMapRef.current.easeTo({ pitch: targetPitch, duration: 800 });
      }

      // Update the ref immediately so applyColors reads the new value
      is3DModeRef.current = newMode;
      // Rebuild layers with extrusion toggled
      applyColors();

      return newMode;
    });
  }, [applyColors]);

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
        }
      })
      .catch((err) => console.error('Identify error:', err));
  }, []);

  // Initialize the two maps and the compare slider
  useEffect(() => {
    if (!mapContainerRef.current) return;

    const container = mapContainerRef.current;

    // Create the left and right map containers
    // Left container - clips at the slider position
    // Use z-index:2 so it renders above any React overlay elements
    const leftClipContainer = document.createElement('div');
    leftClipContainer.style.cssText = 'position:absolute;top:0;left:0;width:50%;height:100%;overflow:hidden;z-index:2;';
    leftClipContainer.id = 'map-left-clip';

    const leftContainer = document.createElement('div');
    leftContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
    leftContainer.id = 'map-left';

    // Right container - clips at the slider position
    // Use z-index:2 so it renders above any React overlay elements (same level as left)
    const rightClipContainer = document.createElement('div');
    rightClipContainer.style.cssText = 'position:absolute;top:0;right:0;width:50%;height:100%;overflow:hidden;z-index:2;';
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
      left:50%;
      width:12px;
      height:100%;
      background:white;
      z-index:10;
      cursor:ew-resize;
      box-shadow:0 0 8px rgba(0,0,0,0.4);
      transform:translateX(-50%);
      touch-action:none;
    `;

    // Slider handle
    const handle = document.createElement('div');
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
    `;
    handle.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 4L3 10L7 16" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 4L17 10L13 16" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    slider.appendChild(handle);
    container.appendChild(slider);
    sliderRef.current = slider;
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

    // Set initial sizes BEFORE creating maps so they initialize with correct dimensions
    updateMapSizes();

    // Create left map with all interactions enabled
    const leftMap = new maplibregl.Map({
      container: leftContainer,
      style: styleUrl,
      center: [20, 0],
      zoom: 3,
      attributionControl: false,
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
      style: styleUrl,
      center: [20, 0],
      zoom: 3,
      attributionControl: false,
      scrollZoom: true,
      dragPan: true,
      dragRotate: true,
      doubleClickZoom: true,
      boxZoom: true,
      keyboard: true,
      touchZoomRotate: true,
      touchPitch: true,
    });

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

    leftMap.on('move', () => syncMaps(leftMap, rightMap));
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
        onMapExtentChangeRef.current({
          center: [center.lng, center.lat],
          zoom: leftMap.getZoom(),
        });
      }
    });
    leftMap.on('zoomend', () => debouncedApplyColors());

    // When maps are loaded, mark ready, resize, and apply initial colours
    leftMap.on('load', () => {
      mapsReady.current.left = true;
      // Ensure proper sizing after load
      updateMapSizes();
      leftMap.resize();
      if (mapsReady.current.right) {
        applyColors();
        setAreMapsReady(true);
      }
    });
    rightMap.on('load', () => {
      mapsReady.current.right = true;
      // Ensure proper sizing after load
      updateMapSizes();
      rightMap.resize();
      if (mapsReady.current.left) {
        applyColors();
        setAreMapsReady(true);
      }
    });

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
      const x = Math.max(20, Math.min(e.clientX - rect.left, rect.width - 20));
      const percent = (x / rect.width) * 100;

      slider.style.left = `${percent}%`;
      // Update both clip containers
      leftClipContainer.style.width = `${percent}%`;
      rightClipContainer.style.width = `${100 - percent}%`;
      updateMapSizes();

      // Trigger resize for both maps
      leftMap.resize();
      rightMap.resize();
    }

    function onSliderPointerUp(e: PointerEvent) {
      if (e.pointerId !== sliderPointerId) return;
      isDragging.current = false;
      sliderPointerId = null;
      // Re-enable map interactions
      leftMap.dragPan.enable();
      rightMap.dragPan.enable();
    }

    slider.addEventListener('pointerdown', onSliderPointerDown);
    slider.addEventListener('pointermove', onSliderPointerMove);
    slider.addEventListener('pointerup', onSliderPointerUp);
    slider.addEventListener('pointercancel', onSliderPointerUp);

    return () => {
      mapsReady.current = { left: false, right: false };
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
      leftMap.remove();
      rightMap.remove();
      leftClipContainerRef.current = null;
      compareContainerRef.current = null;
      sliderRef.current = null;
      indicatorLabel.remove();
      rightLabel.remove();
      leftLabel.remove();
      slider.remove();
      rightClipContainer.remove();
      leftClipContainer.remove();
    };
  }, [applyColors, debouncedApplyColors, handleIdentifyClick]);

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
      slider.style.left = '50%';
      leftClipContainer.style.width = '50%';
      rightClipContainer.style.display = 'block';
      rightClipContainer.style.width = '50%';
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
      indicatorLabel.textContent = comparison.attribute || '';
      indicatorLabel.style.display = comparison.attribute ? 'block' : 'none';
    }

    // Apply scenario-specific colours
    applyColors();
  }, [comparison, applyColors, isSwiperEnabled]);

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

    // Helper to add neon yellow glow highlight to a catchment
    const addHighlight = (map: maplibregl.Map, catchmentId: string) => {
      removeHighlight(map);

      // Use the vector tile source "UoW Tiles" and filter by HYBAS_ID
      const sourceId = 'UoW Tiles';

      // Check if the source exists
      if (!map.getSource(sourceId)) {
        console.warn('Identify highlight: source not found:', sourceId);
        return;
      }

      // Parse catchmentId as number for filtering (HYBAS_ID is numeric)
      const catchmentIdNum = parseInt(catchmentId, 10);

      // Add outer glow layer (neon yellow)
      map.addLayer({
        id: IDENTIFY_HIGHLIGHT_GLOW,
        type: 'line',
        source: sourceId,
        'source-layer': 'catchments_lev12',
        filter: ['==', ['get', CATCHMENT_ID_PROP], catchmentIdNum],
        paint: {
          'line-color': '#FFFF00',  // Bright yellow
          'line-width': 12,
          'line-blur': 8,
          'line-opacity': 0.7,
        },
      });

      // Add inner bright line (white/yellow)
      map.addLayer({
        id: IDENTIFY_HIGHLIGHT_LINE,
        type: 'line',
        source: sourceId,
        'source-layer': 'catchments_lev12',
        filter: ['==', ['get', CATCHMENT_ID_PROP], catchmentIdNum],
        paint: {
          'line-color': '#FFFFAA',  // Pale yellow
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
      addHighlight(leftMap, identifyResult.catchmentID);
      addHighlight(rightMap, identifyResult.catchmentID);
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
      console.log('Adding site boundary to map, geometry type:', geometry.type);
      removeSiteBoundary(map);

      // Add GeoJSON source
      map.addSource(SITE_BOUNDARY_SOURCE, {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry,
        },
      });

      // Fully transparent fill (outline only)
      map.addLayer({
        id: SITE_BOUNDARY_GLOW_OUTER,
        type: 'fill',
        source: SITE_BOUNDARY_SOURCE,
        paint: {
          'fill-color': '#FF00FF',
          'fill-opacity': 0,
        },
      });

      // Thick semi-transparent off-white border (below the neon glow)
      map.addLayer({
        id: SITE_BOUNDARY_OFFWHITE,
        type: 'line',
        source: SITE_BOUNDARY_SOURCE,
        paint: {
          'line-color': '#F5F5F0',  // Off-white
          'line-width': 20,
          'line-opacity': 0.6,
        },
      });

      // Neon glow line around boundary
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

      // Core solid neon line
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

      console.log('Site boundary layers added');
    };

    // If no site, remove boundaries
    if (!siteId) {
      siteCatchmentIdsRef.current = null;
      removeSiteBoundary(leftMap);
      removeSiteBoundary(rightMap);
      return;
    }

    // Fetch site data and add boundary
    getSite(siteId)
      .then((site) => {
        const catchmentIds = Array.isArray(site?.catchmentIds)
          ? site.catchmentIds.map((id: unknown) => String(id))
          : [];
        siteCatchmentIdsRef.current = new Set(catchmentIds);

        const catchmentCount = Array.isArray(site?.catchmentIds) ? site.catchmentIds.length : 0;
        console.log(`[Site Boundary] Site ${siteId} catchments:`, catchmentCount);

        const zoomToLoadedSiteBounds = () => {
          const bounds = site?.boundingBox;
          if (!bounds) return;

          const dx = (bounds.maxX - bounds.minX) * 0.1;
          const dy = (bounds.maxY - bounds.minY) * 0.1;

          const paddedBounds: [[number, number], [number, number]] = [
            [bounds.minX - dx, bounds.minY - dy],
            [bounds.maxX + dx, bounds.maxY + dy],
          ];

          leftMap.fitBounds(paddedBounds, {
            padding: 50,
            duration: 1000,
            maxZoom: 14,
          });
        };

        const geometry = site?.geometry;
        if (geometry) {
          // Wait for maps to be idle before adding layers
          const addToMaps = () => {
            addSiteBoundary(leftMap, geometry);
            addSiteBoundary(rightMap, geometry);
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

    // Cleanup on unmount or siteId change
    return () => {
      siteCatchmentIdsRef.current = null;
      if (leftMapRef.current) removeSiteBoundary(leftMapRef.current);
      if (rightMapRef.current) removeSiteBoundary(rightMapRef.current);
    };
  }, [siteId, areMapsReady]);

  // Zoom to site bounds when siteBounds changes (with 10% padding)
  useEffect(() => {
    if (!siteBounds) return;

    const zoomToBounds = () => {
      const leftMap = leftMapRef.current;
      if (!leftMap) return;

      // Add 10% padding to bounds
      const dx = (siteBounds.maxX - siteBounds.minX) * 0.1;
      const dy = (siteBounds.maxY - siteBounds.minY) * 0.1;

      const paddedBounds: [[number, number], [number, number]] = [
        [siteBounds.minX - dx, siteBounds.minY - dy],
        [siteBounds.maxX + dx, siteBounds.maxY + dy],
      ];

      leftMap.fitBounds(paddedBounds, {
        padding: 50,
        duration: 1000,
        maxZoom: 14,
      });
    };

    // If map is ready, zoom immediately; otherwise wait for load event
    const leftMap = leftMapRef.current;
    if (leftMap && mapsReady.current.left) {
      zoomToBounds();
    } else if (leftMap) {
      leftMap.once('load', zoomToBounds);
    } else {
      // Map not created yet, use a short delay
      const timer = setTimeout(zoomToBounds, 500);
      return () => clearTimeout(timer);
    }
  }, [siteBounds]);

  // Store edit mode refs for event handlers
  const isBoundaryEditModeRef = useRef(isBoundaryEditMode);
  isBoundaryEditModeRef.current = isBoundaryEditMode;
  const siteGeometryRef = useRef(siteGeometry);
  siteGeometryRef.current = siteGeometry;
  const onBoundaryUpdateRef = useRef(onBoundaryUpdate);
  onBoundaryUpdateRef.current = onBoundaryUpdate;
  const editVerticesRef = useRef<[number, number][]>([]);
  const draggingVertexIndexRef = useRef<number | null>(null);

  // Catchment edit mode: 'add' or 'remove' or null
  const [catchmentEditMode, setCatchmentEditMode] = useState<'add' | 'remove' | null>(null);
  const catchmentEditModeRef = useRef(catchmentEditMode);
  catchmentEditModeRef.current = catchmentEditMode;

  // Handle adding a catchment to the site boundary
  const handleAddCatchment = useCallback(async (catchmentId: string) => {
    if (!siteGeometryRef.current || !onBoundaryUpdateRef.current || !siteId) return;

    try {
      // Use the union API endpoint to merge the catchment with the site
      const response = await fetch(`/api/sites/${siteId}/boundary/union/${catchmentId}`, {
        method: 'POST',
      });

      if (response.ok) {
        const result = await response.json();
        if (result.geometry) {
          onBoundaryUpdateRef.current(result.geometry);
        }
      } else {
        console.error('Failed to add catchment to boundary');
      }
    } catch (err) {
      console.error('Error adding catchment:', err);
    }
  }, [siteId]);

  // Handle removing a catchment from the site boundary
  const handleRemoveCatchment = useCallback(async (catchmentId: string) => {
    if (!siteGeometryRef.current || !onBoundaryUpdateRef.current || !siteId) return;

    try {
      // Use the difference API endpoint to remove the catchment from the site
      const response = await fetch(`/api/sites/${siteId}/boundary/difference/${catchmentId}`, {
        method: 'POST',
      });

      if (response.ok) {
        const result = await response.json();
        if (result.geometry) {
          onBoundaryUpdateRef.current(result.geometry);
        }
      } else {
        console.error('Failed to remove catchment from boundary');
      }
    } catch (err) {
      console.error('Error removing catchment:', err);
    }
  }, [siteId]);

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

    if (catchmentEditModeRef.current === 'add') {
      handleAddCatchment(catchmentIdStr);
    } else if (catchmentEditModeRef.current === 'remove') {
      handleRemoveCatchment(catchmentIdStr);
    }
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
        geometry: { type: 'Point', coordinates: coord },
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

    if (leftMap.loaded()) updateMapVertices(leftMap);
    if (rightMap.loaded()) updateMapVertices(rightMap);
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
  }, [buildGeometryFromVertices]);

  // Handle boundary edit mode changes
  useEffect(() => {
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;

    if (!leftMap || !rightMap || !mapsReady.current.left || !mapsReady.current.right) {
      return;
    }

    if (isBoundaryEditMode && siteGeometry) {
      // Enter edit mode
      const vertices = extractVertices(siteGeometry);
      editVerticesRef.current = vertices;
      updateEditVerticesLayer(vertices);

      // Change cursor to indicate draggable points
      leftMap.getCanvas().style.cursor = 'grab';
      rightMap.getCanvas().style.cursor = 'grab';

      // Set up drag handlers
      const handleMouseDown = (e: maplibregl.MapMouseEvent, map: maplibregl.Map) => {
        // Query for vertex points
        const features = map.queryRenderedFeatures(e.point, {
          layers: [EDIT_VERTICES_INNER, EDIT_VERTICES_OUTER, EDIT_VERTICES_GLOW],
        });

        if (features.length > 0) {
          const vertexIndex = features[0].properties?.index;
          if (typeof vertexIndex === 'number') {
            draggingVertexIndexRef.current = vertexIndex;
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
          editVerticesRef.current[idx] = newCoord;
          updateEditVerticesLayer(editVerticesRef.current);
          updateBoundaryDisplay(editVerticesRef.current);
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
            onBoundaryUpdateRef.current(newGeometry);
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
  }, [isBoundaryEditMode, siteGeometry, extractVertices, updateEditVerticesLayer, removeEditVerticesLayers, updateBoundaryDisplay, buildGeometryFromVertices]);

  // Handle catchment add/remove click events
  useEffect(() => {
    const leftMap = leftMapRef.current;
    const rightMap = rightMapRef.current;

    if (!leftMap || !rightMap || !isBoundaryEditMode || !catchmentEditMode) {
      return;
    }

    // Change cursor based on mode
    const cursor = catchmentEditMode === 'add' ? 'crosshair' : 'not-allowed';
    leftMap.getCanvas().style.cursor = cursor;
    rightMap.getCanvas().style.cursor = cursor;

    const onLeftClick = (e: maplibregl.MapMouseEvent) => handleCatchmentEditClick(leftMap, e);
    const onRightClick = (e: maplibregl.MapMouseEvent) => handleCatchmentEditClick(rightMap, e);

    leftMap.on('click', onLeftClick);
    rightMap.on('click', onRightClick);

    return () => {
      leftMap.off('click', onLeftClick);
      rightMap.off('click', onRightClick);
      // Restore cursor based on whether we're still in edit mode
      if (isBoundaryEditModeRef.current) {
        leftMap.getCanvas().style.cursor = 'grab';
        rightMap.getCanvas().style.cursor = 'grab';
      }
    };
  }, [isBoundaryEditMode, catchmentEditMode, handleCatchmentEditClick]);

  // Reset catchment edit mode when boundary edit mode is disabled
  useEffect(() => {
    if (!isBoundaryEditMode) {
      setCatchmentEditMode(null);
    }
  }, [isBoundaryEditMode]);

  // Check if panel is unconfigured (no indicator selected)
  const isUnconfigured = !comparison.attribute;

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
                colorScheme="blue"
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
              bg={is3DMode ? "blue.500" : "white"}
              color={is3DMode ? "white" : "gray.700"}
              onClick={toggle3DMode}
              boxShadow="md"
              _hover={{
                bg: is3DMode ? "blue.600" : "gray.100"
              }}
            />
          </Tooltip>

          {/* Identify button */}
          <Tooltip label={isIdentifyMode ? "Disable Identify" : "Identify Catchment"} placement="right">
            <IconButton
              aria-label="Toggle identify mode"
              icon={<FiInfo />}
              size="sm"
              colorScheme={isIdentifyMode ? "blue" : "gray"}
              variant="solid"
              bg={isIdentifyMode ? "blue.500" : "white"}
              color={isIdentifyMode ? "white" : "gray.700"}
              onClick={toggleIdentifyMode}
              boxShadow="md"
              _hover={{
                bg: isIdentifyMode ? "blue.600" : "gray.100"
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
              bg={isSwiperEnabled ? "blue.500" : "white"}
              color={isSwiperEnabled ? "white" : "gray.700"}
              onClick={toggleSwiper}
              boxShadow="md"
              _hover={{
                bg: isSwiperEnabled ? "blue.600" : "gray.100"
              }}
            />
          </Tooltip>

          {/* Zoom to Site button - only show when site bounds are available */}
          {siteBounds && (
            <Tooltip label="Zoom to Site" placement="right">
              <IconButton
                aria-label="Zoom to site"
                icon={<FiTarget />}
                size="sm"
                variant="solid"
                bg="white"
                color="gray.700"
                onClick={zoomToSite}
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
      {isBoundaryEditMode && (
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
              {catchmentEditMode === 'add'
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
                onClick={() => setCatchmentEditMode(prev => prev === 'add' ? null : 'add')}
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
                onClick={() => setCatchmentEditMode(prev => prev === 'remove' ? null : 'remove')}
                _hover={{ bg: catchmentEditMode === 'remove' ? "cyan.300" : "red.400", transform: "scale(1.05)" }}
                transition="all 0.2s"
                boxShadow={catchmentEditMode === 'remove' ? "0 0 12px rgba(0, 255, 255, 0.6)" : undefined}
              />
            </Tooltip>
          </VStack>
        </>
      )}

    </Box>
  );
}

export default MapView;
