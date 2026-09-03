/**
 * The width of the right-hand slot.
 *
 * Three panels dock into one slot and only one is ever open, so the width
 * belongs to the slot rather than to whichever panel is in it. Drag the edge
 * while reading the calculations and the target editor is that width too —
 * otherwise the frame jumps on every switch.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  loadPanelWidth,
  savePanelWidth,
} from '../lib/panelWidth';

beforeEach(() => {
  window.localStorage.clear();
});

describe('the slot width', () => {
  it('starts at the width the panels used to be pinned at', () => {
    expect(loadPanelWidth()).toBe(DEFAULT_PANEL_WIDTH);
  });

  it('remembers a width across sessions', () => {
    // A width chosen to read something is a choice; asking for it again next
    // session is just forgetting.
    savePanelWidth(700);
    expect(loadPanelWidth()).toBe(700);
  });

  it('will not go narrower than a panel can be read at', () => {
    savePanelWidth(50);
    expect(loadPanelWidth()).toBe(MIN_PANEL_WIDTH);
  });

  it('will not grow past the ceiling', () => {
    savePanelWidth(5000);
    expect(loadPanelWidth()).toBe(MAX_PANEL_WIDTH);
  });

  it('ignores a stored value that is not a width', () => {
    window.localStorage.setItem('dt.panel.width', 'wide please');
    expect(loadPanelWidth()).toBe(DEFAULT_PANEL_WIDTH);
  });

  it('announces a change, so every mounted panel follows the drag', () => {
    const seen: number[] = [];
    const handler = (e: Event) => seen.push((e as CustomEvent<number>).detail);
    window.addEventListener('dt:panel-width-changed', handler);
    savePanelWidth(620);
    savePanelWidth(5000);
    window.removeEventListener('dt:panel-width-changed', handler);
    // Clamped before broadcast: a listener must never be handed a width the
    // store itself would refuse.
    expect(seen).toEqual([620, MAX_PANEL_WIDTH]);
  });
});
