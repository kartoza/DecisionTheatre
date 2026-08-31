import { Accordion, AccordionButton, AccordionIcon, AccordionItem, AccordionPanel, Box, Button, Checkbox, FormControl, FormLabel, HStack, IconButton, Slide, Slider, SliderFilledTrack, SliderThumb, SliderTrack, Spinner, Tooltip, VStack, useToast } from '@chakra-ui/react';
import { FiChevronRight } from 'react-icons/fi';
import { motion, AnimatePresence } from 'framer-motion';
import ViewPane from './ViewPane';
import { navigationPaneIndex } from '../lib/navigationPane';
import { createRecalculationScheduler, loadLiveUpdatePreference, resolveLiveUpdate, saveLiveUpdatePreference } from '../lib/liveTargetUpdate';
import { DEFAULT_PANE_STATES } from '../types';
import type { LayoutMode, QuadColumns, PaneStates, IdentifyResult, MapExtent, MapStatistics, BoundingBox, ColorScaleMode, ColorScaleType, SiteIndicators, RangeMode, ViewMode } from '../types';
import { useAttributeDetails, useAttributeOrder, useAttributeTargetInputs, useAttributeTargetRanges, useAttributeUnits, useAttributeVariableTypes } from '../hooks/useApi';
import type { FullDomainData } from '../hooks/useApi';
import type { ScaleDerivation } from '../lib/dialScale';
import type { CalculationDetailsProps } from './CalculationDetails';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface ContentAreaProps {
  mode: LayoutMode;
  paneStates: PaneStates;
  viewModes: ViewMode[];
  onViewModeChange: (paneIndex: number, mode: ViewMode) => void;
  focusedPane: number;
  onFocusPane: (index: number) => void;
  onGoQuad: () => void;
  onOpenControlPanel?: (paneIndex: number) => void;
  onOpenChartDetails?: (
    paneIndex: number,
    derivation: ScaleDerivation | null,
    calculations: CalculationDetailsProps | null,
  ) => void;
  onRemovePane: (paneIndex: number) => void;
  onIdentify?: (result: IdentifyResult) => void;
  identifyResult?: IdentifyResult;
  onMapExtentChange?: (extent: MapExtent) => void;
  onStatisticsChange?: (stats: MapStatistics) => void;
  isPanelOpen?: boolean;
  siteId?: string | null;
  siteBounds?: BoundingBox | null;
  isBoundaryEditMode?: boolean;
  siteGeometry?: GeoJSON.Geometry | null;
  onBoundaryUpdate?: (geometry: GeoJSON.Geometry) => void;
  isSwiperEnabled?: boolean;
  colorScaleMode: ColorScaleMode;
  colorScaleType: ColorScaleType;
  is3DMode?: boolean;
  // Global map toggles: one control in the header, every pane reflects it.
  isIdentifyMode?: boolean;
  isChoroplethEnabled?: boolean;
  isGoogleBasemap?: boolean;
  onGoogleBasemapChange?: (enabled: boolean) => void;
  // Slider synchronization
  swiperPosition?: number;
  onSwiperPositionChange?: (position: number) => void;
  // Dial chart props
  siteIndicators?: SiteIndicators | null;
  rangeMode?: RangeMode;
  onRangeModeChange?: (mode: RangeMode) => void;
  mapStatistics?: MapStatistics | null;
  chartGroups?: (string | null)[];
  chartAxisLabelFilters?: (string | null)[];
  chartGraphModes?: ('line' | 'boxplot' | null)[];
  mapExtent?: MapExtent | null;
  onSiteIndicatorsChange?: (indicators: SiteIndicators) => Promise<void> | void;
  /**
   * Point every target at an observed scenario. Separate from
   * onSiteIndicatorsChange because a reset must not cascade — see
   * resetSiteIdeal in hooks/useApi.
   */
  onResetTargets?: (scenario: 'reference' | 'current') => Promise<void> | void;
  // For target panel control from parent
  isTargetModalOpen?: boolean;
  onCloseTargetModal?: () => void;
  refreshKey?: number;
  quadColumns?: QuadColumns;
  onQuadColumnsChange?: (cols: QuadColumns) => void;
  fullDomainData?: FullDomainData | null;
}

const paneVariants = {
  hidden: { opacity: 0, scale: 0.92 },
  visible: (i: number) => ({
    opacity: 1,
    scale: 1,
    transition: {
      delay: i * 0.1,
      duration: 0.5,
      ease: [0.16, 1, 0.3, 1],
    },
  }),
  exit: (_i: number) => ({
    opacity: 0,
    scale: 0.92,
    transition: {
      delay: 0,
      duration: 0.3,
      ease: [0.4, 0, 1, 1],
    },
  }),
};

