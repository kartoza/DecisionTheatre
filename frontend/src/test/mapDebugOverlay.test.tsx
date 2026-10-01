import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import type * as maplibregl from 'maplibre-gl';
import { theme } from '../styles/theme';
import MapDebugOverlay from '../components/MapDebugOverlay';
import { CATCHMENT_TILE_SOURCE_LAYER, resolveCatchmentTileset, type CatchmentTileset } from '../lib/choroplethTiles';

// A map that reports a fixed camera and style — everything the overlay reads.
function fakeMap(zoom: number) {
  const handlers = new Map<string, Array<() => void>>();
  return {
    getZoom: () => zoom,
    getCenter: () => ({ lat: -5.123456, lng: 22.654321 }),
    getStyle: () => ({
      layers: [
        { id: 'landcover', minzoom: 0, maxzoom: 24 },
        { id: 'choropleth-left', 'source-layer': 'catchments_lev04', minzoom: 0, maxzoom: 24 },
        { id: 'too-deep', minzoom: 10, maxzoom: 24 },
      ],
    }),
    on: (e: string, h: () => void) => { handlers.set(e, [...(handlers.get(e) ?? []), h]); },
    off: () => {},
  } as unknown as maplibregl.Map;
}

const SPLIT: CatchmentTileset = resolveCatchmentTileset({
  tilesets: [
    { name: 'catchments-lev04', sourceLayer: 'catchments_lev04', tilezoom: 0, tiles: ['http://x/{z}/{x}/{y}.pbf'] },
    { name: 'catchments-lev12', sourceLayer: CATCHMENT_TILE_SOURCE_LAYER, tilezoom: 11, tiles: ['http://x/{z}/{x}/{y}.pbf'] },
  ],
}) as CatchmentTileset;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('MapDebugOverlay', () => {
  it('shows the zoom, centre, and the active catchment level as one big-text line', async () => {
    const mapRef = { current: fakeMap(3) };
    const tilesetRef = { current: SPLIT };

    render(
      <ChakraProvider theme={theme}>
        <MapDebugOverlay mapRef={mapRef} tilesetRef={tilesetRef} />
      </ChakraProvider>,
    );

    // The map exists before the overlay's first poll tick; advance past it
    // and the rAF the update is coalesced through.
    await act(async () => { vi.advanceTimersByTime(350); });
    await act(async () => { vi.advanceTimersToNextFrame(); });

    const overlay = screen.getByTestId('map-debug-overlay');
    expect(overlay.textContent).toContain('z 3.00');
    // z3 falls in the lev04 band (tiled at z0, overzoomed) — the level
    // number is the one fact this overlay exists to make visible, not the
    // overzoom factor or a dump of every matching style layer.
    expect(overlay.textContent).toContain('Catchments Level 04');
  });

  it('names the GeoJSON fallback when there is no catchment tileset', async () => {
    const mapRef = { current: fakeMap(5) };
    const tilesetRef = { current: null };

    render(
      <ChakraProvider theme={theme}>
        <MapDebugOverlay mapRef={mapRef} tilesetRef={tilesetRef} />
      </ChakraProvider>,
    );
    await act(async () => { vi.advanceTimersByTime(350); });
    await act(async () => { vi.advanceTimersToNextFrame(); });

    expect(screen.getByTestId('map-debug-overlay').textContent).toContain('Catchments: GeoJSON fallback');
  });
});

describe('useSoleDebugOverlay', () => {
  it('grants the box to exactly one of many panes, and re-offers it on unmount', async () => {
    const { useSoleDebugOverlay } = await import('../components/MapDebugOverlay');
    const grants: boolean[] = [];
    function Pane({ i }: { i: number }) {
      grants[i] = useSoleDebugOverlay(true);
      return null;
    }
    const { rerender, unmount } = render(<><Pane i={0} /><Pane i={1} /><Pane i={2} /></>);
    expect(grants.filter(Boolean)).toHaveLength(1);
    expect(grants[0]).toBe(true);

    // Owner unmounts: the claim moves to a surviving pane instead of dying.
    rerender(<><Pane i={1} /><Pane i={2} /></>);
    await act(async () => {});
    expect([grants[1], grants[2]].filter(Boolean)).toHaveLength(1);
    unmount();
  });
});

describe('debug features toggle', () => {
  it('combines the server offer with the toolbar toggle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ debug_overlay: true }), { headers: { 'content-type': 'application/json' } })));
    const mod = await import('../components/MapDebugOverlay');

    const states: boolean[] = [];
    function Probe() {
      states.push(mod.useDebugFeaturesActive());
      return null;
    }
    render(<Probe />);
    await act(async () => { await Promise.resolve(); });
    expect(states[states.length - 1]).toBe(true); // offered + default-on toggle

    await act(async () => { mod.setDebugFeaturesEnabled(false); });
    expect(states[states.length - 1]).toBe(false); // toolbar wins over the offer

    await act(async () => { mod.setDebugFeaturesEnabled(true); });
    expect(states[states.length - 1]).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('useSoleDebugOverlay + toggle', () => {
  it('hides the box when the toolbar toggle turns debug off', async () => {
    const mod = await import('../components/MapDebugOverlay');
    mod.setDebugFeaturesEnabled(true);
    let granted = false;
    function Probe({ enabled }: { enabled: boolean }) {
      granted = mod.useSoleDebugOverlay(enabled);
      return null;
    }
    const { rerender } = render(<Probe enabled={true} />);
    expect(granted).toBe(true);

    // The toolbar toggle flips the enabled signal off: the grant must drop
    // with it, or the box lingers with nothing left to remove it.
    rerender(<Probe enabled={false} />);
    await act(async () => {});
    expect(granted).toBe(false);
  });
});

describe('StorageMeter', () => {
  it('reports localStorage usage and tracks growth in realtime', async () => {
    localStorage.clear();
    localStorage.setItem('dt-test-blob', 'x'.repeat(50_000)); // ~100 KB UTF-16

    const mapRef = { current: fakeMap(3) };
    const tilesetRef = { current: SPLIT };
    render(
      <ChakraProvider theme={theme}>
        <MapDebugOverlay mapRef={mapRef} tilesetRef={tilesetRef} />
      </ChakraProvider>,
    );
    await act(async () => { vi.advanceTimersByTime(350); });
    await act(async () => { vi.advanceTimersToNextFrame(); });

    const storage = screen.getByTestId('map-debug-storage');
    expect(storage.textContent).toContain('localStorage');
    expect(storage.textContent).toMatch(/9[7-9]\.\d KiB|1\d\d\.\d KiB/); // ~100 KB

    // A write made while the overlay is up appears on the next poll tick.
    localStorage.setItem('dt-test-blob-2', 'y'.repeat(500_000)); // ~1 MB more
    await act(async () => { vi.advanceTimersByTime(2100); });
    expect(screen.getByTestId('map-debug-storage').textContent).toMatch(/MiB · /);
    localStorage.clear();
  });
});
