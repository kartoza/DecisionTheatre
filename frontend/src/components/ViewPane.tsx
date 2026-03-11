import { useState, useCallback, useMemo } from 'react';
import { Box, HStack, IconButton, Tooltip, useColorModeValue } from '@chakra-ui/react';
import { FiBarChart2, FiMap, FiMaximize, FiGrid, FiActivity } from 'react-icons/fi';
import MapView from './MapView';
import ChartView from './ChartView';
import DialChart from './DialChart';
import type { ComparisonState, LayoutMode, IdentifyResult, MapExtent, MapStatistics, BoundingBox, ColorScaleMode, ViewMode, RangeMode, SiteIndicators } from '../types';
import { SCENARIOS } from '../types';

interface ViewPaneProps {
  comparison: ComparisonState;
  compact?: boolean;
  paneIndex: number;
  layoutMode: LayoutMode;
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
  // Dial chart props
  siteIndicators?: SiteIndicators | null;
  rangeMode?: RangeMode;
  onRangeModeChange?: (mode: RangeMode) => void;
  mapStatistics?: MapStatistics | null;
}

// View mode cycle order
const VIEW_MODES: ViewMode[] = ['map', 'chart', 'dial'];

// Icons and labels for each view mode
const VIEW_MODE_CONFIG: Record<ViewMode, { icon: React.ReactElement; label: string; nextLabel: string }> = {
  map: { icon: <FiMap />, label: 'Map', nextLabel: 'Show line chart' },
  chart: { icon: <FiBarChart2 />, label: 'Chart', nextLabel: 'Show dial gauge' },
  dial: { icon: <FiActivity />, label: 'Dial', nextLabel: 'Show map' },
};

