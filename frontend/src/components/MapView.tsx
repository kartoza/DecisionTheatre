import { useEffect, useRef, useCallback } from 'react';
import { Box } from '@chakra-ui/react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ComparisonState, Scenario } from '../types';
import { SCENARIOS } from '../types';
import { registerMap, unregisterMap } from '../hooks/useMapSync';

interface MapViewProps {
  comparison: ComparisonState;
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

export const PRISM_CSS_GRADIENT =
  `linear-gradient(to right, ${PRISM_STOPS.map(([, c]) => c).join(', ')})`;

const FILL_LAYER_ID = 'catchments-fill';
const SOURCE_LAYER = 'catchments_lev12';
// The property in the vector tiles that identifies each catchment.
// Tippecanoe preserves the original GeoPackage column name.
const CATCHMENT_ID_PROP = 'HYBAS_ID';

/** Interpolate a colour from the PRISM gradient for a normalised [0,1] value */
function interpolateColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  for (let i = 0; i < PRISM_STOPS.length - 1; i++) {
    const [t0, c0] = PRISM_STOPS[i];
    const [t1, c1] = PRISM_STOPS[i + 1];
    if (clamped >= t0 && clamped <= t1) {
      const f = (clamped - t0) / (t1 - t0);
      return lerpHex(c0, c1, f);
    }
  }
  return PRISM_STOPS[PRISM_STOPS.length - 1][1];
}

function lerpHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const bl = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r},${g},${bl})`;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

/**
 * Build a MapLibre match expression that maps catchment IDs to colours.
 * data: Record<string, number> from /api/scenario/{scenario}/{attribute}
 */
function buildColorMatchExpr(
  data: Record<string, number>,
): maplibregl.ExpressionSpecification {
  const values = Object.values(data);
  if (values.length === 0) {
    return 'rgba(0,0,0,0)' as unknown as maplibregl.ExpressionSpecification;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;

  // Build: ['match', ['get', 'HYBAS_ID'], id1, color1, id2, color2, ..., fallback]
  // HYBAS_ID is numeric in the vector tiles, so we match on numbers
  const expr: unknown[] = ['match', ['get', CATCHMENT_ID_PROP]];
  for (const [id, val] of Object.entries(data)) {
    const numId = Number(id);
    if (!Number.isFinite(numId)) continue;
    const normalised = (val - min) / range;
    expr.push(numId, interpolateColor(normalised));
  }
  expr.push('rgba(0,0,0,0)'); // fallback: transparent for unmatched
  return expr as maplibregl.ExpressionSpecification;
}

/** Ensure a catchments-fill layer exists on the map */
function ensureFillLayer(map: maplibregl.Map) {
  if (map.getLayer(FILL_LAYER_ID)) return;
  // Add fill layer before the outlines layer so outlines draw on top
  const beforeLayer = map.getLayer('Catchments Outlines') ? 'Catchments Outlines' : undefined;
  map.addLayer(
    {
      id: FILL_LAYER_ID,
      type: 'fill',
      source: 'UoW Tiles',
      'source-layer': SOURCE_LAYER,
      paint: {
        'fill-color': 'rgba(0,0,0,0)',
        'fill-opacity': 0,
      },
    },
    beforeLayer,
  );
}

/** Apply scenario colouring to a single map */
async function applyScenarioColor(
  map: maplibregl.Map,
  scenario: Scenario,
  attribute: string,
) {
  if (!attribute) {
    // No attribute selected — hide the fill
    try {
      map.setPaintProperty(FILL_LAYER_ID, 'fill-opacity', 0);
    } catch { /* layer may not exist yet */ }
    return;
  }

  // Fetch scenario data
  const resp = await fetch(`/api/scenario/${scenario}/${attribute}`);
  if (!resp.ok) return;
  const data: Record<string, number> = await resp.json();

  // Build colour expression and apply
  const colorExpr = buildColorMatchExpr(data);
  try {
    ensureFillLayer(map);
    map.setPaintProperty(FILL_LAYER_ID, 'fill-color-transition', { duration: 800, delay: 0 });
    map.setPaintProperty(FILL_LAYER_ID, 'fill-color', colorExpr);
    map.setPaintProperty(FILL_LAYER_ID, 'fill-opacity-transition', { duration: 600, delay: 0 });
    map.setPaintProperty(FILL_LAYER_ID, 'fill-opacity', 0.85);
  } catch { /* layer may not exist yet */ }
}

function MapView({ comparison }: MapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const leftMapRef = useRef<maplibregl.Map | null>(null);
  const rightMapRef = useRef<maplibregl.Map | null>(null);
  const compareContainerRef = useRef<HTMLDivElement | null>(null);
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const isDragging = useRef(false);
  const mapsReady = useRef<{ left: boolean; right: boolean }>({ left: false, right: false });

  // Store latest comparison in a ref so async callbacks see current values
  const comparisonRef = useRef(comparison);
  comparisonRef.current = comparison;

  const applyColors = useCallback(() => {
    const c = comparisonRef.current;
    if (leftMapRef.current && mapsReady.current.left) {
      applyScenarioColor(leftMapRef.current, c.leftScenario, c.attribute);
    }
    if (rightMapRef.current && mapsReady.current.right) {
      applyScenarioColor(rightMapRef.current, c.rightScenario, c.attribute);
    }
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
    // pointer-events:auto so the clip region itself receives events for the right map
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

    // Load style from server
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

    // When maps are loaded, add the fill layer and apply initial colours
    leftMap.on('load', () => {
      ensureFillLayer(leftMap);
      mapsReady.current.left = true;
      applyColors();
    });
    rightMap.on('load', () => {
      ensureFillLayer(rightMap);
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
      unregisterMap(syncId);
      slider.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      leftMap.remove();
      rightMap.remove();
    };
  }, [applyColors]);

  // Update labels and colours when comparison changes
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    const leftLabel = container.querySelector('#left-label') as HTMLElement;
    const rightLabel = container.querySelector('#right-label') as HTMLElement;

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

    // Apply scenario-specific colours
    applyColors();
  }, [comparison, applyColors]);

  return (
    <Box
      ref={mapContainerRef}
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      overflow="hidden"
    />
  );
}

export default MapView;
