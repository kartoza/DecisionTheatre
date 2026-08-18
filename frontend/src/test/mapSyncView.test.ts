/**
 * Map view survival across a teardown (issue #76).
 *
 * Map instances are no longer permanent: the compare map lives only while
 * compare mode is on, and a pane releases its maps when it stops showing one.
 * A recreated map therefore has to open where the last one was looking, or
 * every release would throw the user back out to the default world view.
 *
 * The sync registry is where that view already flows through, so it is what
 * remembers it.
 */
import { describe, it, expect } from 'vitest';
import type maplibregl from 'maplibre-gl';
import { registerMap, unregisterMap, getLastMapView } from '../hooks/useMapSync';

/** Minimal stand-in for the handful of methods the registry touches. */
function fakeMap(view: { lng: number; lat: number; zoom: number; bearing?: number; pitch?: number }) {
  const listeners: Array<() => void> = [];
  const state = { ...view, bearing: view.bearing ?? 0, pitch: view.pitch ?? 0 };

  const map = {
    getCenter: () => ({ lng: state.lng, lat: state.lat }),
    getZoom: () => state.zoom,
    getBearing: () => state.bearing,
    getPitch: () => state.pitch,
    jumpTo: (target: { center: { lng: number; lat: number }; zoom: number }) => {
      state.lng = target.center.lng;
      state.lat = target.center.lat;
      state.zoom = target.zoom;
    },
    on: (_event: string, handler: () => void) => listeners.push(handler),
    off: () => {},
    /** Move the map the way a user pan/zoom would, then notify the registry. */
    moveTo(next: { lng: number; lat: number; zoom: number }) {
      Object.assign(state, next);
      for (const handler of listeners) handler();
    },
  };

  return map as unknown as maplibregl.Map & { moveTo: (n: { lng: number; lat: number; zoom: number }) => void };
}

describe('map sync view memory', () => {
  it('round-trips the view through a teardown and recreate', () => {
    const first = fakeMap({ lng: 0, lat: 0, zoom: 3 });
    const firstId = registerMap(first);

    first.moveTo({ lng: 28.19, lat: -25.75, zoom: 11.5 });

    // The pane switches away from map view, or compare mode ends: the instance
    // goes, the view must not.
    unregisterMap(firstId);

    const remembered = getLastMapView();
    expect(remembered).not.toBeNull();
    expect(remembered?.center[0]).toBeCloseTo(28.19);
    expect(remembered?.center[1]).toBeCloseTo(-25.75);
    expect(remembered?.zoom).toBeCloseTo(11.5);
  });

  it('records the view of a map that never moved before being released', () => {
    const map = fakeMap({ lng: 18.42, lat: -33.92, zoom: 9 });
    unregisterMap(registerMap(map));

    expect(getLastMapView()?.center[0]).toBeCloseTo(18.42);
    expect(getLastMapView()?.zoom).toBeCloseTo(9);
  });

  it('still syncs a newly registered map to a live one', () => {
    const live = fakeMap({ lng: 0, lat: 0, zoom: 3 });
    const liveId = registerMap(live);
    live.moveTo({ lng: 31.05, lat: -17.83, zoom: 8 });

    const fresh = fakeMap({ lng: 0, lat: 0, zoom: 3 });
    const freshId = registerMap(fresh);

    expect(fresh.getCenter().lng).toBeCloseTo(31.05);
    expect(fresh.getZoom()).toBeCloseTo(8);

    unregisterMap(freshId);
    unregisterMap(liveId);
  });
});
