/**
 * The consolidated grid controls.
 *
 * Five map toggles — 3D, choropleth, identify, satellite, swiper — used to be a
 * vertical stack of circular IconButtons drawn inside every MapView. Every one
 * of them acted on all panes, so a six-pane grid drew thirty buttons for five
 * settings, and clicking any copy moved all of them. They are drawn once now,
 * in the header.
 *
 * These tests pin the properties that made the old arrangement wrong: one
 * control per setting, a state a screen reader can report, and — for the
 * narrow layout — a route to every control rather than `display: none`.
 */
import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import GridControls from '../components/GridControls';
import Header from '../components/Header';
import { resetSatelliteConfig, applyServerSatelliteConfig } from '../lib/satelliteBasemap';

type Props = ComponentProps<typeof GridControls>;

function renderControls(overrides: Partial<Props> = {}) {
  const handlers = {
    onViewModeChange: vi.fn(),
    onIs3DModeChange: vi.fn(),
    onChoroplethEnabledChange: vi.fn(),
    onIdentifyModeChange: vi.fn(),
    onGoogleBasemapChange: vi.fn(),
    onSwiperEnabledChange: vi.fn(),
  };
  const props: Props = {
    viewMode: 'map',
    siteId: 'site-1',
    is3DMode: false,
    isChoroplethEnabled: true,
    isIdentifyMode: false,
    isGoogleBasemap: false,
    isSwiperEnabled: true,
    ...handlers,
    ...overrides,
  };
  render(
    <ChakraProvider theme={theme}>
      <GridControls {...props} />
    </ChakraProvider>,
  );
  // Both responsive layouts are in the DOM: jsdom applies no media queries, so
  // Chakra's display:{base,xl} cannot hide either one. Queries are scoped to a
  // layout so a duplicate within one is still a failure.
  return {
    ...handlers,
    wide: within(screen.getByTestId('grid-controls-wide')),
    narrow: within(screen.getByTestId('grid-controls-narrow')),
  };
}

afterEach(() => {
  cleanup();
  resetSatelliteConfig();
});

describe('GridControls map toggles', () => {
  it('draws one control per setting, not one per pane', () => {
    const { wide } = renderControls();
    for (const label of [
      'Show 3D extrusion', 'Hide choropleth', 'Identify catchment',
      'Switch to satellite', 'Disable map swiper', 'Zoom to site',
    ]) {
      expect(wide.getAllByLabelText(label)).toHaveLength(1);
    }
  });

  it('reports its state through aria-pressed rather than colour alone', () => {
    const { wide } = renderControls({ is3DMode: true, isIdentifyMode: false });
    expect(wide.getByLabelText('Show flat map')).toHaveAttribute('aria-pressed', 'true');
    expect(wide.getByLabelText('Identify catchment')).toHaveAttribute('aria-pressed', 'false');
  });

  it('asks for the opposite of the current value', () => {
    const handlers = renderControls({ isChoroplethEnabled: true });
    fireEvent.click(handlers.wide.getByLabelText('Hide choropleth'));
    expect(handlers.onChoroplethEnabledChange).toHaveBeenCalledWith(false);
  });

  it('hides the map toggles when the panes are not showing maps', () => {
    renderControls({ viewMode: 'table' });
    expect(screen.queryByLabelText('Identify catchment')).toBeNull();
    expect(screen.queryByLabelText('Zoom to site')).toBeNull();
  });

  it('broadcasts zoom-to-site, because the header cannot reach a pane map', () => {
    const heard = vi.fn();
    window.addEventListener('dt:zoom-to-site', heard);
    const { wide } = renderControls();
    fireEvent.click(wide.getByLabelText('Zoom to site'));
    window.removeEventListener('dt:zoom-to-site', heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('disables zoom-to-site with no site to zoom to', () => {
    const { wide } = renderControls({ siteId: null });
    expect(wide.getByLabelText('Zoom to site')).toBeDisabled();
  });

  it('disables satellite when the server reports no provider', () => {
    applyServerSatelliteConfig({ satellite_available: false } as never);
    const { wide } = renderControls({ isGoogleBasemap: false });
    expect(wide.getByLabelText('Switch to satellite')).toBeDisabled();
  });

  it('omits a toggle whose handler was not supplied', () => {
    const { wide } = renderControls({ onIdentifyModeChange: undefined });
    expect(screen.queryByLabelText('Identify catchment')).toBeNull();
    expect(wide.getByLabelText('Show 3D extrusion')).toBeInTheDocument();
  });

  it('routes every control into the overflow menu on a narrow screen', async () => {
    const { narrow } = renderControls();
    fireEvent.click(narrow.getByLabelText('More controls'));
    const menu = await screen.findByRole('menu');
    for (const label of [
      'Show 3D extrusion', 'Hide choropleth', 'Identify catchment',
      'Switch to satellite', 'Disable map swiper', 'Zoom to site',
    ]) {
      expect(within(menu).getByText(label)).toBeInTheDocument();
    }
  });
});

describe('Header placement', () => {
  /**
   * The cluster was gated on `currentPage === 'map'` and vanished in explore
   * mode — which renders the same six-pane grid, just without a site selected.
   * The pane grid is the thing these controls act on, and only that render
   * passes gridControls, so the props are the gate.
   */
  const gridControls = {
    viewMode: 'map' as const,
    onViewModeChange: () => {},
    siteId: null,
    is3DMode: false,
    onIs3DModeChange: () => {},
  };

  it.each(['map', 'explore'] as const)('shows the controls on the %s page', (page) => {
    render(
      <ChakraProvider theme={theme}>
        <Header onToggleDocs={() => {}} isDocsOpen={false} currentPage={page} gridControls={gridControls} />
      </ChakraProvider>,
    );
    expect(screen.getAllByRole('radiogroup', { name: 'View for all panes' }).length)
      .toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Show 3D extrusion').length).toBeGreaterThan(0);
  });

  it('shows nothing when no grid is on screen to control', () => {
    render(
      <ChakraProvider theme={theme}>
        <Header onToggleDocs={() => {}} isDocsOpen={false} currentPage="landing" />
      </ChakraProvider>,
    );
    expect(screen.queryByRole('radiogroup', { name: 'View for all panes' })).toBeNull();
  });
});
