import type { SiteIndicators } from '../types';

function normalizeAreaKm2(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeAOIFraction(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
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

// AggregateTable-compatible weighting for one attribute: weighted =
// sum(value * validArea) / sum(validArea), where the sums only include
// catchments that actually have a numeric value for this attribute/scenario.
// A catchment missing the value is excluded entirely (not treated as a real
// 0) — otherwise its area still counts toward the denominator with an
// implicit 0 contribution, silently dragging the average toward 0 whenever a
// few catchments lack this particular attribute.
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

  let weightedSum = 0;
  let totalValidArea = 0;

  for (const catchment of catchments) {
    const values = scenario === 'reference' ? catchment.reference
      : scenario === 'ideal' ? (catchment.ideal ?? catchment.reference)
      : catchment.current;
    const raw = values?.[attribute];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;

    const areaKm2 = normalizeAreaKm2(catchment.areaKm2);
    const fraction = normalizeAOIFraction(catchment.aoiFraction);
    const validArea = areaKm2 * fraction;
    if (!(validArea > 0)) continue;

    weightedSum += raw * validArea;
    totalValidArea += validArea;
  }

  if (!(totalValidArea > 0)) return undefined;
  return weightedSum / totalValidArea;
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

  // Target starts as a copy of current (falling back to reference for keys
  // with no current data), matching the same convention used everywhere else
  // — not a copy of reference.
  const hasReference = Object.keys(reference).length > 0;
  const hasCurrent = Object.keys(current).length > 0;
  const ideal = hasCurrent
    ? { ...reference, ...current }
    : hasReference ? { ...reference } : base.ideal;

  return {
    ...base,
    reference: hasReference ? reference : base.reference,
    // Preserve bound maps from backend/whisker computation; only recompute means here.
    referenceLower: base.referenceLower,
    referenceUpper: base.referenceUpper,
    current: hasCurrent ? current : base.current,
    ideal,
    idealLower: base.idealLower,
    idealUpper: base.idealUpper,
    catchmentCount: catchments.length,
    totalAreaKm2,
  };
}
