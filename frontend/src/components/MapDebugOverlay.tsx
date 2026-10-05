// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useRef, useState } from 'react';
import { Box, Text } from '@chakra-ui/react';
import type * as maplibregl from 'maplibre-gl';
import { bandForZoom, type CatchmentTileset } from '../lib/choroplethTiles';

/**
 * Developer map debug overlay: live zoom and centre, and which HydroBASINS
 * catchment level is rendering at this zoom (or the GeoJSON fallback, if
 * no catchment tileset is in play), as one big-text line.
 *
 * Enabled by the server, not the client: `dt serve-debug` starts the server
 * with --debug-overlay, /api/info reports it, and useDebugOverlayEnabled()
 * reads that once per page load. There is deliberately no client-side
 * toggle — a debug session is explicit, and production can never end up
 * with the overlay on by accident.
 */

// One /api/info fetch per page load, shared by every pane. useServerInfo
// polls per mount, which in grid view would mean twelve pollers for one
// boolean that never changes at runtime.
let _enabledPromise: Promise<boolean> | null = null;
function fetchEnabled(): Promise<boolean> {
  if (!_enabledPromise) {
    _enabledPromise = fetch('/api/info')
      .then((r) => (r.ok ? r.json() : null))
      .then((info: { debug_overlay?: boolean } | null) => info?.debug_overlay === true)
      .catch(() => false);
  }
  return _enabledPromise;
}

/** Whether the server offered the debug overlay (see module comment). */
export function useDebugOverlayEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetchEnabled().then((v) => { if (!cancelled && v) setEnabled(true); });
    return () => { cancelled = true; };
  }, []);
  return enabled;
}

// The toolbar toggle: with the server offering debug, the features default
// on but can be switched off (and back) mid-session without a restart.
// Module state rather than React state threaded through five components:
// the toolbar (GridControls) writes it, every MapView reads it, and none of
// the components between them need to know it exists.
let _featuresOn = true;
const _featureListeners = new Set<() => void>();

/** Toolbar entry point: switch every debug feature on or off at once. */
export function setDebugFeaturesEnabled(on: boolean): void {
  if (_featuresOn === on) return;
  _featuresOn = on;
  _featureListeners.forEach((l) => l());
}

/** Current toggle position (regardless of whether the server offers debug). */
export function useDebugFeaturesToggle(): boolean {
  const [on, setOn] = useState(_featuresOn);
  useEffect(() => {
    const listener = () => setOn(_featuresOn);
    _featureListeners.add(listener);
    listener();
    return () => { _featureListeners.delete(listener); };
  }, []);
  return on;
}

/** What the map should actually do: offered by the server AND toggled on. */
export function useDebugFeaturesActive(): boolean {
  const offered = useDebugOverlayEnabled();
  const toggled = useDebugFeaturesToggle();
  return offered && toggled;
}

// One info box however many panes are mounted: grid view syncs every pane's
// camera, so twelve identical boxes would be pure clutter. The first pane to
// mount claims it; when that pane unmounts (layout switch) the claim is
// re-offered to whoever is still listening. The white debug outline is NOT
// gated by this — it is per-map rendering and belongs on every pane.
let _claimHolder: symbol | null = null;
const _claimListeners = new Set<() => void>();
function releaseClaim(id: symbol): void {
  if (_claimHolder === id) {
    _claimHolder = null;
    _claimListeners.forEach((l) => l());
  }
}

/** True for exactly one mounted caller at a time (given enabled). */
export function useSoleDebugOverlay(enabled: boolean): boolean {
  const idRef = useRef(Symbol('map-debug-overlay'));
  const [owns, setOwns] = useState(false);
  useEffect(() => {
    if (!enabled) {
      // Losing the flag (toolbar toggle off) must drop ownership too, or
      // the box lingers with nothing left that would ever remove it.
      setOwns(false);
      return;
    }
    const id = idRef.current;
    const tryClaim = () => {
      if (_claimHolder === null) _claimHolder = id;
      setOwns(_claimHolder === id);
    };
    tryClaim();
    _claimListeners.add(tryClaim);
    return () => {
      _claimListeners.delete(tryClaim);
      releaseClaim(id);
    };
  }, [enabled]);
  return owns;
}

interface DebugSnapshot {
  zoom: string;
  center: string;
  level: string;
}

// localStorage quota is per-origin and browser-dependent; ~5 MiB is the
// common figure, labeled as approximate in the UI.
const LOCALSTORAGE_NOMINAL_QUOTA = 5 * 1024 * 1024;
const STORAGE_POLL_MS = 2000;
const STORAGE_HISTORY_SAMPLES = 60; // two minutes of context

/** Bytes currently held in localStorage (UTF-16: two bytes per code unit). */
function localStorageBytes(): number {
  let bytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) ?? '';
      bytes += (key.length + (localStorage.getItem(key)?.length ?? 0)) * 2;
    }
  } catch { /* storage blocked: report zero rather than crash a debug tool */ }
  return bytes;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Live localStorage usage: headline text, a thin meter against the nominal
 * quota, and a sparkline of the recent trend so writes are visible as they
 * happen. Same-tab writes fire no 'storage' event, so this polls.
 */
