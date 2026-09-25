/**
 * The grid's pane-count cap (#204).
 *
 * Reported: opening more than a 2-row grid's worth of panes rendered them
 * off-screen, forcing a scroll the user had no way to discover. Root cause
 * was two-fold: the grid always sized its rows as if there were only 2
 * regardless of how many the pane count actually needed (see the
 * gridAutoRows fix), and nothing capped how many panes it would try to
 * render into however many rows that left.
 *
 * The grid is always 3 columns wide; row count is not a setting, it's
 * derived from the pane count. Map, dial and table views stay fixed at 2
 * rows (6 panes). Belt charts are small enough to keep growing -- a new row
 * every 3 panes as more are added via Add Pane -- up to 5 rows (15 panes).
 * These tests pin: the grid renders at most that many panes for whatever
 * it's showing, the row count grows/shrinks with the actual pane count,
 * and it never drops the extra pane configs from state -- only their
 * rendering -- so they come back once the cap grows again (e.g. switching
 * to belt charts).
 */
import type { ComponentProps } from 'react';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import ContentArea from '../components/ContentArea';
import { DEFAULT_PANE_STATES } from '../types';
import type { PaneStates, ViewMode } from '../types';

vi.mock('../components/ViewPane', () => ({
  default: ({ paneIndex }: { paneIndex: number }) => <div data-testid={`view-pane-${paneIndex}`} />,
}));

type Props = ComponentProps<typeof ContentArea>;

function panes(count: number): PaneStates {
  return Array.from({ length: count }, (_, i) => ({
    ...DEFAULT_PANE_STATES[i % DEFAULT_PANE_STATES.length],
  }));
}

function renderGrid(paneCount: number, viewMode: ViewMode, overrides: Partial<Props> = {}) {
  const paneStates = panes(paneCount);
  const props: Props = {
    mode: 'quad',
    paneStates,
    viewModes: paneStates.map(() => viewMode),
    onViewModeChange: vi.fn(),
    focusedPane: 0,
    onFocusPane: vi.fn(),
    onGoQuad: vi.fn(),
    onRemovePane: vi.fn(),
    colorScaleMode: 'metadata',
    colorScaleType: 'linear',
    ...overrides,
  };
  return render(
    <ChakraProvider theme={theme}>
      <ContentArea {...props} />
    </ChakraProvider>,
  );
}

function visiblePaneIndices() {
  return screen.queryAllByTestId(/^view-pane-/).map((el) => Number(el.dataset.testid!.replace('view-pane-', '')));
}

afterEach(() => {
  cleanup();
});

describe('quad grid pane cap', () => {
  it('caps map/dial/table views at 6 panes, even with more in memory', () => {
    renderGrid(9, 'map');
    for (let i = 0; i < 6; i++) expect(screen.getByTestId(`view-pane-${i}`)).toBeInTheDocument();
    for (let i = 6; i < 9; i++) expect(screen.queryByTestId(`view-pane-${i}`)).toBeNull();
  });

  it('renders all 9 belt-chart panes at once', () => {
    renderGrid(9, 'flat');
    for (let i = 0; i < 9; i++) expect(screen.getByTestId(`view-pane-${i}`)).toBeInTheDocument();
  });

  it('renders belt charts up to the 15-pane cap', () => {
    renderGrid(15, 'flat');
    expect(visiblePaneIndices()).toHaveLength(15);
  });

  it('caps belt charts at 15 panes too, even with more in memory', () => {
    renderGrid(18, 'flat');
    expect(visiblePaneIndices()).toHaveLength(15);
    expect(screen.queryByTestId('view-pane-15')).toBeNull();
  });

  it('does not truncate pane state going from belt to map -- switching back restores the rest', async () => {
    const paneStates = panes(15);
    const { rerender } = render(
      <ChakraProvider theme={theme}>
        <ContentArea
          mode="quad"
          paneStates={paneStates}
          viewModes={paneStates.map(() => 'flat' as const)}
          onViewModeChange={vi.fn()}
          focusedPane={0}
          onFocusPane={vi.fn()}
          onGoQuad={vi.fn()}
          onRemovePane={vi.fn()}
          colorScaleMode="metadata"
          colorScaleType="linear"
        />
      </ChakraProvider>,
    );
    expect(screen.getByTestId('view-pane-14')).toBeInTheDocument();

    rerender(
      <ChakraProvider theme={theme}>
        <ContentArea
          mode="quad"
          paneStates={paneStates}
          viewModes={paneStates.map(() => 'map' as const)}
          onViewModeChange={vi.fn()}
          focusedPane={0}
          onFocusPane={vi.fn()}
          onGoQuad={vi.fn()}
          onRemovePane={vi.fn()}
          colorScaleMode="metadata"
          colorScaleType="linear"
        />
      </ChakraProvider>,
    );
    // The exiting panes leave via an AnimatePresence exit transition, so
    // their removal is not synchronous with the rerender.
    await waitFor(() => expect(screen.queryByTestId('view-pane-14')).toBeNull());
    expect(visiblePaneIndices()).toHaveLength(6);

    rerender(
      <ChakraProvider theme={theme}>
        <ContentArea
          mode="quad"
          paneStates={paneStates}
          viewModes={paneStates.map(() => 'flat' as const)}
          onViewModeChange={vi.fn()}
          focusedPane={0}
          onFocusPane={vi.fn()}
          onGoQuad={vi.fn()}
          onRemovePane={vi.fn()}
          colorScaleMode="metadata"
          colorScaleType="linear"
        />
      </ChakraProvider>,
    );
    // The pane's original state (not a fresh default) is what comes back.
    expect(screen.getByTestId('view-pane-14')).toBeInTheDocument();
  });

  it('is always 3 columns wide, and sizes rows for the actual row count, not a fixed guess', () => {
    // Chakra style props compile to emotion classes rather than inline
    // styles, so they aren't queryable from jsdom's rendered DOM -- pinned
    // at the source level instead.
    const source = readFileSync('src/components/ContentArea.tsx', 'utf8');
    expect(source).toContain("gridTemplateColumns={isQuad ? 'repeat(3, minmax(0, 1fr))' : '1fr'}");
    expect(source).toContain('gridAutoRows={isQuad ? `calc((100% - ${(quadRows - 1) * 2}px) / ${quadRows})` : undefined}');
  });
});
