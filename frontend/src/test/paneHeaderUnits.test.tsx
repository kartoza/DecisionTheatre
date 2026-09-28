/**
 * The pane header names the factor a pane is showing, and is shared by every
 * view mode except the map (which draws its own, see paneChrome.test.tsx).
 * Reported: dial and belt legends showed bare numbers with no unit, so two
 * indicators' values looked directly comparable when they were not. The unit
 * belongs on the label that already names the factor once, not repeated on
 * every reading below it — matching the "label (unit)" convention ChartView
 * already uses for its y-axis.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import type { ComparisonState } from '../types';

vi.mock('../components/MapView', () => ({ default: () => <div data-testid="map-view" /> }));
vi.mock('../components/ChartView', () => ({ default: () => <div /> }));
vi.mock('../components/DialChart', () => ({ default: () => <div /> }));
vi.mock('../components/FlatDial', () => ({ default: () => <div /> }));
vi.mock('../components/AggregateTable', () => ({ default: () => <div /> }));

vi.mock('../hooks/useApi', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useApi')>('../hooks/useApi');
  return {
    ...actual,
    useAttributeDetails: () => ({ details: { grass_cover: 'Grass cover fraction' }, loading: false }),
    useAttributeUnits: () => ({ units: { grass_cover: '%' }, loading: false }),
  };
});

const comparison: ComparisonState = {
  leftScenario: 'current',
  rightScenario: 'future',
  attribute: 'grass_cover',
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderPane(viewMode: 'dial' | 'flat' | 'table') {
  const ViewPane = (await import('../components/ViewPane')).default;
  return render(
    <ChakraProvider theme={theme}>
      <ViewPane
        comparison={comparison}
        paneIndex={0}
        layoutMode="quad"
        viewMode={viewMode}
        onViewModeChange={() => {}}
        onFocusPane={() => {}}
        onGoQuad={() => {}}
        onOpenControlPanel={() => {}}
        colorScaleMode="rainbow"
        colorScaleType="linear"
      />
    </ChakraProvider>,
  );
}

describe('the pane header label', () => {
  it('appends the unit in brackets for the dial view', async () => {
    const { findByText } = await renderPane('dial');
    expect(await findByText('Grass cover fraction (%)')).toBeInTheDocument();
  });

  it('appends the unit in brackets for the belt view', async () => {
    const { findByText } = await renderPane('flat');
    expect(await findByText('Grass cover fraction (%)')).toBeInTheDocument();
  });

  it('appends the unit in brackets for the table view', async () => {
    const { findByText } = await renderPane('table');
    expect(await findByText('Grass cover fraction (%)')).toBeInTheDocument();
  });
});
