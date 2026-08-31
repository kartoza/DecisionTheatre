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
        onRangeModeChange={() => {}}
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
        <FlatDial visible min={0} max={100} currentValue={50} onRangeModeChange={() => {}} />
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
