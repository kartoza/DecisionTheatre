// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

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
import { SCENARIO_COLORS } from '../lib/dialScale';

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

describe('the belt legend', () => {
  /**
   * Same failure as the arc gauge, different arithmetic: each entry sat in
   * an equal third of the band's width (barW / 3), which shrank with the
   * container but the label text's font size had a floor (fontLegend never
   * dropped below 10px), so a narrow pane's third column still ran its text
   * past the right edge, where the clipping Box hid it. Now a wrapping HTML
   * flexbox, same as the arc gauge.
   */
  it('hosts the legend in a wrapping flexbox rather than three equal-width SVG columns', () => {
    renderBelt(1200);
    const referenceLabel = screen.getByText(/Reference: 365\.4/);
    const foreignObject = referenceLabel.closest('foreignObject');
    expect(foreignObject).not.toBeNull();

    const flexRow = foreignObject!.querySelector('div');
    expect(flexRow).not.toBeNull();
    expect(flexRow).toHaveStyle({ display: 'flex', flexWrap: 'wrap' });

    expect(flexRow!.textContent).toContain('Reference: 365.4');
    expect(flexRow!.textContent).toContain('Current: 836.3');
    expect(flexRow!.textContent).toContain('Target: 1.2K');
  });
});

describe('the arc', () => {
  it('does not let a growing target drag its scale either', () => {
    expect(renderArc(2500)).toBe(renderArc(1200));
  });
});

describe('the arc legend', () => {
  /**
   * Reported: on a narrow single pane the Reference/Current/Target legend
   * was not visible at all. Root cause was three SVG <text> columns pinned
   * at fixed offsets from the dial's horizontal centre (centerX - 330, etc.)
   * — offsets sized for a wide dial, which ran negative (or past the right
   * edge) once the container was narrow, and the parent Box clips anything
   * outside its bounds. The legend is now a real HTML flexbox in a
   * <foreignObject>, which wraps onto more rows instead of running off
   * either edge, at any width jsdom can't itself lay out.
   */
  it('hosts the legend in a wrapping flexbox rather than fixed-offset SVG columns', () => {
    renderArc(1200);
    const referenceLabel = screen.getByText(/Reference: 365\.4/);
    const foreignObject = referenceLabel.closest('foreignObject');
    expect(foreignObject).not.toBeNull();

    const flexRow = foreignObject!.querySelector('div');
    expect(flexRow).not.toBeNull();
    expect(flexRow).toHaveStyle({ display: 'flex', flexWrap: 'wrap' });

    // All three legend entries live inside that one wrapping row.
    expect(flexRow!.textContent).toContain('Reference: 365.4');
    expect(flexRow!.textContent).toContain('Current: 836.3');
    expect(flexRow!.textContent).toContain('Target: 1.2K');

    // No remaining fixed-offset <g transform="translate(...)"> column for
    // the legend -- the width-dependent positioning that clipped it.
    expect(referenceLabel.closest('g[transform]')).toBeNull();
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
    // The buckle: a target-coloured stroked rect on the band. Width
    // distinguishes it from the legend's swatch, which is the same colour
    // but a fixed 12px.
    return Array.from(document.querySelectorAll('rect'))
      .filter((r) => (r.getAttribute('stroke') || '').toLowerCase() === SCENARIO_COLORS.future
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

describe('marker sizing on a small container', () => {
  /**
   * Reported: the reference line, current line and target buckle overflowed
   * onto the tick value labels drawn beneath the band, on smaller screens.
   * Root cause: `compact` only ever reflects whether this is one of several
   * panes in a grid -- a single pane is always `compact={false}`, so these
   * markers stayed full-size no matter how small the container FlatDial
   * itself measured, and the fixed pixel math for the buckle's height left
   * no margin above the tick labels below it once the container shrank past
   * what that sizing was tuned for. FlatDial's default pre-measurement size
   * (800x300) is itself short enough to trigger the same responsive
   * compactness, with no `compact` prop passed at all -- this pins that it
   * actually does, by checking the buckle shrinks to the same width the
   * `compact` prop would have produced explicitly.
   */
  it('renders the buckle at its compact width even with no compact prop, because the measured container is short', () => {
    render(
      <ChakraProvider theme={theme}>
        <FlatDial visible min={0} max={1} referenceValue={0.3} currentValue={0.5} targetValue={0.7} />
      </ChakraProvider>,
    );
    const buckleRect = Array.from(document.querySelectorAll('rect'))
      .find((r) => (r.getAttribute('stroke') || '').toLowerCase() === SCENARIO_COLORS.future
        && Number(r.getAttribute('width')) > 20);
    expect(buckleRect).toBeDefined();
    // barH compact (22) * 1.7 = 37.4 -- the compact buckle width. The
    // non-compact figure (barH 34 * 1.8 = 61.2) would mean this container's
    // short default height was not picked up at all.
    expect(Number(buckleRect!.getAttribute('width'))).toBeCloseTo(37.4, 1);
  });
});

describe('the arc needle order', () => {
  it('draws the target needle after the current needle, so it is never hidden underneath it', () => {
    cleanup();
    render(
      <ChakraProvider theme={theme}>
        <DialChart
          visible
          attribute="Grass cover fraction"
          min={0}
          max={1}
          referenceValue={0.52}
          currentValue={0.31}
          targetValue={0.47}
        />
      </ChakraProvider>,
    );
    const paths = Array.from(document.querySelectorAll('svg path'));
    const currentIndex = paths.findIndex((p) => p.getAttribute('fill') === SCENARIO_COLORS.current);
    const targetIndex = paths.findIndex((p) => p.getAttribute('stroke-dasharray') === '8,6');
    expect(currentIndex).toBeGreaterThanOrEqual(0);
    expect(targetIndex).toBeGreaterThan(currentIndex);
  });
});
