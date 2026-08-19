import type { Site } from '../types';
import { safeSetItem, safeRemoveItem } from './storage';

/**
 * Per-site persistence for the browser runtime.
 *
 * A user's sites live in their browser — that is the design brief — so this is
 * the system of record, not a cache. Three things about how it was stored made
 * that expensive:
 *
 *   - **One blob.** Every save read `dt-sites`, parsed it, mapped over it,
 *     re-serialised all of it and wrote it back. On the Africa walkthrough that
 *     measured 46.6 ms to parse and 27.7 ms to stringify, before the synchronous
 *     `setItem` that follows — 74 ms of blocked main thread on every indicator
 *     edit, on a developer laptop.
 *   - **The per-catchment breakdown.** 27-56 KB per catchment against a ~5 MB
 *     quota, so a site of 90-185 catchments filled the browser on its own. The
 *     server computes it and `getSiteCatchments` already refetches it behind a
 *     TTL cache, which is why the old quota-failure path could strip it and
 *     carry on.
 *   - **`catchmentIds` twice**, once on the site and once inside `indicators`.
 *
 * Records are now stored one key per site, so a save touches one record and
 * costs the size of that record rather than the size of the store. Sites are
 * normalised on the way in: the breakdown is dropped, and so is the duplicated
 * id list if an old document still carries it.
 *
 * ## Why one key per site was not enough on its own
 *
 * Splitting the keys fixed the *write*, not the work around it. The three bulk
 * callers in hooks/useApi.ts — create, update, delete a site — still do
 * load-everything, change one entry, write-everything-back, because that is the
 * shape the API has always had. Against per-site records that became: parse all
 * N records on the way in, then re-serialise all N on the way out to work out
 * which one differed. Same O(store) main-thread cost as the blob, spread over
 * more keys.
 *
 * So this module keeps a **record cache**: for each id, the object it last
 * handed out or wrote, and the exact string that object serialises to. That
 * buys two things.
 *
 *   - A read whose stored string is unchanged returns the cached object without
 *     parsing.
 *   - A bulk write can recognise an unchanged site by **reference identity** —
 *     it is the very object the cache handed out — and skip serialising it
 *     entirely. One changed site out of N costs one `JSON.stringify`, not N.
 *
 * ## The contract that makes that sound
 *
 * **Sites handed out by this module are values. Do not mutate one in place.**
 * Change a site by building a new object (`{ ...site, title }`), which is what
 * React state requires anyway and what every caller in this codebase already
 * does. A site mutated in place is indistinguishable, cheaply, from one that
 * was not, and the bulk path would skip writing it.
 *
 * Two things keep that from being a trap:
 *
 *   - `saveSite` — the explicit single-site write, and the one every interactive
 *     editor uses — **never** takes the identity shortcut. If a caller says a
 *     site changed, it is written. The shortcut applies only to `saveSites`,
 *     whose whole job is to work out which of a list changed.
 *   - `invalidateSiteCache` is exported for anything that needs to opt out.
 *
 * ## What is not deferred
 *
 * Writes are still synchronous and still happen on the call. Nothing is
 * debounced, batched or queued, so there is **no window in which an accepted
 * save has not reached disk** — close the tab immediately after a save returns
 * true and the work is there. Making saves cheaper was the fix; making them
 * later would have traded the user's only copy of their work for smoothness.
 *
 * Moving the work off the main thread proper is not possible here: Web Storage
 * is not exposed to workers. Storing in IndexedDB, which is, is issue #72.
 *
 * ## One cost left, on purpose
 *
 * Every read and write still probes the legacy `dt-sites` key first. Once it has
 * been migrated the key is gone and the probe is a null lookup, so it costs
 * nothing worth caching — and not caching it means a `dt-sites` written later,
 * by an import or a restore, is still picked up. In the one state where the
 * probe is expensive, a migration that failed because storage was full, the blob
 * is re-read and re-parsed on every save; that is deliberate, because in that
 * state the blob is still the user's only copy and every attempt is a chance to
 * rescue it.
 */

const INDEX_KEY = 'dt-site-index';
const RECORD_PREFIX = 'dt-site:';

