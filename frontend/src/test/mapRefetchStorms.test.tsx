/**
 * Refetch storms on map interaction (issue #60).
 *
 * A pan fires choropleth requests that the next pan immediately obsoletes.
 * Nothing ordered the responses, so whichever landed last painted the map — and
 * the map could settle showing a viewport the user had already left. Nothing
 * cancelled them either, so the connection and the server stayed busy on
 * answers no one would read.
 *
 * MapLibre is stubbed (as in webglContextBudget.test.tsx — WebGL cannot run in
 * jsdom) with a movable viewport, so a pan is a real 'moveend' with real new
 * bounds and the requests it produces are the real ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import type { ComparisonState } from '../types';

// --- MapLibre stand-in --------------------------------------------------------

const constructed: FakeMap[] = [];

class FakeMap {
  removed = false;
  west = 0;
  south = 0;
  east = 1;
  north = 1;
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  private canvas = document.createElement('canvas');

  constructor() {
    constructed.push(this);
  }

  on(event: string, handler: (...args: unknown[]) => void) {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
    return this;
  }

  once(event: string, handler: (...args: unknown[]) => void) {
    return this.on(event, handler);
  }

  off() {
    return this;
  }

  fire(event: string) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler({ point: { x: 0, y: 0 } });
  }

  /** Move the viewport, exactly as a drag would, and end the movement. */
  panTo(west: number) {
    this.west = west;
    this.east = west + 1;
    this.fire('moveend');
  }

  addControl() { return this; }
  getCenter() { return { lng: (this.west + this.east) / 2, lat: 0 }; }
  getZoom() { return 6; }
  getBearing() { return 0; }
  getPitch() { return 0; }

  getBounds() {
    return {
      getWest: () => this.west,
      getSouth: () => this.south,
      getEast: () => this.east,
      getNorth: () => this.north,
      getSouthWest: () => ({ lng: this.west, lat: this.south }),
      getNorthEast: () => ({ lng: this.east, lat: this.north }),
    };
  }

  getCanvas() { return this.canvas; }
  getStyle() { return { sources: {} }; }
  getSource() { return undefined; }
  getLayer() { return undefined; }
  get style() { return undefined; }
  loaded() { return false; }
  isStyleLoaded() { return false; }
  jumpTo() {}
  easeTo() {}
  fitBounds() {}
  setStyle() {}
  resize() {}
  triggerRepaint() {}
  setMaxBounds() {}
  setMinZoom() {}
  setMaxZoom() {}
  queryRenderedFeatures() { return []; }
  project() { return { x: 0, y: 0 }; }
  dragPan = { enable() {}, disable() {} };
  remove() { this.removed = true; }
}

class FakeLngLatBounds {
  constructor(private sw: [number, number], private ne: [number, number]) {}
  getSouthWest() { return { lng: this.sw[0], lat: this.sw[1] }; }
  getNorthEast() { return { lng: this.ne[0], lat: this.ne[1] }; }
  getWest() { return this.sw[0]; }
  getSouth() { return this.sw[1]; }
  getEast() { return this.ne[0]; }
  getNorth() { return this.ne[1]; }
  extend() { return this; }
}

vi.mock('maplibre-gl', () => {
  class NavigationControl {}
  const api = { Map: FakeMap, NavigationControl, LngLatBounds: FakeLngLatBounds };
  return { ...api, default: api };
});

vi.mock('../components/ChartView', () => ({ default: () => <div /> }));
vi.mock('../components/DialChart', () => ({ default: () => <div /> }));
vi.mock('../components/AggregateTable', () => ({ default: () => <div /> }));

// --- Network stand-in ---------------------------------------------------------

interface Call {
  url: string;
  signal?: AbortSignal;
  settle: (body: unknown) => void;
}

let calls: Call[] = [];

/**
 * The viewport's own choropleth requests.
 *
 * Deliberately not the full-domain and site-scoped `valuesOnly` requests: those
 * feed the Full and Site range statistics, do not depend on the viewport, and
 * are correctly left alone by a pan.
 */
function choroplethCalls(): Call[] {
  return calls.filter((c) => c.url.startsWith('/api/choropleth?') && !c.url.includes('valuesOnly'));
}

function boundsOf(call: Call): string {
  const params = new URLSearchParams(call.url.slice(call.url.indexOf('?') + 1));
  return `${params.get('minx')},${params.get('maxx')}`;
}

/** One catchment carrying `value` for `attribute`, in the shape /api/choropleth returns. */
function featureCollection(attribute: string, value: number) {
  return {
    type: 'FeatureCollection',
    domain_min: value,
    domain_max: value,
    features: [{
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      properties: { HYBAS_ID: 1, [attribute]: value },
    }],
  };
}

