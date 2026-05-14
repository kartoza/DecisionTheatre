import { useState, useEffect, useCallback } from 'react';
import type { Scenario, ServerInfo, Site, CatchmentIndicators } from '../types';
import { getAppRuntime } from '../types/runtime';

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

export function saveLocalSites(sites: Site[]): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(SITES_STORAGE_KEY, JSON.stringify(sites));
  } catch {
    // Ignore localStorage write errors
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

export async function listSites(): Promise<Site[]> {
  if (isBrowserRuntime()) {
    return sortSitesByCreatedAtDesc(loadLocalSites());
  }

  return fetchJSON<Site[]>(`${API_BASE}/sites`);
}

export async function getSite(id: string): Promise<Site | null> {
  if (isBrowserRuntime()) {
    const sites = loadLocalSites();
    return sites.find((site) => site.id === id) || null;
  }

  const response = await fetch(`${API_BASE}/sites/${id}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch site: ${response.statusText}`);
  }
  return response.json();
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
      ...data,
      appRuntime: 'browser',
    };

    const sites = loadLocalSites();
    sites.push(site);
    saveLocalSites(sortSitesByCreatedAtDesc(sites));

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
    body: JSON.stringify(data),
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
    saveLocalSites(sortSitesByCreatedAtDesc(sites));
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
  indicators: Site['indicators']
): Promise<Site> {
  if (isBrowserRuntime()) {
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

export async function getSiteWhiskerBounds(siteId: string): Promise<WhiskerBoundsResponse | null> {
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
