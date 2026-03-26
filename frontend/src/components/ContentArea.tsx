import { Box } from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';
import ViewPane from './ViewPane';
import type { LayoutMode, PaneStates, IdentifyResult, MapExtent, MapStatistics, BoundingBox, ColorScaleMode, SiteIndicators, RangeMode, ViewMode } from '../types';

interface ContentAreaProps {
  mode: LayoutMode;
  paneStates: PaneStates;
  viewModes: ViewMode[];
  onViewModeChange: (paneIndex: number, mode: ViewMode) => void;
  focusedPane: number;
  onFocusPane: (index: number) => void;
  onGoQuad: () => void;
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
  chartGroup?: string | null;
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
  exit: (i: number) => ({
    opacity: 0,
    scale: 0.92,
    transition: {
      delay: (3 - i) * 0.06,
      duration: 0.3,
      ease: [0.4, 0, 1, 1],
    },
  }),
};

function ContentArea({
  mode,
  paneStates,
  viewModes,
  onViewModeChange,
  focusedPane,
  onFocusPane,
  onGoQuad,
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
  chartGroup,
}: ContentAreaProps) {
  const isQuad = mode === 'quad';

  // In single mode, show only the focused pane
  // In quad mode, show all 4
  const visibleIndices = isQuad ? [0, 1, 2, 3] : [focusedPane];

  return (
    <Box
      position="relative"
      w="100%"
      h="100%"
      display="grid"
      gridTemplateColumns={isQuad ? '1fr 1fr' : '1fr'}
      gridTemplateRows={isQuad ? '1fr 1fr' : '1fr'}
      gap={isQuad ? '2px' : 0}
      bg={isQuad ? 'gray.700' : 'transparent'}
      sx={{
        transition: 'grid-template-columns 0.6s cubic-bezier(0.16, 1, 0.3, 1), grid-template-rows 0.6s cubic-bezier(0.16, 1, 0.3, 1), gap 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {isQuad ? (
        <>
          {/* Pane 0 always rendered without AnimatePresence in quad */}
          <Box position="relative" overflow="hidden">
            <ViewPane
              comparison={paneStates[0]}
              compact
              paneIndex={0}
              layoutMode={mode}
              viewMode={viewModes[0]}
              onViewModeChange={onViewModeChange}
              onFocusPane={onFocusPane}
              onGoQuad={onGoQuad}
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
              chartGroup={chartGroup}
            />
          </Box>
          <AnimatePresence>
            {[1, 2, 3].map((i) => (
              <motion.div
                key={`pane-${i}`}
                custom={i}
                variants={paneVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                style={{ position: 'relative', overflow: 'hidden' }}
              >
                <ViewPane
                  comparison={paneStates[i]}
                  compact
                  paneIndex={i}
                  layoutMode={mode}
                  viewMode={viewModes[i]}
                  onViewModeChange={onViewModeChange}
                  onFocusPane={onFocusPane}
                  onGoQuad={onGoQuad}
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
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </>
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
            chartGroup={chartGroup}
          />
        </Box>
      )}
    </Box>
  );
}

export default ContentArea;
