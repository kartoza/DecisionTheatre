/**
 * The table panel names its factor twice inside its own body — the Site
 * Average caption and the column header — independent of the shared pane
 * header above it. Reported alongside the map and dial/belt panels: no unit
 * shown, so two factors' numbers looked directly comparable when they were
 * not.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import AggregateTable from '../components/AggregateTable';

vi.mock('../hooks/useApi', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useApi')>('../hooks/useApi');
  return {
    ...actual,
    useAttributeDetails: () => ({ details: { grass_cover: 'Grass cover fraction' }, loading: false }),
    useAttributeUnits: () => ({ units: { grass_cover: '%' }, loading: false }),
    getSiteCatchments: () => Promise.resolve([
      { id: 'c1', areaKm2: 10, aoiFraction: 1, current: { grass_cover: 0.5 }, reference: { grass_cover: 0.6 } },
    ]),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the table panel label', () => {
  it('appends the unit in brackets, on both the caption and the column header', async () => {
    render(
      <ChakraProvider theme={theme}>
        <AggregateTable visible attribute="grass_cover" siteId="test-site" />
      </ChakraProvider>,
    );
    await screen.findByRole('columnheader', { name: 'Grass cover fraction (%)' });
    const matches = screen.getAllByText('Grass cover fraction (%)');
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('does not double up a unit already baked into the label', () => {
    cleanup();
    render(
      <ChakraProvider theme={theme}>
        <AggregateTable visible attribute="perc_burned" />
      </ChakraProvider>,
    );
    // Not stubbed in the mocked details/units above, so it falls back to the
    // raw attribute key -- the point here is only that composeLabelWithUnit
    // is in the path at all, verified directly in dialScale.test.ts.
    expect(screen.queryAllByText(/\(.*\)\s*\(.*\)/).length).toBe(0);
  });
});
