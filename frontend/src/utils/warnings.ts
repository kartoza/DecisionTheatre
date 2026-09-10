type ToastFn = (options: Record<string, unknown>) => void;

const WARNING_NPP_GM2 = 'NPP_gm2';

const targetWarningMessages: Record<string, string> = {
  [WARNING_NPP_GM2]: 'Herbivore consumption is higher than available biomass',
};

/**
 * Shows a toast for each warning key that is newly active.
 *
 * `previouslyActive` is the set returned by the prior call (e.g. kept in a
 * ref by the caller). Live-update recalculation calls this once per PATCH
 * response, and a warning condition (e.g. grazing demand exceeding
 * available biomass) commonly stays true across many consecutive steps of
 * the same drag — most visibly while decreasing a factor back down, since
 * the condition doesn't clear until the value crosses the threshold.
 * Without this, every one of those responses re-toasted the same warning,
 * stacking duplicates. Comparing against what was already shown means a
 * warning fires once when it starts, stays silent while it persists, and
 * can fire again only after it has cleared and reoccurs.
 *
 * Returns the new active set so the caller can pass it back in next time.
 */
export function showTargetWarningsPopup(
  warnings: string[] | undefined,
  toast: ToastFn,
  previouslyActive?: ReadonlySet<string>,
): Set<string> {
  const active = new Set(warnings ?? []);

  for (const warning of active) {
    if (previouslyActive?.has(warning)) continue;
    const message = targetWarningMessages[warning];
    if (!message) continue;
    toast({
      title: 'Warning',
      description: message,
      status: 'warning',
      duration: 8000,
      isClosable: true,
      position: 'top',
    });
  }

  return active;
}

// Below this fraction of the app's known indicators resolving a reference-period
// value for a site, warn that the site sits mostly outside the dataset's covered area.
const LOW_DATA_AVAILABILITY_THRESHOLD = 0.2;

interface IndicatorMaps {
  reference?: Record<string, number>;
  current?: Record<string, number>;
  ideal?: Record<string, number>;
}

// Fraction of the app's known indicators that resolve both a reference and current
// value for a site. Mirrors IndicatorEditorPage's summary tiles: the denominator is
// every key the catalog (or the site itself) knows about, the numerator is how many
// of those a site actually has data for.
export function computeIndicatorAvailabilityFraction(
  indicators: IndicatorMaps | null | undefined,
  attributeDetails: Record<string, string>,
  variableTypes: Record<string, string>,
  userInputs: Record<string, boolean>,
): number | undefined {
  if (!indicators) return undefined;

  const allKeys = new Set<string>();
  Object.keys(indicators.reference || {}).forEach((k) => allKeys.add(k));
  Object.keys(indicators.current || {}).forEach((k) => allKeys.add(k));
  Object.keys(indicators.ideal || {}).forEach((k) => allKeys.add(k));
  Object.keys(attributeDetails || {}).forEach((k) => allKeys.add(k));
  Object.keys(variableTypes || {}).forEach((k) => allKeys.add(k));
  Object.keys(userInputs || {}).forEach((k) => allKeys.add(k));

  const keys = Array.from(allKeys)
    .filter((key) => key.trim() !== '' && key.toLowerCase() !== 'catchid' && key.toLowerCase() !== 'catchment_id');
  if (keys.length === 0) return undefined;

  const available = keys.filter((key) => {
    const ref = indicators.reference?.[key] ?? null;
    const cur = indicators.current?.[key] ?? null;
    return ref !== null && cur !== null;
  }).length;

  return available / keys.length;
}

export function showLowDataAvailabilityWarning(dataAvailability: number | undefined, toast: ToastFn): void {
  if (dataAvailability === undefined || dataAvailability >= LOW_DATA_AVAILABILITY_THRESHOLD) {
    return;
  }

  toast({
    title: 'Low data availability',
    description: `Only ${Math.round(dataAvailability * 100)}% of this site's indicators have `
      + 'reference-period data. Comparisons and other features may be sparse or unreliable for this site.',
    status: 'warning',
    duration: 8000,
    isClosable: true,
    position: 'top',
  });
}