/** The pre-migration key. Read once, then removed. */
export const LEGACY_KEY = 'dt-sites';

/**
 * Three names for the same payload accumulated over time and every reader had
 * to try all three. They are dropped on write, so nothing needs to read them
 * again — but old records still carry them, hence the list.
 */
const BREAKDOWN_FIELDS = ['catchments', 'catchmentIndicators', 'catchmentData'] as const;

function recordKey(id: string): string {
  return `${RECORD_PREFIX}${id}`;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

/**
 * How much work the store has done, in the units that actually cost something.
 *
 * Exists because "a save is proportional to what changed" is only a claim until
 * it is counted. The tests assert on these: saving one site out of fifty must
 * serialise one site, not fifty.
 */
export interface SiteStoreStats {
  /** Sites put through `JSON.stringify`. */
  serialised: number;
  /** Records put through `JSON.parse`. */
  parsed: number;
  /** `getItem` calls for site records. */
  recordReads: number;
  /** `setItem` calls for site records. */
  recordWrites: number;
  /** `setItem` calls for the index. */
  indexWrites: number;
}

const stats: SiteStoreStats = {
  serialised: 0,
  parsed: 0,
  recordReads: 0,
  recordWrites: 0,
  indexWrites: 0,
};

export function getSiteStoreStats(): SiteStoreStats {
  return { ...stats };
}

export function resetSiteStoreStats(): void {
  stats.serialised = 0;
  stats.parsed = 0;
  stats.recordReads = 0;
  stats.recordWrites = 0;
  stats.indexWrites = 0;
}

/**
 * One entry per known record: the object callers hold, and the string that is
 * in storage for it.
 *
 * `raw` is only ever set from a read that succeeded or a write that succeeded,
 * so it is what is on disk, never what we hoped was.
 */
interface CachedRecord {
  site: Site;
  raw: string;
}

const recordCache = new Map<string, CachedRecord>();

/** The index, when it is known to match storage. Null means "go and read it". */
let indexCache: string[] | null = null;

function forgetEverything(): void {
  recordCache.clear();
  indexCache = null;
}

/**
 * Drop cached knowledge of a record, or of all of them.
 *
 * The escape hatch for the immutability contract above: anything that has
 * changed a site in place, or changed storage behind this module's back, calls
 * this and the next read or write goes to storage.
 */
export function invalidateSiteCache(id?: string): void {
  if (id === undefined) {
    forgetEverything();
    return;
  }
  recordCache.delete(id);
}

/**
 * Another tab wrote to our storage, so what we have cached may be stale.
 *
 * `storage` events fire in every tab *except* the one that wrote, which is
 * exactly the set of tabs whose caches are now wrong. Without this, two tabs
 * open on the same sites would each keep serving their own stale copy — and
 * worse, the identity shortcut in `saveSites` would decide a record needed no
 * write when the other tab had already replaced it.
 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event: StorageEvent) => {
    // A null key means the whole area was cleared.
    if (event.key === null) {
      forgetEverything();
      return;
    }
    if (event.key === INDEX_KEY) {
      indexCache = null;
    } else if (event.key.startsWith(RECORD_PREFIX)) {
      recordCache.delete(event.key.slice(RECORD_PREFIX.length));
    }
  });
}

/**
 * What actually gets stored: the site definition, without anything the server
 * can recompute and without anything held twice.
 *
 * Returns a new object; the caller's site is not mutated, because callers hold
 * these in React state and mutating one would be a silent aliasing bug.
 */
export function normaliseForStorage(site: Site): Site {
  const copy: Record<string, unknown> = { ...(site as unknown as Record<string, unknown>) };

  for (const field of BREAKDOWN_FIELDS) {
    delete copy[field];
  }

  // Older records carry indicators.catchmentIds, byte-identical to the array on
  // the site itself. Nothing reads it.
  const indicators = copy.indicators as Record<string, unknown> | undefined | null;
  if (indicators && typeof indicators === 'object' && 'catchmentIds' in indicators) {
    const { catchmentIds: _dropped, ...rest } = indicators;
    void _dropped;
    copy.indicators = rest;
  }

  return copy as unknown as Site;
}

/** The one place a site becomes a string, so the cost has somewhere to be counted. */
function serialise(site: Site): string {
  stats.serialised++;
  return JSON.stringify(normaliseForStorage(site));
}

function getRecordRaw(id: string): string | null {
  if (!isBrowser()) return null;
  try {
    stats.recordReads++;
    return window.localStorage.getItem(recordKey(id));
  } catch {
    return null;
  }
}

/**
 * Write a record and remember it.
 *
 * The cache entry is set only when the write succeeded, and cleared when it did
 * not — so a quota failure can never leave this module believing a site is
 * stored when it is not. That is the whole point of `safeSetItem` returning a
 * boolean, and losing it here would recreate the silent-loss bug one level up.
 */
function writeRecord(site: Site, raw: string): boolean {
  stats.recordWrites++;
  if (!safeSetItem(recordKey(site.id), raw)) {
    recordCache.delete(site.id);
    return false;
  }
  recordCache.set(site.id, { site, raw });
  return true;
}

function readIndex(): string[] {
  if (!isBrowser()) return [];
  if (indexCache) return indexCache;
  try {
    const raw = window.localStorage.getItem(INDEX_KEY);
    if (!raw) {
      indexCache = [];
      return indexCache;
    }
    const parsed = JSON.parse(raw);
    indexCache = Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : [];
    return indexCache;
  } catch {
    return [];
  }
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Write the index, unless it already says this.
 *
 * The bulk path used to rewrite the index on every save even when membership
 * and order were unchanged, which is most saves.
 */
function writeIndex(ids: string[]): boolean {
  if (indexCache && sameIds(indexCache, ids)) return true;
  stats.indexWrites++;
  if (!safeSetItem(INDEX_KEY, JSON.stringify(ids))) {
    indexCache = null;
    return false;
  }
  indexCache = ids.slice();
  return true;
}

/**
 * Read one record, parsing only when the stored string is not the one already
 * parsed.
 *
 * Returns the cached object itself, not a copy — see the immutability contract
 * at the top of this file. Handing out a stable reference is what lets a later
 * `saveSites` recognise an untouched site for free.
 */
function readRecord(id: string): Site | null {
  if (!isBrowser()) return null;

  const raw = getRecordRaw(id);
  if (!raw) {
    recordCache.delete(id);
    return null;
  }

  const cached = recordCache.get(id);
  if (cached && cached.raw === raw) return cached.site;

  try {
    stats.parsed++;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const site = parsed as Site;
    recordCache.set(id, { site, raw });
    return site;
  } catch {
    return null;
  }
}

/** Whether the per-site index has ever been written, even as an empty list. */
function indexKeyExists(): boolean {
  if (!isBrowser()) return false;
  try {
    return window.localStorage.getItem(INDEX_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Move a legacy `dt-sites` blob to per-site records.
 *
 * Intended to run at most once: the blob is removed on success. If writing any
 * record fails — a full quota, most likely — the blob used to be left alone so
 * the next read would try again. Under a quota that never recovers (the blob
 * itself, a full duplicate of everything, was often *why* it was full) that
 * meant it never went away, and every read kept re-migrating it — including
 * sites the per-site store had since had deleted, resurrecting them on every
 * load with no error to explain why the delete "didn't work".
 *
 * So a second condition ends the retries even without a successful migration:
 * once the per-site index has ever been written — by this function or by an
 * ordinary create/update/delete — the per-site store is the live system of
 * record, and the legacy blob is stale by definition. It is discarded rather
 * than merged, on the same best-effort basis as everything else here: freeing
 * the space it held matters more than a blob nothing will read again.
 *
 * Returns the migrated sites, or null when there was nothing to migrate.
 */
export function migrateLegacyStore(): Site[] | null {
  if (!isBrowser()) return null;

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(LEGACY_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  if (indexKeyExists()) {
    safeRemoveItem(LEGACY_KEY);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unreadable. Removing it would destroy whatever it held, and it is no
    // longer in the way, so leave it for a human.
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const sites = (parsed as Site[]).filter((s) => s && typeof s.id === 'string');

  for (const site of sites) {
    // Deliberately not retried on failure: the blob below is still the user's
    // copy, and a reload will try again once there is room.
    if (!writeRecord(site, serialise(site))) return sites;
  }
  if (!writeIndex(sites.map((s) => s.id))) return sites;

  safeRemoveItem(LEGACY_KEY);
  return sites;
}

/** Every stored site, in index order. */
export function loadSites(): Site[] {
  if (!isBrowser()) return [];

  const migrated = migrateLegacyStore();
  if (migrated) return migrated;

  const ids = readIndex();
  const sites: Site[] = [];
  for (const id of ids) {
    const site = readRecord(id);
    if (site) sites.push(site);
  }
  return sites;
}

export function loadSite(id: string): Site | null {
  if (!isBrowser()) return null;
  migrateLegacyStore();
  return readRecord(id);
}

/**
 * Write one site. Touches one record, and the index only when the site is new.
 *
 * Always writes, even if the site looks unchanged: a caller reaching for this
 * function is asserting that it changed, and second-guessing that is how work
 * gets lost. Costs one serialisation regardless of how much is stored.
 */
export function saveSite(site: Site): boolean {
  if (!isBrowser()) return true;
  if (!site || typeof site.id !== 'string') return false;

  migrateLegacyStore();

  if (!writeRecord(site, serialise(site))) return false;

  const ids = readIndex();
  if (!ids.includes(site.id)) {
    return writeIndex([site.id, ...ids]);
  }
  return true;
}

/**
 * Write a whole list, as the old whole-store save did — but only the records
 * that actually changed, and only serialising the ones that might have.
 *
 * Callers overwhelmingly pass the full list back with one site modified, having
 * got the list from `loadSites`. Every site they did not touch is still the
 * object this module handed them, so it is recognised by reference and costs
 * nothing at all. A site that is not recognised is serialised and compared
 * against what is stored, so an unfamiliar object that happens to be identical
 * still does not reach disk.
 */
export function saveSites(sites: Site[]): boolean {
  if (!isBrowser()) return true;

  migrateLegacyStore();

  let ok = true;
  const ids: string[] = [];
  const kept = new Set<string>();

  for (const site of sites) {
    if (!site || typeof site.id !== 'string') continue;
    ids.push(site.id);
    kept.add(site.id);

    // The object we handed out, unchanged. Nothing to serialise, nothing to
    // write. This is the case that makes a save proportional to the edit.
    const cached = recordCache.get(site.id);
    if (cached && cached.site === site) continue;

    const next = serialise(site);
    // Prefer what the cache knows is on disk over re-reading it; getItem copies
    // the whole record string, which for a continent-scale site is ~2 M chars.
    const current = cached ? cached.raw : getRecordRaw(site.id);
    if (current === next) {
      recordCache.set(site.id, { site, raw: next });
      continue;
    }

    if (!writeRecord(site, next)) ok = false;
  }

  // Records dropped from the list are deleted, so the store cannot accumulate
  // sites the caller believes it removed. A failed removal must fail the whole
  // save — otherwise the caller (and the index write below) reports success
  // while an orphaned record silently survives on disk.
  for (const id of readIndex()) {
    if (!kept.has(id)) {
      if (!safeRemoveItem(recordKey(id))) ok = false;
      recordCache.delete(id);
    }
  }

  if (!writeIndex(ids)) ok = false;
  return ok;
}

export function deleteSite(id: string): boolean {
  if (!isBrowser()) return true;
  migrateLegacyStore();
  const removed = safeRemoveItem(recordKey(id));
  recordCache.delete(id);
  const ids = readIndex().filter((entry) => entry !== id);
  return writeIndex(ids) && removed;
}

/** Test seam: forget everything this module owns. */
export function clearSiteStore(): void {
  if (!isBrowser()) {
    forgetEverything();
    return;
  }
  for (const id of readIndex()) safeRemoveItem(recordKey(id));
  safeRemoveItem(INDEX_KEY);
  safeRemoveItem(LEGACY_KEY);
  forgetEverything();
}
