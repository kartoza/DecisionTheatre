/**
 * The identify results table, moved from a map-anchored popup into the
 * docked side panel (issue #203). Covers: content renders correctly for
 * both the catchment and site-boundary shapes, the collapse button closes
 * it, and the empty state shows when there are no comparable rows.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import IdentifyPanel from '../components/IdentifyPanel';
import type { IdentifyRow } from '../types';

afterEach(() => {
  cleanup();
});

const rows: IdentifyRow[] = [
  { label: 'Above-ground woody biomass', left: '12.30', right: '15.10', trend: 'up', delta: 2.8, trendWidthPx: 10 },
  { label: 'Percent burned', left: '40.00', right: '40.00', trend: 'neutral', delta: 0, trendWidthPx: 0 },
  { label: 'Grass NPP', left: '-', right: '8.20', trend: 'neutral', delta: null, trendWidthPx: 0 },
];

function renderPanel(overrides: Partial<React.ComponentProps<typeof IdentifyPanel>> = {}) {
  const onClose = vi.fn();
  render(
    <ChakraProvider theme={theme}>
      <IdentifyPanel
        title="Catchment 1234"
        leftLabel="Ecological Reference"
        rightLabel="Current State"
        rows={rows}
        emptyMessage="No comparable values available."
        onClose={onClose}
        {...overrides}
      />
    </ChakraProvider>,
  );
  return onClose;
}

describe('IdentifyPanel', () => {
  it('shows the title and both column labels', () => {
    renderPanel();
    expect(screen.getByText('Catchment 1234')).toBeInTheDocument();
    expect(screen.getByText('Ecological Reference')).toBeInTheDocument();
    expect(screen.getByText('Current State')).toBeInTheDocument();
  });

  it('renders one row per attribute, with both values', () => {
    renderPanel();
    expect(screen.getByText('Above-ground woody biomass')).toBeInTheDocument();
    expect(screen.getByText('12.30')).toBeInTheDocument();
    expect(screen.getByText('15.10')).toBeInTheDocument();
    expect(screen.getByText('Percent burned')).toBeInTheDocument();
    expect(screen.getByText('Grass NPP')).toBeInTheDocument();
  });

  it('shows the empty message instead of a table when there are no rows', () => {
    renderPanel({ rows: [] });
    expect(screen.getByText('No comparable values available.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('calls onClose when the collapse button is clicked', () => {
    const onClose = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse identify results' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('works identically for the site-boundary shape (Reference vs Current, whole site)', () => {
    renderPanel({ title: 'Site Indicators', leftLabel: 'Reference', rightLabel: 'Current' });
    expect(screen.getByText('Site Indicators')).toBeInTheDocument();
    expect(screen.getByText('Reference')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
  });
});
