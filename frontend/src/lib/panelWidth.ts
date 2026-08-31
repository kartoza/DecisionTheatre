/**
 * How wide the right-hand slot is.
 *
 * Three panels dock into one slot — the factor controls, the target editor and
 * the chart details — and only one is ever open. So the width belongs to the
 * slot, not to whichever panel is currently in it: drag the edge while reading
 * the calculations and the target editor should be that width too, or the frame
 * jumps every time you switch.
 *
 * Only one panel had a draggable edge at all; the other two were pinned at
 * 440px, so content that did not fit could not be read. All three share this
 * now.
 *
 * Persisted, because a width the user chose to read something is a width they
 * chose, and making them choose it again next session is just forgetting.
 */

import { useCallback, useEffect, useState } from 'react';
import { safeSetItem } from './storage';

const KEY = 'dt.panel.width';
const EVENT = 'dt:panel-width-changed';

export const MIN_PANEL_WIDTH = 320;
export const MAX_PANEL_WIDTH = 900;
export const DEFAULT_PANEL_WIDTH = 440;

function clamp(width: number): number {
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
}

export function loadPanelWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_PANEL_WIDTH;
  try {
    const raw = Number(window.localStorage.getItem(KEY));
    return Number.isFinite(raw) && raw > 0 ? clamp(raw) : DEFAULT_PANEL_WIDTH;
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
}

export function savePanelWidth(width: number): void {
  const next = clamp(width);
  safeSetItem(KEY, String(next));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  }
}

/**
 * The slot's width, and a drag handler for the edge that sets it.
 *
 * Every panel calls this, so they all report the same number and all update
 * together while one of them is being dragged.
 */
export function usePanelWidth() {
  const [width, setWidth] = useState(loadPanelWidth);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: Event) => setWidth((e as CustomEvent<number>).detail);
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  /**
   * Drag from the panel's left edge. Rightward narrows, leftward widens,
   * because the panel is anchored to the right of the window.
   */
  const startResize = useCallback((event: { clientX: number; preventDefault: () => void }) => {
    event.preventDefault();
    const originX = event.clientX;
    const originWidth = loadPanelWidth();

    const onMove = (move: MouseEvent) => {
      savePanelWidth(originWidth + (originX - move.clientX));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Restored rather than cleared: a panel that leaves the document without
      // its own text selection turned back on leaves the whole page unable to
      // select, which is a strange thing to inherit from a drag.
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    // While dragging, the pointer regularly leaves the 6px handle. Without
    // these the drag selects the panel's text instead of resizing it.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  return { width, startResize };
}
