import { useState, useEffect, useCallback } from 'react';
import type { Scenario, ServerInfo, Site, CatchmentIndicators } from '../types';
import { DEFAULT_PANE_STATES } from '../types';
import { getAppRuntime } from '../types/runtime';
import { WALKTHROUGH_SITE_IDS } from '../constants/walkthroughSites';
import { applyAOIWeightedIndicators } from '../utils/indicators';
import { evictExpired } from '../lib/ttlCache';

const API_BASE = '/api';
const SITES_STORAGE_KEY = 'dt-sites';
type SiteWithCatchments = Site & {
  catchments?: CatchmentIndicators[];
  catchmentIndicators?: CatchmentIndicators[];
  catchmentData?: CatchmentIndicators[];
};

function isBrowserRuntime(): boolean {
  return getAppRuntime() === 'browser';
}

export function loadLocalSites(): Site[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(SITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as Site[] : [];
  } catch {
    return [];
  }
}

function isQuotaExceededError(err: unknown): boolean {
  return err instanceof DOMException
    && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

// Returns whether the sites were actually persisted. localStorage has a hard
// per-origin quota (~5-10MB); every site's per-catchment breakdown (per-species
// biomass etc. for each catchment) can make this add up, and once the quota is
// hit every write throws and silently no-ops unless callers check this return
// value. On quota failure, retry once with that breakdown stripped from every
// site — it's the largest field and is regenerable on demand from the server —
// before giving up and reporting failure so the caller can tell the user.
export function saveLocalSites(sites: Site[]): boolean {
  if (typeof window === 'undefined') return true;

  try {
    window.localStorage.setItem(SITES_STORAGE_KEY, JSON.stringify(sites));
    return true;
  } catch (err) {
    if (!isQuotaExceededError(err)) return false;

    try {
      const slimmed = sites.map((site) => {
        const { catchments, catchmentIndicators, catchmentData, ...rest } = site as SiteWithCatchments;
        void catchments; void catchmentIndicators; void catchmentData;
        return rest;
      });
      window.localStorage.setItem(SITES_STORAGE_KEY, JSON.stringify(slimmed));
      return true;
    } catch {
      return false;
    }
  }
}

function loadLocalCatchments(siteId: string): CatchmentIndicators[] {
  const sites = loadLocalSites();
  const site = sites.find((entry) => entry.id === siteId) as SiteWithCatchments | undefined;
  if (!site) return [];

  const stored = site.catchments ?? site.catchmentIndicators ?? site.catchmentData;
  return Array.isArray(stored) ? stored : [];
}

function loadLocalSite(siteId: string): Site | null {
  const sites = loadLocalSites();
  return sites.find((entry) => entry.id === siteId) ?? null;
}

function sortSitesByCreatedAtDesc(sites: Site[]): Site[] {
  return [...sites].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function persistLocalCatchments(siteId: string, catchments: CatchmentIndicators[]): void {
  const sites = loadLocalSites();
  if (sites.length === 0) return;

  const nextSites = sites.map((site) => {
    if (site.id !== siteId) return site;
    return {
      ...site,
      catchments,
      updatedAt: new Date().toISOString(),
    };
  });

  saveLocalSites(sortSitesByCreatedAtDesc(nextSites));
}

function generateSiteId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function fetchJSON<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function useServerInfo() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJSON<ServerInfo>(`${API_BASE}/info`)
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, []);

  return { info, error };
}

export interface DatapackDownloadInfo {
  available: boolean;
  filename?: string;
  size_bytes?: number;
}

export function useDatapackDownloadInfo() {
  const [downloadInfo, setDownloadInfo] = useState<DatapackDownloadInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<DatapackDownloadInfo>(`${API_BASE}/datapack/download-info`)
      .then((info) => { setDownloadInfo(info); setLoading(false); })
      .catch(() => { setDownloadInfo({ available: false }); setLoading(false); });
  }, []);

  return { downloadInfo, loading };
}

export interface ExecutablePlatformInfo {
  available: boolean;
  filename?: string;
  size_bytes?: number;
}

export interface ExecutablesInfo {
  windows: ExecutablePlatformInfo;
  linux: ExecutablePlatformInfo;
  macos: ExecutablePlatformInfo;
}

