import { useEffect, useRef, useCallback, useState } from 'react';
import { Box, IconButton, Tooltip, Flex, Text, Icon, VStack, Button } from '@chakra-ui/react';
import { FiSliders, FiMap, FiInfo, FiBox } from 'react-icons/fi';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ComparisonState, Scenario, IdentifyResult, MapExtent } from '../types';
import { SCENARIOS } from '../types';
import { registerMap, unregisterMap } from '../hooks/useMapSync';

interface MapViewProps {
  comparison: ComparisonState;
  paneIndex: number;
  onOpenSettings: () => void;
  onIdentify?: (result: IdentifyResult) => void;
  onMapExtentChange?: (extent: MapExtent) => void;
}

// Layer IDs for choropleth
const CHOROPLETH_LAYER_LEFT = 'choropleth-left';
const CHOROPLETH_LAYER_RIGHT = 'choropleth-right';
const CHOROPLETH_3D_LEFT = 'choropleth-left-3d';
const CHOROPLETH_3D_RIGHT = 'choropleth-right-3d';

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

function MapView({ comparison, paneIndex: _paneIndex, onOpenSettings, onIdentify, onMapExtentChange }: MapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const leftMapRef = useRef<maplibregl.Map | null>(null);
  const rightMapRef = useRef<maplibregl.Map | null>(null);
  const compareContainerRef = useRef<HTMLDivElement | null>(null);
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const isDragging = useRef(false);
  const mapsReady = useRef<{ left: boolean; right: boolean }>({ left: false, right: false });

  // Identify mode state
  const [isIdentifyMode, setIsIdentifyMode] = useState(false);

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
      return;
    }

    // Check zoom — hide catchment layers when zoomed out
    const currentZoom = leftMap.getZoom();
    if (currentZoom < MIN_CATCHMENT_ZOOM) {
      removeChoroplethLayers(leftMap, 'left');
      removeChoroplethLayers(rightMap, 'right');
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

      // Use domain min/max from API response for consistent color scaling across scenarios
      // Both responses should have the same domain values since they're computed across all scenarios
      let min = 0;
      let max = 1;
      if (leftData && leftData.domain_min !== undefined && leftData.domain_max !== undefined) {
        min = leftData.domain_min;
        max = leftData.domain_max;
      } else if (rightData && rightData.domain_min !== undefined && rightData.domain_max !== undefined) {
        min = rightData.domain_min;
        max = rightData.domain_max;
      }

      // Apply to left map - verify the map is ready
      if (leftData && leftData.features.length > 0) {
        if (leftMap.loaded()) {
          applyChoroplethLayer(leftMap, 'left', leftData, c.attribute, min, max, extruded);
        } else {
          leftMap.once('idle', () => {
            applyChoroplethLayer(leftMap, 'left', leftData, c.attribute, min, max, extruded);
          });
        }
      }

      // Apply to right map - verify the map is ready
      if (rightData && rightData.features.length > 0) {
        if (rightMap.loaded()) {
          applyChoroplethLayer(rightMap, 'right', rightData, c.attribute, min, max, extruded);
        } else {
          rightMap.once('idle', () => {
            applyChoroplethLayer(rightMap, 'right', rightData, c.attribute, min, max, extruded);
          });
        }
      }
    } catch (err) {
      console.error('Failed to apply choropleth:', err);
    }
  }, []);

  /**
   * Remove choropleth layers from a map.
   */
  function removeChoroplethLayers(map: maplibregl.Map, side: string) {
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

      // Force a re-render to ensure the layer is drawn
      map.triggerRepaint();
    } catch (err) {
      console.error(`Error adding choropleth layer for ${side}:`, err);
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
      if (mapsReady.current.right) applyColors();
    });
    rightMap.on('load', () => {
      mapsReady.current.right = true;
      // Ensure proper sizing after load
      updateMapSizes();
      rightMap.resize();
      if (mapsReady.current.left) applyColors();
    });

    leftMapRef.current = leftMap;
    rightMapRef.current = rightMap;

    // Register the left map for cross-pane sync
    const syncId = registerMap(leftMap);

    // Slider drag handling with proper isolation from map events
    let sliderPointerId: number | null = null;

    function onSliderPointerDown(e: PointerEvent) {
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
      if (fetchTimerRef.current) {
        clearTimeout(fetchTimerRef.current);
      }
      unregisterMap(syncId);
      slider.removeEventListener('pointerdown', onSliderPointerDown);
      slider.removeEventListener('pointermove', onSliderPointerMove);
      slider.removeEventListener('pointerup', onSliderPointerUp);
      slider.removeEventListener('pointercancel', onSliderPointerUp);
      leftMap.remove();
      rightMap.remove();
    };
  }, [applyColors, debouncedApplyColors, handleIdentifyClick]);

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
    }

    if (indicatorLabel) {
      indicatorLabel.textContent = comparison.attribute || '';
      indicatorLabel.style.display = comparison.attribute ? 'block' : 'none';
    }

    // Apply scenario-specific colours
    applyColors();
  }, [comparison, applyColors]);

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
              Select an indicator from the sidebar to visualize catchment data
              and compare scenarios across Africa's river basins.
            </Text>

            {/* Call to action button */}
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
        </VStack>
      )}
    </Box>
  );
}

export default MapView;
