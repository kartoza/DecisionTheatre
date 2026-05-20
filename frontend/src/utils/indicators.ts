import type { SiteIndicators } from '../types';

function normalizeAreaKm2(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeAOIFraction(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 1;
}

function computeTotalValidArea(
  catchments: Array<{ areaKm2: number; aoiFraction?: number }>,
): number {
  return catchments.reduce((sum, catchment) => {
    const areaKm2 = normalizeAreaKm2(catchment.areaKm2);
    const fraction = normalizeAOIFraction(catchment.aoiFraction);
    return sum + (areaKm2 * fraction);
  }, 0);
}

// AggregateTable-compatible weighting for one attribute:
// weighted = sum((validArea / totalValidArea) * value), with missing value treated as 0.
export function computeAOIWeightedAttributeValue(
  catchments: Array<{
    areaKm2: number;
    aoiFraction?: number;
    reference: Record<string, number>;
    current: Record<string, number>;
    ideal?: Record<string, number>;
  }>,
  scenario: 'reference' | 'current' | 'ideal',
  attribute: string,
): number | undefined {
  if (!attribute || !Array.isArray(catchments) || catchments.length === 0) return undefined;

  const totalValidArea = computeTotalValidArea(catchments);
  if (!(totalValidArea > 0)) return undefined;

  let weightedSum = 0;

  for (const catchment of catchments) {
    const areaKm2 = normalizeAreaKm2(catchment.areaKm2);
    const fraction = normalizeAOIFraction(catchment.aoiFraction);
    const validArea = areaKm2 * fraction;
    if (!(validArea > 0)) continue;

    const values = scenario === 'reference' ? catchment.reference
      : scenario === 'ideal' ? (catchment.ideal ?? catchment.reference)
      : catchment.current;
    const raw = values?.[attribute];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    weightedSum += (validArea / totalValidArea) * value;
  }

  return weightedSum;
}

export function computeAOIWeightedScenarioValues(
  catchments: Array<{
    areaKm2: number;
    aoiFraction?: number;
    reference: Record<string, number>;
    current: Record<string, number>;
  }>,
  scenario: 'reference' | 'current',
): Record<string, number> {
  const result: Record<string, number> = {};
  if (!Array.isArray(catchments) || catchments.length === 0) return result;

  const keys = new Set<string>();
  for (const catchment of catchments) {
    const values = scenario === 'reference' ? catchment.reference : catchment.current;
    for (const key of Object.keys(values || {})) {
      keys.add(key);
    }
  }

  for (const key of keys) {
    const value = computeAOIWeightedAttributeValue(catchments, scenario, key);
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = value;
    }
  }

  return result;
}

export function applyAOIWeightedIndicators(
  base: SiteIndicators,
  catchments: Array<{
    id: string;
    areaKm2: number;
    aoiFraction?: number;
    reference: Record<string, number>;
    current: Record<string, number>;
  }>,
): SiteIndicators {
  if (!Array.isArray(catchments) || catchments.length === 0) return base;

  const reference = computeAOIWeightedScenarioValues(catchments, 'reference');
  const current = computeAOIWeightedScenarioValues(catchments, 'current');
  if (Object.keys(reference).length === 0 && Object.keys(current).length === 0) return base;

  const totalAreaKm2 = computeTotalValidArea(catchments);

  return {
    ...base,
    reference: Object.keys(reference).length > 0 ? reference : base.reference,
    // Preserve bound maps from backend/whisker computation; only recompute means here.
    referenceLower: base.referenceLower,
    referenceUpper: base.referenceUpper,
    current: Object.keys(current).length > 0 ? current : base.current,
    ideal: Object.keys(reference).length > 0 ? { ...reference } : base.ideal,
    idealLower: base.idealLower,
    idealUpper: base.idealUpper,
    catchmentCount: catchments.length,
    totalAreaKm2,
    catchmentIds: catchments.map((c) => c.id),
  };
}
