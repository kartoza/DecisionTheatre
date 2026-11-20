// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

import type { ViewMode } from '../types';

/**
 * Whether switching to a view mode should auto-collapse the control panel.
 *
 * Below 763px the panel covers most of the pane it's explaining, so landing
 * on a visual view there (map/chart/dial/flat) collapses it automatically
 * rather than leaving it open over whatever the user just asked to look at.
 * Table is excluded: it is already its own full-width layout, so the panel
 * sitting beside it is not in the way the way it is over a map or a chart.
 */
const AUTO_COLLAPSE_VIEW_MODES: ReadonlySet<ViewMode> = new Set(['map', 'chart', 'dial', 'flat']);

export function shouldAutoCollapsePanel(mode: ViewMode, isNarrowScreen: boolean): boolean {
  return isNarrowScreen && AUTO_COLLAPSE_VIEW_MODES.has(mode);
}