/**
 * Every user-visible string the target editor owns, in one object — the same
 * arrangement GridControls uses, and for the same reason: there is no i18n
 * layer yet, and collecting the strings makes the eventual extraction
 * mechanical rather than a hunt through JSX.
 */
const STRINGS = {
  targetsHeading: 'Edit Target Values',
  closePanel: 'Close target editor',
  liveUpdate: 'Live update',
  liveUpdateHintOn:
    'Charts and sliders recalculate continuously while you drag. Best on small sites.',
  liveUpdateHintOff:
    'Charts and sliders recalculate once you let go of a slider. Best on large sites.',
  recalculating: 'Recalculating…',
  resetToReference: 'Reset to reference',
  resetToCurrent: 'Reset to current',
  resetToReferenceHint: 'Set every target to the ecological reference value',
  resetToCurrentHint: 'Set every target back to the current state, clearing all targets',
  resetConfirmReference: 'Set every target to the reference?',
  resetConfirmCurrent: 'Set every target back to current?',
  resetConfirmBody: 'This replaces the targets you have set.',
  resetConfirm: 'Reset',
  resetCancel: 'Cancel',
  resetUnavailable: 'No values to reset to',
  invalidTargetTitle: 'Invalid target value',
  invalidTargetBody: (label: string) => `Please enter a valid number for ${label}.`,
  updateFailed: 'Failed to update target values',
} as const;