function StorageMeter() {
  const [history, setHistory] = useState<number[]>(() => [localStorageBytes()]);

  useEffect(() => {
    const tick = () => setHistory((prev) => [...prev, localStorageBytes()].slice(-STORAGE_HISTORY_SAMPLES));
    const interval = window.setInterval(tick, STORAGE_POLL_MS);
    return () => window.clearInterval(interval);
  }, []);

  const used = history[history.length - 1] ?? 0;
  const fraction = Math.min(1, used / LOCALSTORAGE_NOMINAL_QUOTA);
  // Status colour is reserved for state: the accent hue until the quota is
  // genuinely near, then the warning hue.
  const barColor = fraction >= 0.8 ? 'orange.300' : 'green.300';

  // Sparkline normalised to the window's own range so small changes are
  // visible; flat history draws a flat line.
  const max = Math.max(...history, 1);
  const min = Math.min(...history);
  const span = Math.max(max - min, 1);
  const points = history
    .map((v, i) => {
      const x = history.length > 1 ? (i / (history.length - 1)) * 118 + 1 : 1;
      const y = 17 - ((v - min) / span) * 14;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <Box mt={1.5} data-testid="map-debug-storage">
      <Text color="whiteAlpha.800">
        localStorage {formatBytes(used)} · {(fraction * 100).toFixed(1)}% of ~5 MiB
      </Text>
      <Box mt={1} h="4px" borderRadius="full" bg="whiteAlpha.200" overflow="hidden">
        <Box h="100%" w={`${Math.max(fraction * 100, 1)}%`} borderRadius="full" bg={barColor} />
      </Box>
      {history.length > 1 && (
        <svg width="120" height="18" style={{ marginTop: '4px', display: 'block' }} aria-hidden="true">
          <polyline
            points={points}
            fill="none"
            stroke="var(--chakra-colors-green-300)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}
    </Box>
  );
}

/**
 * Which catchment level is rendering at this zoom, as one big-text label
 * -- what used to be a multi-line dump of every matching style layer and
 * its source-layer (`choropleth-left [catchments_lev08]`,
 * `choropleth-left-edge-blend [catchments_lev08]`, ...) was unreadable at
 * a glance; a HydroBASINS level number is the one fact that actually
 * answers "what am I looking at".
 */
function describeLevel(tileset: CatchmentTileset | null, zoom: number): string {
  if (!tileset) return 'Catchments: GeoJSON fallback';
  const band = bandForZoom(tileset, zoom);
  if (!band) return zoom < tileset.minzoom ? 'Catchments: none' : 'Catchments: gap';
  // --legacy's own low-zoom band carries lev12 ids/values under a hexagon
  // standing in for the real boundary (see generate_catchment_hexagons.py)
  // -- called out rather than left to read as plain "Level 12", which
  // would claim real boundary geometry this band doesn't have.
  const hexMatch = band.sourceLayer.match(/^catchments_lev(\d{2})_hex$/);
  if (hexMatch) return `Catchments Level ${hexMatch[1]} (hex)`;
  const level = band.sourceLayer.replace('catchments_lev', '');
  return `Catchments Level ${level}`;
}

function snapshot(map: maplibregl.Map, tileset: CatchmentTileset | null): DebugSnapshot {
  const zoom = map.getZoom();
  const center = map.getCenter();
  return {
    zoom: zoom.toFixed(2),
    center: `${center.lat.toFixed(3)}, ${center.lng.toFixed(3)}`,
    level: describeLevel(tileset, zoom),
  };
}

function MapDebugOverlay({
  mapRef,
  tilesetRef,
}: {
  mapRef: React.MutableRefObject<maplibregl.Map | null>;
  tilesetRef: React.MutableRefObject<CatchmentTileset | null>;
}) {
  const [snap, setSnap] = useState<DebugSnapshot | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let boundMap: maplibregl.Map | null = null;

    const update = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const map = mapRef.current;
        if (disposed || !map || !map.getStyle) return;
        try {
          setSnap(snapshot(map, tilesetRef.current));
        } catch { /* style mid-swap; the next event repaints */ }
      });
    };

    const events = ['move', 'zoom', 'styledata', 'idle'] as const;
    // The map is created after mount, so poll until it exists, then bind.
    const poll = window.setInterval(() => {
      const map = mapRef.current;
      if (!map || boundMap === map) return;
      boundMap = map;
      for (const e of events) map.on(e, update);
      update();
    }, 300);

    return () => {
      disposed = true;
      window.clearInterval(poll);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (boundMap) for (const e of events) boundMap.off(e, update);
    };
  }, [mapRef, tilesetRef]);

  if (!snap) return null;

  return (
    <Box
      position="absolute"
      // Lower-left, sitting to the right of MapLibre's zoom control (29px
      // wide + 10px margin) with a little breathing room, so it neither
      // covers the control nor the map's centre of attention.
      bottom={2}
      left="52px"
      zIndex={30}
      pointerEvents="none"
      bg="rgba(10, 15, 25, 0.82)"
      color="green.200"
      fontFamily="mono"
      fontSize="xs"
      px={2}
      py={1.5}
      borderRadius="md"
      maxW="340px"
      data-testid="map-debug-overlay"
    >
      <Text>z {snap.zoom} · {snap.center}</Text>
      <Text fontSize="lg" fontWeight="bold" color="green.200" my={1}>{snap.level}</Text>
      <StorageMeter />
    </Box>
  );
}

export default MapDebugOverlay;
