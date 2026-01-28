import { useEffect, useRef } from 'react';
import { Box } from '@chakra-ui/react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ComparisonState } from '../types';
import { SCENARIOS } from '../types';

interface MapViewProps {
  comparison: ComparisonState;
}

// Color ramp for data visualization (blue to red)
function getColorExpression(attribute: string): maplibregl.ExpressionSpecification {
  if (!attribute) {
    return ['interpolate', ['linear'], ['get', 'value'],
      0, '#2166ac',
      0.25, '#67a9cf',
      0.5, '#fddbc7',
      0.75, '#ef8a62',
      1, '#b2182b',
    ];
  }

  return ['interpolate', ['linear'], ['get', attribute],
    0, '#2166ac',
    0.25, '#67a9cf',
    0.5, '#f7f7f7',
    0.75, '#ef8a62',
    1, '#b2182b',
  ];
}

function MapView({ comparison }: MapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const leftMapRef = useRef<maplibregl.Map | null>(null);
  const rightMapRef = useRef<maplibregl.Map | null>(null);
  const compareContainerRef = useRef<HTMLDivElement | null>(null);
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const isDragging = useRef(false);

  // Initialize the two maps and the compare slider
  useEffect(() => {
    if (!mapContainerRef.current) return;

    const container = mapContainerRef.current;

    // Create the left and right map containers
    const leftContainer = document.createElement('div');
    leftContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
    leftContainer.id = 'map-left';

    // Right map container is full-width but we position it inside
    // the clip so only the right portion is visible. We offset it
    // left by the clip's left edge so it aligns pixel-perfectly
    // with the left map underneath.
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

    // Load style from server
    const styleUrl = window.location.origin + '/data/style.json';

    // Create left map
    const leftMap = new maplibregl.Map({
      container: leftContainer,
      style: styleUrl,
      center: [20, 0], // Center of Africa
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

    leftMapRef.current = leftMap;
    rightMapRef.current = rightMap;

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
      slider.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      leftMap.remove();
      rightMap.remove();
    };
  }, []);

  // Update labels and styles when comparison changes
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

    // Update catchment colors based on attribute
    if (comparison.attribute && leftMapRef.current && rightMapRef.current) {
      const colorExpr = getColorExpression(comparison.attribute);

      try {
        leftMapRef.current.setPaintProperty('catchments-fill', 'fill-color', colorExpr);
        rightMapRef.current.setPaintProperty('catchments-fill', 'fill-color', colorExpr);
      } catch {
        // Layer may not exist yet if tiles aren't loaded
      }
    }
  }, [comparison]);

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
