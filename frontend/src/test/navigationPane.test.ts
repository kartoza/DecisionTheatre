/**
 * One zoom cluster for a grid of maps, not one per pane.
 *
 * Every map in the grid is registered with useMapSync, so moving any one moves
 * all the others: six zoom clusters were six ways to do the same thing.
 */
import { describe, it, expect } from 'vitest';
import { navigationPaneIndex } from '../lib/navigationPane';

const allMaps = () => true;

describe('navigationPaneIndex', () => {
  it('picks the bottom-left pane of a full grid', () => {
    // 6 panes, 3 across: bottom row is 3,4,5 — bottom-left is 3.
    expect(navigationPaneIndex([0, 1, 2, 3, 4, 5], 3, allMaps)).toBe(3);
    // 6 panes, 2 across: bottom row is 4,5 — bottom-left is 4.
    expect(navigationPaneIndex([0, 1, 2, 3, 4, 5], 2, allMaps)).toBe(4);
  });

  it('picks the bottom-left of a part-filled last row', () => {
    // 5 panes, 3 across: last row holds 3 and 4 only.
    expect(navigationPaneIndex([0, 1, 2, 3, 4], 3, allMaps)).toBe(3);
  });

  it('is the only pane, when there is only one', () => {
    expect(navigationPaneIndex([2], 1, allMaps)).toBe(2);
    expect(navigationPaneIndex([2], 3, allMaps)).toBe(2);
  });

  it('walks up and right when the bottom-left pane is not a map', () => {
    // 3,4 are charts; 5 is a map, same row, to the right.
    expect(navigationPaneIndex([0, 1, 2, 3, 4, 5], 3, (i) => i === 5)).toBe(5);
    // The whole bottom row is charts: the control moves up a row.
    expect(navigationPaneIndex([0, 1, 2, 3, 4, 5], 3, (i) => i < 3)).toBe(0);
  });

  it('gives no pane the control when no pane shows a map', () => {
    expect(navigationPaneIndex([0, 1, 2], 2, () => false)).toBeNull();
  });

  it('follows the visible panes, not their indices', () => {
    // Panes are removable, so the visible set is not always 0..n.
    expect(navigationPaneIndex([1, 4, 7, 9], 2, allMaps)).toBe(7);
  });

  it('refuses a nonsense column count rather than looping', () => {
    expect(navigationPaneIndex([0, 1], 0, allMaps)).toBeNull();
  });
});