function formatVariableType(value: string): string {
  return value
    .replace(/_/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function ContentArea({
  mode,
  paneStates,
  viewModes,
  onViewModeChange,
  focusedPane,
  onFocusPane,
  onGoQuad,
  onOpenControlPanel,
  onOpenChartDetails,
  onRemovePane,
  onIdentify,
  identifyResult,
  onMapExtentChange,
  onStatisticsChange,
  isPanelOpen,
  siteId,
  siteBounds,
  isBoundaryEditMode,
  siteGeometry,
  onBoundaryUpdate,
  isSwiperEnabled,
  colorScaleMode,
  colorScaleType,
  is3DMode,
  isIdentifyMode,
  isChoroplethEnabled,
  isGoogleBasemap,
  onGoogleBasemapChange,
  swiperPosition,
  onSwiperPositionChange,
  siteIndicators,
  rangeMode,
  onRangeModeChange,
  mapStatistics,
  chartGroups,
  chartAxisLabelFilters,
  chartGraphModes,
  mapExtent,
  onSiteIndicatorsChange,
  onResetTargets,
  isTargetModalOpen,
  onCloseTargetModal,
  refreshKey,
  quadColumns = 2,
  onQuadColumnsChange,
  fullDomainData,
}: ContentAreaProps) {
  const toast = useToast();
  const { details: attributeDetails } = useAttributeDetails();
  const { targetInputs } = useAttributeTargetInputs();
  const { units: attributeUnits } = useAttributeUnits();
  const { targetRanges } = useAttributeTargetRanges();
  const { variableTypes } = useAttributeVariableTypes();
  const { order: attributeOrder } = useAttributeOrder();
  const [targetDraftValues, setTargetDraftValues] = useState<Record<string, string>>({});
  const [targetDefaultValues, setTargetDefaultValues] = useState<Record<string, number>>({});
  const [isSavingTargets, setIsSavingTargets] = useState(false);
  // Which reset is awaiting confirmation, or null. A reset discards target work
  // and cannot be undone, so it is confirmed — but in place rather than in a
  // dialog, so the panel the user is working in is where the question appears.
  const [pendingReset, setPendingReset] = useState<'reference' | 'current' | null>(null);

  // --- Live update -------------------------------------------------------
  //
  // `storedLiveUpdate` is the user's explicit choice and null until they make
  // one, which is what keeps the checkbox stateful: the catchment count only
  // decides the default, and only for as long as nobody has overruled it.
  const [storedLiveUpdate, setStoredLiveUpdate] = useState<boolean | null>(() => loadLiveUpdatePreference());
  // The count the recalculation actually iterates over, straight off the
  // extraction that produced these indicators — the same number the backend
  // rescores on every edit, which is what makes it the right one to size the
  // default by.
  const catchmentCount = siteIndicators?.catchmentCount ?? 0;
  const isLiveUpdate = resolveLiveUpdate(catchmentCount, storedLiveUpdate);

  const handleLiveUpdateChange = useCallback((enabled: boolean) => {
    setStoredLiveUpdate(enabled);
    saveLiveUpdatePreference(enabled);
  }, []);


  const isQuad = mode === 'quad';
  const minimumQuadPaneCount = DEFAULT_PANE_STATES.length;

  const editableTargetKeys = useMemo(() => {
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
        const aOrder = attributeOrder[a];
        const bOrder = attributeOrder[b];
        if (aOrder != null && bOrder != null) return aOrder - bOrder;
        if (aOrder != null) return -1;
        if (bOrder != null) return 1;
        const aLabel = attributeDetails[a] ?? a;
        const bLabel = attributeDetails[b] ?? b;
        return aLabel.localeCompare(bLabel);
      });
  }, [attributeDetails, attributeOrder, siteIndicators, targetInputs, variableTypes]);

  const targetGroups = useMemo(() => {
    const groups = new Map<string, string[]>();
    editableTargetKeys.forEach((key) => {
      const groupName = variableTypes[key] ? formatVariableType(variableTypes[key]) : 'Other';
      const keysInGroup = groups.get(groupName) ?? [];
      keysInGroup.push(key);
      groups.set(groupName, keysInGroup);
    });
    return Array.from(groups.entries())
      .map(([groupName, keys]) => ({
        groupName,
        // Herbivores lists alphabetically by label; every other group keeps
        // the metadata.csv row order already applied in editableTargetKeys.
        keys: groupName === 'Herbivores'
          ? [...keys].sort((a, b) => (attributeDetails[a] ?? a).localeCompare(attributeDetails[b] ?? b))
          : keys,
      }))
      .sort((a, b) => a.groupName.localeCompare(b.groupName));
  }, [attributeDetails, editableTargetKeys, variableTypes]);

  const targetHasBeenUpdated = useMemo(() => {
    if (!siteIndicators?.ideal || !siteIndicators?.current) return false;
    return Object.entries(siteIndicators.ideal).some(([key, idealVal]) => {
      const curVal = siteIndicators.current[key];
      return typeof curVal === 'number' && typeof idealVal === 'number' &&
             Number.isFinite(curVal) && Number.isFinite(idealVal) && idealVal !== curVal;
    });
  }, [siteIndicators]);

  // If the user has already set a custom target for a key (ideal differs
  // from current), keep that value; otherwise default to the current state.
  const computeTargetDrafts = () => {
    const nextDrafts: Record<string, string> = {};
    for (const key of editableTargetKeys) {
      const idealVal = siteIndicators?.ideal?.[key];
      const currentVal = siteIndicators?.current?.[key];
      const hasCustomTarget = typeof idealVal === 'number' && typeof currentVal === 'number' &&
        Number.isFinite(idealVal) && Number.isFinite(currentVal) && idealVal !== currentVal;

      if (hasCustomTarget) {
        nextDrafts[key] = String(idealVal);
        continue;
      }

      if (typeof currentVal === 'number' && Number.isFinite(currentVal)) {
        nextDrafts[key] = String(currentVal);
      } else if (typeof idealVal === 'number' && Number.isFinite(idealVal)) {
        nextDrafts[key] = String(idealVal);
      } else {
        const fallback = siteIndicators?.idealLower?.[key];
        nextDrafts[key] = typeof fallback === 'number' && Number.isFinite(fallback) ? String(fallback) : '0';
      }
    }
    return nextDrafts;
  };

  // The keys whose slider the user has actually moved since opening the
  // editor. Untouched sliders still carry a draft — it defaults to the
  // current-state value so they start somewhere meaningful — and submitting
  // those as edits would tell the backend every indicator changed at once,
  // derailing the cascade for the one being edited.
  const touchedTargetKeysRef = useRef<Set<string>>(new Set());
  // Which slider the pointer is on right now, or null between drags. Only the
  // dragged slider is exempt from the resync below; every other slider still
  // picks up cascade results live.
  const draggingTargetKeyRef = useRef<string | null>(null);

  // Recalculations are chained, so a second one in the same drag must build on
  // what the first returned rather than on the `siteIndicators` captured when
  // the drag started.
  const siteIndicatorsRef = useRef(siteIndicators);
  siteIndicatorsRef.current = siteIndicators;

  // Populate draft values whenever the panel opens, regardless of which entry
  // point triggered it (header "Targets" button vs internal button). While
  // the panel stays open, also resync drafts whenever `siteIndicators`
  // itself changes — a recalculation can cascade into other factors (e.g.
  // dropping grass cover fraction shifts the tree cover target), and those
  // sliders need to pick up the new value without the user closing and
  // reopening the panel.
  const targetPanelWasOpenRef = useRef(false);
  useEffect(() => {
    if (!isTargetModalOpen) {
      targetPanelWasOpenRef.current = false;
      touchedTargetKeysRef.current = new Set();
      return;
    }

    const nextDrafts = computeTargetDrafts();
    // Mid-drag, a live recalculation's cascade must not yank the thumb out
    // from under the pointer, so the dragged slider keeps the user's value
    // and everything else takes the freshly calculated one.
    const draggingKey = draggingTargetKeyRef.current;
    setTargetDraftValues((prev) =>
      draggingKey != null && prev[draggingKey] !== undefined
        ? { ...nextDrafts, [draggingKey]: prev[draggingKey] }
        : nextDrafts
    );

    if (!targetPanelWasOpenRef.current) {
      // Only snapshot the "opened at" values on the initial open — this
      // snapshot is what the reset-to-origin check below diffs against.
      setTargetDefaultValues(
        Object.fromEntries(
          Object.entries(nextDrafts).map(([key, value]) => [key, Number(value)])
        )
      );
    }
    targetPanelWasOpenRef.current = true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTargetModalOpen, siteIndicators]);


  // The application header is content-sized — logos plus padding — not a fixed
  // height, so the docked panel measures it instead of repeating a magic number
  // that goes stale the moment the header's contents change. Getting this wrong
  // tucks the panel's heading up underneath the top bar.
  const [headerOffset, setHeaderOffset] = useState(0);
  useEffect(() => {
    const header = document.querySelector('header');
    if (!header) return;
    const apply = () => setHeaderOffset(header.getBoundingClientRect().height);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  // Broadcast open/close so the guided tour can react to the panel appearing.
  // Using a ref to skip the initial mount dispatch. The event names predate
  // the panel being a docked panel rather than a modal and are kept as-is so
  // the tours keep working.
  const prevPanelOpenRef = useRef(false);
  useEffect(() => {
    const isOpen = isTargetModalOpen ?? false;
    if (isOpen && !prevPanelOpenRef.current) {
      window.dispatchEvent(new Event('dt:targets-modal-opened'));
    } else if (!isOpen && prevPanelOpenRef.current) {
      window.dispatchEvent(new Event('dt:targets-modal-closed'));
    }
    prevPanelOpenRef.current = isOpen;
  }, [isTargetModalOpen]);

  // One recalculation round trip. `draftValues` is passed in rather than read
  // from `targetDraftValues` state so the value that triggered it is
  // guaranteed to be included, even though the setState that recorded it may
  // not have flushed to state yet by the time this runs.
  const runRecalculation = async (draftValues: Record<string, string>) => {
    const indicators = siteIndicatorsRef.current;
    if (!indicators || !onSiteIndicatorsChange) return;

    const currentIdeal = indicators.ideal ?? {};
    const nextIdeal = { ...currentIdeal };
    let hasChanges = false;

    for (const key of editableTargetKeys) {
      if (!touchedTargetKeysRef.current.has(key)) continue;
      const raw = (draftValues[key] ?? '').trim();
      if (raw === '') continue;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        toast({
          title: STRINGS.invalidTargetTitle,
          description: STRINGS.invalidTargetBody(attributeDetails[key] ?? key),
          status: 'error',
          duration: 2500,
        });
        return;
      }
      // Always send a touched key, even when the user has dragged it back to
      // where it started: that is a request to clear the target, and skipping
      // it would leave the previously submitted ideal in place forever.
      nextIdeal[key] = parsed;
      if (currentIdeal[key] !== parsed) hasChanges = true;
    }

    if (!hasChanges) return;

    try {
      await onSiteIndicatorsChange({ ...indicators, ideal: nextIdeal });
    } catch {
      toast({ title: STRINGS.updateFailed, status: 'error', duration: 2500 });
    }
  };

  /**
   * Point every editable target at one of the observed scenarios.
   *
   * Both buttons go through the same path a slider does — set the drafts, mark
   * the keys as touched, schedule a recalculation — so a reset cascades exactly
   * as a manual edit would and cannot land the site in a state the sliders
   * could not have produced.
   *
   * Resetting to current is the "clear my targets" case: with ideal equal to
   * current there is no divergence, so the dials stop showing a target at all.
   */
  const resetTargetsTo = (scenario: 'reference' | 'current') => {
    if (!onResetTargets) return;
    // Every editable slider is untouched again: the reset has replaced the
    // targets wholesale, so nothing the user did before it is still pending.
    touchedTargetKeysRef.current = new Set();
    setIsSavingTargets(true);
    void (async () => {
      try {
        await onResetTargets(scenario);
      } catch {
        toast({ title: STRINGS.updateFailed, status: 'error', duration: 2500 });
      } finally {
        setIsSavingTargets(false);
      }
    })();
  };

  // The scheduler is created once and reaches the current render's
  // `runRecalculation` through a ref, so a request chained after an await
  // still sees the latest props rather than the ones captured when the drag
  // started.
  const runRecalculationRef = useRef(runRecalculation);
  runRecalculationRef.current = runRecalculation;
  const schedulerRef = useRef<ReturnType<typeof createRecalculationScheduler<Record<string, string>>> | null>(null);
  if (schedulerRef.current === null) {
    schedulerRef.current = createRecalculationScheduler<Record<string, string>>(
      (drafts) => runRecalculationRef.current(drafts),
      setIsSavingTargets,
    );
  }
  const scheduleRecalculation = (draftValues: Record<string, string>) => {
    schedulerRef.current?.schedule(draftValues);
  };

  const visibleIndices = isQuad
    ? paneStates.map((_, index) => index)
    : [Math.min(focusedPane, Math.max(0, paneStates.length - 1))];

  // One zoom cluster for the whole grid, on the bottom-left map. Recomputed
  // rather than fixed, because which pane is bottom-left changes: panes are
  // removable, the columns toggle between two and three, and a pane showing a
  // chart cannot host a map control.
  const navigationPane = navigationPaneIndex(
    visibleIndices,
    isQuad ? quadColumns : 1,
    (paneIndex) => viewModes[paneIndex] === 'map',
  );

  return (
    <Box
      position="relative"
      w="100%"
      h="100%"
      display="flex"
      flexDirection="column"
    >
      {/*
        The grid-wide controls used to be a full-width bar here: four view-mode
        icons, three range-mode buttons, add-pane and the target editor. They
        cost a horizontal band of vertical space on the most space-starved
        screen in the application, and they are now in the header, in a gap that
        was empty. See GridControls.
      */}

      <Box
        position="relative"
        w="100%"
        h="100%"
        flex={1}
        display="grid"
        gridTemplateColumns={isQuad ? `repeat(${quadColumns}, minmax(0, 1fr))` : '1fr'}
        gridTemplateRows={isQuad ? undefined : '1fr'}
        gridAutoRows={isQuad ? 'calc((100% - 2px) / 2)' : undefined}
        alignContent={isQuad ? 'start' : undefined}
        gap={isQuad ? '2px' : 0}
        bg={isQuad ? 'gray.700' : 'transparent'}
        overflowY={isQuad ? 'auto' : 'hidden'}
        overflowX="hidden"
        sx={{
          transition: 'grid-template-columns 0.6s cubic-bezier(0.16, 1, 0.3, 1), gap 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
      {isQuad ? (
        <AnimatePresence>
            {visibleIndices.map((i) => (
              <motion.div
                key={`pane-${i}`}
                custom={i}
                variants={paneVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                style={{ position: 'relative', overflow: 'hidden', height: '100%' }}
              >
                <ViewPane
                  comparison={paneStates[i]}
                  compact
                  paneCount={paneStates.length}
                  paneIndex={i}
                  layoutMode={mode}
                  viewMode={viewModes[i]}
                  onViewModeChange={onViewModeChange}
                  onFocusPane={onFocusPane}
                  onGoQuad={onGoQuad}
                  onOpenControlPanel={onOpenControlPanel}
                  onOpenChartDetails={onOpenChartDetails}
                  canRemove={paneStates.length > minimumQuadPaneCount && i >= minimumQuadPaneCount}
                  onRemovePane={onRemovePane}
                  onIdentify={onIdentify}
                  identifyResult={identifyResult}
                  siteId={siteId}
                  siteBounds={siteBounds}
                  isBoundaryEditMode={isBoundaryEditMode}
                  siteGeometry={siteGeometry}
                  onBoundaryUpdate={onBoundaryUpdate}
                  isSwiperEnabled={isSwiperEnabled}
                  colorScaleMode={colorScaleMode}
                  colorScaleType={colorScaleType}
                  is3DMode={is3DMode}
                  isIdentifyMode={isIdentifyMode}
                  isChoroplethEnabled={isChoroplethEnabled}
                  isGoogleBasemap={isGoogleBasemap}
                  onGoogleBasemapChange={onGoogleBasemapChange}
                  showNavigation={i === navigationPane}
                  swiperPosition={swiperPosition}
                  onSwiperPositionChange={onSwiperPositionChange}
                  siteIndicators={siteIndicators}
                  rangeMode={rangeMode}
                  onRangeModeChange={onRangeModeChange}
                  mapStatistics={mapStatistics}
                  chartGroup={chartGroups?.[i] ?? null}
                  mapExtent={mapExtent}
                  chartAxisLabelFilter={chartAxisLabelFilters?.[i] ?? null}
                  chartGraphMode={chartGraphModes?.[i] ?? null}
                  refreshKey={refreshKey}
                  targetHasBeenUpdated={targetHasBeenUpdated}
                  editableTargetKeys={editableTargetKeys}
                  quadColumns={quadColumns}
                  onQuadColumnsChange={onQuadColumnsChange}
                  fullDomainData={fullDomainData}
                />
              </motion.div>
            ))}
        </AnimatePresence>
      ) : (
        <Box
          position="relative"
          overflow="hidden"
          gridColumn="1 / -1"
          gridRow="1 / -1"
        >
          <ViewPane
            comparison={paneStates[visibleIndices[0]]}
            compact={false}
            paneCount={paneStates.length}
            paneIndex={visibleIndices[0]}
            layoutMode={mode}
            viewMode={viewModes[visibleIndices[0]]}
            onViewModeChange={onViewModeChange}
            onFocusPane={onFocusPane}
            onGoQuad={onGoQuad}
            onOpenChartDetails={onOpenChartDetails}
            onIdentify={onIdentify}
            identifyResult={identifyResult}
            onMapExtentChange={onMapExtentChange}
            onStatisticsChange={onStatisticsChange}
            isPanelOpen={isPanelOpen}
            siteId={siteId}
            siteBounds={siteBounds}
            isBoundaryEditMode={isBoundaryEditMode}
            siteGeometry={siteGeometry}
            onBoundaryUpdate={onBoundaryUpdate}
            isSwiperEnabled={isSwiperEnabled}
            colorScaleMode={colorScaleMode}
            colorScaleType={colorScaleType}
            is3DMode={is3DMode}
            isIdentifyMode={isIdentifyMode}
            isChoroplethEnabled={isChoroplethEnabled}
            isGoogleBasemap={isGoogleBasemap}
            onGoogleBasemapChange={onGoogleBasemapChange}
            showNavigation={visibleIndices[0] === navigationPane}
            swiperPosition={swiperPosition}
            onSwiperPositionChange={onSwiperPositionChange}
            siteIndicators={siteIndicators}
            rangeMode={rangeMode}
            onRangeModeChange={onRangeModeChange}
            mapStatistics={mapStatistics}
            chartGroup={chartGroups?.[visibleIndices[0]] ?? null}
            chartAxisLabelFilter={chartAxisLabelFilters?.[visibleIndices[0]] ?? null}
            chartGraphMode={chartGraphModes?.[visibleIndices[0]] ?? null}
            mapExtent={mapExtent}
            refreshKey={refreshKey}
            targetHasBeenUpdated={targetHasBeenUpdated}
            editableTargetKeys={editableTargetKeys}
            fullDomainData={fullDomainData}
          />
        </Box>
      )}
      </Box>

      {/*
        A docked right-hand panel rather than a modal overlay. The editor is
        something you work *alongside* — its whole purpose is watching the
        dials behind it answer a slider — and an overlay hid exactly what it
        was meant to show. It takes the same slot as the single-factor
        ControlPanel, which is never open at the same time.
      */}
      <Slide
        direction="right"
        in={isTargetModalOpen ?? false}
        style={{
          zIndex: 15,
          position: 'fixed',
          top: headerOffset,
          right: 0,
          height: `calc(100% - ${headerOffset}px)`,
          width: 'auto',
        }}
      >
        <Box
          id="tour-target-panel"
          role="region"
          aria-label={STRINGS.targetsHeading}
          w={{ base: '100vw', md: '440px' }}
          h="100%"
          bg="gray.800"
          color="white"
          borderLeft="1px"
          borderColor="whiteAlpha.200"
          boxShadow="-4px 0 24px rgba(0,0,0,0.35)"
          display="flex"
          flexDirection="column"
        >
          <HStack px={4} pt={3} pb={2} align="center" spacing={2}>
            <Box fontSize="md" fontWeight="bold" flex="1">{STRINGS.targetsHeading}</Box>
            {isSavingTargets && (
              <HStack spacing={2} color="cyan.300" fontSize="xs">
                <Spinner size="xs" thickness="2px" speed="0.7s" />
                <Box>{STRINGS.recalculating}</Box>
              </HStack>
            )}
            <IconButton
              aria-label={STRINGS.closePanel}
              icon={<FiChevronRight />}
              size="sm"
              variant="ghost"
              onClick={onCloseTargetModal}
            />
          </HStack>

          <Box px={4} pb={3}>
            <Tooltip
              label={isLiveUpdate ? STRINGS.liveUpdateHintOn : STRINGS.liveUpdateHintOff}
              placement="left"
              openDelay={400}
            >
              <Box>
                <Checkbox
                  colorScheme="cyan"
                  size="sm"
                  isChecked={isLiveUpdate}
                  onChange={(e) => handleLiveUpdateChange(e.target.checked)}
                >
                  <Box fontSize="sm" color="gray.200">{STRINGS.liveUpdate}</Box>
                </Checkbox>
              </Box>
            </Tooltip>
          </Box>

          {/*
            Reset the whole target set to one of the observed scenarios.
            Confirmed in place rather than in a dialog: this discards target
            work and cannot be undone, and the question belongs in the panel
            the user is already working in.
          */}
          <Box px={4} pb={3}>
            {pendingReset === null ? (
              <HStack spacing={2}>
                <Tooltip label={STRINGS.resetToReferenceHint} placement="bottom" openDelay={400}>
                  <Button
                    size="xs"
                    variant="outline"
                    colorScheme="orange"
                    isDisabled={!onResetTargets || !siteIndicators?.reference}
                    onClick={() => setPendingReset('reference')}
                  >
                    {STRINGS.resetToReference}
                  </Button>
                </Tooltip>
                <Tooltip label={STRINGS.resetToCurrentHint} placement="bottom" openDelay={400}>
                  <Button
                    size="xs"
                    variant="outline"
                    colorScheme="cyan"
                    isDisabled={!onResetTargets || !siteIndicators?.current}
                    onClick={() => setPendingReset('current')}
                  >
                    {STRINGS.resetToCurrent}
                  </Button>
                </Tooltip>
              </HStack>
            ) : (
              <Box bg="whiteAlpha.100" borderRadius="md" p={3}>
                <Box fontSize="sm" color="gray.100" fontWeight="600">
                  {pendingReset === 'reference'
                    ? STRINGS.resetConfirmReference
                    : STRINGS.resetConfirmCurrent}
                </Box>
                <Box fontSize="xs" color="gray.400" mt={1} mb={2}>
                  {STRINGS.resetConfirmBody}
                </Box>
                <HStack spacing={2}>
                  <Button
                    size="xs"
                    colorScheme={pendingReset === 'reference' ? 'orange' : 'cyan'}
                    onClick={() => {
                      resetTargetsTo(pendingReset);
                      setPendingReset(null);
                    }}
                  >
                    {STRINGS.resetConfirm}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setPendingReset(null)}>
                    {STRINGS.resetCancel}
                  </Button>
                </HStack>
              </Box>
            )}
          </Box>

          <Box px={4} pb={4} flex="1" overflowY="auto">
            <Accordion allowMultiple>
              {targetGroups.map((group) => (
                <AccordionItem key={group.groupName} border="none" mb={3}>
                  <AccordionButton bg="whiteAlpha.50" borderRadius="md" _hover={{ bg: 'whiteAlpha.100' }}>
                    <Box flex="1" textAlign="left" fontSize="sm" fontWeight="bold" color="gray.200">
                      {group.groupName}
                    </Box>
                    <Box fontSize="xs" color="gray.500" mr={2}>{group.keys.length}</Box>
                    <AccordionIcon />
                  </AccordionButton>
                  <AccordionPanel pb={4}>
                    <VStack spacing={5} align="stretch">
                      {group.keys.map((key) => {
                        const refVal = siteIndicators?.reference?.[key];
                        const safeRef = typeof refVal === 'number' && Number.isFinite(refVal) ? refVal : 0;
                        const unit = attributeUnits[key] ?? '';
                        const isProportion = unit === 'proportion' || unit === 'fraction';
                        const metaRange = targetRanges[key];
                        const safeMin = (metaRange?.min != null && Number.isFinite(metaRange.min)) ? metaRange.min : 0;
                        const metaMax = (metaRange?.max != null && Number.isFinite(metaRange.max)) ? metaRange.max : isProportion ? 1 : safeRef + 1000;
                        const defaultVal = targetDefaultValues[key];
                        const safeMax = (typeof defaultVal === 'number' && Number.isFinite(defaultVal) && defaultVal > 1000)
                          ? defaultVal + 1000
                          : metaMax;
                        const range = safeMax - safeMin;
                        const step = isProportion ? 0.01 : range > 200 ? 1 : range > 20 ? 0.1 : 0.01;
                        const rawVal = targetDraftValues[key] ?? '';
                        const numVal = rawVal !== '' && Number.isFinite(Number(rawVal))
                          ? Math.min(safeMax, Math.max(safeMin, Number(rawVal)))
                          : safeMin;
                        return (
                          <FormControl key={key}>
                            <HStack justify="space-between" mb={2}>
                              <FormLabel fontSize="sm" color="gray.200" mb={0}>
                                {attributeDetails[key] ?? key}
                                {attributeUnits[key] ? <Box as="span" fontSize="xs" color="gray.400" ml={1}>({attributeUnits[key]})</Box> : null}
                                <Box fontSize="xs" color="gray.500" fontWeight="normal" mt={0.5}>{key}</Box>
                              </FormLabel>
                              <Box fontSize="sm" color="cyan.300" fontWeight="600" minW="50px" textAlign="right">
                                {numVal % 1 === 0 ? numVal : numVal.toFixed(step < 0.1 ? 2 : 1)}{attributeUnits[key] ? <Box as="span" fontSize="xs" color="gray.400" ml={1}>{attributeUnits[key]}</Box> : null}
                              </Box>
                            </HStack>
                            <Slider
                              value={numVal}
                              min={safeMin}
                              max={safeMax}
                              step={step}
                              colorScheme="cyan"
                              // Deliberately never disabled while a
                              // recalculation runs. Disabling every slider
                              // mid-edit was what made the editor feel like it
                              // redrew itself: focus moved, the scroll
                              // position jumped, and the user had to find
                              // their place again after each change.
                              //
                              // Chakra focuses a thumb whenever its *value*
                              // changes, with a bare .focus() that scrolls the
                              // element into view. A cascade rewrites the
                              // other sliders' values, so releasing one drag
                              // threw focus onto an unrelated slider and
                              // scrolled the panel to it. Focus is restored
                              // deliberately in onPointerDown below instead —
                              // on the slider the pointer actually landed on,
                              // and without scrolling.
                              focusThumbOnChange={false}
                              onPointerDown={(e) => {
                                const thumb = e.currentTarget.querySelector('[role="slider"]');
                                if (thumb instanceof HTMLElement) thumb.focus({ preventScroll: true });
                              }}
                              onChange={(val) => {
                                draggingTargetKeyRef.current = key;
                                touchedTargetKeysRef.current.add(key);
                                const nextDraft = { ...targetDraftValues, [key]: String(val) };
                                setTargetDraftValues(nextDraft);
                                if (isLiveUpdate) scheduleRecalculation(nextDraft);
                              }}
                              onChangeEnd={(val) => {
                                draggingTargetKeyRef.current = null;
                                touchedTargetKeysRef.current.add(key);
                                const nextDraft = { ...targetDraftValues, [key]: String(val) };
                                setTargetDraftValues(nextDraft);
                                // Runs in both modes. With live update off it
                                // is the only recalculation; with it on it is
                                // the one that guarantees the released value
                                // is the value that was scored, whatever the
                                // coalescing dropped on the way.
                                scheduleRecalculation(nextDraft);
                              }}
                            >
                              <SliderTrack bg="whiteAlpha.200">
                                <SliderFilledTrack />
                              </SliderTrack>
                              <SliderThumb />
                            </Slider>
                            <HStack justify="space-between" mt={1}>
                              <Box fontSize="xs" color="gray.500">{safeMin.toFixed(2)}</Box>
                              <Box fontSize="xs" color="gray.500">{safeMax.toFixed(2)}</Box>
                            </HStack>
                          </FormControl>
                        );
                      })}
                    </VStack>
                  </AccordionPanel>
                </AccordionItem>
              ))}
            </Accordion>
          </Box>
        </Box>
      </Slide>
    </Box>
  );
}

export default ContentArea;
