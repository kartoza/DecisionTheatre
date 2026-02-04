import { useState, useCallback } from 'react';
import { Box, HStack, IconButton, Tooltip, useColorModeValue } from '@chakra-ui/react';
import { FiBarChart2, FiMap, FiMaximize, FiGrid } from 'react-icons/fi';
import MapView from './MapView';
import ChartView from './ChartView';
import type { ComparisonState, LayoutMode, IdentifyResult } from '../types';
import { SCENARIOS } from '../types';

interface ViewPaneProps {
  comparison: ComparisonState;
  compact?: boolean;
  paneIndex: number;
  layoutMode: LayoutMode;
  onFocusPane: (index: number) => void;
  onGoQuad: () => void;
  onIdentify?: (result: IdentifyResult) => void;
}

function ViewPane({
  comparison,
  compact = false,
  paneIndex,
  layoutMode,
  onFocusPane,
  onGoQuad,
  onIdentify,
}: ViewPaneProps) {
  const [isChartView, setIsChartView] = useState(false);
  const borderColor = useColorModeValue('gray.600', 'gray.600');

  const handleToggle = useCallback(() => {
    setIsChartView((prev) => !prev);
  }, []);

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
        opacity={isChartView ? 0 : 1}
        transition="opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1)"
        pointerEvents={isChartView ? 'none' : 'auto'}
      >
        <MapView
          comparison={comparison}
          paneIndex={paneIndex}
          onOpenSettings={() => onFocusPane(paneIndex)}
          onIdentify={onIdentify}
        />
      </Box>

      {/* Chart layer */}
      <ChartView visible={isChartView} />

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
        {/* Map / Chart toggle */}
        <Tooltip label={isChartView ? 'Show map' : 'Show chart'} placement="top">
          <IconButton
            aria-label="Toggle map/chart"
            icon={isChartView ? <FiMap /> : <FiBarChart2 />}
            onClick={handleToggle}
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
