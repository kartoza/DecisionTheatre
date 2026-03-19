import {
  Box,
  VStack,
  Heading,
  Text,
  Select,
  Divider,
  Badge,
  useColorModeValue,
  Slide,
  IconButton,
  HStack,
  Tooltip,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Button,
  ButtonGroup,
} from '@chakra-ui/react';
import { FiChevronRight, FiInfo, FiX, FiMapPin, FiGlobe, FiSquare, FiTarget } from 'react-icons/fi';
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useAttributeCanMap, useAttributeCanGraph, useAttributeColors, useAttributeDetails, useColumns } from '../hooks/useApi';
import { PRISM_CSS_GRADIENT, formatNumber } from './MapView';
import type { Scenario, ComparisonState, IdentifyResult, MapStatistics, ColorScaleMode, ViewMode, RangeMode } from '../types';
import { SCENARIOS } from '../types';

interface ControlPanelProps {
  isOpen: boolean;
  comparison: ComparisonState;
  onLeftChange: (scenario: Scenario) => void;
  onRightChange: (scenario: Scenario) => void;
  onAttributeChange: (attribute: string) => void;
  paneIndex: number | null;
  viewMode?: ViewMode;
  identifyResult?: IdentifyResult;
  onClearIdentify?: () => void;
  isExploreMode?: boolean;
  onNavigateToCreateSite?: () => void;
  mapStatistics?: MapStatistics;
  isSwiperEnabled?: boolean;
  isSiteAggregationActive?: boolean;
  hideScenarioSelectors?: boolean;
  hideColorScale?: boolean;
  colorScaleMode: ColorScaleMode;
  onColorScaleModeChange: (mode: ColorScaleMode) => void;
  rangeMode?: RangeMode;
  onRangeModeChange?: (mode: RangeMode) => void;
}

import type { ZoneStats } from '../types';

const MIN_LEGEND_OPACITY = 0.15;
const MAX_LEGEND_OPACITY = 0.9;

function getTrend(current: number, reference: number): 'up' | 'down' | 'neutral' {
  const threshold = 0.05;
  const change = (current - reference) / Math.abs(reference || 1);
  if (change > threshold) return 'up';
  if (change < -threshold) return 'down';
  return 'neutral';
}

type ReferenceDeltaDirection = 'left' | 'right' | 'neutral';

function getReferenceDirection(value: number, reference: number): ReferenceDeltaDirection {
  if (value > reference) return 'right';
  if (value < reference) return 'left';
  return 'neutral';
}

