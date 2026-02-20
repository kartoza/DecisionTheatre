import { useState, useEffect, useCallback } from 'react';
import type { Scenario, ServerInfo, Site } from '../types';
import { getAppRuntime } from '../types/runtime';

const API_BASE = '/api';
const SITES_STORAGE_KEY = 'dt-sites';

function isBrowserRuntime(): boolean {
  return getAppRuntime() === 'browser';
}

function loadLocalSites(): Site[] {
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

function saveLocalSites(sites: Site[]): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(SITES_STORAGE_KEY, JSON.stringify(sites));
  } catch {
    // Ignore localStorage write errors
  }
}

function sortSitesByCreatedAtDesc(sites: Site[]): Site[] {
  return [...sites].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
