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

function readIndex(): string[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeIndex(ids: string[]): boolean {
  return safeSetItem(INDEX_KEY, JSON.stringify(ids));
}

function readRecord(id: string): Site | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(recordKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Site) : null;
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
    if (!safeSetItem(recordKey(site.id), JSON.stringify(normaliseForStorage(site)))) {
      return sites;
    }
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
 */
export function saveSite(site: Site): boolean {
  if (!isBrowser()) return true;
  if (!site || typeof site.id !== 'string') return false;

  migrateLegacyStore();

  if (!safeSetItem(recordKey(site.id), JSON.stringify(normaliseForStorage(site)))) {
    return false;
  }

  const ids = readIndex();
  if (!ids.includes(site.id)) {
    return writeIndex([site.id, ...ids]);
  }
  return true;
}

/**
 * Write a whole list, as the old whole-store save did — but only the records
 * that actually changed.
 *
 * Callers overwhelmingly pass the full list back with one site modified. The
 * comparison is against the serialised record, so an unchanged site costs a
 * read and a string compare rather than a write to disk.
 */
export function saveSites(sites: Site[]): boolean {
  if (!isBrowser()) return true;

  migrateLegacyStore();

  let ok = true;
  const ids: string[] = [];

  for (const site of sites) {
    if (!site || typeof site.id !== 'string') continue;
    ids.push(site.id);

    const next = JSON.stringify(normaliseForStorage(site));
    let current: string | null = null;
    try {
      current = window.localStorage.getItem(recordKey(site.id));
    } catch {
      current = null;
    }
    if (current === next) continue;

    if (!safeSetItem(recordKey(site.id), next)) ok = false;
  }

  // Records dropped from the list are deleted, so the store cannot accumulate
  // sites the caller believes it removed. A failed removal must fail the whole
  // save — otherwise the caller (and the index write below) reports success
  // while an orphaned record silently survives on disk.
  for (const id of readIndex()) {
    if (!ids.includes(id) && !safeRemoveItem(recordKey(id))) ok = false;
  }

  if (!writeIndex(ids)) ok = false;
  return ok;
}

export function deleteSite(id: string): boolean {
  if (!isBrowser()) return true;
  migrateLegacyStore();
  const removed = safeRemoveItem(recordKey(id));
  const ids = readIndex().filter((entry) => entry !== id);
  return writeIndex(ids) && removed;
}

/** Test seam: forget everything this module owns. */
export function clearSiteStore(): void {
  if (!isBrowser()) return;
  for (const id of readIndex()) safeRemoveItem(recordKey(id));
  safeRemoveItem(INDEX_KEY);
  safeRemoveItem(LEGACY_KEY);
}
