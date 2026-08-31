/**
 * What the belt draws its axis against.
 *
 * Reported from use: dragging the Black Rhino slider moved the blue current
 * line, with Lock scale ticked. Current had not changed — it read 836.3 before
 * and after. The axis had: its maximum tracked the target, 1.2K to 2.5K, and
 * the same value slid left on a wider band.
 *
 * The lock held the range in ViewPane, and then the dial widened it again
 * locally to fit whatever it was asked to plot. Since the target is one of
 * those values, the axis followed the target and the lock did nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import FlatDial from '../components/FlatDial';
import DialChart from '../components/DialChart';

function axisOf(): { min: string; max: string } {
  const ticks = Array.from(document.querySelectorAll('text'))
    .filter((t) => t.getAttribute('fill') === '#718096');
  return {
    min: ticks[0]?.textContent ?? '',
    max: ticks[ticks.length - 1]?.textContent ?? '',
  };
}

function renderBelt(targetValue: number, isScaleLocked: boolean) {
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
        isScaleLocked={isScaleLocked}
      />
    </ChakraProvider>,
  );
  return axisOf();
}

afterEach(cleanup);

describe('a locked belt', () => {
  it('does not let a growing target drag the axis with it', () => {
    const before = renderBelt(1200, true);
    const after = renderBelt(2500, true);
    expect(after).toEqual(before);
  });

  it('keeps the current marker where it was, since its value did not change', () => {
    // The reported symptom, stated directly: same value, same place.
    const before = renderBelt(1200, true);
    const beforeX = document.querySelectorAll('line').length;
    const after = renderBelt(2500, true);
    expect(after.min).toBe(before.min);
    expect(after.max).toBe(before.max);
    expect(document.querySelectorAll('line').length).toBe(beforeX);
  });

  it('still shows the factor and its readings', () => {
    renderBelt(2500, true);
    expect(screen.getByText(/Total Methane production/)).toBeInTheDocument();
    expect(screen.getByText(/Current: 836.3/)).toBeInTheDocument();
  });
});

describe('an unlocked belt', () => {
  it('grows to fit a target beyond its range, which is why the lock exists', () => {
    const before = renderBelt(1200, false);
    const after = renderBelt(2500, false);
    expect(after.max).not.toBe(before.max);
  });
});

/**
 * The lock applies to the arc too.
 *
 * The hold is taken in ViewPane, so it always reached both shapes — but the arc
 * widened the handed-down range again locally, exactly as the belt did, and had
 * no checkbox to switch the lock on from.
 */
function renderArc(targetValue: number, isScaleLocked: boolean) {
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
        isScaleLocked={isScaleLocked}
        onRangeModeChange={() => {}}
      />
    </ChakraProvider>,
  );
  // The scale only: the legend carries the target's value, which is supposed to
  // change. What must not change is the ruler it is read against.
  return Array.from(document.querySelectorAll('text'))
    .map((t) => t.textContent ?? '')
    .filter((t) => t !== '' && !t.includes(':') && !/[A-Za-z]{2}/.test(t))
    .join('|');
}

describe('a locked arc', () => {
  it('does not let a growing target drag its scale with it', () => {
    const before = renderArc(1200, true);
    const after = renderArc(2500, true);
    expect(after).toBe(before);
  });

  it('grows when unlocked, which is why the lock exists', () => {
    const before = renderArc(1200, false);
    const after = renderArc(2500, false);
    expect(after).not.toBe(before);
  });

  it('offers the lock control, not only the flat band', () => {
    renderArc(1200, false);
    expect(screen.getByRole('checkbox', { name: /lock scale/i })).toBeInTheDocument();
  });
});

describe('the widget control cluster', () => {
  it('carries no shape toggle — the shape is a view mode in the header', () => {
    // Six panes each carrying a Dial/Flat button was six copies of one global
    // choice. It is picked once now, from the same cluster as the other views.
    cleanup();
    render(
      <ChakraProvider theme={theme}>
        <FlatDial visible min={0} max={100} currentValue={50} onRangeModeChange={() => {}} />
      </ChakraProvider>,
    );
    expect(screen.queryByRole('button', { name: /show as a dial/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /flat band/i })).toBeNull();
  });

  it('carries no help button — the pane\'s own info icon opens the panel', () => {
    cleanup();
    render(
      <ChakraProvider theme={theme}>
        <FlatDial visible min={0} max={100} currentValue={50} onRangeModeChange={() => {}} />
      </ChakraProvider>,
    );
    expect(screen.queryByRole('button', { name: /explain this chart/i })).toBeNull();
  });

  it('keeps the lock, which is per-chart rather than global', () => {
    cleanup();
    render(
      <ChakraProvider theme={theme}>
        <FlatDial visible min={0} max={100} currentValue={50} onRangeModeChange={() => {}} />
      </ChakraProvider>,
    );
    expect(screen.getByRole('checkbox', { name: /lock scale/i })).toBeInTheDocument();
  });
});
