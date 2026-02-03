import { useState, useEffect, useCallback } from 'react';
import type { Scenario, ServerInfo, Project } from '../types';

const API_BASE = '/api';

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

// Project management hooks
export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchJSON<Project[]>(`${API_BASE}/projects`);
      setProjects(result || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  return { projects, loading, error, refetch: fetchProjects };
}

export async function createProject(
  data: Partial<Project>
): Promise<Project> {
  const response = await fetch(`${API_BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(`Failed to create project: ${response.statusText}`);
  }
  return response.json();
}

export async function updateProject(
  id: string,
  data: Partial<Project>
): Promise<Project> {
  const response = await fetch(`${API_BASE}/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(`Failed to update project: ${response.statusText}`);
  }
  return response.json();
}

export async function deleteProject(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/projects/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(`Failed to delete project: ${response.statusText}`);
  }
}
