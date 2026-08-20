/**
 * WebGL context budget (issue #76).
 *
 * Every MapLibre instance holds a WebGL context, browsers cap the simultaneous
 * total at around sixteen, and quad view renders six panes. Two unconditional
 * instances per pane put the application at twelve before Plotly asks for any.
 *
 * WebGL itself cannot be exercised in jsdom, so this counts the decision that
 * sets the context budget instead: how many MapLibre instances one MapView
 * constructs, and whether it gives the compare one back. The context count as
 * the browser sees it still has to be read in a browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import type { ComparisonState, ViewMode } from '../types';

// --- MapLibre stand-in --------------------------------------------------------
// Records every construction and removal so a test can count contexts asked for.

const constructed: FakeMap[] = [];

class FakeMap {
  container: unknown;
  removed = false;
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  private canvas = document.createElement('canvas');

  constructor(options: { container: unknown }) {
    this.container = options.container;
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
    for (const handler of this.handlers.get(event) ?? []) handler();
  }

  addControl() {
    return this;
  }

  getCenter() {
    return { lng: 20, lat: 0 };
  }

  getZoom() {
    return 3;
  }

  getBearing() {
    return 0;
  }

  getPitch() {
    return 0;
  }

  getBounds() {
    return {
      getWest: () => 0,
      getSouth: () => 0,
      getEast: () => 1,
      getNorth: () => 1,
    };
  }

  getCanvas() {
    return this.canvas;
  }

  getStyle() {
    return { sources: {} };
  }

  getSource() {
    return undefined;
  }

  getLayer() {
    return undefined;
  }

  get style() {
    return undefined;
  }

  loaded() {
    return false;
  }

  isStyleLoaded() {
    return false;
  }

  jumpTo() {}
  easeTo() {}
  fitBounds() {}
  setStyle() {}
  resize() {}
  triggerRepaint() {}
  setMaxBounds() {}
  setMinZoom() {}
  setMaxZoom() {}
  queryRenderedFeatures() {
    return [];
  }

  project() {
    return { x: 0, y: 0 };
  }

  dragPan = { enable() {}, disable() {} };

  remove() {
    this.removed = true;
  }
}

vi.mock('maplibre-gl', () => {
  class NavigationControl {}
  const api = { Map: FakeMap, NavigationControl };
  return { ...api, default: api };
});

// The quad-view count below renders whole panes. Only the map matters here, and
// ChartView and DialChart pull in plotly.
vi.mock('../components/ChartView', () => ({ default: () => <div /> }));
vi.mock('../components/DialChart', () => ({ default: () => <div /> }));
vi.mock('../components/AggregateTable', () => ({ default: () => <div /> }));

// The map init effect kicks off catchment/tile bounds requests and the attribute
// metadata hooks fetch on mount. Nothing here asserts on them; this only keeps
// them from reaching the network or rejecting into the console.
beforeEach(() => {
  constructed.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const comparison: ComparisonState = {
  leftScenario: 'current',
  rightScenario: 'future',
  attribute: '',
};

describe('MapView WebGL instances', () => {
  it('creates one map, not two, when compare mode is off', async () => {
    const MapView = (await import('../components/MapView')).default;

    render(
      <ChakraProvider theme={theme}>
        <MapView
          comparison={comparison}
          onOpenSettings={() => {}}
          colorScaleMode="rainbow"
          colorScaleType="linear"
          isSwiperEnabled={false}
        />
      </ChakraProvider>,
    );

    expect(constructed).toHaveLength(1);
  });

  it('creates the compare map only on entering compare mode', async () => {
    const MapView = (await import('../components/MapView')).default;

    const view = (isSwiperEnabled: boolean) => (
      <ChakraProvider theme={theme}>
        <MapView
          comparison={comparison}
          onOpenSettings={() => {}}
          colorScaleMode="rainbow"
          colorScaleType="linear"
          isSwiperEnabled={isSwiperEnabled}
        />
      </ChakraProvider>
    );

    const { rerender } = render(view(false));
    expect(constructed).toHaveLength(1);

    rerender(view(true));
    expect(constructed).toHaveLength(2);
    expect(constructed[1].removed).toBe(false);
  });

  it('releases the compare map on leaving compare mode', async () => {
    const MapView = (await import('../components/MapView')).default;

    const view = (isSwiperEnabled: boolean) => (
      <ChakraProvider theme={theme}>
        <MapView
          comparison={comparison}
          onOpenSettings={() => {}}
          colorScaleMode="rainbow"
          colorScaleType="linear"
          isSwiperEnabled={isSwiperEnabled}
        />
      </ChakraProvider>
    );

    const { rerender } = render(view(true));
    expect(constructed).toHaveLength(2);

    rerender(view(false));

    const [leftMap, rightMap] = constructed;
    expect(rightMap.removed).toBe(true);
    // The map the user is actually looking at must not be disturbed by the
    // compare map coming and going.
    expect(leftMap.removed).toBe(false);
    expect(constructed).toHaveLength(2);
  });

  it('releases both maps on unmount', async () => {
    const MapView = (await import('../components/MapView')).default;

    const { unmount } = render(
      <ChakraProvider theme={theme}>
        <MapView
          comparison={comparison}
          onOpenSettings={() => {}}
          colorScaleMode="rainbow"
          colorScaleType="linear"
          isSwiperEnabled
        />
      </ChakraProvider>,
    );

    expect(constructed).toHaveLength(2);
    unmount();
    expect(constructed.every((map) => map.removed)).toBe(true);
  });
});

// The number the issue asks to see fall: not a browser context counter, which
// jsdom cannot provide, but the count of MapLibre instances a full quad view
// asks for. Before this change it was six panes x two maps = twelve, whatever
// compare mode was doing and whatever each pane was displaying.
//
// Note the compare swiper defaults to ON in App.tsx, so the twelve only falls
// to six once the user turns it off — the pane-level release below is what
// bounds the default configuration.
describe('quad view map instance count', () => {
  const PANES = 6;

  const renderQuad = async (viewModes: ViewMode[], isSwiperEnabled: boolean) => {
    const ViewPane = (await import('../components/ViewPane')).default;

    const quad = (modes: ViewMode[]) => (
      <ChakraProvider theme={theme}>
        {modes.map((mode, index) => (
          <ViewPane
            key={index}
            comparison={comparison}
            paneIndex={index}
            layoutMode="quad"
            viewMode={mode}
            isSwiperEnabled={isSwiperEnabled}
            onViewModeChange={() => {}}
            onFocusPane={() => {}}
            onGoQuad={() => {}}
            colorScaleMode="rainbow"
            colorScaleType="linear"
          />
        ))}
      </ChakraProvider>
    );

    const utils = render(quad(viewModes));
    // Panes stagger their map creation by 250 ms each; let them all land.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    return { ...utils, quad };
  };

  const allMaps = () => Array.from({ length: PANES }, () => 'map' as ViewMode);

  it('asks for one context per pane when compare mode is off', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderQuad(allMaps(), false);
      expect(constructed).toHaveLength(PANES);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks for two per pane in compare mode, which is the worst case', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderQuad(allMaps(), true);
      // Twelve is the pre-existing ceiling, and it is only reachable now with
      // every pane on a map and the swiper on — not, as before, by six panes
      // having each shown a map once at some point in the session.
      expect(constructed).toHaveLength(PANES * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Two panes stay on the map; the other four move to a chart, dial or table.
  const mixed: ViewMode[] = ['map', 'map', 'chart', 'chart', 'dial', 'table'];

  it('holds nothing for panes that have left map view', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender, quad } = await renderQuad(allMaps(), true);
      expect(constructed).toHaveLength(PANES * 2);

      rerender(quad(mixed));
      act(() => {
        vi.advanceTimersByTime(30_000);
      });

      const live = constructed.filter((map) => !map.removed);
      expect(live).toHaveLength(2 * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bottoms out at one context per displayed map', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender, quad } = await renderQuad(allMaps(), false);
      rerender(quad(mixed));
      act(() => {
        vi.advanceTimersByTime(30_000);
      });

      const live = constructed.filter((map) => !map.removed);
      expect(live).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
