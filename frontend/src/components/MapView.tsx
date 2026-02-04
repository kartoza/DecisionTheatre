import { useEffect, useRef, useCallback, useState } from 'react';
import { Box, IconButton, Tooltip, Flex, Text, Icon, VStack, Button } from '@chakra-ui/react';
import { FiSliders, FiMap, FiInfo, FiBox } from 'react-icons/fi';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { tableFromIPC, Table } from 'apache-arrow';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { GeoArrowSolidPolygonLayer } from '@geoarrow/deck.gl-layers';
import type { ComparisonState, Scenario, IdentifyResult } from '../types';
import { SCENARIOS } from '../types';
import { registerMap, unregisterMap } from '../hooks/useMapSync';

interface MapViewProps {
  comparison: ComparisonState;
  paneIndex: number;
  onOpenSettings: () => void;
  onIdentify?: (result: IdentifyResult) => void;
}

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

// Convert hex colour to [R, G, B, A] array
function hexToRgba(hex: string): [number, number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
    220, // slightly transparent
  ];
}

// Pre-compute RGBA stop array for interpolation
const RGBA_STOPS = PRISM_STOPS.map(([t, hex]) => ({ t, rgba: hexToRgba(hex) }));

/** Linearly interpolate through the PRISM gradient for a normalised 0-1 value. */
function prismColor(normalised: number): [number, number, number, number] {
  const t = Math.max(0, Math.min(1, normalised));
  for (let i = 1; i < RGBA_STOPS.length; i++) {
    if (t <= RGBA_STOPS[i].t) {
      const prev = RGBA_STOPS[i - 1];
      const next = RGBA_STOPS[i];
      const f = (t - prev.t) / (next.t - prev.t);
      return [
        Math.round(prev.rgba[0] + f * (next.rgba[0] - prev.rgba[0])),
        Math.round(prev.rgba[1] + f * (next.rgba[1] - prev.rgba[1])),
        Math.round(prev.rgba[2] + f * (next.rgba[2] - prev.rgba[2])),
        Math.round(prev.rgba[3] + f * (next.rgba[3] - prev.rgba[3])),
      ];
    }
  }
  return RGBA_STOPS[RGBA_STOPS.length - 1].rgba;
}

// The property in the vector tiles that identifies each catchment.
const CATCHMENT_ID_PROP = 'HYBAS_ID';

// Minimum zoom level at which catchment choropleth layers are displayed.
// Roughly corresponds to 1:500,000 map scale.
const MIN_CATCHMENT_ZOOM = 8;

// Maximum extrusion height in metres for 3D mode
const MAX_EXTRUSION_HEIGHT = 50000;

/** Cache loaded Arrow tables so we only fetch each scenario file once. */
const arrowCache = new Map<string, Table>();

