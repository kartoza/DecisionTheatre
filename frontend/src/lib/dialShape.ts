/**
 * Which shape the dial is drawn in, shared by every pane.
 *
 * The arc gauge and the flat band are two drawings of one scale, and the point
 * of having both is being able to compare them — so the choice is global and
 * persistent rather than per pane. Six panes disagreeing about their own shape
 * would make the comparison harder, not easier.
 *
 * Panes do not share a parent that could hold this in React state without
 * threading a prop through ViewPane and ContentArea, so it is a module-level
 * value plus an event, which is the pattern the map toggles already use.
 */

import { safeSetItem } from './storage';

export type DialShape = 'arc' | 'flat';

const KEY = 'dt.dial.shape';
const EVENT = 'dt:dial-shape-changed';

/** The shape to draw, defaulting to the arc gauge that predates the flat one. */
export function loadDialShape(): DialShape {
  if (typeof window === 'undefined') return 'arc';
  try {
    return window.localStorage.getItem(KEY) === 'flat' ? 'flat' : 'arc';
  } catch {
    // Storage blocked entirely. The toggle still works for this session; it
    // just will not be remembered.
    return 'arc';
  }
}

/** Record the choice and tell every mounted dial about it. */
export function saveDialShape(shape: DialShape): void {
  safeSetItem(KEY, shape);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: shape }));
  }
}

/** Subscribe to changes. Returns the unsubscribe function. */
export function onDialShapeChange(listener: (shape: DialShape) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => listener((e as CustomEvent<DialShape>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
