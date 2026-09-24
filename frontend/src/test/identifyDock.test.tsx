/**
 * The identify panel's own docking shell. Reported: opening the identify
 * tool while the indicator panel was already open had nowhere to go.
 * Covers: it docks flush right alone, and immediately left of slot B
 * (offset by the shared panel width) when slot B is also open -- so the
 * two sections read as one panel that got wider, not two unrelated
 * floating panels.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import IdentifyDock from '../components/IdentifyDock';
import type { IdentifyResult, SiteIdentifyResult } from '../types';

afterEach(() => {
  cleanup();
});

const catchmentResult: IdentifyResult = {
  catchmentID: '1234',
  leftLabel: 'Ecological Reference',
  rightLabel: 'Current State',
  rows: [{ label: 'Above-ground woody biomass', left: '12.30', right: '15.10', trend: 'up', delta: 2.8, trendWidthPx: 10 }],
};

const siteResult: SiteIdentifyResult = {
  leftLabel: 'Reference',
  rightLabel: 'Current',
  rows: [{ label: 'Grass NPP', left: '8.20', right: '9.10', trend: 'up', delta: 0.9, trendWidthPx: 6 }],
};

function renderDock(props: Partial<React.ComponentProps<typeof IdentifyDock>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <ChakraProvider theme={theme}>
      <IdentifyDock
        identifyResult={null}
        siteIdentifyResult={null}
        onClose={onClose}
        isSlotBOpen={false}
        {...props}
      />
    </ChakraProvider>,
  );
  return { onClose, ...utils };
}

describe('IdentifyDock', () => {
  it('shows no identify content when there is no result of either kind', () => {
    // The panel shell always mounts (Slide animates visibility rather than
    // mounting/unmounting, same as the other three docked panels) -- what
    // matters is that it has nothing to show.
    renderDock();
    expect(screen.queryByText(/^Catchment /)).not.toBeInTheDocument();
    expect(screen.queryByText('Site Indicators')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the catchment result when set', () => {
    renderDock({ identifyResult: catchmentResult });
    expect(screen.getByText('Catchment 1234')).toBeInTheDocument();
  });

  it('renders the site-boundary result when set', () => {
    renderDock({ siteIdentifyResult: siteResult });
    expect(screen.getByText('Site Indicators')).toBeInTheDocument();
  });

  it('stays flush against the right edge while closed, even if slot B is open', () => {
    // Reported: the closed identify panel stayed offset from a previous
    // open, and (since Chakra's Slide assumes a direction="right" panel
    // rests at right:0 while closed) that broke its off-screen transform
    // enough to visually cover chart details with an empty panel.
    const { container } = renderDock({ identifyResult: null, siteIdentifyResult: null, isSlotBOpen: true });
    const region = screen.getByRole('region', { name: 'Identify results' });
    const slide = region.closest('[style*="position: fixed"]') ?? container.querySelector('[style*="position: fixed"]');
    expect(slide).not.toBeNull();
    expect((slide as HTMLElement).style.right).toBe('0px');
  });

  it('docks flush against the right edge when slot B is not open', () => {
    const { container } = renderDock({ identifyResult: catchmentResult, isSlotBOpen: false });
    const region = screen.getByRole('region', { name: 'Identify results' });
    const slide = region.closest('[style*="position: fixed"]') ?? container.querySelector('[style*="position: fixed"]');
    expect(slide).not.toBeNull();
    expect((slide as HTMLElement).style.right).toBe('0px');
  });

  it('docks to the left of slot B (offset by the shared panel width) when slot B is open', () => {
    const { container } = renderDock({ identifyResult: catchmentResult, isSlotBOpen: true });
    const region = screen.getByRole('region', { name: 'Identify results' });
    const slide = region.closest('[style*="position: fixed"]') ?? container.querySelector('[style*="position: fixed"]');
    expect(slide).not.toBeNull();
    // Not flush right: offset by whatever the shared panel width currently
    // is (the exact number is usePanelWidth's persisted/default value, not
    // what's under test here -- only that it moved off 0).
    expect((slide as HTMLElement).style.right).not.toBe('0px');
  });

  it('animates the move between right:0 and the slot-B offset, rather than snapping', () => {
    // Reported: closing slot B while identify stayed open should slide
    // identify over to take its place, not jump there instantly.
    const { container } = renderDock({ identifyResult: catchmentResult, isSlotBOpen: true });
    const region = screen.getByRole('region', { name: 'Identify results' });
    const slide = region.closest('[style*="position: fixed"]') ?? container.querySelector('[style*="position: fixed"]');
    expect((slide as HTMLElement).style.transition).toContain('right');
  });

  it('calls onClose when the panel is closed', () => {
    const { onClose } = renderDock({ identifyResult: catchmentResult });
    screen.getByRole('button', { name: 'Collapse identify results' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