function ViewPane({
  comparison,
  compact = false,
  paneIndex,
  layoutMode,
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
  siteIndicators,
  rangeMode = 'domain',
  onRangeModeChange,
  mapStatistics,
}: ViewPaneProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('map');
  const borderColor = useColorModeValue('gray.600', 'gray.600');

  // Cycle through view modes: map -> chart -> dial -> map
  const handleToggleViewMode = useCallback(() => {
    setViewMode((prev) => {
      const currentIndex = VIEW_MODES.indexOf(prev);
      const nextIndex = (currentIndex + 1) % VIEW_MODES.length;
      return VIEW_MODES[nextIndex];
    });
  }, []);

  // Calculate dial chart values based on current attribute and range mode
  const dialData = useMemo(() => {
    const attribute = comparison.attribute;
    if (!attribute) return null;

    let min = 0;
    let max = 100;
    let referenceValue: number | undefined;
    let currentValue: number | undefined;
    let targetValue: number | undefined;

    // Get values from site indicators if available
    if (siteIndicators) {
      referenceValue = siteIndicators.reference?.[attribute];
      currentValue = siteIndicators.current?.[attribute];
      targetValue = siteIndicators.ideal?.[attribute];
    }

    // Determine min/max based on range mode
    switch (rangeMode) {
      case 'site':
        // Use min/max from site indicators
        if (siteIndicators) {
          const values = [
            siteIndicators.reference?.[attribute],
            siteIndicators.current?.[attribute],
            siteIndicators.ideal?.[attribute],
          ].filter((v): v is number => typeof v === 'number' && !isNaN(v));
          if (values.length > 0) {
            min = Math.min(...values) * 0.9; // 10% padding
            max = Math.max(...values) * 1.1;
          }
        }
        break;
      case 'extent':
        // Use min/max from current map extent statistics
        if (mapStatistics?.leftStats && mapStatistics?.rightStats) {
          min = Math.min(mapStatistics.leftStats.min, mapStatistics.rightStats.min);
          max = Math.max(mapStatistics.leftStats.max, mapStatistics.rightStats.max);
        } else if (mapStatistics?.leftStats) {
          min = mapStatistics.leftStats.min;
          max = mapStatistics.leftStats.max;
        } else if (mapStatistics?.rightStats) {
          min = mapStatistics.rightStats.min;
          max = mapStatistics.rightStats.max;
        }
        break;
      case 'domain':
      default:
        // Use full domain range
        if (mapStatistics?.domainRange) {
          min = mapStatistics.domainRange.min;
          max = mapStatistics.domainRange.max;
        }
        break;
    }

    // Ensure min < max
    if (min >= max) {
      const mid = (min + max) / 2 || 50;
      min = mid - 10;
      max = mid + 10;
    }

    return { min, max, referenceValue, currentValue, targetValue };
  }, [comparison.attribute, siteIndicators, rangeMode, mapStatistics]);

  const leftInfo = SCENARIOS.find((s) => s.id === comparison.leftScenario);
  const rightInfo = SCENARIOS.find((s) => s.id === comparison.rightScenario);
  const paneLabel = `${leftInfo?.label || ''} vs ${rightInfo?.label || ''}`;

  const isQuad = layoutMode === 'quad';
  const btnSize = compact ? 'xs' : 'sm';

  return (
    <Box
      position="relative"
      w="100%"
      h="100%"
      overflow="hidden"
      border={compact ? '1px' : 'none'}
      borderColor={borderColor}
    >
      {/* Map layer */}
      <Box
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        opacity={viewMode === 'map' ? 1 : 0}
        transition="opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1)"
        pointerEvents={viewMode === 'map' ? 'auto' : 'none'}
      >
        <MapView
          comparison={comparison}
          onOpenSettings={() => onFocusPane(paneIndex)}
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
        />
      </Box>

      {/* Line Chart layer */}
      <ChartView visible={viewMode === 'chart'} />

      {/* Dial Chart layer */}
      <DialChart
        visible={viewMode === 'dial'}
        referenceValue={dialData?.referenceValue}
        currentValue={dialData?.currentValue}
        targetValue={dialData?.targetValue}
        min={dialData?.min ?? 0}
        max={dialData?.max ?? 100}
        attribute={comparison.attribute}
        rangeMode={rangeMode}
        onRangeModeChange={onRangeModeChange}
      />

      {/* Pane label (shown in quad mode) */}
      {compact && (
        <Box
          position="absolute"
          top={2}
          left={2}
          zIndex={5}
          bg="blackAlpha.700"
          color="white"
          px={3}
          py={1}
          borderRadius="md"
          fontSize="xs"
          fontWeight="600"
          letterSpacing="0.5px"
          backdropFilter="blur(8px)"
          pointerEvents="none"
        >
          {paneLabel}
        </Box>
      )}

      {/* Per-pane toolbar */}
      <HStack
        position="absolute"
        bottom={compact ? 2 : 3}
        right={compact ? 2 : 3}
        zIndex={5}
        spacing={1}
        bg="blackAlpha.600"
        borderRadius="lg"
        px={1.5}
        py={1}
        backdropFilter="blur(8px)"
        transition="opacity 0.3s ease"
      >
        {/* View mode toggle: map -> chart -> dial -> map */}
        <Tooltip label={VIEW_MODE_CONFIG[viewMode].nextLabel} placement="top">
          <IconButton
            aria-label="Toggle view mode"
            icon={VIEW_MODE_CONFIG[viewMode].icon}
            onClick={handleToggleViewMode}
            variant="ghost"
            color="white"
            _hover={{ bg: 'whiteAlpha.300' }}
            size={btnSize}
            borderRadius="md"
          />
        </Tooltip>

        {/* Layout toggle — context-dependent */}
        {isQuad ? (
          <Tooltip label="Focus this pane" placement="top">
            <IconButton
              aria-label="Focus pane"
              icon={<FiMaximize />}
              onClick={() => onFocusPane(paneIndex)}
              variant="ghost"
              color="white"
              _hover={{ bg: 'whiteAlpha.300' }}
              size={btnSize}
              borderRadius="md"
            />
          </Tooltip>
        ) : (
          <Tooltip label="Quad view" placement="top">
            <IconButton
              aria-label="Switch to quad view"
              icon={<FiGrid />}
              onClick={onGoQuad}
              variant="ghost"
              color="white"
              _hover={{ bg: 'whiteAlpha.300' }}
              size={btnSize}
              borderRadius="md"
            />
          </Tooltip>
        )}
      </HStack>
    </Box>
  );
}

export default ViewPane;