beforeEach(() => {
  // The choropleth caches are module state with a 60-second TTL, and every test
  // here pans over the same bounds. Without a fresh module the second test
  // would be served from the first test's cache and make no requests at all —
  // which is the right behaviour in the application and useless in a test.
  vi.resetModules();
  constructed.length = 0;
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const call: Call = {
        url,
        signal: init?.signal ?? undefined,
        settle: (body: unknown) =>
          resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })),
      };
      calls.push(call);
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
      // Anything the test does not care about answers with an empty object as
      // soon as it is asked, so mount-time metadata requests do not hang.
      if (!url.startsWith('/api/choropleth?') && !url.startsWith('/api/catchment-values?')) {
        call.settle({});
      }
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const comparison: ComparisonState = {
  leftScenario: 'reference',
  rightScenario: 'current',
  attribute: 'water_yield',
};

async function mountMap(props: Record<string, unknown> = {}) {
  const MapView = (await import('../components/MapView')).default;
  const stats: Array<{ domainRange: { min: number; max: number } | null }> = [];

  await act(async () => {
    render(
      <ChakraProvider theme={theme}>
        <MapView
          comparison={comparison}
          onOpenSettings={() => {}}
          colorScaleMode="rainbow"
          colorScaleType="linear"
          isSwiperEnabled={false}
          onStatisticsChange={(s) => stats.push(s as { domainRange: { min: number; max: number } | null })}
          {...props}
        />
      </ChakraProvider>,
    );
  });

  const map = constructed[0];
  // 'load' is what marks the map ready and triggers the first paint.
  await act(async () => { map.fire('load'); });
  return { map, stats };
}

/** Let the moveend debounce elapse and the resulting work start. */
async function settle(ms = 400) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

describe('choropleth requests during a pan', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('cancels the request a further pan has made pointless', async () => {
    const { map } = await mountMap();
    await settle();

    const first = choroplethCalls();
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((c) => c.signal !== undefined)).toBe(true);
    expect(first.every((c) => c.signal!.aborted)).toBe(false);

    // Pan away before the first viewport's answer arrives.
    await act(async () => { map.panTo(10); });
    await settle();

    const second = choroplethCalls().filter((c) => !first.includes(c));
    expect(second.length).toBeGreaterThan(0);
    expect(boundsOf(second[0])).not.toBe(boundsOf(first[0]));

    // The superseded requests are really cancelled, not merely ignored: the
    // connection is freed and the server is free to stop.
    expect(first.every((c) => c.signal!.aborted)).toBe(true);
    expect(second.every((c) => c.signal!.aborted)).toBe(false);
  });

  it('paints the current viewport even when the old one answers last', async () => {
    // The out-of-order case. The first viewport's request is allowed to finish
    // after the second's, with a different domain, and must not be the one that
    // reaches the statistics panel.
    const { map, stats } = await mountMap();
    await settle();

    const first = choroplethCalls();
    await act(async () => { map.panTo(10); });
    await settle();
    const second = choroplethCalls().filter((c) => !first.includes(c));

    await act(async () => {
      second.forEach((c) => c.settle(featureCollection('water_yield', 222)));
      await Promise.resolve();
    });
    await act(async () => {
      first.forEach((c) => c.settle(featureCollection('water_yield', 111)));
      await Promise.resolve();
    });

    const published = stats.filter((s) => s.domainRange !== null).map((s) => s.domainRange!.max);
    expect(published).toContain(222);
    expect(published).not.toContain(111);
    expect(published[published.length - 1]).toBe(222);
  });

  it('does not re-request a viewport it never left', async () => {
    // moveend fires for plenty of things that leave the viewport where it was.
    const { map } = await mountMap();
    await settle();
    const before = choroplethCalls().length;

    await act(async () => { map.fire('moveend'); });
    await settle();

    expect(choroplethCalls()).toHaveLength(before);
  });

  it('reports an unchanged extent to the application once, not once per moveend', async () => {
    // Every report lands in App state and re-renders the whole pane tree.
    const extents: unknown[] = [];
    const { map } = await mountMap({ onMapExtentChange: (e: unknown) => extents.push(e) });
    await settle();

    await act(async () => { map.fire('moveend'); });
    await act(async () => { map.fire('moveend'); });
    const afterRepeats = extents.length;

    await act(async () => { map.panTo(42); });
    expect(extents.length).toBe(afterRepeats + 1);
    expect(afterRepeats).toBeLessThanOrEqual(1);
  });

  it('makes one request per question when several panes ask together', async () => {
    // Quad view: every pane holds its own MapView over the same viewport.
    const MapView = (await import('../components/MapView')).default;
    await act(async () => {
      render(
        <ChakraProvider theme={theme}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <MapView
              key={i}
              comparison={comparison}
              onOpenSettings={() => {}}
              colorScaleMode="rainbow"
              colorScaleType="linear"
              isSwiperEnabled={false}
            />
          ))}
        </ChakraProvider>,
      );
    });

    await act(async () => { constructed.forEach((m) => m.fire('load')); });
    await settle();

    const urls = choroplethCalls().map((c) => c.url);
    // Two scenarios, one viewport: two distinct questions, and no duplicates of
    // either however many panes are asking.
    expect(new Set(urls).size).toBe(2);
    expect(urls).toHaveLength(2);
  });
});
