import { Accordion, AccordionButton, AccordionIcon, AccordionItem, AccordionPanel, Box, Button, FormControl, FormLabel, HStack, Modal, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalOverlay, Slider, SliderFilledTrack, SliderThumb, SliderTrack, VStack, useToast } from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';
import ViewPane from './ViewPane';
import { editableTargetKeys as editableTargetKeysFor } from '../lib/editableTargets';
import { DEFAULT_PANE_STATES } from '../types';
import type { LayoutMode, QuadColumns, PaneStates, IdentifyResult, MapExtent, MapStatistics, BoundingBox, ColorScaleMode, ColorScaleType, SiteIndicators, RangeMode, ViewMode } from '../types';
import { useAttributeDetails, useAttributeTargetInputs, useAttributeTargetRanges, useAttributeUnits, useAttributeVariableTypes } from '../hooks/useApi';
import type { FullDomainData } from '../hooks/useApi';
import { useEffect, useMemo, useRef, useState } from 'react';

interface ContentAreaProps {
  mode: LayoutMode;
  paneStates: PaneStates;
  viewModes: ViewMode[];
  onViewModeChange: (paneIndex: number, mode: ViewMode) => void;
  focusedPane: number;
  onFocusPane: (index: number) => void;
  onGoQuad: () => void;
  onOpenControlPanel?: (paneIndex: number) => void;
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
  // For target modal control from parent
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
  const [targetDraftValues, setTargetDraftValues] = useState<Record<string, string>>({});
  const [targetDefaultValues, setTargetDefaultValues] = useState<Record<string, number>>({});
  const [isSavingTargets, setIsSavingTargets] = useState(false);
  const isQuad = mode === 'quad';
  const minimumQuadPaneCount = DEFAULT_PANE_STATES.length;

  const editableTargetKeys = useMemo(
    () => editableTargetKeysFor(siteIndicators, targetInputs, variableTypes, attributeDetails),
    [attributeDetails, siteIndicators, targetInputs, variableTypes],
  );

  const targetGroups = useMemo(() => {
    const groups = new Map<string, string[]>();
    editableTargetKeys.forEach((key) => {
      const groupName = variableTypes[key] ? formatVariableType(variableTypes[key]) : 'Other';
      const keysInGroup = groups.get(groupName) ?? [];
      keysInGroup.push(key);
      groups.set(groupName, keysInGroup);
    });
    return Array.from(groups.entries())
      .map(([groupName, keys]) => ({ groupName, keys }))
      .sort((a, b) => a.groupName.localeCompare(b.groupName));
  }, [editableTargetKeys, variableTypes]);

  const targetHasBeenUpdated = useMemo(() => {
    if (!siteIndicators?.ideal || !siteIndicators?.current) return false;
    return Object.entries(siteIndicators.ideal).some(([key, idealVal]) => {
      const curVal = siteIndicators.current[key];
      return typeof curVal === 'number' && typeof idealVal === 'number' &&
             Number.isFinite(curVal) && Number.isFinite(idealVal) && idealVal !== curVal;
    });
  }, [siteIndicators]);

  // Populate draft values whenever the modal opens, regardless of which entry
  // point triggered it (header "Targets" button vs internal button). If the
  // user has already set a custom target for a key (ideal differs from
  // current, its starting value), keep that value; otherwise default to the
  // current state.
  useEffect(() => {
    if (!isTargetModalOpen) return;
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
    setTargetDraftValues(nextDrafts);
    setTargetDefaultValues(
      Object.fromEntries(
        Object.entries(nextDrafts).map(([key, value]) => [key, Number(value)])
      )
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTargetModalOpen]);


  // Broadcast open/close so the guided tour can hide itself while the modal
  // is visible. Using a ref to skip the initial mount dispatch.
  const prevModalOpenRef = useRef(false);
  useEffect(() => {
    const isOpen = isTargetModalOpen ?? false;
    if (isOpen && !prevModalOpenRef.current) {
      window.dispatchEvent(new Event('dt:targets-modal-opened'));
    } else if (!isOpen && prevModalOpenRef.current) {
      window.dispatchEvent(new Event('dt:targets-modal-closed'));
    }
    prevModalOpenRef.current = isOpen;
  }, [isTargetModalOpen]);

  const saveTargetValues = async () => {
    if (!siteIndicators || !onSiteIndicatorsChange) {
      onCloseTargetModal?.();
      return;
    }

    const nextIdeal = { ...(siteIndicators.ideal ?? {}) };

    for (const key of editableTargetKeys) {
      const raw = (targetDraftValues[key] ?? '').trim();
      if (raw === '') continue;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        toast({
          title: 'Invalid target value',
          description: `Please enter a valid number for ${attributeDetails[key] ?? key}.`,
          status: 'error',
          duration: 2500,
        });
        return;
      }
      // Sliders the user never touched still hold a draft — it defaults to
      // the current-state value so untouched sliders start somewhere
      // meaningful (see the modal-open effect above). Submitting that
      // untouched draft as an "ideal" edit would make the backend think
      // every uncustomized indicator changed at once, which derails the
      // cascade recalculation for the one field actually being edited.
      // Only include keys whose draft has actually moved from its
      // modal-open snapshot.
      const openedAt = targetDefaultValues[key];
      if (typeof openedAt === 'number' && parsed === openedAt) continue;
      nextIdeal[key] = parsed;
    }

    setIsSavingTargets(true);
    try {
      await onSiteIndicatorsChange({
        ...siteIndicators,
        ideal: nextIdeal,
      });
      onCloseTargetModal?.();
      toast({ title: 'Target values updated', status: 'success', duration: 2000 });
    } catch {
      toast({ title: 'Failed to update target values', status: 'error', duration: 2500 });
    } finally {
      setIsSavingTargets(false);
    }
  };

  const visibleIndices = isQuad
    ? paneStates.map((_, index) => index)
    : [Math.min(focusedPane, Math.max(0, paneStates.length - 1))];

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

      <Modal
        isOpen={isTargetModalOpen ?? false}
        onClose={onCloseTargetModal ?? (() => {})}
        size="xl"
        scrollBehavior="inside"
        closeOnOverlayClick={!isSavingTargets}
        closeOnEsc={!isSavingTargets}
      >
        <ModalOverlay />
        <ModalContent bg="gray.800" color="white">
          <ModalHeader>Edit Target Values</ModalHeader>
          <ModalCloseButton isDisabled={isSavingTargets} />
          <ModalBody>
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
                              onChange={(val) =>
                                setTargetDraftValues((prev) => ({ ...prev, [key]: String(val) }))
                              }
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
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={onCloseTargetModal} isDisabled={isSavingTargets}>Cancel</Button>
            <Button
              colorScheme="cyan"
              onClick={saveTargetValues}
              isLoading={isSavingTargets}
              loadingText="Recalculating"
            >
              Save
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  );
}

export default ContentArea;
