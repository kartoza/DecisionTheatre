/**
 * /api/aggregate fan-out on map interaction (issue #60).
 *
 * The most expensive request the client makes — a full-domain aggregate for a
 * single attribute measures around 4.8 seconds server-side — and the least
 * coordinated. Every pane issued its own, none were shared, none were
 * cancelled, and the effects that issued them listed the map extent object as a
 * dependency whether or not the range mode used it. So a pan re-asked, per
 * pane, a question whose answer could not have changed.
 *
 * The panes are real ViewPanes; MapView, ChartView and DialChart are stubbed
 * (WebGL and plotly do not run in jsdom), which leaves the dial's range fetch —
 * the same effect shape the chart view uses six at a time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import type { ComparisonState, MapExtent } from '../types';

vi.mock('../components/MapView', () => ({ default: () => <div data-testid="map-view" /> }));
vi.mock('../components/ChartView', () => ({ default: () => <div /> }));
vi.mock('../components/DialChart', () => ({ default: () => <div /> }));
vi.mock('../components/AggregateTable', () => ({ default: () => <div /> }));

interface Call {
  url: string;
  signal?: AbortSignal;
  settle: () => void;
}

let calls: Call[] = [];

const aggregateCalls = () => calls.filter((c) => c.url.startsWith('/api/aggregate?'));

beforeEach(() => {
  // The aggregate cache is module state; every test here asks the same
  // question, so each needs a fresh one.
  vi.resetModules();
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const body = JSON.stringify({ water_yield: 42 });
      const call: Call = {
        url,
        signal: init?.signal ?? undefined,
        settle: () => resolve(new Response(body, { headers: { 'content-type': 'application/json' } })),
      };
      calls.push(call);
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
      if (!url.startsWith('/api/aggregate?')) call.settle();
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

const extentAt = (minx: number): MapExtent => ({
  center: [minx + 0.5, 0],
  zoom: 6,
  bounds: [minx, 0, minx + 1, 1],
});

async function renderPanes(count: number, props: Record<string, unknown>) {
  const ViewPane = (await import('../components/ViewPane')).default;

  const tree = (overrides: Record<string, unknown>) => (
    <ChakraProvider theme={theme}>
      {Array.from({ length: count }, (_, i) => (
        <ViewPane
          key={i}
          comparison={comparison}
          paneIndex={i}
          layoutMode="quad"
          viewMode="dial"
          onViewModeChange={() => {}}
          onFocusPane={() => {}}
          onGoQuad={() => {}}
          colorScaleMode="rainbow"
          colorScaleType="linear"
          {...props}
          {...overrides}
        />
      ))}
    </ChakraProvider>
  );

  const utils = await act(async () => render(tree({})));
  return { ...utils, tree };
}

describe('aggregate requests across panes', () => {
  it('asks once for a question every pane is asking', async () => {
    await renderPanes(6, { rangeMode: 'extent', mapExtent: extentAt(0) });

    const urls = aggregateCalls().map((c) => c.url);
    // Two scenarios over one extent: two questions, however many panes want
    // the answer. Six panes previously meant twelve requests.
    expect(new Set(urls).size).toBe(2);
    expect(urls).toHaveLength(2);
  });

  it('does not re-ask when the extent changes but the range mode ignores it', async () => {
    // Full-domain mode. The extent is not part of the question, so panning
    // cannot change the answer — and these are the seconds-long requests.
    const { rerender, tree } = await renderPanes(6, { rangeMode: 'domain', mapExtent: extentAt(0) });
    const before = aggregateCalls().length;
    expect(before).toBeGreaterThan(0);

    await act(async () => { rerender(tree({ mapExtent: extentAt(10) })); });
    await act(async () => { rerender(tree({ mapExtent: extentAt(20) })); });

    expect(aggregateCalls()).toHaveLength(before);
  });

  it('does not re-ask when the extent object is new but the extent is not', async () => {
    // mapExtent is rebuilt on every report, so identity churn alone used to
    // re-run the effect.
    const { rerender, tree } = await renderPanes(1, { rangeMode: 'extent', mapExtent: extentAt(0) });
    const before = aggregateCalls().length;

    await act(async () => { rerender(tree({ mapExtent: extentAt(0) })); });

    expect(aggregateCalls()).toHaveLength(before);
  });

  it('cancels the aggregates a pan has superseded', async () => {
    const { rerender, tree } = await renderPanes(1, { rangeMode: 'extent', mapExtent: extentAt(0) });
    const first = aggregateCalls();
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((c) => c.signal !== undefined)).toBe(true);

    await act(async () => { rerender(tree({ mapExtent: extentAt(10) })); });

    const second = aggregateCalls().filter((c) => !first.includes(c));
    expect(second.length).toBeGreaterThan(0);
    // The grace period is there so a re-subscribe in the next tick keeps the
    // request; nothing re-subscribes to the old extent.
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });

    expect(first.every((c) => c.signal!.aborted)).toBe(true);
    expect(second.every((c) => c.signal!.aborted)).toBe(false);
  });

  it('keeps a site-scoped range mode off the aggregate endpoint entirely', async () => {
    await renderPanes(6, { rangeMode: 'site', mapExtent: extentAt(0) });
    expect(aggregateCalls()).toHaveLength(0);
  });
});