export function useExecutablesInfo() {
  const [executablesInfo, setExecutablesInfo] = useState<ExecutablesInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<ExecutablesInfo>(`${API_BASE}/executables/info`)
      .then((info) => { setExecutablesInfo(info); setLoading(false); })
      .catch(() => {
        setExecutablesInfo({ windows: { available: false }, linux: { available: false }, macos: { available: false } });
        setLoading(false);
      });
  }, []);

  return { executablesInfo, loading };
}

export function useColumns() {
  const [columns, setColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<string[]>(`${API_BASE}/columns`)
      .then((cols) => {
        setColumns(cols || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { columns, loading };
}

export function useAttributeColors() {
  const [colors, setColors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, string>>(`${API_BASE}/metadata/colors`)
      .then((data) => {
        setColors(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { colors, loading };
}

export function useAttributeDetails() {
  const [details, setDetails] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, string>>(`${API_BASE}/metadata/details`)
      .then((data) => {
        setDetails(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { details, loading };
}

export function useAttributeVariableTypes() {
  const [variableTypes, setVariableTypes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, string>>(`${API_BASE}/metadata/variabletypes`)
      .then((data) => {
        setVariableTypes(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { variableTypes, loading };
}

export function useAttributeUserInputs() {
  const [userInputs, setUserInputs] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, boolean>>(`${API_BASE}/metadata/inputs`)
      .then((data) => {
        setUserInputs(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { userInputs, loading };
}

export function useAttributeTargetInputs() {
  const [targetInputs, setTargetInputs] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, boolean>>(`${API_BASE}/metadata/targetinputs`)
      .then((data) => {
        setTargetInputs(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { targetInputs, loading };
}

export function useAttributeCanMap() {
  const [canMap, setCanMap] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, boolean>>(`${API_BASE}/metadata/canmap`)
      .then((data) => {
        setCanMap(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { canMap, loading };
}

export function useAttributeAxisLabels() {
  const [axisLabels, setAxisLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, string>>(`${API_BASE}/metadata/axislabels`)
      .then((data) => {
        setAxisLabels(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { axisLabels, loading };
}

export function useAttributeXAxisLabels() {
  const [xAxisLabels, setXAxisLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, string>>(`${API_BASE}/metadata/xaxislabels`)
      .then((data) => {
        setXAxisLabels(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { xAxisLabels, loading };
}

export function useAttributeUnits() {
  const [units, setUnits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, string>>(`${API_BASE}/metadata/units`)
      .then((data) => {
        setUnits(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { units, loading };
}

export interface TargetRange {
  min?: number | null;
  max?: number | null;
}

export function useAttributeTargetRanges() {
  const [targetRanges, setTargetRanges] = useState<Record<string, TargetRange>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, TargetRange>>(`${API_BASE}/metadata/targetranges`)
      .then((data) => {
        setTargetRanges(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { targetRanges, loading };
}

export function useAttributeCanGraph() {
  const [canGraph, setCanGraph] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, boolean>>(`${API_BASE}/metadata/cangraph`)
      .then((data) => {
        setCanGraph(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { canGraph, loading };
}

export function useAttributeDial0Middle() {
  const [dial0Middle, setDial0Middle] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, boolean>>(`${API_BASE}/metadata/dial0middle`)
      .then((data) => {
        setDial0Middle(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { dial0Middle, loading };
}

export function useAttributeChartTypes() {
  const [chartTypes, setChartTypes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, string>>(`${API_BASE}/metadata/charttypes`)
      .then((data) => {
        setChartTypes(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { chartTypes, loading };
}

export function useAttributeGroupingVariables() {
  const [groupingVariables, setGroupingVariables] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, string>>(`${API_BASE}/metadata/groupingvariables`)
      .then((data) => {
        setGroupingVariables(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { groupingVariables, loading };
}

export function useAttributeGroupingValues() {
  const [groupingValues, setGroupingValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Record<string, string>>(`${API_BASE}/metadata/groupingvalues`)
      .then((data) => {
        setGroupingValues(data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { groupingValues, loading };
}

export interface DrilldownComponent {
  column: string;
  label: string;
  color: string;
  chartType: string;
}

export interface DrilldownGroup {
  components: DrilldownComponent[];
}

export interface DrilldownAxisGroup {
  units: string;
  groups: Record<string, DrilldownGroup>;
}

export interface DrilldownEntry {
  variableType: string;
  axisGroups: Record<string, DrilldownAxisGroup>;
}

export function useScenarios() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<Scenario[]>(`${API_BASE}/scenarios`)
      .then((s) => {
        setScenarios(s || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { scenarios, loading };
}

export function useScenarioData(scenario: Scenario, attribute: string) {
  const [data, setData] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!attribute) return;

    setLoading(true);
    setError(null);

    try {
      const result = await fetchJSON<Record<string, number>>(
        `${API_BASE}/scenario/${scenario}/${attribute}`
      );
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [scenario, attribute]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error };
}

export function useComparisonData(
  left: Scenario,
  right: Scenario,
  attribute: string
) {
  const [data, setData] = useState<Record<string, [number, number]> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!attribute) return;

    setLoading(true);
    setError(null);

    try {
      const result = await fetchJSON<Record<string, [number, number]>>(
        `${API_BASE}/compare?left=${left}&right=${right}&attribute=${attribute}`
      );
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [left, right, attribute]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error };
}

// Site management hooks
export function useSites() {
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSites = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listSites();
      setSites(result || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSites();
  }, [fetchSites]);

  return { sites, loading, error, refetch: fetchSites };
}

// Walkthrough demo sites live as static JSON under data/walkthroughs/ rather
// than in the site store (localStorage in browser runtime, data/sites/ in
// webview runtime), so they must be fetched separately and merged into every
// listSites() result — otherwise a walkthrough only appears once its tour has
// been run and it happens to get written into localStorage (browser only;
// webview never persists it to disk at all). Cached for the session since the
// static files don't change at runtime.
let _walkthroughSitesPromise: Promise<Site[]> | null = null;

// Walkthrough JSON files bake in a precomputed `indicators` aggregate that
// can go stale relative to the aggregation formula (e.g. after a formula
// fix) — unlike a real site, there's no "re-extract" action available to
// refresh a read-only demo site. Recompute it live from the embedded
// per-catchment breakdown on every load instead, so it can never drift.
export function normalizeWalkthroughSite(site: Site): Site {
  const embedded = (site as SiteWithCatchments).catchments
    ?? (site as SiteWithCatchments).catchmentIndicators
    ?? (site as SiteWithCatchments).catchmentData;
  if (!Array.isArray(embedded) || embedded.length === 0 || !site.indicators) return site;
  return { ...site, indicators: applyAOIWeightedIndicators(site.indicators, embedded) };
}

async function loadWalkthroughSite(id: string): Promise<Site | null> {
  try {
    const site = await fetchJSON<Site>(`/data/walkthroughs/${id}.json`);
    return normalizeWalkthroughSite({ ...site, source: 'walkthrough' });
  } catch {
    return null;
  }
}

function loadWalkthroughSites(): Promise<Site[]> {
  if (!_walkthroughSitesPromise) {
    _walkthroughSitesPromise = Promise.all(WALKTHROUGH_SITE_IDS.map(loadWalkthroughSite))
      .then((sites) => sites.filter((site) => site !== null));
  }
  return _walkthroughSitesPromise;
}

export async function listSites(): Promise<Site[]> {
  const [realSites, walkthroughSites] = await Promise.all([
    isBrowserRuntime() ? loadLocalSites() : fetchJSON<Site[]>(`${API_BASE}/sites`),
    loadWalkthroughSites(),
  ]);

  // A walkthrough already persisted into the real site list (e.g. the browser
  // ran its tour before, resetting ideal targets along the way) takes
  // precedence over the freshly-fetched static copy.
  const realSiteIds = new Set(realSites.map((site) => site.id));
  const merged = [...realSites, ...walkthroughSites.filter((site) => !realSiteIds.has(site.id))];
  return sortSitesByCreatedAtDesc(merged);
}

// Promise-level deduplication caches: concurrent callers (e.g. all 4 quad-view panes)
// share a single in-flight request rather than firing N identical network calls.
const CACHE_TTL_MS = 30_000;
const _siteCache = new Map<string, { promise: Promise<Site | null>; ts: number }>();
const _catchmentsCache = new Map<string, { promise: Promise<CatchmentIndicators[]>; ts: number }>();

// Walkthrough demo sites embed their own per-catchment breakdown directly in
// the static JSON they're loaded from (they were never created through the
// site store, so there's nothing on the server to fetch it from in webview
// runtime — GET /sites/{id}/catchments 404s just like the indicators PATCH
// did). Seed the same cache getSiteCatchments reads from, so every consumer
// (table/chart/dial views) gets data with no network round trip at all.
export function primeSiteCatchmentsFromEmbedded(site: Site): void {
  const embedded = (site as SiteWithCatchments).catchments
    ?? (site as SiteWithCatchments).catchmentIndicators
    ?? (site as SiteWithCatchments).catchmentData;
  if (Array.isArray(embedded) && embedded.length > 0) {
    _catchmentsCache.set(site.id, { promise: Promise.resolve(embedded), ts: Date.now() });
  }
}

export async function getSite(id: string): Promise<Site | null> {
  const now = Date.now();
  const hit = _siteCache.get(id);
  if (hit && now - hit.ts < CACHE_TTL_MS) return hit.promise;

  const promise = (async (): Promise<Site | null> => {
    if (isBrowserRuntime()) {
      const sites = loadLocalSites();
      return sites.find((site) => site.id === id) || null;
    }
    const response = await fetch(`${API_BASE}/sites/${id}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Failed to fetch site: ${response.statusText}`);
    return response.json();
  })();

  // Evict on error so next caller retries cleanly.
  promise.catch(() => _siteCache.delete(id));
  evictExpired(_siteCache, CACHE_TTL_MS, now);
  _siteCache.set(id, { promise, ts: now });
  return promise;
}

export async function createSite(
  data: Partial<Site>
): Promise<Site> {
  if (isBrowserRuntime()) {
    const now = new Date().toISOString();
    const site: Site = {
      id: generateSiteId(),
      title: data.title || 'Untitled Site',
      description: data.description || '',
      thumbnail: data.thumbnail ?? null,
      createdAt: now,
      updatedAt: now,
      paneStates: structuredClone(DEFAULT_PANE_STATES),
      layoutMode: 'single',
      quadColumns: 3,
      ...data,
      appRuntime: 'browser',
    };

    const sites = loadLocalSites();
    sites.push(site);
    if (!saveLocalSites(sortSitesByCreatedAtDesc(sites))) {
      throw new Error('Browser storage is full — delete some existing sites and try again.');
    }

    // Preload and persist per-catchment scenario details so site aggregate
    // views can render immediately from localStorage.
    if (Array.isArray(site.catchmentIds) && site.catchmentIds.length > 0) {
      try {
        const { thumbnail, ...siteWithoutThumbnail } = site;
        const response = await fetch(`${API_BASE}/sites/${site.id}/catchments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runtime: 'browser', site: siteWithoutThumbnail }),
        });
        if (response.ok) {
          const catchments = await response.json();
          if (Array.isArray(catchments) && catchments.length > 0) {
            persistLocalCatchments(site.id, catchments);
          }
        }
      } catch {
        // Keep site creation successful even if preloading catchments fails.
      }
    }

    return site;
  }

  const response = await fetch(`${API_BASE}/sites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paneStates: structuredClone(DEFAULT_PANE_STATES),
      layoutMode: 'single',
      quadColumns: 3,
      ...data,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create site: ${response.statusText}`);
  }
  return response.json();
}

export async function updateSite(
  id: string,
  data: Partial<Site>
): Promise<Site> {
  if (isBrowserRuntime()) {
    const sites = loadLocalSites();
    const siteIndex = sites.findIndex((site) => site.id === id);
    if (siteIndex < 0) {
      throw new Error('Failed to update site: not found');
    }

    const existingSite = sites[siteIndex];
    const updatedSite: Site = {
      ...existingSite,
      ...data,
      id: existingSite.id,
      createdAt: existingSite.createdAt,
      updatedAt: new Date().toISOString(),
      appRuntime: existingSite.appRuntime || 'browser',
    };

    sites[siteIndex] = updatedSite;
    if (!saveLocalSites(sortSitesByCreatedAtDesc(sites))) {
      throw new Error('Browser storage is full — delete some existing sites and try again.');
    }
    return updatedSite;
  }

  const response = await fetch(`${API_BASE}/sites/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(`Failed to update site: ${response.statusText}`);
  }
  return response.json();
}

export async function patchSite(
  id: string,
  data: Partial<Site>
): Promise<Site> {
  if (isBrowserRuntime()) {
    return updateSite(id, data);
  }

  const response = await fetch(`${API_BASE}/sites/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(`Failed to update site: ${response.statusText}`);
  }
  return response.json();
}

export async function patchSiteIndicators(
  id: string,
  indicators: Site['indicators'],
  site?: Site
): Promise<Site> {
  // Walkthrough demo sites are loaded straight from a static JSON file and
  // were never created through the site store, so h.siteStore.Get(id) on the
  // backend 404s for them. Route these through the same "runtime: browser"
  // path real browser-runtime sessions use: the backend recalculates
  // cascades from the site payload in the request body instead of loading
  // it from data/sites/, and the result is never persisted to disk.
  if (site?.source === 'walkthrough') {
    const { thumbnail, ...siteWithoutThumbnail } = site;
    const response = await fetch(`${API_BASE}/sites/${id}/indicators`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runtime: 'browser',
        site: siteWithoutThumbnail,
        ideal: indicators?.ideal,
        idealLower: indicators?.idealLower,
        idealUpper: indicators?.idealUpper,
        reference: indicators?.reference,
        referenceLower: indicators?.referenceLower,
        referenceUpper: indicators?.referenceUpper,
        current: indicators?.current,
        currentLower: indicators?.currentLower,
        currentUpper: indicators?.currentUpper,
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to update site indicators: ${response.statusText}`);
    }
    _catchmentsCache.delete(id);
    return response.json();
  }

  if (isBrowserRuntime()) {
    const localSite = loadLocalSite(id);
    if (localSite) {
      try {
        const { thumbnail, ...siteWithoutThumbnail } = localSite;
        const response = await fetch(`${API_BASE}/sites/${id}/indicators`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runtime: 'browser',
            site: siteWithoutThumbnail,
            ideal: indicators?.ideal,
            idealLower: indicators?.idealLower,
            idealUpper: indicators?.idealUpper,
            reference: indicators?.reference,
            referenceLower: indicators?.referenceLower,
            referenceUpper: indicators?.referenceUpper,
            current: indicators?.current,
            currentLower: indicators?.currentLower,
            currentUpper: indicators?.currentUpper,
          }),
        });
        if (response.ok) {
          const updatedSite = await response.json() as SiteWithCatchments;
          if (Array.isArray(updatedSite.catchments) && updatedSite.catchments.length > 0) {
            persistLocalCatchments(id, updatedSite.catchments);
            _catchmentsCache.delete(id);
          }
          return updateSite(id, { indicators: updatedSite.indicators });
        }
      } catch {
        // Fall through to local-only update
      }
    }
    return updateSite(id, { indicators });
  }

  const response = await fetch(`${API_BASE}/sites/${id}/indicators`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ideal: indicators?.ideal,
      idealLower: indicators?.idealLower,
      idealUpper: indicators?.idealUpper,
      reference: indicators?.reference,
      referenceLower: indicators?.referenceLower,
      referenceUpper: indicators?.referenceUpper,
      current: indicators?.current,
      currentLower: indicators?.currentLower,
      currentUpper: indicators?.currentUpper,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to update site indicators: ${response.statusText}`);
  }
  _catchmentsCache.delete(id);
  return response.json();
}

export async function deleteSite(id: string): Promise<void> {
  if (isBrowserRuntime()) {
    const sites = loadLocalSites();
    const nextSites = sites.filter((site) => site.id !== id);
    saveLocalSites(sortSitesByCreatedAtDesc(nextSites));
    return;
  }

  const response = await fetch(`${API_BASE}/sites/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(`Failed to delete site: ${response.statusText}`);
  }
}

// Get per-catchment breakdown data for a site
export async function getSiteCatchments(siteId: string): Promise<CatchmentIndicators[]> {
  const now = Date.now();
  const hit = _catchmentsCache.get(siteId);
  if (hit && now - hit.ts < CACHE_TTL_MS) return hit.promise;

  const promise = (async (): Promise<CatchmentIndicators[]> => {
    if (isBrowserRuntime()) {
      const localCatchments = loadLocalCatchments(siteId);
      if (localCatchments.length > 0) {
        return localCatchments;
      }

      try {
        const localSite = loadLocalSite(siteId);
        if (localSite) {
          const { thumbnail, ...siteWithoutThumbnail } = localSite;
          const response = await fetch(`${API_BASE}/sites/${siteId}/catchments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runtime: 'browser', site: siteWithoutThumbnail }),
          });
          if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data) && data.length > 0) {
              persistLocalCatchments(siteId, data);
              return data;
            }
          }
        }
      } catch {
        // Fall through to GET fallback below.
      }

      // Fallback for browser runtime when local storage is missing stale/incomplete.
      try {
        const response = await fetch(`${API_BASE}/sites/${siteId}/catchments`);
        if (!response.ok) return [];
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
          persistLocalCatchments(siteId, data);
        }
        return Array.isArray(data) ? data : [];
      } catch {
        return [];
      }
    }

    const response = await fetch(`${API_BASE}/sites/${siteId}/catchments`);
    if (!response.ok) {
      throw new Error(`Failed to get site catchments: ${response.statusText}`);
    }
    const data = await response.json();
    if (Array.isArray(data) && data.length > 0) {
      persistLocalCatchments(siteId, data);
    }
    return data;
  })();

  promise.catch(() => _catchmentsCache.delete(siteId));
  evictExpired(_catchmentsCache, CACHE_TTL_MS, now);
  _catchmentsCache.set(siteId, { promise, ts: now });
  return promise;
}

// Slim cache: keyed by siteId, returns only id+areaKm2+aoiFraction for MapView AOI filtering.
const _aOIFractionsCache = new Map<string, { promise: Promise<{ id: string; areaKm2: number; aoiFraction?: number }[]>; ts: number }>();

export async function getSiteAOIFractions(siteId: string): Promise<{ id: string; areaKm2: number; aoiFraction?: number }[]> {
  const now = Date.now();
  const hit = _aOIFractionsCache.get(siteId);
  if (hit && now - hit.ts < CACHE_TTL_MS) return hit.promise;

  const promise = (async (): Promise<{ id: string; areaKm2: number; aoiFraction?: number }[]> => {
    // Browser-runtime sites (and walkthrough demos) live in localStorage/embedded
    // JSON and were never created through the server-side site store, so a plain
    // GET .../catchments 404s just like it does elsewhere in browser runtime.
    // getSiteCatchments already knows how to resolve this (local cache, primed
    // walkthrough cache, or POSTing the site body for server-side computation),
    // so reuse it instead of duplicating that fetch logic here.
    if (isBrowserRuntime()) {
      const catchments = await getSiteCatchments(siteId).catch(() => []);
      return catchments.map((c) => ({ id: c.id, areaKm2: c.areaKm2, aoiFraction: c.aoiFraction }));
    }

    try {
      const response = await fetch(`${API_BASE}/sites/${siteId}/catchments?slim=true`);
      if (!response.ok) return [];
      return await response.json();
    } catch {
      return [];
    }
  })();

  promise.catch(() => _aOIFractionsCache.delete(siteId));
  evictExpired(_aOIFractionsCache, CACHE_TTL_MS, now);
  _aOIFractionsCache.set(siteId, { promise, ts: now });
  return promise;
}

// FullDomainData holds precomputed area-weighted means for all attributes
// across the entire dataset for reference and current scenarios.
export interface FullDomainData {
  reference: Record<string, number>;
  current: Record<string, number>;
}

// Fetch precalculated full-domain averages once on mount. The backend caches
// the result after the first computation so all subsequent calls return instantly.
export function useFullDomainPrecalculated() {
  const [data, setData] = useState<FullDomainData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJSON<FullDomainData>(`${API_BASE}/precalculate/full`)
      .then((result) => {
        setData(result);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { data, loading };
}

export type WhiskerBoundsResponse = {
  referenceUpper: Record<string, number>;
  referenceLower: Record<string, number>;
  currentUpper: Record<string, number>;
  currentLower: Record<string, number>;
};

type WhiskerCSVData = {
  currentUpper: Record<string, Record<string, number>>;
  currentLower: Record<string, Record<string, number>>;
  referenceUpper: Record<string, Record<string, number>>;
  referenceLower: Record<string, Record<string, number>>;
};

function normalizeCatchmentId(id: string): string {
  return String(id).trim().replace(/\.0$/, '');
}

function hasWhiskerData(bounds: WhiskerBoundsResponse | null | undefined): boolean {
  if (!bounds) return false;
  return Object.keys(bounds.referenceUpper || {}).length > 0
    || Object.keys(bounds.referenceLower || {}).length > 0
    || Object.keys(bounds.currentUpper || {}).length > 0
    || Object.keys(bounds.currentLower || {}).length > 0;
}

async function loadWhiskerCSVFile(filename: string): Promise<Record<string, Record<string, number>>> {
  try {
    const response = await fetch(`/data/${filename}`);
    if (!response.ok) return {};

    const text = await response.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return {};

    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const catchIdIndex = headers.findIndex((h) => h.toLowerCase() === 'catchid');
    if (catchIdIndex === -1) return {};

    const data: Record<string, Record<string, number>> = {};

    for (let i = 1; i < lines.length; i += 1) {
      const values = lines[i].split(',');
      if (values.length !== headers.length) continue;

      const rawId = values[catchIdIndex].trim().replace(/^"|"$/g, '');
      const catchId = normalizeCatchmentId(rawId);
      if (!catchId || catchId.toUpperCase() === 'NA') continue;

      const row: Record<string, number> = {};
      for (let j = 0; j < headers.length; j += 1) {
        if (j === catchIdIndex) continue;
        const rawVal = values[j].trim().replace(/^"|"$/g, '');
        if (!rawVal || rawVal.toUpperCase() === 'NA') continue;
        const num = Number(rawVal);
        if (Number.isFinite(num)) row[headers[j]] = num;
      }
      data[catchId] = row;
    }

    return data;
  } catch {
    return {};
  }
}

async function loadWhiskerCSVData(): Promise<WhiskerCSVData | null> {
  const [currentUpper, currentLower, referenceUpper, referenceLower] = await Promise.all([
    loadWhiskerCSVFile('current_upper.csv'),
    loadWhiskerCSVFile('current_lower.csv'),
    loadWhiskerCSVFile('reference_upper.csv'),
    loadWhiskerCSVFile('reference_lower.csv'),
  ]);

  const hasAny = Object.keys(currentUpper).length > 0
    || Object.keys(currentLower).length > 0
    || Object.keys(referenceUpper).length > 0
    || Object.keys(referenceLower).length > 0;

  if (!hasAny) return null;
  return { currentUpper, currentLower, referenceUpper, referenceLower };
}

function computeWhiskerBoundsFromCSV(
  catchments: CatchmentIndicators[],
  csvData: WhiskerCSVData,
): WhiskerBoundsResponse | null {
  if (!Array.isArray(catchments) || catchments.length === 0) return null;

  let totalArea = 0;
  const weightedCatchments = catchments
    .map((c) => {
      const frac = typeof c.aoiFraction === 'number' && c.aoiFraction > 0 && c.aoiFraction <= 1 ? c.aoiFraction : 1;
      const area = c.areaKm2 * frac;
      return { id: normalizeCatchmentId(c.id), area };
    })
    .filter((c) => Number.isFinite(c.area) && c.area > 0);

  for (const c of weightedCatchments) totalArea += c.area;
  if (!(totalArea > 0)) return null;

  const compute = (source: Record<string, Record<string, number>>): Record<string, number> => {
    const sums: Record<string, number> = {};
    const weights: Record<string, number> = {};

    for (const c of weightedCatchments) {
      const row = source[c.id];
      if (!row) continue;
      const weight = c.area / totalArea;
      for (const [col, val] of Object.entries(row)) {
        if (!Number.isFinite(val)) continue;
        sums[col] = (sums[col] ?? 0) + val * weight;
        weights[col] = (weights[col] ?? 0) + weight;
      }
    }

    const out: Record<string, number> = {};
    for (const [col, sum] of Object.entries(sums)) {
      const w = weights[col] ?? 0;
      if (w > 0) out[col] = sum / w;
    }
    return out;
  };

  return {
    referenceUpper: compute(csvData.referenceUpper),
    referenceLower: compute(csvData.referenceLower),
    currentUpper: compute(csvData.currentUpper),
    currentLower: compute(csvData.currentLower),
  };
}

// Module-level cache for whisker bounds, keyed by siteId. ComputeWhiskerBounds
// on the backend is a full-table scan-and-join across 4 scenario tables for
// every catchment in the site (several seconds for a large site), and the
// server only persists its own cache for GET-based (webview) requests - POST
// requests (browser runtime, see below) are never cached server-side since
// the site data comes from the request body, not the site store. Without a
// client-side cache, every ChartView mount - which happens on every quad-view
// pane switch, since the effect below re-runs whenever `visible` flips true -
// re-triggers that full computation from scratch. Caching here means only the
// first mount per site pays the cost; the rest read from memory instantly.
// TTL is generous since whisker bounds only change if the site's catchment
// geometry changes (editing the boundary), not on scenario/attribute/target
// changes, which are comparatively rare mid-session.
const _whiskerCache = new Map<string, { promise: Promise<WhiskerBoundsResponse | null>; ts: number }>();
const WHISKER_CACHE_TTL_MS = 5 * 60_000;

export function clearSiteWhiskerCache(siteId: string): void {
  _whiskerCache.delete(siteId);
}

export async function getSiteWhiskerBounds(siteId: string): Promise<WhiskerBoundsResponse | null> {
  const now = Date.now();
  const hit = _whiskerCache.get(siteId);
  if (hit && now - hit.ts < WHISKER_CACHE_TTL_MS) return hit.promise;

  const promise = fetchSiteWhiskerBounds(siteId);
  // Only cache genuine successes - an empty/failed result must stay
  // retryable (see ChartView's fetchWhiskersWithRetry), not get stuck
  // serving the same failure for the full TTL.
  promise.then(
    (result) => { if (!hasWhiskerData(result)) _whiskerCache.delete(siteId); },
    () => _whiskerCache.delete(siteId)
  );
  evictExpired(_whiskerCache, WHISKER_CACHE_TTL_MS, now);
  _whiskerCache.set(siteId, { promise, ts: now });
  return promise;
}

async function fetchSiteWhiskerBounds(siteId: string): Promise<WhiskerBoundsResponse | null> {
  const csvFallback = async (): Promise<WhiskerBoundsResponse | null> => {
    const catchments = await getSiteCatchments(siteId).catch(() => []);
    if (!Array.isArray(catchments) || catchments.length === 0) return null;
    const csvData = await loadWhiskerCSVData();
    if (!csvData) return null;
    const computed = computeWhiskerBoundsFromCSV(catchments, csvData);
    return hasWhiskerData(computed) ? computed : null;
  };

  if (isBrowserRuntime()) {
    const localSite = loadLocalSite(siteId);
    if (localSite) {
      const { thumbnail, ...siteWithoutThumbnail } = localSite;
      void thumbnail;
      try {
        const response = await fetch(`${API_BASE}/sites/${siteId}/whiskers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runtime: 'browser', site: siteWithoutThumbnail }),
        });
        if (response.ok) {
          const data = await response.json() as WhiskerBoundsResponse;
          if (hasWhiskerData(data)) return data;
        }
      } catch {
        // fall through to GET fallback below
      }
    }

    // Fallback for browser runtime when local storage is empty or POST fails.
    try {
      const response = await fetch(`${API_BASE}/sites/${siteId}/whiskers`);
      if (response.ok) {
        const data = await response.json() as WhiskerBoundsResponse;
        if (hasWhiskerData(data)) return data;
      }
      return await csvFallback();
    } catch {
      return await csvFallback();
    }
  }

  try {
    const response = await fetch(`${API_BASE}/sites/${siteId}/whiskers`);
    if (response.ok) {
      const data = await response.json() as WhiskerBoundsResponse;
      if (hasWhiskerData(data)) return data;
    }
    return await csvFallback();
  } catch {
    return await csvFallback();
  }
}

// Load whisker data for boxplots
export function useWhiskerData() {
  const [whiskerData, setWhiskerData] = useState<{
    currentUpper: Record<string, Record<string, number>>;
    currentLower: Record<string, Record<string, number>>;
    referenceUpper: Record<string, Record<string, number>>;
    referenceLower: Record<string, Record<string, number>>;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadWhiskerCSV = async (filename: string): Promise<Record<string, Record<string, number>>> => {
      try {
        const response = await fetch(`/data/${filename}`);
        if (!response.ok) {
          console.warn(`Failed to load ${filename}`);
          return {};
        }
        const text = await response.text();
        const lines = text.trim().split('\n');
        if (lines.length < 2) return {};

        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        const catchIdIndex = headers.findIndex(h => h.toLowerCase().includes('catchid') || h === 'catchID');

        if (catchIdIndex === -1) return {};

        const data: Record<string, Record<string, number>> = {};

        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',');
          if (values.length !== headers.length) continue;

          const catchId = values[catchIdIndex].trim();
          if (!catchId || catchId === 'NA') continue;

          data[catchId] = {};
          for (let j = 0; j < headers.length; j++) {
            if (j === catchIdIndex) continue;
            const val = parseFloat(values[j]);
            if (!isNaN(val)) {
              data[catchId][headers[j]] = val;
            }
          }
        }

        return data;
      } catch (error) {
        console.error(`Error loading ${filename}:`, error);
        return {};
      }
    };

    Promise.all([
      loadWhiskerCSV('current_upper.csv'),
      loadWhiskerCSV('current_lower.csv'),
      loadWhiskerCSV('reference_upper.csv'),
      loadWhiskerCSV('reference_lower.csv'),
    ]).then(([currentUpper, currentLower, referenceUpper, referenceLower]) => {
      setWhiskerData({ currentUpper, currentLower, referenceUpper, referenceLower });
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  }, []);

  return { whiskerData, loading };
}
