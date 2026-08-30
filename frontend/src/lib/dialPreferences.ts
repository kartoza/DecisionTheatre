/**
 * Dial display preferences, shared by every pane.
 *
 * These are choices about how the dial is drawn rather than about what it
 * shows, and they are global: the point of a shape toggle is comparing two
 * shapes, and the point of a scale lock is holding one scale still while values
 * move — six panes disagreeing about either would defeat both.
 *
 * Panes have no shared parent that could hold this in React state without
 * threading a prop through ViewPane and ContentArea, so each preference is a
 * stored value plus an event, which is the pattern the map toggles already use.
 */

import { safeSetItem } from './storage';

/**
 * One persisted, broadcast preference.
 *
 * A factory rather than two hand-written copies of load/save/subscribe: the
 * second preference would otherwise have been the first one's code with the key
 * changed, which is how they drift.
 */
function createPreference<T extends string>(key: string, values: readonly T[], fallback: T) {
  const event = `dt:pref-${key}`;

  const load = (): T => {
    if (typeof window === 'undefined') return fallback;
    try {
      const raw = window.localStorage.getItem(key) as T | null;
      return raw !== null && values.includes(raw) ? raw : fallback;
    } catch {
      // Storage blocked entirely (private mode, policy). The toggle still works
      // for this session; it just will not be remembered.
      return fallback;
    }
  };

  const save = (value: T): void => {
    safeSetItem(key, value);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(event, { detail: value }));
    }
  };

  const subscribe = (listener: (value: T) => void): (() => void) => {
    if (typeof window === 'undefined') return () => {};
    const handler = (e: Event) => listener((e as CustomEvent<T>).detail);
    window.addEventListener(event, handler);
    return () => window.removeEventListener(event, handler);
  };

  return { load, save, subscribe };
}

// --- Shape ----------------------------------------------------------------

export type DialShape = 'arc' | 'flat';

/**
 * Defaults to the flat band on this branch, because the flat band is what the
 * branch exists to look at. Flip this to 'arc' to restore the previous default.
 */
const DEFAULT_SHAPE: DialShape = 'flat';

const shape = createPreference<DialShape>('dt.dial.shape', ['arc', 'flat'], DEFAULT_SHAPE);

export const loadDialShape = shape.load;
export const saveDialShape = shape.save;
export const onDialShapeChange = shape.subscribe;

// --- Scale lock -----------------------------------------------------------

export type ScaleLock = 'on' | 'off';

/**
 * Whether the scale holds still while values move.
 *
 * Off by default: an axis that adapts to its data is the more useful first
 * impression, and a scale that silently refuses to grow past a marker would be
 * a strange thing to meet unannounced.
 */
const scaleLock = createPreference<ScaleLock>('dt.dial.scaleLock', ['on', 'off'], 'off');

export const loadScaleLock = (): boolean => scaleLock.load() === 'on';
export const saveScaleLock = (locked: boolean): void => scaleLock.save(locked ? 'on' : 'off');
export const onScaleLockChange = (listener: (locked: boolean) => void): (() => void) =>
  scaleLock.subscribe((v) => listener(v === 'on'));
