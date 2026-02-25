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
} from '@chakra-ui/react';
import { FiChevronRight, FiInfo, FiX, FiMapPin } from 'react-icons/fi';
import { useColumns } from '../hooks/useApi';
import { PRISM_CSS_GRADIENT, formatNumber } from './MapView';
import type { Scenario, ComparisonState, IdentifyResult, MapStatistics } from '../types';
import { SCENARIOS } from '../types';

interface ControlPanelProps {
  isOpen: boolean;
  comparison: ComparisonState;
  onLeftChange: (scenario: Scenario) => void;
  onRightChange: (scenario: Scenario) => void;
  onAttributeChange: (attribute: string) => void;
  paneIndex: number | null;
  identifyResult?: IdentifyResult;
  onClearIdentify?: () => void;
  isExploreMode?: boolean;
  onNavigateToCreateSite?: () => void;
  mapStatistics?: MapStatistics;
  isSwiperEnabled?: boolean;
}

import type { ZoneStats } from '../types';

function ScenarioSelector({
  label,
  value,
  onChange,
  side,
  zoneStats,
}: {
  label: string;
  value: Scenario;
  onChange: (s: Scenario) => void;
  side: 'left' | 'right';
  zoneStats?: ZoneStats | null;
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
            Visible Zone Statistics ({zoneStats.count} catchments)
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
  identifyResult,
  onClearIdentify,
  isExploreMode,
  onNavigateToCreateSite,
  mapStatistics,
  isSwiperEnabled = true,
}: ControlPanelProps) {
  const { columns, loading: columnsLoading } = useColumns();
  const bgColor = useColorModeValue('gray.50', 'gray.800');
  const borderColor = useColorModeValue('gray.200', 'gray.700');
  const cardBg = useColorModeValue('white', 'gray.750');
  const tableHeaderBg = useColorModeValue('gray.100', 'gray.700');

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
        w={{ base: '100vw', md: '400px', lg: '440px' }}
        h="100%"
        bg={bgColor}
        borderLeft="1px"
        borderColor={borderColor}
        overflowY="auto"
        boxShadow="-4px 0 24px rgba(0,0,0,0.15)"
        pt="56px" // Header height offset
      >
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
              Choose a factor to colour the catchments on this map.
            </Text>
          </Box>

          <Divider />

          {/* Scenario 1 (Left) */}
          <ScenarioSelector
            label="Scenario 1"
            value={comparison.leftScenario}
            onChange={onLeftChange}
            side="left"
            zoneStats={mapStatistics?.leftStats}
          />

          {/* Scenario 2 (Right) */}
          {isSwiperEnabled && (
            <ScenarioSelector
              label="Scenario 2"
              value={comparison.rightScenario}
              onChange={onRightChange}
              side="right"
              zoneStats={mapStatistics?.rightStats}
            />
          )}

          <Divider />

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
              {columns.map((col) => (
                <option key={col} value={col}>
                  {col
                    .replace(/_/g, ' ')
                    .replace(/\b\w/g, (c) => c.toUpperCase())}
                </option>
              ))}
            </Select>

            {comparison.attribute && (
              <Text fontSize="xs" color="gray.500" mt={2}>
                Showing{' '}
                <Text as="span" fontWeight="600" color="green.400">
                  {comparison.attribute.replace(/_/g, ' ')}
                </Text>{' '}
                values per catchment
              </Text>
            )}
          </Box>

          <Divider />

          {/* Legend */}
          {comparison.attribute && (
            <Box>
              <Text fontSize="xs" fontWeight="600" color="gray.500" mb={2}>
                COLOR SCALE (Domain Range)
              </Text>
              <Box
                h="12px"
                borderRadius="full"
                bg={PRISM_CSS_GRADIENT}
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
                  overflow="hidden"
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
                        {/* Order columns to match left/right map panes */}
                        {[comparison.leftScenario, comparison.rightScenario].map((scenarioId, idx) => {
                          const scenarioInfo = SCENARIOS.find((s) => s.id === scenarioId);
                          return (
                            <Th
                              key={scenarioId}
                              fontSize="xs"
                              py={2}
                              isNumeric
                              borderLeft={`3px solid ${scenarioInfo?.color || '#fff'}`}
                              color={scenarioInfo?.color}
                              bg={tableHeaderBg}
                            >
                              {idx === 0 ? 'Left: ' : 'Right: '}{scenarioInfo?.label || scenarioId}
                            </Th>
                          );
                        })}
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

                          // Calculate bar widths (percentage of cell)
                          const maxVal = Math.max(
                            typeof leftVal === 'number' ? Math.abs(leftVal) : 0,
                            typeof rightVal === 'number' ? Math.abs(rightVal) : 0
                          );

                          const leftBarWidth = maxVal > 0 && typeof leftVal === 'number'
                            ? (Math.abs(leftVal) / maxVal) * 100
                            : 0;
                          const rightBarWidth = maxVal > 0 && typeof rightVal === 'number'
                            ? (Math.abs(rightVal) / maxVal) * 100
                            : 0;

                          // Get scenario colors
                          const leftScenarioInfo = SCENARIOS.find((s) => s.id === orderedScenarios[0]);
                          const rightScenarioInfo = SCENARIOS.find((s) => s.id === orderedScenarios[1]);

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
                                title={attr}
                              >
                                {attr}
                              </Td>
                              {/* Left scenario cell - bar from left */}
                              <Td
                                fontSize="xs"
                                isNumeric
                                py={1.5}
                                position="relative"
                                overflow="hidden"
                              >
                                {/* Bar background - originates from left */}
                                <Box
                                  position="absolute"
                                  top="2px"
                                  bottom="2px"
                                  left={0}
                                  width={`${leftBarWidth}%`}
                                  bg={leftScenarioInfo?.color || 'orange.400'}
                                  opacity={0.25}
                                  borderRightRadius="sm"
                                  transition="width 0.3s ease"
                                />
                                {/* Value text */}
                                <Text position="relative" zIndex={1}>
                                  {leftVal != null ? leftVal.toFixed(2) : '-'}
                                </Text>
                              </Td>
                              {/* Right scenario cell - bar from right */}
                              <Td
                                fontSize="xs"
                                isNumeric
                                py={1.5}
                                position="relative"
                                overflow="hidden"
                              >
                                {/* Bar background - originates from right */}
                                <Box
                                  position="absolute"
                                  top="2px"
                                  bottom="2px"
                                  right={0}
                                  width={`${rightBarWidth}%`}
                                  bg={rightScenarioInfo?.color || 'blue.400'}
                                  opacity={0.25}
                                  borderLeftRadius="sm"
                                  transition="width 0.3s ease"
                                />
                                {/* Value text */}
                                <Text position="relative" zIndex={1}>
                                  {rightVal != null ? rightVal.toFixed(2) : '-'}
                                </Text>
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

          {/* Info footer */}
          <Box mt="auto" pt={4}>
            <Text fontSize="xs" color="gray.600" textAlign="center">
              Drag the slider on the map to compare scenarios side by side.
              All data is served locally with no internet required.
            </Text>
          </Box>
        </VStack>
      </Box>
    </Slide>
  );
}

export default ControlPanel;
