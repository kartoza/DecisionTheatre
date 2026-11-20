// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { wrapTickLabel } from '../components/ChartView';

// Reported, with a screenshot (word-wrap.png): the grouped boxplot/line
// chart's x-axis category labels ("Variable grazer biomass") were rendered
// rotated at tickangle: -50, which ate a label-length-proportional chunk of
// the chart's own height for the diagonal bounding box, squeezing the plot
// area. Word-wrapping onto multiple horizontal lines only needs
// line-count * line-height instead, and the font should read a little
// bigger once it isn't fighting the rotation for space.

describe('wrapTickLabel', () => {
  it('leaves a short label on one line', () => {
    expect(wrapTickLabel('Fuel load')).toBe('Fuel load');
  });

  it('wraps a long label on word boundaries, never mid-word', () => {
    const wrapped = wrapTickLabel('Variable grazer biomass');
    expect(wrapped).toContain('<br>');
    for (const line of wrapped.split('<br>')) {
      expect('Variable grazer biomass').toContain(line);
    }
  });

  it('never splits a single word even if it exceeds the wrap width', () => {
    expect(wrapTickLabel('Supercalifragilisticexpialidocious')).toBe(
      'Supercalifragilisticexpialidocious',
    );
  });
});

describe('ChartView grouped chart x-axis config', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..');
  const chartView = readFileSync(join(src, 'components', 'ChartView.tsx'), 'utf8');

  it('no longer rotates tick labels', () => {
    expect(chartView).not.toMatch(/^\s*tickangle: -50/m);
  });

  it('feeds wrapped text through tickvals/ticktext on both the boxplot and line xaxis', () => {
    const uses = chartView.match(/ticktext: (wrappedTickText|wrappedTickText,)/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it('bumped the tick font size up from the old rotated-label size of 10', () => {
    expect(chartView).not.toMatch(/tickfont: \{ color: '#718096', size: 10 \}/);
  });
});
