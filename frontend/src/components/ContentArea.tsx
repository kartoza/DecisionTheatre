import { Accordion, AccordionButton, AccordionIcon, AccordionItem, AccordionPanel, Box, Button, FormControl, FormLabel, HStack, IconButton, Modal, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalOverlay, Slider, SliderFilledTrack, SliderThumb, SliderTrack, Spinner, Tooltip, VStack, useToast } from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiActivity, FiBarChart2, FiEdit2, FiGlobe, FiMap, FiPlus, FiSquare, FiTable, FiTarget } from 'react-icons/fi';
import ViewPane from './ViewPane';
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
  onAddPane: () => void;
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
  onSwiperEnabledChange?: (enabled: boolean) => void;
  colorScaleMode: ColorScaleMode;
  colorScaleType: ColorScaleType;
  is3DMode?: boolean;
  on3DModeChange?: (enabled: boolean) => void;
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
  isExtractingIndicators?: boolean;
  // For target modal control from parent
  isTargetModalOpen?: boolean;
  onOpenTargetModal?: () => void;
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

const QUAD_VIEW_MODE_CONFIG: Record<ViewMode, { icon: React.ReactElement; label: string }> = {
  map: { icon: <FiMap />, label: 'Map' },
  chart: { icon: <FiBarChart2 />, label: 'Chart' },
  dial: { icon: <FiActivity />, label: 'Dial' },
  table: { icon: <FiTable />, label: 'Table' },
};

const QUAD_VIEW_MODES: ViewMode[] = ['map', 'chart', 'dial', 'table'];

const RANGE_MODE_CONFIG: { id: RangeMode; label: string; icon: React.ReactElement }[] = [
  { id: 'domain', label: 'Full', icon: <FiGlobe size={14} /> },
  { id: 'extent', label: 'Extent', icon: <FiSquare size={14} /> },
  { id: 'site', label: 'Site', icon: <FiTarget size={14} /> },
];

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
  onAddPane,
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
  onSwiperEnabledChange,
  colorScaleMode,
  colorScaleType,
  is3DMode,
  on3DModeChange,
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
  isExtractingIndicators,
  isTargetModalOpen,
  onOpenTargetModal,
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
  const isQuad = mode === 'quad';
  const minimumQuadPaneCount = DEFAULT_PANE_STATES.length;
  const quadActiveMode: ViewMode = viewModes[focusedPane] ?? viewModes[0] ?? 'map';

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
        const aLabel = attributeDetails[a] ?? a;
        const bLabel = attributeDetails[b] ?? b;
        return aLabel.localeCompare(bLabel);
      });
  }, [attributeDetails, siteIndicators, targetInputs, variableTypes]);

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

  const openTargetModal = () => {
    if (typeof onOpenTargetModal === 'function') onOpenTargetModal();
  };

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

    try {
      await onSiteIndicatorsChange({
        ...siteIndicators,
        ideal: nextIdeal,
      });
      onCloseTargetModal?.();
      toast({ title: 'Target values updated', status: 'success', duration: 2000 });
    } catch {
      toast({ title: 'Failed to update target values', status: 'error', duration: 2500 });
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
      {isQuad && (
        <HStack
          spacing={1}
          px={2}
          py={2}
          bg="gray.800"
          borderBottom="1px"
          borderColor="gray.700"
          justify="center"
        >
          {QUAD_VIEW_MODES.map((viewMode) => {
            const config = QUAD_VIEW_MODE_CONFIG[viewMode];
            const isActive = quadActiveMode === viewMode;
            return (
              <Tooltip key={viewMode} label={`Show ${config.label} in all panes`} placement="bottom">
                <IconButton
                  aria-label={`Show ${config.label} in all panes`}
                  icon={config.icon}
                  onClick={() => onViewModeChange(focusedPane, viewMode)}
                  variant="ghost"
                  color={isActive ? 'white' : 'gray.300'}
                  bg={isActive ? 'cyan.500' : 'transparent'}
                  _hover={{ bg: isActive ? 'cyan.400' : 'whiteAlpha.200' }}
                  size="sm"
                  borderRadius="md"
                />
              </Tooltip>
            );
          })}

          {(quadActiveMode === 'dial' || quadActiveMode === 'chart') && onRangeModeChange && (
            <HStack spacing={1} pl={2} ml={2} borderLeft="1px" borderColor="gray.600">
              {RANGE_MODE_CONFIG.map((mode) => {
                const isActive = rangeMode === mode.id;
                const isDisabled = mode.id === 'site' && !siteId;
                return (
                  <Tooltip key={mode.id} label={isDisabled ? 'No site selected' : `${mode.label} range`} placement="bottom">
                    <Button
                      size="sm"
                      leftIcon={mode.icon as React.ReactElement}
                      onClick={() => !isDisabled && onRangeModeChange(mode.id)}
                      variant="ghost"
                      bg={isActive ? 'cyan.500' : 'transparent'}
                      color={isActive ? 'white' : isDisabled ? 'gray.600' : 'gray.300'}
                      _hover={{ bg: isDisabled ? 'transparent' : isActive ? 'cyan.400' : 'whiteAlpha.200' }}
                      fontSize="xs"
                      fontWeight={isActive ? '600' : '400'}
                      px={3}
                      cursor={isDisabled ? 'not-allowed' : 'pointer'}
                    >
                      {mode.label}
                    </Button>
                  </Tooltip>
                );
              })}
            </HStack>
          )}

          <Tooltip label="Add pane" placement="bottom">
            <IconButton
              aria-label="Add pane"
              icon={<FiPlus />}
              onClick={onAddPane}
              variant="ghost"
              color="gray.200"
              _hover={{ bg: 'whiteAlpha.200' }}
              size="sm"
              borderRadius="md"
              ml={2}
            />
          </Tooltip>

          {isExtractingIndicators && !siteIndicators && (
            <HStack spacing={2} ml={2} color="gray.400">
              <Spinner size="xs" color="cyan.400" />
              <Box fontSize="sm">Extracting indicators…</Box>
            </HStack>
          )}

          {siteIndicators && editableTargetKeys.length > 0 && (
            <Tooltip label="Edit target values" placement="bottom">
              <Button
                id="demo-edit-targets-btn"
                size="sm"
                leftIcon={<FiEdit2 size={14} />}
                onClick={openTargetModal}
                variant="ghost"
                color="gray.200"
                _hover={{ bg: 'whiteAlpha.200' }}
                ml={2}
              >
                Targets
              </Button>
            </Tooltip>
          )}
        </HStack>
      )}

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
                  onSwiperEnabledChange={onSwiperEnabledChange}
                  colorScaleMode={colorScaleMode}
                  colorScaleType={colorScaleType}
                  is3DMode={is3DMode}
                  on3DModeChange={on3DModeChange}
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
            onSwiperEnabledChange={onSwiperEnabledChange}
            colorScaleMode={colorScaleMode}
            colorScaleType={colorScaleType}
            is3DMode={is3DMode}
            on3DModeChange={on3DModeChange}
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

      <Modal isOpen={isTargetModalOpen ?? false} onClose={onCloseTargetModal ?? (() => {})} size="xl" scrollBehavior="inside">
        <ModalOverlay />
        <ModalContent bg="gray.800" color="white">
          <ModalHeader>Edit Target Values</ModalHeader>
          <ModalCloseButton />
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
            <Button variant="ghost" mr={3} onClick={onCloseTargetModal}>Cancel</Button>
            <Button colorScheme="cyan" onClick={saveTargetValues}>Save</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  );
}

export default ContentArea;
