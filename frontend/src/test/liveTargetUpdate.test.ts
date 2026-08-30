/**
 * Live update: the default, the override, and the coalescing.
 *
 * A target edit costs a round trip that rescores every catchment in the site,
 * so whether the editor recalculates during a drag or only after it is a
 * question about site size. These tests pin the three properties that make the
 * feature behave: the size-derived default, the fact that an explicit choice
 * outranks it in both directions and survives, and — the part that makes live
 * update viable at all — that a drag's worth of values becomes at most two
 * requests rather than one per pointer move.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LIVE_UPDATE_CATCHMENT_THRESHOLD,
  clearLiveUpdatePreference,
  createRecalculationScheduler,
  defaultLiveUpdate,
  loadLiveUpdatePreference,
  resolveLiveUpdate,
  saveLiveUpdatePreference,
} from '../lib/liveTargetUpdate';

beforeEach(() => {
  window.localStorage.clear();
});

describe('the size-derived default', () => {
  it('is on at and below the threshold', () => {
    expect(defaultLiveUpdate(1)).toBe(true);
    expect(defaultLiveUpdate(LIVE_UPDATE_CATCHMENT_THRESHOLD)).toBe(true);
  });

  it('is off above it', () => {
    expect(defaultLiveUpdate(LIVE_UPDATE_CATCHMENT_THRESHOLD + 1)).toBe(false);
    expect(defaultLiveUpdate(400)).toBe(false);
  });

  it('treats a site with no catchments as small', () => {
    // Nothing to iterate over means nothing to wait for. Off would be a
    // needless downgrade, and 0 is not a stand-in for "unknown" here — the
    // count is read straight off the open site.
    expect(defaultLiveUpdate(0)).toBe(true);
  });
});

describe('the stored preference', () => {
  it('is absent until the user makes a choice', () => {
    expect(loadLiveUpdatePreference()).toBeNull();
  });

  it('round-trips both answers', () => {
    saveLiveUpdatePreference(true);
    expect(loadLiveUpdatePreference()).toBe(true);
    saveLiveUpdatePreference(false);
    expect(loadLiveUpdatePreference()).toBe(false);
  });

  it('goes back to null once cleared', () => {
    saveLiveUpdatePreference(false);
    clearLiveUpdatePreference();
    expect(loadLiveUpdatePreference()).toBeNull();
  });

  it('reads as absent rather than throwing when storage is unreadable', () => {
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
    expect(loadLiveUpdatePreference()).toBeNull();
    getItem.mockRestore();
  });
});

describe('resolveLiveUpdate', () => {
  it('falls back to the size default when nothing is stored', () => {
    expect(resolveLiveUpdate(5, null)).toBe(true);
    expect(resolveLiveUpdate(500, null)).toBe(false);
  });

  it('lets an explicit choice overrule the default in both directions', () => {
    // The whole point of the checkbox: overruling a guess that does not match
    // the machine, the network, or the site in front of the user.
    expect(resolveLiveUpdate(500, true)).toBe(true);
    expect(resolveLiveUpdate(5, false)).toBe(false);
  });
});

describe('the coalescing scheduler', () => {
  /** A run function whose promises are resolved by hand, one at a time. */
  function deferredRunner() {
    const calls: string[] = [];
    const resolvers: Array<() => void> = [];
    const run = (payload: string) => {
      calls.push(payload);
      return new Promise<void>((resolve) => resolvers.push(resolve));
    };
    const settleNext = async () => {
      const resolve = resolvers.shift();
      expect(resolve).toBeDefined();
      resolve?.();
      // Two turns: one for the awaited run, one for the loop's next iteration.
      await Promise.resolve();
      await Promise.resolve();
    };
    return { calls, run, settleNext };
  }

  it('starts immediately when nothing is in flight', () => {
    const { calls, run } = deferredRunner();
    createRecalculationScheduler(run).schedule('a');
    expect(calls).toEqual(['a']);
  });

  it('collapses a drag into the first value and the last', async () => {
    const { calls, run, settleNext } = deferredRunner();
    const scheduler = createRecalculationScheduler(run);

    scheduler.schedule('0.10');
    // Everything between arrives while the first request is still open. Each
    // replaces the last, so none of them costs a round trip.
    scheduler.schedule('0.20');
    scheduler.schedule('0.30');
    scheduler.schedule('0.40');
    expect(calls).toEqual(['0.10']);

    await settleNext();
    expect(calls).toEqual(['0.10', '0.40']);

    await settleNext();
    // Drag over, queue drained — no trailing request for the values it skipped.
    expect(calls).toEqual(['0.10', '0.40']);
  });

  it('never has more than one request open at a time', async () => {
    let open = 0;
    let maxOpen = 0;
    const resolvers: Array<() => void> = [];
    const scheduler = createRecalculationScheduler<number>((_n) => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      return new Promise<void>((resolve) =>
        resolvers.push(() => {
          open -= 1;
          resolve();
        }),
      );
    });

    for (let i = 0; i < 25; i += 1) scheduler.schedule(i);
    while (resolvers.length > 0) {
      resolvers.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(maxOpen).toBe(1);
  });

  it('brackets the whole burst with one busy signal, not one per request', async () => {
    const { run, settleNext } = deferredRunner();
    const busy: boolean[] = [];
    const scheduler = createRecalculationScheduler(run, (b) => busy.push(b));

    scheduler.schedule('a');
    scheduler.schedule('b');
    await settleNext();
    await settleNext();

    // A progress indicator driven by this must stay lit for the drag rather
    // than strobing once per round trip.
    expect(busy).toEqual([true, false]);
  });

  it('reports a failed request without wedging or losing what follows', async () => {
    const calls: string[] = [];
    const errors: unknown[] = [];
    const busy: boolean[] = [];
    let fail = true;
    const scheduler = createRecalculationScheduler<string>(
      async (payload) => {
        calls.push(payload);
        if (fail) {
          fail = false;
          throw new Error('network');
        }
      },
      (b) => busy.push(b),
      (e) => errors.push(e),
    );

    // The drain is started with `void`, so a rejection that escaped it would
    // become an unhandled rejection, and the busy flag would never clear —
    // leaving the editor lit as recalculating forever.
    scheduler.schedule('a');
    scheduler.schedule('b');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect(scheduler.isBusy()).toBe(false);
    expect(busy).toEqual([true, false]);
    // The payload queued behind the failure still went out.
    expect(calls).toEqual(['a', 'b']);
  });
});
