/**
 * Whether the target editor recalculates while a slider is being dragged.
 *
 * Every target edit costs a round trip that rescores each catchment in the
 * site, so the cost of recalculating scales with how many catchments the site
 * has. On a small site that is fast enough to run continuously as the thumb
 * moves, and continuous feedback is the whole point of the editor: you see the
 * dials answer the slider. On a large site the same behaviour would queue a
 * request per animation frame's worth of movement, so there the recalculation
 * waits for the drag to finish.
 *
 * The catchment count only supplies the *default*. Once the user has ticked or
 * unticked the box the choice is theirs and is remembered, because the point of
 * the control is to overrule a guess that does not match the machine, the
 * network, or the site in front of them.
 */

import { safeSetItem } from './storage';

/**
 * Sites at or below this many catchments default to live update.
 *
 * Chosen as the point where a full recalculation stays comfortably inside a
 * drag's frame budget on a local backend. It is a default, not a limit — the
 * checkbox overrides it in either direction.
 */
export const LIVE_UPDATE_CATCHMENT_THRESHOLD = 20;

const PREFERENCE_KEY = 'dt.targets.liveUpdate';

/**
 * The user's explicit choice, or null when they have never made one.
 *
 * Null is meaningfully different from false: it means "no opinion recorded, so
 * pick the default for this site", and it is why an untouched checkbox can
 * change between sites while a touched one cannot.
 */
export function loadLiveUpdatePreference(): boolean | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PREFERENCE_KEY);
  } catch {
    // Storage blocked entirely (private mode, enterprise policy). Falling back
    // to the per-site default is correct: the feature still works, it just
    // forgets between sessions.
    return null;
  }
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return null;
}

/** Record an explicit choice, so it survives reloads and outlives this site. */
export function saveLiveUpdatePreference(enabled: boolean): void {
  safeSetItem(PREFERENCE_KEY, enabled ? 'on' : 'off');
}

/** Forget the explicit choice and go back to deciding by catchment count. */
export function clearLiveUpdatePreference(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PREFERENCE_KEY);
  } catch {
    // Nothing useful to do — the value was never stored in the first place.
  }
}

/**
 * The default for a site of this size, ignoring any stored preference.
 *
 * A site with no catchments counts as small rather than unknown: there is
 * nothing for a recalculation to iterate over, so live update costs nothing.
 */
export function defaultLiveUpdate(catchmentCount: number): boolean {
  return catchmentCount <= LIVE_UPDATE_CATCHMENT_THRESHOLD;
}

/**
 * The setting to actually use: the stored choice when there is one, otherwise
 * the size-derived default.
 */
export function resolveLiveUpdate(catchmentCount: number, stored: boolean | null): boolean {
  return stored ?? defaultLiveUpdate(catchmentCount);
}

/**
 * Coalescing scheduler for recalculations.
 *
 * A drag produces a stream of values, not a queue of edits. Sending one
 * request per value would put the backend behind the pointer and land the
 * answers out of order, so this keeps at most one request in flight and
 * remembers only the newest payload produced while it runs. When the request
 * finishes, the remembered payload — and only that one — is sent, so the
 * sequence always converges on the last value the user actually chose no
 * matter how much movement was dropped in between.
 *
 * `onBusyChange` brackets the whole burst rather than each request, so a
 * progress indicator driven by it stays lit for the duration of a drag instead
 * of flickering once per round trip.
 */
export interface RecalculationScheduler<T> {
  /** Queue `payload`, starting a request now if nothing is in flight. */
  schedule(payload: T): void;
  /** Whether a request is in flight or a payload is waiting behind one. */
  isBusy(): boolean;
}

export function createRecalculationScheduler<T>(
  run: (payload: T) => Promise<void>,
  onBusyChange: (busy: boolean) => void = () => {},
  onError: (error: unknown) => void = (error) =>
    console.error('Target recalculation failed', error),
): RecalculationScheduler<T> {
  // `undefined` rather than null: a payload of null is a legitimate value for
  // a caller to schedule, and "nothing pending" must stay distinguishable.
  let pending: { payload: T } | undefined;
  let inFlight = false;

  const drain = async () => {
    inFlight = true;
    onBusyChange(true);
    try {
      while (pending) {
        const { payload } = pending;
        pending = undefined;
        // Caught per iteration, not around the loop. A failed request must
        // neither strand the editor as permanently busy nor discard the
        // payload waiting behind it, and the drain is started with `void`, so
        // an escaping rejection would surface as an unhandled one.
        try {
          await run(payload);
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      inFlight = false;
      onBusyChange(false);
    }
  };

  return {
    schedule(payload: T) {
      pending = { payload };
      if (inFlight) return;
      void drain();
    },
    isBusy() {
      return inFlight;
    },
  };
}
