// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reported: with the control panel collapsed and the identify dock open,
 * both the "Expand control panel" chevron (App.tsx, pinned to the screen
 * edge) and the identify dock's own "Collapse identify results" chevron
 * (IdentifyPanel.tsx) land on the identical screen position -- the dock
 * sits flush at `right: 0` whenever slot B is closed (IdentifyDock.tsx),
 * which is exactly where the expand chevron is pinned too. Hovering
 * flickered between the two tooltips depending on which the mouse happened
 * to land on. A full App render can't easily be driven into this exact
 * state (it needs a real identify click against a live map), so this pins
 * the fix at the source level instead: the expand chevron must not render
 * at all while the identify dock is covering that pixel.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const APP = readFileSync('src/App.tsx', 'utf8');

describe('control panel expand chevron vs. identify dock overlap', () => {
  it('only renders the expand-control-panel chevron when the identify dock is also closed', () => {
    expect(APP).toContain('{!isSlotBOpen && !isIdentifyPanelOpen && (');
  });

  it('still renders it whenever only the control panel (not identify) is collapsed', () => {
    // isIdentifyPanelOpen already exists for the identical purpose
    // elsewhere (the margin calc) -- this guards against reintroducing a
    // tighter condition like `!isSlotBOpen && !isIdentifyPanelOpen &&
    // somethingElse` that would stop the chevron showing in the plain
    // collapsed-with-no-identify-result case the "guaranteed way back"
    // feature exists for.
    expect(APP).toContain('const isIdentifyPanelOpen = identifyResult !== null || siteIdentifyResult !== null;');
  });
});
