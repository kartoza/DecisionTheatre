/**
 * Per-site scale ranges, remembered across reloads.
 *
 * A site's spread for an attribute is derived from its whole catchment payload
 * — hundreds of kilobytes for a modest site, tens of megabytes for a large one
 * — and the answer is two numbers. Recomputing it on every reload means
 * fetching all of that again to arrive back where we started, and until it
 * lands the dial has no scale to draw against.
 *
 * So the two numbers are cached, not the payload. This is the opposite trade to
 * the in-memory catchment cache: that one keeps the data because the session
 * will want other things from it; this one keeps only the conclusion, because
 * it is the conclusion that outlives the session.
 *
 * Scoped per site, and invalidated by a fingerprint rather than by a clock. A
 * site's spread does not go stale with time — it goes stale when the site
 * changes, and nothing else. See `siteRangeFingerprint`.
 */

import { safeRemoveItem, safeSetItem } from './storage';

export interface SiteRange {
  min: number;
  max: number;
}

/** One site's cached ranges, as stored. */
interface SiteRangeEntry {
  /** Identifies the version of the site these ranges were computed from. */
  f: string;
  /** When this entry was last written, for eviction. */
  t: number;
  /** attribute → [min, max]. Tuples rather than objects: this is the bulk. */
  r: Record<string, [number, number]>;
}

const PREFIX = 'dt.siteRange.';

/**
 * How many sites to keep ranges for.
 *
 * Local storage is the only copy of the user's sites in the browser runtime, so
 * this cache must never be the reason a save fails. A handful of sites is all a
 * session realistically revisits, and the oldest is dropped past that.
 */
const MAX_SITES = 8;

/**
 * What makes a cached range stale.
 *
 * Time does not: a site that has not changed has the same spread today as
 * yesterday. What changes it is the site changing — a redrawn boundary, a
 * different set of catchments, a re-extraction — and all three land as a new
 * `extractedAt` and/or a different catchment count. Comparing those is both
 * cheaper and more honest than an expiry that is right only by accident.
 */
export function siteRangeFingerprint(
  extractedAt: string | undefined,
  catchmentCount: number | undefined,
): string {
  return `${extractedAt ?? 'none'}:${catchmentCount ?? 0}`;
}

function keyFor(siteId: string): string {
  return `${PREFIX}${siteId}`;
}

function readEntry(siteId: string): SiteRangeEntry | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(keyFor(siteId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SiteRangeEntry;
    if (!parsed || typeof parsed.f !== 'string' || typeof parsed.r !== 'object') return null;
    return parsed;
  } catch {
    // Corrupt or written by an older shape. Treat as absent rather than
    // throwing on a cache read — a bad cache entry must not break the dial.
    return null;
  }
}

/**
 * The cached range for one attribute, or null when there is nothing usable.
 *
 * Returns null on a fingerprint mismatch rather than stale numbers: a scale
 * drawn from the previous version of a site is wrong in a way the viewer cannot
 * see, which is worse than having no scale for a moment.
 */
export function loadSiteRange(
  siteId: string,
  fingerprint: string,
  attribute: string,
): SiteRange | null {
  const entry = readEntry(siteId);
  if (!entry || entry.f !== fingerprint) return null;
  const pair = entry.r[attribute];
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  const [min, max] = pair;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return null;
  return { min, max };
}

/** Remember one attribute's range for a site. */
export function saveSiteRange(
  siteId: string,
  fingerprint: string,
  attribute: string,
  range: SiteRange,
): void {
  if (typeof window === 'undefined') return;
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || !(range.max > range.min)) return;

  const existing = readEntry(siteId);
  // A fingerprint change discards the whole entry rather than merging into it:
  // the other attributes were computed from the same superseded site.
  const entry: SiteRangeEntry =
    existing && existing.f === fingerprint
      ? { ...existing, t: Date.now() }
      : { f: fingerprint, t: Date.now(), r: {} };

  entry.r[attribute] = [range.min, range.max];
  evictOldestBeyond(MAX_SITES - 1, siteId);
  safeSetItem(keyFor(siteId), JSON.stringify(entry));
}

/** Forget a site's ranges, or every site's when no id is given. */
export function clearSiteRanges(siteId?: string): void {
  if (typeof window === 'undefined') return;
  if (siteId) {
    safeRemoveItem(keyFor(siteId));
    return;
  }
  for (const key of ownKeys()) safeRemoveItem(key);
}

function ownKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(PREFIX)) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

/**
 * Keep the cache to `limit` sites besides the one about to be written.
 *
 * Oldest write goes first. This is a cache in a store that also holds the only
 * copy of the user's sites, so it has to stay small on its own account rather
 * than waiting to be told it is full.
 */
function evictOldestBeyond(limit: number, exceptSiteId: string): void {
  const others = ownKeys().filter((k) => k !== keyFor(exceptSiteId));
  if (others.length <= limit) return;

  const dated = others.map((key) => {
    let t = 0;
    try {
      t = (JSON.parse(window.localStorage.getItem(key) ?? '{}') as SiteRangeEntry).t ?? 0;
    } catch {
      // Unparseable entries sort oldest, which evicts them first — exactly
      // what should happen to them.
    }
    return { key, t };
  });
  dated.sort((a, b) => a.t - b.t);
  for (const { key } of dated.slice(0, dated.length - limit)) safeRemoveItem(key);
}
