/**
 * What a chart draws its axis against.
 *
 * Reported from use: dragging the Black Rhino slider moved the blue current
 * line. Current had not changed — it read 836.3 before and after. The axis had:
 * its maximum tracked the target, 1.2K to 2.5K, and the same value slid left on
 * a wider band.
 *
 * The scale is now pinned before any target exists — by the metadata bound
 * where one is declared, otherwise by the range mode's own minima and maxima —
 * and nothing downstream may widen it to fit the target. There is no lock any
 * more because there is nothing left for a lock to hold.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import FlatDial from '../components/FlatDial';
import DialChart from '../components/DialChart';

/** The tick labels only: the legend carries the target, which is meant to change. */
function axis(): string {
  return Array.from(document.querySelectorAll('text'))
    .map((t) => t.textContent ?? '')
    .filter((t) => t !== '' && !t.includes(':') && !/[A-Za-z]{2}/.test(t))
    .join('|');
}

function renderBelt(targetValue: number) {
  cleanup();
  render(
    <ChakraProvider theme={theme}>
      <FlatDial
        visible
        attribute="Total Methane production"
        min={328.9}
        max={1200}
        referenceValue={365.4}
        currentValue={836.3}
        targetValue={targetValue}
      />
    </ChakraProvider>,
  );
  return axis();
}

function renderArc(targetValue: number) {
  cleanup();
  render(
    <ChakraProvider theme={theme}>
      <DialChart
        visible
        attribute="Total Methane production"
        min={328.9}
        max={1200}
        referenceValue={365.4}
        currentValue={836.3}
        targetValue={targetValue}
      />
    </ChakraProvider>,
  );
  return axis();
}

afterEach(cleanup);

describe('the belt', () => {
  it('does not let a growing target drag the axis with it', () => {
    // The reported numbers exactly: target 1.2K then 2.5K, current unchanged.
    expect(renderBelt(2500)).toBe(renderBelt(1200));
  });

  it('still reads the current value it was given', () => {
    renderBelt(2500);
    expect(screen.getByText(/Current: 836.3/)).toBeInTheDocument();
  });

  it('keeps the factor title, which a grid of six needs to be distinguishable', () => {
    renderBelt(1200);
    expect(screen.getByText(/Total Methane production/)).toBeInTheDocument();
  });
});

describe('the arc', () => {
  it('does not let a growing target drag its scale either', () => {
    expect(renderArc(2500)).toBe(renderArc(1200));
  });
});

describe('the widget control cluster', () => {
  const renderPlain = () => {
    cleanup();
    render(
      <ChakraProvider theme={theme}>
        <FlatDial visible min={0} max={100} currentValue={50} />
      </ChakraProvider>,
    );
  };

  it('carries no shape toggle — the shape is a view mode in the header', () => {
    renderPlain();
    expect(screen.queryByRole('button', { name: /show as a dial/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /flat band/i })).toBeNull();
  });

  it("carries no help button — the pane's own info icon opens the panel", () => {
    renderPlain();
    expect(screen.queryByRole('button', { name: /explain this chart/i })).toBeNull();
  });

  it('carries no scale lock — the scale can no longer move', () => {
    renderPlain();
    expect(screen.queryByRole('checkbox', { name: /lock scale/i })).toBeNull();
  });
});

describe('the target marker', () => {
  const renderWith = (targetValue: number | undefined) => {
    cleanup();
    render(
      <ChakraProvider theme={theme}>
        <FlatDial
          visible
          attribute="Grass cover fraction"
          min={0}
          max={1}
          referenceValue={0.52}
          currentValue={0.31}
          targetValue={targetValue}
        />
      </ChakraProvider>,
    );
    // The buckle: a green-stroked rect on the band. Width distinguishes it from
    // the legend's swatch, which is the same colour but a fixed 12px.
    return Array.from(document.querySelectorAll('rect'))
      .filter((r) => (r.getAttribute('stroke') || '').toLowerCase() === '#4caf50'
        && Number(r.getAttribute('width')) > 20).length;
  };

  it('draws the target where it sits on the current value', () => {
    // Reported: after "reset to current" the buckle vanished instead of landing
    // on the blue line. A target set to current is a target, not the absence of
    // one — Target State starts equal to Current State and diverges only where
    // you make it.
    expect(renderWith(0.31)).toBeGreaterThan(0);
  });

  it('draws the target where it differs from current', () => {
    expect(renderWith(0.47)).toBeGreaterThan(0);
  });

  it('draws no target when the site has no ideal for the factor', () => {
    expect(renderWith(undefined)).toBe(0);
  });
});
