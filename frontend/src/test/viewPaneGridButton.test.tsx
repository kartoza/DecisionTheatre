// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The single-pane toolbar's "Switch to grid view" button, at 500px and
 * below. There is no room left in the per-pane toolbar for it beside the
 * view-mode icons at that width, so it hides rather than crowding them —
 * the grid can still be reached from the header's own view controls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import type { ComparisonState } from '../types';

vi.mock('../components/MapView', () => ({ default: () => <div data-testid="map-view" /> }));
vi.mock('../components/ChartView', () => ({ default: () => <div /> }));
vi.mock('../components/DialChart', () => ({ default: () => <div /> }));
vi.mock('../components/FlatDial', () => ({ default: () => <div /> }));
vi.mock('../components/AggregateTable', () => ({ default: () => <div /> }));

const comparison: ComparisonState = {
  leftScenario: 'current',
  rightScenario: 'future',
  attribute: 'grass_cover',
};

function setWindowWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => { window.dispatchEvent(new Event('resize')); });
}

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
  setWindowWidth(1024);
});

async function renderSinglePane() {
  const ViewPane = (await import('../components/ViewPane')).default;
  return render(
    <ChakraProvider theme={theme}>
      <ViewPane
        comparison={comparison}
        paneIndex={0}
        layoutMode="single"
        viewMode="map"
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

describe('the grid-view button', () => {
  it('shows above 500px', async () => {
    setWindowWidth(501);
    await renderSinglePane();
    expect(screen.getByLabelText('Switch to grid view')).toBeInTheDocument();
  });

  it('hides at 500px and below', async () => {
    setWindowWidth(500);
    await renderSinglePane();
    expect(screen.queryByLabelText('Switch to grid view')).toBeNull();
  });
});
