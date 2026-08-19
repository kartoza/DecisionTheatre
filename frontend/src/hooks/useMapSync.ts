/**
 * Global map synchronization registry.
 * All MapView instances register their MapLibre maps here.
 * When any map moves, all others are updated to match.
 */
import maplibregl from 'maplibre-gl';

type MapEntry = {
  map: maplibregl.Map;
  id: string;
  handler: () => void;
};

const registry: MapEntry[] = [];
let syncing = false;

/** A map view, in the four properties every sync path already copies. */
export interface SyncedMapView {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

// The last view any registered map reported.
//
// Map instances are transient: the compare map is created only while compare
// mode is on, and a pane releases its maps when it stops displaying one, so the
// browser is not holding WebGL contexts nothing is drawing to (issue #76). The
// view therefore has to outlive the instances that produced it — without this,
// every recreate would drop the user back to the default world view.
let lastView: SyncedMapView | null = null;

function captureView(map: maplibregl.Map): void {
  const center = map.getCenter();
  lastView = {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  };
}

/** The view a freshly created map should open at, or null on a cold start. */
export function getLastMapView(): SyncedMapView | null {
  return lastView;
}

function broadcastMove(sourceId: string, source: maplibregl.Map) {
  // Recorded before the re-entrancy guard: a programmatic jump driven by
  // another map still leaves the registry at a view worth restoring.
  captureView(source);
  if (syncing) return;
  syncing = true;
  for (const entry of registry) {
    if (entry.id !== sourceId) {
      entry.map.jumpTo({
        center: source.getCenter(),
        zoom: source.getZoom(),
        bearing: source.getBearing(),
        pitch: source.getPitch(),
      });
    }
  }
  syncing = false;
}

let nextId = 0;

export function registerMap(map: maplibregl.Map): string {
  const id = `map-${nextId++}`;
  const handler = () => broadcastMove(id, map);

  registry.push({ map, id, handler });

  // Sync new map to existing maps' position (if any exist)
  if (registry.length > 1) {
    const first = registry[0];
    if (first.id !== id) {
      map.jumpTo({
        center: first.map.getCenter(),
        zoom: first.map.getZoom(),
        bearing: first.map.getBearing(),
        pitch: first.map.getPitch(),
      });
    }
  }

  map.on('move', handler);

  return id;
}

export function unregisterMap(id: string) {
  const idx = registry.findIndex((e) => e.id === id);
  if (idx !== -1) {
    const entry = registry[idx];
    // Last chance to record where this map was looking: it is about to be
    // removed, and it may be the only one left.
    captureView(entry.map);
    // Remove the event listener to prevent memory leaks
    entry.map.off('move', entry.handler);
    registry.splice(idx, 1);
  }
}
