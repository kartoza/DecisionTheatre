/**
 * Pane map lifecycle (issue #76).
 *
 * ViewPane used to latch "this pane has shown a map" on first display and never
 * clear it: the map stayed mounted behind `opacity: 0` for the rest of the
 * session, so a quad view where every pane had once shown a map held six panes'
 * worth of WebGL contexts no matter what those panes were displaying.
 *
 * MapView is stubbed here — this is about when the pane mounts and unmounts it,
 * not about what it draws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import type { ComparisonState } from '../types';

vi.mock('../components/MapView', async () => {
  const { useEffect } = await import('react');
  return {
    default: function MapViewStub({ onReady }: { onReady?: () => void }) {
      useEffect(() => {
        onReady?.();
      }, [onReady]);
      return <div data-testid="map-view" />;
    },
  };
});

// Rendered alongside the map in every pane, and irrelevant here: ChartView and
// DialChart pull in plotly.
vi.mock('../components/ChartView', () => ({ default: () => <div /> }));
vi.mock('../components/DialChart', () => ({ default: () => <div /> }));
vi.mock('../components/AggregateTable', () => ({ default: () => <div /> }));

beforeEach(() => {
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

describe('ViewPane map mounting', () => {
  const renderPane = async (viewMode: 'map' | 'chart') => {
    const ViewPane = (await import('../components/ViewPane')).default;

    const pane = (mode: 'map' | 'chart') => (
      <ChakraProvider theme={theme}>
        <ViewPane
          comparison={comparison}
          paneIndex={0}
          layoutMode="quad"
          viewMode={mode}
          onViewModeChange={() => {}}
          onFocusPane={() => {}}
          onGoQuad={() => {}}
          colorScaleMode="rainbow"
          colorScaleType="linear"
        />
      </ChakraProvider>
    );

    const utils = render(pane(viewMode));
    return { ...utils, pane };
  };

  it('mounts no map for a pane that has never shown one', async () => {
    await renderPane('chart');
    expect(screen.queryByTestId('map-view')).toBeNull();
  });

  it('unmounts the map once the pane has stopped showing one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender, pane } = await renderPane('map');
      expect(screen.getByTestId('map-view')).toBeInTheDocument();

      rerender(pane('chart'));
      // Still mounted inside the grace period: a quick map -> chart -> map
      // round trip must not pay for a full re-init.
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.queryByTestId('map-view')).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(screen.queryByTestId('map-view')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the map mounted when the pane returns to map view in time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender, pane } = await renderPane('map');

      rerender(pane('chart'));
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      rerender(pane('map'));
      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(screen.queryByTestId('map-view')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
