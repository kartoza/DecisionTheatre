import type { SiteIndicators } from '../types';

/**
 * Which attributes a user may set a target value for, for a given site.
 *
 * Extracted from ContentArea when the grid-wide controls moved into the header:
 * the Targets button now lives in one place and the modal it opens in another,
 * and both have to agree about whether there is anything to edit. Two copies of
 * this filter chain would disagree the moment either was touched, and the
 * disagreement would present as a button that opens an empty dialog.
 *
 * The rules, in order:
 *
 *   - the attribute must be one the catalogue permits a target on
 *   - the site must have a value for it under ideal, reference or current
 *   - it must have a finite reference or current reading, since a target is
 *     meaningless without something to compare against
 *   - herbivore attributes additionally need a non-zero reading: zero there
 *     means the species is absent, not that it is at zero density
 *
 * Returned sorted by display label, deduplicated.
 */
export function editableTargetKeys(
  siteIndicators: SiteIndicators | null | undefined,
  targetInputs: Record<string, boolean>,
  variableTypes: Record<string, string>,
  attributeDetails: Record<string, string>,
): string[] {
  const availableKeys = new Set<string>();
  Object.keys(siteIndicators?.ideal ?? {}).forEach((k) => availableKeys.add(k));
  Object.keys(siteIndicators?.reference ?? {}).forEach((k) => availableKeys.add(k));
  Object.keys(siteIndicators?.current ?? {}).forEach((k) => availableKeys.add(k));

  const keys = Object.entries(targetInputs)
    .filter(([, allowed]) => allowed)
    .map(([key]) => key)
    .filter((key) => availableKeys.has(key))
    .filter((key) => {
      const refVal = siteIndicators?.reference?.[key];
      const curVal = siteIndicators?.current?.[key];
      return (typeof refVal === 'number' && Number.isFinite(refVal)) ||
        (typeof curVal === 'number' && Number.isFinite(curVal));
    })
    .filter((key) => {
      if (variableTypes[key] !== 'Herbivores') return true;
      const refVal = siteIndicators?.reference?.[key];
      const curVal = siteIndicators?.current?.[key];
      const refNum = typeof refVal === 'number' && Number.isFinite(refVal) ? refVal : 0;
      const curNum = typeof curVal === 'number' && Number.isFinite(curVal) ? curVal : 0;
      return refNum > 0 || curNum > 0;
    });

  return keys
    .filter((key, idx, arr) => arr.indexOf(key) === idx)
    .sort((a, b) => {
      const aLabel = attributeDetails[a] ?? a;
      const bLabel = attributeDetails[b] ?? b;
      return aLabel.localeCompare(bLabel);
    });
}
