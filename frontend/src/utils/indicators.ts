import type { SiteIndicators } from '../types';

export function computeAOIWeightedScenarioValues(
  catchments: Array<{
    areaKm2: number;
    aoiFraction?: number;
    reference: Record<string, number>;
    current: Record<string, number>;
  }>,
  scenario: 'reference' | 'current',
): Record<string, number> {
  const weightedSums = new Map<string, number>();
  const validAreaSums = new Map<string, number>();

  for (const catchment of catchments) {
    const areaKm2 = typeof catchment.areaKm2 === 'number' && Number.isFinite(catchment.areaKm2)
      ? catchment.areaKm2
      : 0;
    const fraction = typeof catchment.aoiFraction === 'number' && Number.isFinite(catchment.aoiFraction)
      ? Math.max(0, Math.min(1, catchment.aoiFraction))
      : 1;
    const validArea = areaKm2 * fraction;
    if (!(validArea > 0)) continue;

    const values = scenario === 'reference' ? catchment.reference : catchment.current;
    for (const [key, value] of Object.entries(values || {})) {
      if (typeof value !== 'number' || Number.isNaN(value)) continue;
      weightedSums.set(key, (weightedSums.get(key) ?? 0) + (value * validArea));
      validAreaSums.set(key, (validAreaSums.get(key) ?? 0) + validArea);
    }
  }

  const result: Record<string, number> = {};
  for (const [key, weightedSum] of weightedSums.entries()) {
    const keyValidArea = validAreaSums.get(key) ?? 0;
    if (keyValidArea > 0) {
      result[key] = weightedSum / keyValidArea;
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

  const totalAreaKm2 = catchments.reduce((sum, c) => {
    const areaKm2 = typeof c.areaKm2 === 'number' && Number.isFinite(c.areaKm2) ? c.areaKm2 : 0;
    const fraction = typeof c.aoiFraction === 'number' && Number.isFinite(c.aoiFraction)
      ? Math.max(0, Math.min(1, c.aoiFraction))
      : 1;
    return sum + (areaKm2 * fraction);
  }, 0);

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
