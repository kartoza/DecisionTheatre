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
