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

function broadcastMove(sourceId: string, source: maplibregl.Map) {
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
    // Remove the event listener to prevent memory leaks
    entry.map.off('move', entry.handler);
    registry.splice(idx, 1);
  }
}
