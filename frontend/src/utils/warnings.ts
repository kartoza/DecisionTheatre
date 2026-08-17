type ToastFn = (options: Record<string, unknown>) => void;

const WARNING_NPP_GM2 = 'NPP_gm2';

const targetWarningMessages: Record<string, string> = {
  [WARNING_NPP_GM2]: 'Herbivore consumption is higher than available biomass',
};

export function showTargetWarningsPopup(warnings: string[] | undefined, toast: ToastFn): void {
  if (!warnings || warnings.length === 0) {
    return;
  }

  const popupMessages = warnings
    .map((warning) => targetWarningMessages[warning])
    .filter((message): message is string => Boolean(message));

  if (popupMessages.length === 0) {
    return;
  }

  const uniqueMessages = Array.from(new Set(popupMessages));
  for (const message of uniqueMessages) {
    toast({
      title: 'Warning',
      description: message,
      status: 'warning',
      duration: 8000,
      isClosable: true,
      position: 'top',
    });
  }
}

// Below this fraction of the app's known indicators resolving a reference-period
// value for a site, warn that the site sits mostly outside the dataset's covered area.
const LOW_DATA_AVAILABILITY_THRESHOLD = 0.2;

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