async function loadArrowTable(scenario: Scenario): Promise<Table> {
  const cached = arrowCache.get(scenario);
  if (cached) return cached;

  const resp = await fetch(`/data/${scenario}.arrow`);
  if (!resp.ok) throw new Error(`Failed to load ${scenario}.arrow: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const table = tableFromIPC(buf);
  arrowCache.set(scenario, table);
  return table;
}

/**
 * Build a GeoArrowSolidPolygonLayer that colours catchments by a given attribute.
 * When extruded is true, catchments are raised by their normalised attribute value.
 */
function buildGeoArrowLayer(
  id: string,
  table: Table,
  attribute: string,
  globalMin: number,
  globalRange: number,
  extruded: boolean,
): GeoArrowSolidPolygonLayer {
  const geomCol = table.getChild('geometry');

  return new GeoArrowSolidPolygonLayer({
    id,
    data: table,
    getPolygon: geomCol!,
    getFillColor: ({ index, data }) => {
      const batch = data.data;
      const col = batch.getChild(attribute);
      if (!col) return [0, 0, 0, 0];
      const val = col.get(index) as number | null;
      if (val == null || !Number.isFinite(val)) return [0, 0, 0, 0];
      const normalised = globalRange > 0 ? (val - globalMin) / globalRange : 0;
      return prismColor(normalised);
    },
    extruded,
    getElevation: extruded
      ? ({ index, data }) => {
          const batch = data.data;
          const col = batch.getChild(attribute);
          if (!col) return 0;
          const val = col.get(index) as number | null;
          if (val == null || !Number.isFinite(val)) return 0;
          const normalised = globalRange > 0 ? (val - globalMin) / globalRange : 0;
          return normalised * MAX_EXTRUSION_HEIGHT;
        }
      : undefined,
    pickable: false,
    _validate: false,
  });
}

/**
 * Compute global min/max for an attribute across both scenario tables.
 * Using a shared range ensures both maps are colour-comparable.
 */
function computeGlobalMinMax(
  tables: Table[],
  attribute: string,
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;

  for (const table of tables) {
    const col = table.getChild(attribute);
    if (!col) continue;
    for (let i = 0; i < col.length; i++) {
      const v = col.get(i) as number | null;
      if (v != null && Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }

  return { min, max };
}

function MapView({ comparison, paneIndex: _paneIndex, onOpenSettings, onIdentify }: MapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const leftMapRef = useRef<maplibregl.Map | null>(null);
  const rightMapRef = useRef<maplibregl.Map | null>(null);
  const compareContainerRef = useRef<HTMLDivElement | null>(null);
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const isDragging = useRef(false);
  const mapsReady = useRef<{ left: boolean; right: boolean }>({ left: false, right: false });

  // deck.gl overlay refs
  const leftOverlayRef = useRef<MapboxOverlay | null>(null);
  const rightOverlayRef = useRef<MapboxOverlay | null>(null);

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

  /** Load Arrow tables for both scenarios and create deck.gl layers.
   *  Layers are only shown when zoomed in past MIN_CATCHMENT_ZOOM.
   *  In 3D mode, catchments are extruded by their attribute value. */
  const applyColors = useCallback(async () => {
    const c = comparisonRef.current;
    if (!c.attribute) {
      // No attribute selected — remove overlays
      if (leftOverlayRef.current) leftOverlayRef.current.setProps({ layers: [] });
      if (rightOverlayRef.current) rightOverlayRef.current.setProps({ layers: [] });
      return;
    }

    // Check zoom — hide catchment layers when zoomed out beyond 1:500k
    const currentZoom = leftMapRef.current?.getZoom() ?? 0;
    if (currentZoom < MIN_CATCHMENT_ZOOM) {
      if (leftOverlayRef.current) leftOverlayRef.current.setProps({ layers: [] });
      if (rightOverlayRef.current) rightOverlayRef.current.setProps({ layers: [] });
      return;
    }

    const extruded = is3DModeRef.current;

    try {
      // Load both tables in parallel
      const [leftTable, rightTable] = await Promise.all([
        loadArrowTable(c.leftScenario),
        loadArrowTable(c.rightScenario),
      ]);

      // Compute shared min/max so both sides use the same colour scale
      const { min, max } = computeGlobalMinMax([leftTable, rightTable], c.attribute);
      const range = max - min;

      // Build layers
      const leftLayer = buildGeoArrowLayer(
        'choropleth-left', leftTable, c.attribute, min, range, extruded,
      );
      const rightLayer = buildGeoArrowLayer(
        'choropleth-right', rightTable, c.attribute, min, range, extruded,
      );

      if (leftOverlayRef.current) leftOverlayRef.current.setProps({ layers: [leftLayer] });
      if (rightOverlayRef.current) rightOverlayRef.current.setProps({ layers: [rightLayer] });
    } catch (err) {
      console.error('Failed to apply GeoArrow choropleth:', err);
    }
  }, []);

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
  const handleIdentifyClick = useCallback((map: maplibregl.Map, e: maplibregl.MapMouseEvent) => {
    if (!isIdentifyModeRef.current || !onIdentifyRef.current) return;

    // Query the catchments outline layer for features at the click point
    const features = map.queryRenderedFeatures(e.point, {
      layers: ['Catchments Outlines'],
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
    const leftContainer = document.createElement('div');
    leftContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
    leftContainer.id = 'map-left';

    const rightContainer = document.createElement('div');
    rightContainer.style.cssText = 'position:absolute;top:0;height:100%;';
    rightContainer.id = 'map-right';

    // Create the clip container for the right map
    const clipContainer = document.createElement('div');
    clipContainer.style.cssText = 'position:absolute;top:0;right:0;width:50%;height:100%;overflow:hidden;z-index:1;';
    clipContainer.id = 'map-clip';
    clipContainer.appendChild(rightContainer);

    // Size the right map to match the full parent width, offset left
    function updateRightMapSize() {
      const parentWidth = container.offsetWidth;
      const clipWidth = clipContainer.offsetWidth;
      rightContainer.style.width = parentWidth + 'px';
      rightContainer.style.left = -(parentWidth - clipWidth) + 'px';
    }

    container.appendChild(leftContainer);
    container.appendChild(clipContainer);

    // Create the slider
    const slider = document.createElement('div');
    slider.style.cssText = `
      position:absolute;
      top:0;
      left:50%;
      width:4px;
      height:100%;
      background:white;
      z-index:10;
      cursor:ew-resize;
      box-shadow:0 0 8px rgba(0,0,0,0.4);
      transform:translateX(-50%);
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
    compareContainerRef.current = clipContainer;

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

    // Create left map
    const leftMap = new maplibregl.Map({
      container: leftContainer,
      style: styleUrl,
      center: [20, 0],
      zoom: 3,
      attributionControl: false,
    });
    leftMap.addControl(new maplibregl.NavigationControl(), 'bottom-left');

    // Create right map
    const rightMap = new maplibregl.Map({
      container: rightContainer,
      style: styleUrl,
      center: [20, 0],
      zoom: 3,
      attributionControl: false,
    });

    // Initial sizing of right map container
    updateRightMapSize();

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

    // Identify click handlers
    leftMap.on('click', (e) => handleIdentifyClick(leftMap, e));
    rightMap.on('click', (e) => handleIdentifyClick(rightMap, e));

    // Re-evaluate catchment layer visibility when zoom changes
    leftMap.on('zoomend', () => applyColors());

    // Create deck.gl overlays (non-interleaved so they don't block MapLibre events)
    const leftOverlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
    });
    const rightOverlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
    });

    // When maps are loaded, add deck.gl overlays and apply colours
    leftMap.on('load', () => {
      leftMap.addControl(leftOverlay as unknown as maplibregl.IControl);
      leftOverlayRef.current = leftOverlay;

      // Make deck.gl canvas non-blocking for pointer events
      const deckCanvas = leftContainer.querySelector('.deck-canvas') as HTMLCanvasElement | null;
      if (deckCanvas) deckCanvas.style.pointerEvents = 'none';

      mapsReady.current.left = true;
      applyColors();
    });
    rightMap.on('load', () => {
      rightMap.addControl(rightOverlay as unknown as maplibregl.IControl);
      rightOverlayRef.current = rightOverlay;

      const deckCanvas = rightContainer.querySelector('.deck-canvas') as HTMLCanvasElement | null;
      if (deckCanvas) deckCanvas.style.pointerEvents = 'none';

      mapsReady.current.right = true;
      applyColors();
    });

    leftMapRef.current = leftMap;
    rightMapRef.current = rightMap;

    // Register the left map for cross-pane sync
    const syncId = registerMap(leftMap);

    // Slider drag handling
    function onPointerDown(e: PointerEvent) {
      isDragging.current = true;
      slider.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: PointerEvent) {
      if (!isDragging.current) return;
      const rect = container.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const percent = (x / rect.width) * 100;

      slider.style.left = `${percent}%`;
      clipContainer.style.width = `${100 - percent}%`;
      updateRightMapSize();

      leftMap.resize();
      rightMap.resize();
    }

    function onPointerUp() {
      isDragging.current = false;
    }

    slider.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      mapsReady.current = { left: false, right: false };
      leftOverlayRef.current = null;
      rightOverlayRef.current = null;
      unregisterMap(syncId);
      slider.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      leftMap.remove();
      rightMap.remove();
    };
  }, [applyColors, handleIdentifyClick]);

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

    // Apply scenario-specific colours via deck.gl
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
