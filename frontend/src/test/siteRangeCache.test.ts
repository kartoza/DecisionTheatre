/**
 * Remembered per-site scale ranges.
 *
 * The cache stores the conclusion (two numbers) rather than the catchment
 * payload it was derived from, and is invalidated by the site changing rather
 * than by a clock. These tests pin both of those, and the bounding — this cache
 * shares local storage with the only copy of the user's sites in the browser
 * runtime, so it must never be the reason a save fails.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearSiteRanges,
  loadSiteRange,
  saveSiteRange,
  siteRangeFingerprint,
} from '../lib/siteRangeCache';

const FP = siteRangeFingerprint('2026-08-30T00:00:00Z', 11);

beforeEach(() => {
  window.localStorage.clear();
});

describe('round trip', () => {
  it('returns nothing before anything is stored', () => {
    expect(loadSiteRange('site-a', FP, 'npp')).toBeNull();
  });

  it('remembers a range per site and attribute', () => {
    saveSiteRange('site-a', FP, 'npp', { min: 0, max: 1500 });
    saveSiteRange('site-a', FP, 'soc', { min: -70, max: 70 });
    saveSiteRange('site-b', FP, 'npp', { min: 5, max: 900 });

    expect(loadSiteRange('site-a', FP, 'npp')).toEqual({ min: 0, max: 1500 });
    expect(loadSiteRange('site-a', FP, 'soc')).toEqual({ min: -70, max: 70 });
    expect(loadSiteRange('site-b', FP, 'npp')).toEqual({ min: 5, max: 900 });
  });

  it('does not answer for an attribute it has not seen', () => {
    saveSiteRange('site-a', FP, 'npp', { min: 0, max: 1500 });
    expect(loadSiteRange('site-a', FP, 'herbs')).toBeNull();
  });
});

describe('invalidation', () => {
  it('refuses a range computed from a different version of the site', () => {
    saveSiteRange('site-a', FP, 'npp', { min: 0, max: 1500 });
    const afterReExtraction = siteRangeFingerprint('2026-08-30T12:00:00Z', 11);
    // Stale numbers would draw a scale that is wrong in a way the viewer
    // cannot see. No scale for a moment is the better failure.
    expect(loadSiteRange('site-a', afterReExtraction, 'npp')).toBeNull();
  });

  it('notices a changed catchment count, which a boundary edit produces', () => {
    saveSiteRange('site-a', FP, 'npp', { min: 0, max: 1500 });
    expect(loadSiteRange('site-a', siteRangeFingerprint('2026-08-30T00:00:00Z', 12), 'npp')).toBeNull();
  });

  it('discards the whole entry when the site changes, not just the one attribute', () => {
    saveSiteRange('site-a', FP, 'npp', { min: 0, max: 1500 });
    saveSiteRange('site-a', FP, 'soc', { min: -70, max: 70 });

    const next = siteRangeFingerprint('2026-08-31T00:00:00Z', 11);
    saveSiteRange('site-a', next, 'npp', { min: 0, max: 1200 });

    // soc was computed from the superseded site and must not survive alongside
    // a freshly computed npp.
    expect(loadSiteRange('site-a', next, 'npp')).toEqual({ min: 0, max: 1200 });
    expect(loadSiteRange('site-a', next, 'soc')).toBeNull();
  });

  it('is not invalidated by time', () => {
    // A site that has not changed has the same spread today as yesterday.
    saveSiteRange('site-a', FP, 'npp', { min: 0, max: 1500 });
    expect(loadSiteRange('site-a', FP, 'npp')).toEqual({ min: 0, max: 1500 });
  });

  it('can be cleared for one site or for all of them', () => {
    saveSiteRange('site-a', FP, 'npp', { min: 0, max: 1500 });
    saveSiteRange('site-b', FP, 'npp', { min: 0, max: 900 });

    clearSiteRanges('site-a');
    expect(loadSiteRange('site-a', FP, 'npp')).toBeNull();
    expect(loadSiteRange('site-b', FP, 'npp')).toEqual({ min: 0, max: 900 });

    clearSiteRanges();
    expect(loadSiteRange('site-b', FP, 'npp')).toBeNull();
  });
});

describe('bounding', () => {
  it('keeps to a handful of sites, dropping the oldest written', () => {
    for (let i = 0; i < 12; i += 1) {
      saveSiteRange(`site-${i}`, FP, 'npp', { min: 0, max: 100 + i });
    }
    const kept = Object.keys(window.localStorage).filter((k) => k.startsWith('dt.siteRange.'));
    expect(kept.length).toBeLessThanOrEqual(8);
    // The most recent survives; the first does not.
    expect(loadSiteRange('site-11', FP, 'npp')).toEqual({ min: 0, max: 111 });
    expect(loadSiteRange('site-0', FP, 'npp')).toBeNull();
  });

  it('leaves everything else in storage alone', () => {
    window.localStorage.setItem('dt-sites', 'the-users-actual-sites');
    for (let i = 0; i < 12; i += 1) {
      saveSiteRange(`site-${i}`, FP, 'npp', { min: 0, max: 100 });
    }
    expect(window.localStorage.getItem('dt-sites')).toBe('the-users-actual-sites');
  });
});

describe('robustness', () => {
  it('treats a corrupt entry as absent rather than throwing', () => {
    window.localStorage.setItem('dt.siteRange.site-a', 'not json');
    expect(loadSiteRange('site-a', FP, 'npp')).toBeNull();
  });

  it('refuses to store a range that is not one', () => {
    saveSiteRange('site-a', FP, 'npp', { min: 10, max: 10 });
    saveSiteRange('site-a', FP, 'soc', { min: NaN, max: 5 });
    saveSiteRange('site-a', FP, 'fire', { min: 90, max: 10 });
    expect(loadSiteRange('site-a', FP, 'npp')).toBeNull();
    expect(loadSiteRange('site-a', FP, 'soc')).toBeNull();
    expect(loadSiteRange('site-a', FP, 'fire')).toBeNull();
  });
});
