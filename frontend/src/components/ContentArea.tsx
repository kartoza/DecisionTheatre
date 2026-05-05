import { Box, Button, FormControl, FormLabel, HStack, IconButton, Input, Modal, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalOverlay, Spinner, Tooltip, VStack, useToast } from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiActivity, FiBarChart2, FiEdit2, FiGlobe, FiMap, FiPlus, FiSquare, FiTable, FiTarget } from 'react-icons/fi';
import ViewPane from './ViewPane';
import { DEFAULT_PANE_STATES } from '../types';
import type { LayoutMode, PaneStates, IdentifyResult, MapExtent, MapStatistics, BoundingBox, ColorScaleMode, SiteIndicators, RangeMode, ViewMode } from '../types';
import { useAttributeDetails, useAttributeTargetInputs } from '../hooks/useApi';
import { useMemo, useState } from 'react';

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
}: ContentAreaProps) {
  const toast = useToast();
  const { details: attributeDetails } = useAttributeDetails();
  const { targetInputs } = useAttributeTargetInputs();
  const [targetDraftValues, setTargetDraftValues] = useState<Record<string, string>>({});
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
      .filter((key) => availableKeys.has(key));
    return keys
      .filter((key, idx, arr) => arr.indexOf(key) === idx)
      .sort((a, b) => {
        const aLabel = attributeDetails[a] ?? a;
        const bLabel = attributeDetails[b] ?? b;
        return aLabel.localeCompare(bLabel);
      });
  }, [attributeDetails, siteIndicators, targetInputs]);

  const openTargetModal = () => {
    const nextDrafts: Record<string, string> = {};
    for (const key of editableTargetKeys) {
      const value = siteIndicators?.ideal?.[key];
      nextDrafts[key] = typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    }
    setTargetDraftValues(nextDrafts);
    if (typeof onOpenTargetModal === 'function') onOpenTargetModal();
  };

  const saveTargetValues = async () => {
    if (!siteIndicators || !onSiteIndicatorsChange) {
      onCloseTargetModal?.();
      return;
    }

    const nextIdeal = { ...(siteIndicators.ideal ?? {}) };
    const nextIdealLower = { ...(siteIndicators.idealLower ?? {}) };
    const nextIdealUpper = { ...(siteIndicators.idealUpper ?? {}) };

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
      nextIdeal[key] = parsed;
      nextIdealLower[key] = parsed;
      nextIdealUpper[key] = parsed;
    }

    try {
      await onSiteIndicatorsChange({
        ...siteIndicators,
        ideal: nextIdeal,
        idealLower: nextIdealLower,
        idealUpper: nextIdealUpper,
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
        gridTemplateColumns={isQuad ? 'repeat(2, minmax(0, 1fr))' : '1fr'}
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
            <VStack spacing={3} align="stretch">
              {editableTargetKeys.map((key) => (
                <FormControl key={key}>
                  <FormLabel fontSize="sm" color="gray.200" mb={1}>
                    {attributeDetails[key] ?? key}
                  </FormLabel>
                  <Input
                    value={targetDraftValues[key] ?? ''}
                    onChange={(e) =>
                      setTargetDraftValues((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                    placeholder="Enter target value"
                    bg="whiteAlpha.100"
                    borderColor="whiteAlpha.300"
                  />
                </FormControl>
              ))}
            </VStack>
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
