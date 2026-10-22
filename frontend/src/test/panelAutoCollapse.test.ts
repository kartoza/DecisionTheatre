// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { shouldAutoCollapsePanel } from '../lib/panelAutoCollapse';
import type { ViewMode } from '../types';

describe('shouldAutoCollapsePanel', () => {
  it.each<ViewMode>(['map', 'chart', 'dial', 'flat'])(
    'collapses on a narrow screen when switching to %s',
    (mode) => {
      expect(shouldAutoCollapsePanel(mode, true)).toBe(true);
    },
  );

  it('does not collapse for table — it is already its own full-width layout', () => {
    expect(shouldAutoCollapsePanel('table', true)).toBe(false);
  });

  it.each<ViewMode>(['map', 'chart', 'dial', 'flat', 'table'])(
    'never collapses on a wide screen (%s)',
    (mode) => {
      expect(shouldAutoCollapsePanel(mode, false)).toBe(false);
    },
  );
});