function ReferenceTrendBar({ reference, value, color }: { reference: number; value: number; color: string }) {
  const maxLinePx = 28;
  const referenceMagnitude = Math.abs(reference) || 1;
  const delta = value - reference;
  const direction = getReferenceDirection(value, reference);
  const ratio = Math.min(1, Math.abs(delta) / referenceMagnitude);
  const width = Math.max(2, ratio * maxLinePx);

  return (
    <Box position="relative" w="72px" h="12px" aria-hidden="true">
      <Box
        position="absolute"
        left="50%"
        top="1px"
        bottom="1px"
        w="2px"
        bg="gray.500"
        transform="translateX(-1px)"
        borderRadius="full"
      />
      {direction === 'neutral' ? (
        <Box
          position="absolute"
          left="50%"
          top="4px"
          w="4px"
          h="4px"
          bg={color}
          borderRadius="full"
          transform="translateX(-2px)"
        />
      ) : (
        <Box
          position="absolute"
          top="5px"
          left={
            direction === 'right'
              ? `calc(50% + 1px)`
              : `calc(50% - ${width + 1}px)`
          }
          w={`${width}px`}
          h="2px"
          bg={color}
          borderRadius="full"
        />
      )}
    </Box>
  );
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = hex.trim().replace('#', '');
  if (normalized.length === 3) {
    const r = parseInt(normalized[0] + normalized[0], 16);
    const g = parseInt(normalized[1] + normalized[1], 16);
    const b = parseInt(normalized[2] + normalized[2], 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : { r, g, b };
  }
  if (normalized.length === 6) {
    const r = parseInt(normalized.slice(0, 2), 16);
    const g = parseInt(normalized.slice(2, 4), 16);
    const b = parseInt(normalized.slice(4, 6), 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : { r, g, b };
  }
  return null;
}

function buildOpacityGradient(color?: string): string {
  if (!color) return PRISM_CSS_GRADIENT;
  const rgb = hexToRgb(color);
  if (!rgb) return PRISM_CSS_GRADIENT;
  return `linear-gradient(to right, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${MIN_LEGEND_OPACITY}), rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${MAX_LEGEND_OPACITY}))`;
}

function ScenarioSelector({
  label,
  value,
  onChange,
  side,
  zoneStats,
  hideLabel,
  zoneStatsLabel,
}: {
  label: string;
  value: Scenario;
  onChange: (s: Scenario) => void;
  side: 'left' | 'right';
  zoneStats?: ZoneStats | null;
  hideLabel?: boolean;
  zoneStatsLabel?: string;
}) {
  const selectedInfo = SCENARIOS.find((s) => s.id === value);
  const borderColor = useColorModeValue('gray.200', 'gray.600');

  return (
    <Box
      p={4}
      borderRadius="lg"
      border="1px"
      borderColor={borderColor}
      bg={useColorModeValue('white', 'gray.750')}
      _hover={{ borderColor: selectedInfo?.color || 'brand.400' }}
      transition="border-color 0.2s"
    >
      {!hideLabel && (
        <HStack mb={2}>
          <Badge
            colorScheme={side === 'left' ? 'orange' : 'blue'}
            variant="subtle"
            fontSize="xs"
            borderRadius="full"
          >
            {side === 'left' ? 'LEFT' : 'RIGHT'}
          </Badge>
          <Text fontSize="sm" fontWeight="600" color="gray.400">
            {label}
          </Text>
        </HStack>
      )}

      <Select
        value={value}
        onChange={(e) => onChange(e.target.value as Scenario)}
        size="md"
        bg={useColorModeValue('gray.50', 'gray.700')}
        border="none"
        fontWeight="500"
        _focus={{ boxShadow: `0 0 0 2px ${selectedInfo?.color || '#2bb0ed'}` }}
      >
        {SCENARIOS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </Select>

      {selectedInfo && (
        <Text fontSize="xs" color="gray.500" mt={2}>
          {selectedInfo.description}
        </Text>
      )}

      {/* Zone statistics for visible catchments */}
      {zoneStats && (
        <Box mt={3} pt={3} borderTop="1px" borderColor={borderColor}>
          <Text fontSize="xs" color="gray.500" mb={2}>
            {zoneStatsLabel ?? 'Visible Zone Statistics'} ({zoneStats.count} catchments)
          </Text>
          <HStack justify="space-between">
            <VStack spacing={0} align="start">
              <Text fontSize="10px" color="gray.500">Min</Text>
              <Text fontSize="sm" fontWeight="600" color={selectedInfo?.color || 'white'}>
                {formatNumber(zoneStats.min)}
              </Text>
            </VStack>
            <VStack spacing={0} align="center">
              <Text fontSize="10px" color="gray.500">Mean</Text>
              <Text fontSize="sm" fontWeight="600" color={selectedInfo?.color || 'white'}>
                {formatNumber(zoneStats.mean)}
              </Text>
            </VStack>
            <VStack spacing={0} align="end">
              <Text fontSize="10px" color="gray.500">Max</Text>
              <Text fontSize="sm" fontWeight="600" color={selectedInfo?.color || 'white'}>
                {formatNumber(zoneStats.max)}
              </Text>
            </VStack>
          </HStack>
        </Box>
      )}
    </Box>
  );
}

function ControlPanel({
  isOpen,
  comparison,
  onLeftChange,
  onRightChange,
  onAttributeChange,
  paneIndex,
  viewMode = 'map',
  identifyResult,
  onClearIdentify,
  isExploreMode,
  onNavigateToCreateSite,
  mapStatistics,
  isSwiperEnabled = true,
  isSiteAggregationActive = false,
  hideScenarioSelectors = false,
  hideColorScale = false,
  colorScaleMode,
  onColorScaleModeChange,
  rangeMode = 'domain',
  onRangeModeChange,
}: ControlPanelProps) {
  const { columns, loading: columnsLoading } = useColumns();
  const { colors: attributeColors } = useAttributeColors();
  const { details: attributeDetails } = useAttributeDetails();
  const { canMap } = useAttributeCanMap();
  const { canGraph } = useAttributeCanGraph();
  const bgColor = useColorModeValue('gray.50', 'gray.800');
  const borderColor = useColorModeValue('gray.200', 'gray.700');
  const cardBg = useColorModeValue('white', 'gray.750');
  const tableHeaderBg = useColorModeValue('gray.100', 'gray.700');
  const attributeColor = colorScaleMode === 'metadata' && comparison.attribute
    ? attributeColors[comparison.attribute]
    : undefined;
  const effectiveRangeMode: RangeMode = isSiteAggregationActive ? 'site' : rangeMode;
  const zoneStatsLabel = effectiveRangeMode === 'domain'
    ? 'Full Zone Statistics'
    : effectiveRangeMode === 'extent'
      ? 'Extent Zone Statistics'
      : 'Site Zone Statistics';
  const leftZoneStats = effectiveRangeMode === 'domain'
    ? mapStatistics?.fullStats?.left ?? null
    : effectiveRangeMode === 'site'
      ? mapStatistics?.siteStats?.left ?? null
      : mapStatistics?.leftStats ?? null;
  const rightZoneStats = effectiveRangeMode === 'domain'
    ? mapStatistics?.fullStats?.right ?? null
    : effectiveRangeMode === 'site'
      ? mapStatistics?.siteStats?.right ?? null
      : mapStatistics?.rightStats ?? null;
  const [panelWidth, setPanelWidth] = useState(440);
  const [isResizing, setIsResizing] = useState(false);
  const resizeOriginX = useRef(0);
  const resizeOriginWidth = useRef(0);
  const minPanelWidth = 320;
  const maxPanelWidth = 720;

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (event: MouseEvent) => {
      const delta = resizeOriginX.current - event.clientX;
      const nextWidth = Math.min(
        maxPanelWidth,
        Math.max(minPanelWidth, resizeOriginWidth.current + delta)
      );
      setPanelWidth(nextWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  const handleResizeStart = (event: ReactMouseEvent<HTMLDivElement>) => {
    resizeOriginX.current = event.clientX;
    resizeOriginWidth.current = panelWidth;
    setIsResizing(true);
  };

  return (
    <Slide
      direction="right"
      in={isOpen}
      style={{
        zIndex: 15,
        position: 'fixed',
        top: 0,
        right: 0,
        height: '100%',
        width: 'auto',
      }}
    >
      <Box
        w={{ base: '100vw', md: `${panelWidth}px` }}
        h="100%"
        bg={bgColor}
        borderLeft="1px"
        borderColor={borderColor}
        overflowY="auto"
        boxShadow="-4px 0 24px rgba(0,0,0,0.15)"
        pt="56px" // Header height offset
        position="relative"
      >
        <Box
          display={{ base: 'none', md: 'block' }}
          position="absolute"
          left={0}
          top={0}
          bottom={0}
          width="6px"
          cursor="col-resize"
          zIndex={2}
          onMouseDown={handleResizeStart}
          _hover={{ bg: 'blackAlpha.200' }}
        />
        {/* Close hint for mobile */}
        <Box display={{ base: 'block', md: 'none' }} p={2} textAlign="right">
          <IconButton
            aria-label="Close panel"
            icon={<FiChevronRight />}
            size="sm"
            variant="ghost"
          />
        </Box>

        <VStack spacing={6} p={6} align="stretch">
          {/* Create Site button - shown prominently at top in explore mode */}
          {isExploreMode && onNavigateToCreateSite && (
            <Box>
              <Button
                size="lg"
                width="100%"
                leftIcon={<FiMapPin />}
                onClick={onNavigateToCreateSite}
                bgGradient="linear(to-r, cyan.400, purple.500)"
                color="white"
                _hover={{
                  transform: 'translateY(-2px)',
                  boxShadow: '0 10px 30px -10px rgba(0, 255, 255, 0.5)',
                  bgGradient: 'linear(to-r, cyan.300, purple.400)',
                }}
                transition="all 0.2s"
              >
                Create Site
              </Button>
              <Text fontSize="xs" color="gray.500" mt={2} textAlign="center">
                Define a site boundary for your analysis
              </Text>
            </Box>
          )}

          {/* Title */}
          <Box>
            <HStack mb={1}>
              <Heading size="sm">
                Indicator
              </Heading>
              {paneIndex !== null && (
                <Badge colorScheme="purple" variant="subtle" fontSize="xs" borderRadius="full">
                  Pane {paneIndex + 1}
                </Badge>
              )}
            </HStack>
            <Text fontSize="sm" color="gray.500">
              Choose a factor to display in this view.
            </Text>
          </Box>

          <Divider />

          {viewMode !== 'dial' && !hideScenarioSelectors && (
            <>
              {/* Scenario 1 (Left) */}
              <ScenarioSelector
                label="Scenario 1"
                value={comparison.leftScenario}
                onChange={onLeftChange}
                side="left"
                zoneStats={leftZoneStats}
                hideLabel={isSiteAggregationActive}
                zoneStatsLabel={zoneStatsLabel}
              />

              {/* Scenario 2 (Right) */}
              {isSwiperEnabled && !isSiteAggregationActive && (
                <ScenarioSelector
                  label="Scenario 2"
                  value={comparison.rightScenario}
                  onChange={onRightChange}
                  side="right"
                  zoneStats={rightZoneStats}
                  zoneStatsLabel={zoneStatsLabel}
                />
              )}
            </>
          )}

          {viewMode !== 'dial' && onRangeModeChange && (
            <Box>
              <HStack justify="space-between" align="center" mb={2}>
                <Text fontSize="xs" fontWeight="600" color="gray.500">
                  ZONE RANGE
                </Text>
              </HStack>
              <ButtonGroup size="xs" isAttached variant="outline">
                <Button
                  leftIcon={<FiGlobe size={12} />}
                  onClick={() => onRangeModeChange('domain')}
                  variant={rangeMode === 'domain' ? 'solid' : 'outline'}
                  colorScheme={rangeMode === 'domain' ? 'cyan' : 'gray'}
                >
                  Full
                </Button>
                <Button
                  leftIcon={<FiSquare size={12} />}
                  onClick={() => onRangeModeChange('extent')}
                  variant={rangeMode === 'extent' ? 'solid' : 'outline'}
                  colorScheme={rangeMode === 'extent' ? 'cyan' : 'gray'}
                >
                  Extent
                </Button>
                <Button
                  leftIcon={<FiTarget size={12} />}
                  onClick={() => onRangeModeChange('site')}
                  variant={rangeMode === 'site' ? 'solid' : 'outline'}
                  colorScheme={rangeMode === 'site' ? 'cyan' : 'gray'}
                >
                  Site
                </Button>
              </ButtonGroup>
            </Box>
          )}

          {viewMode !== 'dial' && <Divider />}

          {/* Attribute selection */}
          <Box
            p={4}
            borderRadius="lg"
            border="1px"
            borderColor={borderColor}
            bg={useColorModeValue('white', 'gray.750')}
          >
            <HStack mb={2}>
              <Badge colorScheme="green" variant="subtle" fontSize="xs" borderRadius="full">
                FACTOR
              </Badge>
              <Tooltip label="Select a data attribute to visualize on the map">
                <Box cursor="help">
                  <FiInfo size={14} color="gray" />
                </Box>
              </Tooltip>
            </HStack>

            <Select
              value={comparison.attribute}
              onChange={(e) => onAttributeChange(e.target.value)}
              placeholder={columnsLoading ? 'Loading...' : 'Select an attribute'}
              size="md"
              bg={useColorModeValue('gray.50', 'gray.700')}
              border="none"
              fontWeight="500"
              _focus={{ boxShadow: '0 0 0 2px #4caf50' }}
            >
              {(Object.keys((viewMode === 'dial' ? canGraph : canMap) || {}).length > 0
                ? columns.filter((col) => (viewMode === 'dial' ? canGraph[col] : canMap[col]))
                : columns
              ).map((col) => {
                const displayName = attributeDetails[col]
                  ?? col
                    .replace(/_/g, ' ')
                    .replace(/\b\w/g, (c) => c.toUpperCase());
                return (
                <option key={col} value={col}>
                  {displayName}
                </option>
                );
              })}
            </Select>

            {comparison.attribute && (
              <Text fontSize="xs" color="gray.500" mt={2}>
                Showing{' '}
                <Text as="span" fontWeight="600" color="green.400">
                  {attributeDetails[comparison.attribute]
                    ?? comparison.attribute.replace(/_/g, ' ')}
                </Text>{' '}
                values per catchment
              </Text>
            )}

          </Box>

          <Divider />

          {/* Legend */}
          {comparison.attribute && viewMode !== 'dial' && !hideColorScale && (
            <Box>
              <HStack justify="space-between" align="center" mb={2}>
                <Text fontSize="xs" fontWeight="600" color="gray.500">
                  COLOR SCALE (Domain Range)
                </Text>
                <ButtonGroup size="xs" isAttached variant="outline">
                  <Button
                    onClick={() => onColorScaleModeChange('rainbow')}
                    variant={colorScaleMode === 'rainbow' ? 'solid' : 'outline'}
                    colorScheme={colorScaleMode === 'rainbow' ? 'purple' : 'gray'}
                  >
                    Rainbow
                  </Button>
                  <Button
                    onClick={() => onColorScaleModeChange('metadata')}
                    variant={colorScaleMode === 'metadata' ? 'solid' : 'outline'}
                    colorScheme={colorScaleMode === 'metadata' ? 'teal' : 'gray'}
                  >
                    Metadata
                  </Button>
                </ButtonGroup>
              </HStack>
              <Box
                h="12px"
                borderRadius="full"
                bg={buildOpacityGradient(attributeColor)}
              />
              <HStack justify="space-between" mt={1}>
                <Text fontSize="xs" color="gray.500">
                  {mapStatistics?.domainRange
                    ? formatNumber(mapStatistics.domainRange.min)
                    : 'Low'}
                </Text>
                <Text fontSize="xs" color="gray.500">
                  {mapStatistics?.domainRange
                    ? formatNumber(mapStatistics.domainRange.max)
                    : 'High'}
                </Text>
              </HStack>
            </Box>
          )}

          {/* Identify Results */}
          {identifyResult && (
            <>
              <Divider />
              <Box>
                <HStack justify="space-between" mb={3}>
                  <HStack>
                    <Badge colorScheme="blue" variant="subtle" fontSize="xs" borderRadius="full">
                      IDENTIFY
                    </Badge>
                    <Text fontSize="sm" fontWeight="600" color="gray.400">
                      Catchment {identifyResult.catchmentID}
                    </Text>
                  </HStack>
                  {onClearIdentify && (
                    <IconButton
                      aria-label="Clear identify"
                      icon={<FiX />}
                      size="xs"
                      variant="ghost"
                      onClick={onClearIdentify}
                    />
                  )}
                </HStack>

                <Box
                  borderRadius="lg"
                  border="1px"
                  borderColor={borderColor}
                  bg={cardBg}
                  overflowX="auto"
                  maxH="400px"
                  overflowY="auto"
                >
                  <Table size="sm" variant="striped">
                    <Thead
                      position="sticky"
                      top={0}
                      zIndex={2}
                      boxShadow="0 2px 4px rgba(0,0,0,0.1)"
                    >
                      <Tr>
                        <Th fontSize="xs" py={2} bg={tableHeaderBg}>Attribute</Th>
                        {(() => {
                          const leftInfo = SCENARIOS.find((s) => s.id === comparison.leftScenario);
                          const rightInfo = SCENARIOS.find((s) => s.id === comparison.rightScenario);
                          return (
                            <>
                              <Th
                                fontSize="xs"
                                py={2}
                                isNumeric
                                borderLeft={`3px solid ${leftInfo?.color || '#fff'}`}
                                color={leftInfo?.color}
                                bg={tableHeaderBg}
                              >
                                Left: {leftInfo?.label || comparison.leftScenario}
                              </Th>
                              <Th fontSize="xs" py={2} bg={tableHeaderBg} textAlign="center">
                                Trend
                              </Th>
                              <Th
                                fontSize="xs"
                                py={2}
                                isNumeric
                                borderLeft={`3px solid ${rightInfo?.color || '#fff'}`}
                                color={rightInfo?.color}
                                bg={tableHeaderBg}
                              >
                                Right: {rightInfo?.label || comparison.rightScenario}
                              </Th>
                            </>
                          );
                        })()}
                      </Tr>
                    </Thead>
                    <Tbody>
                      {(() => {
                        // Collect all attribute names across scenarios
                        const allAttrs = new Set<string>();
                        for (const scenarioData of Object.values(identifyResult.data)) {
                          for (const attr of Object.keys(scenarioData)) {
                            allAttrs.add(attr);
                          }
                        }
                        // Use ordered scenarios matching left/right panes
                        const orderedScenarios = [comparison.leftScenario, comparison.rightScenario];
                        return Array.from(allAttrs).sort().map((attr) => {
                          // Get values for both scenarios
                          const leftVal = identifyResult.data[orderedScenarios[0]]?.[attr];
                          const rightVal = identifyResult.data[orderedScenarios[1]]?.[attr];
                          const displayName = attributeDetails[attr] ?? attr;
                          const hasNumbers = typeof leftVal === 'number' && typeof rightVal === 'number';
                          const trend = hasNumbers ? getTrend(rightVal as number, leftVal as number) : 'neutral';
                          const trendColor = trend === 'up' ? 'red.400' : trend === 'down' ? 'red.400' : 'gray.400';

                          return (
                            <Tr key={attr}>
                              <Td
                                fontSize="xs"
                                fontWeight={attr === comparison.attribute ? '700' : '400'}
                                color={attr === comparison.attribute ? 'blue.400' : undefined}
                                py={1.5}
                                maxW="160px"
                                overflow="hidden"
                                textOverflow="ellipsis"
                                whiteSpace="nowrap"
                                title={displayName}
                              >
                                {displayName}
                              </Td>
                              {/* Left scenario cell */}
                              <Td
                                fontSize="xs"
                                isNumeric
                                py={1.5}
                                position="relative"
                                overflow="hidden"
                              >
                                <Text>{leftVal != null ? leftVal.toFixed(2) : '-'}</Text>
                              </Td>
                              {/* Trend cell */}
                              <Td fontSize="xs" py={1.5} textAlign="center">
                                <HStack justify="center" spacing={2}>
                                  {hasNumbers ? (
                                    <ReferenceTrendBar
                                      reference={leftVal as number}
                                      value={rightVal as number}
                                      color={trendColor}
                                    />
                                  ) : (
                                    <Text color="gray.500">-</Text>
                                  )}
                                </HStack>
                              </Td>
                              {/* Right scenario cell */}
                              <Td
                                fontSize="xs"
                                isNumeric
                                py={1.5}
                                position="relative"
                                overflow="hidden"
                              >
                                <Text>{rightVal != null ? rightVal.toFixed(2) : '-'}</Text>
                              </Td>
                            </Tr>
                          );
                        });
                      })()}
                    </Tbody>
                  </Table>
                </Box>
              </Box>
            </>
          )}

          {/* Info footer intentionally hidden */}
        </VStack>
      </Box>
    </Slide>
  );
}

export default ControlPanel;
