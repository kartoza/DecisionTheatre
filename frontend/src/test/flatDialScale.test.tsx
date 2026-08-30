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
