import {
  Box,
  VStack,
  Heading,
  Text,
  Select,
  Input,
  Divider,
  Badge,
  useColorModeValue,
  Slide,
  IconButton,
  HStack,
  Tooltip,
  Button,
  ButtonGroup,
} from '@chakra-ui/react';
import { FiChevronRight, FiInfo, FiMapPin, FiGlobe, FiSquare, FiTarget } from 'react-icons/fi';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useAttributeCanMap, useAttributeCanGraph, useAttributeChartTypes, useAttributeColors, useColumns, useAttributeDetails, useAttributeGroupingVariables, useAttributeVariableTypes } from '../hooks/useApi';
import { PRISM_CSS_GRADIENT, formatNumber } from './MapView';
import type { Scenario, ComparisonState, MapStatistics, ColorScaleMode, ViewMode, RangeMode } from '../types';
import { SCENARIOS } from '../types';
import { colors } from '../styles/colors';

interface ControlPanelProps {
  isOpen: boolean;
  comparison: ComparisonState;
  onLeftChange: (scenario: Scenario) => void;
  onRightChange: (scenario: Scenario) => void;
  onAttributeChange: (attribute: string) => void;
  paneIndex: number | null;
  viewMode?: ViewMode;
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
  chartGroup?: string | null;
  onChartGroupChange?: (group: string | null) => void;
  chartAxisLabelFilter?: string | null;
  onChartAxisLabelFilterChange?: (axisLabel: string | null) => void;
  chartGraphMode?: 'line' | 'boxplot' | null;
  onChartGraphModeChange?: (mode: 'line' | 'boxplot' | null) => void;
}

import type { ZoneStats } from '../types';

function resolveGroupingVariableForColumn(column: string, groupingVariables: Record<string, string>): string {
  const candidates = [
    column,
    column.replace(/_/g, ' '),
    column.replace(/_/g, '.'),
    column.replace(/\./g, '_'),
    column.replace(/\./g, ' '),
    column.replace(/ /g, '_'),
    column.replace(/ /g, '.'),
  ];

  for (const key of candidates) {
    const group = groupingVariables[key];
    if (group && group.trim().length > 0) return group;
  }

  const normalizedColumn = normalizeColumnKey(column);
  for (const [key, group] of Object.entries(groupingVariables)) {
    if (normalizeColumnKey(key) === normalizedColumn && group.trim().length > 0) return group;
  }

  return '';
}

function resolveVariableTypeForColumn(column: string, variableTypes: Record<string, string>): string {
  const candidates = [
    column,
    column.replace(/_/g, ' '),
    column.replace(/_/g, '.'),
    column.replace(/\./g, '_'),
    column.replace(/\./g, ' '),
    column.replace(/ /g, '_'),
    column.replace(/ /g, '.'),
  ];

  for (const key of candidates) {
    const variableType = variableTypes[key];
    if (variableType && variableType.trim().length > 0) return variableType;
  }

  const normalizedColumn = normalizeColumnKey(column);
  for (const [key, variableType] of Object.entries(variableTypes)) {
    if (normalizeColumnKey(key) === normalizedColumn && variableType.trim().length > 0) return variableType;
  }

  return '';
}

function normalizeColumnKey(value: string): string {
  const normalized = value
    .trim()
    .replace(/_/g, '.')
    .replace(/ - /g, '.')
    .replace(/-/g, '.')
    .replace(/\s+/g, '.')
    .replace(/\$/g, '.')
    .replace(/'s/g, '.s')
    .replace(/'/g, '.')
    .replace(/\//g, '.')
    .replace(/\+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.|\.$/g, '')
    .toLowerCase();

  return normalized
    .replace(/\.functional\.group\./g, '.fg.')
    .replace(/\.species\./g, '.sp.')
    .replace(/\.{2,}/g, '.');
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
  return `linear-gradient(to right, rgb(255, 255, 255), rgb(${rgb.r}, ${rgb.g}, ${rgb.b}))`;
}

function SearchableSelect({
  value,
  onChange,
  options,
  placeholder,
  focusColor = '#2bb0ed',
  allowClear = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  focusColor?: string;
  allowClear?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const dropdownBg = useColorModeValue('white', 'gray.700');
  const hoverBg = useColorModeValue('gray.100', 'gray.600');
  const dropdownBorderColor = useColorModeValue('gray.200', 'gray.600');
  const inputBg = useColorModeValue('gray.50', 'gray.700');

  const selectedLabel = useMemo(
    () => options.find((o) => o.value === value)?.label ?? '',
    [options, value],
  );

  const filtered = useMemo(() => {
    if (!search) return options;
    const q = search.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, search]);

  const handleSelect = (val: string) => {
    onChange(val);
    setSearch('');
    setIsOpen(false);
  };

  return (
    <Box position="relative" mt={10}>
      <Input
        value={isOpen ? search : selectedLabel}
        onChange={(e) => setSearch(e.target.value)}
        onFocus={() => { setSearch(''); setIsOpen(true); }}
        onBlur={() => setTimeout(() => setIsOpen(false), 200)}
        placeholder={value ? selectedLabel : (placeholder ?? 'Select...')}
        size="md"
        bg={inputBg}
        border="none"
        fontWeight="500"
        _focus={{ boxShadow: `0 0 0 2px ${focusColor}` }}
      />
      {isOpen && (
        <Box
          position="absolute"
          top="100%"
          left={0}
          right={0}
          zIndex={20}
          bg={dropdownBg}
          border="1px"
          borderColor={dropdownBorderColor}
          borderRadius="md"
          boxShadow="lg"
          maxH="200px"
          overflowY="auto"
          mt={1}
        >
          {allowClear && (
            <Box
              px={3} py={2}
              fontSize="sm"
              cursor="pointer"
              color="gray.500"
              _hover={{ bg: hoverBg }}
              onMouseDown={() => handleSelect('')}
            >
              — None —
            </Box>
          )}
          {filtered.length === 0 ? (
            <Box px={3} py={2} fontSize="sm" color="gray.500">No results</Box>
          ) : (
            filtered.map((opt) => (
              <Box
                key={opt.value}
                px={3} py={2}
                fontSize="sm"
                cursor="pointer"
                fontWeight={opt.value === value ? '600' : '400'}
                color={opt.value === value ? 'white' : undefined}
                bg={opt.value === value ? 'blue.600' : undefined}
                _hover={{ bg: opt.value === value ? 'blue.700' : hoverBg }}
                onMouseDown={() => handleSelect(opt.value)}
              >
                {opt.label}
              </Box>
            ))
          )}
        </Box>
      )}
    </Box>
  );
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
            bg={side === 'left' ? colors.orange : colors.blue}
            color={colors.dark}
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
  chartGroup,
  onChartGroupChange,
  chartAxisLabelFilter,
  onChartAxisLabelFilterChange,
  chartGraphMode,
  onChartGraphModeChange,
}: ControlPanelProps) {
  const { columns, loading: columnsLoading } = useColumns();
  const { colors: attributeColors } = useAttributeColors();
  const { details: attributeDetails } = useAttributeDetails();
  const { canMap } = useAttributeCanMap();
  const { canGraph } = useAttributeCanGraph();
  const { chartTypes } = useAttributeChartTypes();
  const { groupingVariables } = useAttributeGroupingVariables();
  const { variableTypes } = useAttributeVariableTypes();
  const bgColor = useColorModeValue('gray.50', 'gray.800');
  const borderColor = useColorModeValue('gray.200', 'gray.700');
  const cardBg = useColorModeValue('white', 'gray.750');

  const uniqueVariableTypes = useMemo(
    () => [...new Set(Object.values(variableTypes))].filter((t) => t && t !== 'catchID').sort(),
    [variableTypes],
  );

  const groupingVariableOptions = useMemo(() => {
    if (!chartGroup) return [];

    const fromChartableColumns = columns
      .filter((col) => canGraph[col] && resolveVariableTypeForColumn(col, variableTypes) === chartGroup)
      .map((col) => resolveGroupingVariableForColumn(col, groupingVariables))
      .filter((group): group is string => Boolean(group && group.trim().length > 0 && group !== 'catchID'));

    const groups = fromChartableColumns.length > 0
      ? fromChartableColumns
      : Object.entries(groupingVariables)
          .filter(([col, group]) => {
            if (!group || group === 'catchID') return false;
            return resolveVariableTypeForColumn(col, variableTypes) === chartGroup;
          })
          .map(([, group]) => group);

    return [...new Set(groups)].sort().map((group) => ({ value: group, label: group.replace(/_/g, ' ') }));
  }, [chartGroup, columns, canGraph, variableTypes, groupingVariables]);

  const lineBoxplotToggleAvailable = useMemo(() => {
    if (viewMode !== 'chart' || !chartGroup || !chartAxisLabelFilter) return false;

    const resolveChartTypeForColumn = (column: string): string | undefined => {
      const candidates = [
        column,
        column.replace(/_/g, ' '),
        column.replace(/_/g, '.'),
        column.replace(/\./g, '_'),
        column.replace(/\./g, ' '),
        column.replace(/ /g, '_'),
        column.replace(/ /g, '.'),
      ];

      for (const key of candidates) {
        const value = chartTypes[key];
        if (typeof value === 'string' && value.trim().length > 0) return value;
      }

      const normalizedColumn = normalizeColumnKey(column);
      for (const [key, value] of Object.entries(chartTypes)) {
        if (normalizeColumnKey(key) === normalizedColumn && value.trim().length > 0) return value;
      }

      return undefined;
    };

    const groupColumns = columns.filter((col) => {
      if (!canGraph[col]) return false;
      if (resolveVariableTypeForColumn(col, variableTypes) !== chartGroup) return false;
      return resolveGroupingVariableForColumn(col, groupingVariables) === chartAxisLabelFilter;
    });

    return groupColumns.some((col) => {
      const chartType = (resolveChartTypeForColumn(col) ?? '').toLowerCase().replace(/\s+/g, '');
      return chartType.includes('line/boxplot');
    });
  }, [viewMode, chartGroup, chartAxisLabelFilter, columns, canGraph, variableTypes, groupingVariables, chartTypes]);

  useEffect(() => {
    if (chartAxisLabelFilter && !groupingVariableOptions.some((option) => option.value === chartAxisLabelFilter)) {
      onChartAxisLabelFilterChange?.(null);
    }
  }, [chartAxisLabelFilter, groupingVariableOptions, onChartAxisLabelFilterChange]);

  const factorOptions = useMemo(() => {
    const useGraphable = viewMode === 'chart' || viewMode === 'dial';
    const isAggregateTableView = viewMode === 'table';
    const filterMap = useGraphable ? canGraph : canMap;
    const filtered = Object.keys(filterMap).length > 0
      ? columns.filter((col) => {
          if (isAggregateTableView) return true;
          if (!filterMap[col]) return false;
          if (viewMode === 'dial') {
            const chartType = (chartTypes[col] || '').toLowerCase();
            if (!chartType.includes('dial')) return false;
          }
          if (viewMode === 'chart' && chartGroup && resolveVariableTypeForColumn(col, variableTypes) !== chartGroup) {
            return false;
          }
          if (viewMode === 'chart' && chartAxisLabelFilter) {
            if (resolveGroupingVariableForColumn(col, groupingVariables) !== chartAxisLabelFilter) return false;
          }
          return true;
        })
      : columns;
    return filtered.map((col) => ({
      value: col,
      label: attributeDetails[col] || col,
    }));
  }, [viewMode, canGraph, canMap, chartTypes, columns, chartGroup, chartAxisLabelFilter, groupingVariables, variableTypes, attributeDetails]);
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
  // Compute combined domain range from both scenarios so legend updates when zone range changes
  const combinedDomainRange: { min: number; max: number } | null = (() => {
    if (leftZoneStats && rightZoneStats) {
      return {
        min: Math.min(leftZoneStats.min, rightZoneStats.min),
        max: Math.max(leftZoneStats.max, rightZoneStats.max),
      };
    }
    if (leftZoneStats) return { min: leftZoneStats.min, max: leftZoneStats.max };
    if (rightZoneStats) return { min: rightZoneStats.min, max: rightZoneStats.max };
    // Fallback to overall domainRange from mapStatistics if available
    if (mapStatistics?.domainRange) return { min: mapStatistics.domainRange.min, max: mapStatistics.domainRange.max };
    return null;
  })();
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

  // If the user navigates into explore mode and the current range is 'site',
  // automatically switch to 'extent' because there is no site to base 'site'
  // range on when exploring.
  useEffect(() => {
    if (isExploreMode && rangeMode === 'site' && onRangeModeChange) {
      onRangeModeChange('extent');
    }
  }, [isExploreMode, rangeMode, onRangeModeChange]);

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
        pt="70px" // Header height offset
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
                bg={colors.orange}
                color="white"
                _hover={{
                  transform: 'translateY(-2px)',
                  bg: colors.orangeHover,
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
                <Badge bg={colors.brightGreen} color={colors.dark} variant="subtle" fontSize="xs" borderRadius="full">
                  Pane {paneIndex + 1}
                </Badge>
              )}
            </HStack>
            <Text fontSize="sm" color="gray.500">
              Choose a factor to display in this view.
            </Text>
          </Box>

          <Divider />

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
                  colorScheme="gray"
                  bg={rangeMode === 'domain' ? colors.pastelLightBlue : undefined}
                  color={rangeMode === 'domain' ? colors.dark: undefined}
                >
                  Full
                </Button>
                <Button
                  leftIcon={<FiSquare size={12} />}
                  onClick={() => onRangeModeChange('extent')}
                  variant={rangeMode === 'extent' ? 'solid' : 'outline'}
                  colorScheme="gray"
                  bg={rangeMode === 'extent' ? colors.pastelLightBlue : undefined}
                  color={rangeMode === 'extent' ? colors.dark: undefined}
                >
                  Extent
                </Button>
                <Button
                  leftIcon={<FiTarget size={12} />}
                  onClick={() => onRangeModeChange('site')}
                  variant={rangeMode === 'site' ? 'solid' : 'outline'}
                  colorScheme="gray"
                  bg={rangeMode === 'site' ? colors.pastelLightBlue : undefined}
                  color={rangeMode === 'site' ? colors.dark: undefined}
                  isDisabled={!!isExploreMode}
                >
                  Site
                </Button>
              </ButtonGroup>
            </Box>
          )}

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

          {viewMode !== 'dial' && <Divider />}

          {/* Parent Group selector — chart view only */}
          {viewMode === 'chart' && (
            <Box
              p={4}
              borderRadius="lg"
              border="1px"
              borderColor={borderColor}
              bg={cardBg}
            >
              <HStack mb={2}>
                <Badge bg={colors.pastelLightOrange} color={colors.dark} variant="subtle" fontSize="xs" borderRadius="full">
                  VARIABLE TYPE
                </Badge>
                <Tooltip label="Select a VariableType_highest level of grouping from metadata.csv">
                  <Box cursor="help">
                    <FiInfo size={14} color="gray" />
                  </Box>
                </Tooltip>
              </HStack>

              <SearchableSelect
                value={chartGroup ?? ''}
                onChange={(val) => onChartGroupChange?.(val || null)}
                options={uniqueVariableTypes.map((group) => ({ value: group, label: group.replace(/_/g, ' ') }))}
                placeholder="No variable type selected"
                focusColor="#e65100"
                allowClear
              />

              {chartGroup && (
                <Text fontSize="xs" color="gray.500" mt={2}>
                  Showing charted factors for variable type{' '}
                  <Text as="span" fontWeight="600" color="orange.400">
                    {chartGroup.replace(/_/g, ' ')}
                  </Text>
                </Text>
              )}

              {chartGroup && (
                <Box mt={3}>
                  <HStack mb={2}>
                    <Badge bg={colors.pastelLightGreen} color={colors.dark} variant="subtle" fontSize="xs" borderRadius="full">
                      GROUPING VARIABLE
                    </Badge>
                    <Tooltip label="Select a Grouping variable filtered by the selected variable type">
                      <Box cursor="help">
                        <FiInfo size={14} color="gray" />
                      </Box>
                    </Tooltip>
                  </HStack>

                  <SearchableSelect
                    value={chartAxisLabelFilter ?? ''}
                    onChange={(val) => onChartAxisLabelFilterChange?.(val || null)}
                    options={groupingVariableOptions}
                    placeholder="No grouping variable selected"
                    focusColor="#4caf50"
                    allowClear
                  />

                  {lineBoxplotToggleAvailable && (
                    <Box mt={3}>
                      <HStack justify="space-between" align="center" mb={2}>
                        <Badge bg={colors.pastelDarkGreen} color={colors.dark} variant="subtle" fontSize="xs" borderRadius="full">
                          GRAPH STYLE
                        </Badge>
                      </HStack>
                      <ButtonGroup size="xs" isAttached variant="outline">
                        <Button
                          onClick={() => onChartGraphModeChange?.('line')}
                          variant={(chartGraphMode ?? (rangeMode === 'site' ? 'boxplot' : 'line')) === 'line' ? 'solid' : 'outline'}
                          colorScheme="gray"
                          bg={(chartGraphMode ?? (rangeMode === 'site' ? 'boxplot' : 'line')) === 'line' ? colors.pastelLightBlue : undefined}
                          color={(chartGraphMode ?? (rangeMode === 'site' ? 'boxplot' : 'line')) === 'line' ? colors.dark : undefined}
                        >
                          Line
                        </Button>
                        <Button
                          onClick={() => onChartGraphModeChange?.('boxplot')}
                          variant={(chartGraphMode ?? (rangeMode === 'site' ? 'boxplot' : 'line')) === 'boxplot' ? 'solid' : 'outline'}
                          colorScheme="gray"
                          bg={(chartGraphMode ?? (rangeMode === 'site' ? 'boxplot' : 'line')) === 'boxplot' ? colors.pastelLightBlue : undefined}
                          color={(chartGraphMode ?? (rangeMode === 'site' ? 'boxplot' : 'line')) === 'boxplot' ? colors.dark : undefined}
                        >
                          Whisker Boxplot
                        </Button>
                      </ButtonGroup>
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          )}

          {viewMode !== 'chart' && (
            <Box
              p={4}
              borderRadius="lg"
              border="1px"
              borderColor={borderColor}
              bg={useColorModeValue('white', 'gray.750')}
            >
              <HStack mb={2}>
                <Badge bg={colors.brightGreen} color={colors.dark} variant="subtle" fontSize="xs" borderRadius="full">
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
                {factorOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </Select>

              {comparison.attribute && (
                <Text fontSize="xs" color="gray.500" mt={2}>
                  Showing{' '}
                  <Text as="span" fontWeight="600" color="green.400">
                      {comparison.attribute}
                  </Text>{' '}
                  values per catchment
                </Text>
              )}
            </Box>
          )}

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
                    bg={colorScaleMode === 'rainbow' ? colors.pastelDarkGreen : undefined}
                  >
                    Rainbow
                  </Button>
                  <Button
                    onClick={() => onColorScaleModeChange('metadata')}
                    variant={colorScaleMode === 'metadata' ? 'solid' : 'outline'}
                    bg={colorScaleMode === 'metadata' ? colors.pastelDarkGreen : undefined}
                  >
                    Single
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
                  {combinedDomainRange
                    ? formatNumber(combinedDomainRange.min)
                    : mapStatistics?.domainRange
                      ? formatNumber(mapStatistics.domainRange.min)
                      : 'Low'}
                </Text>
                <Text fontSize="xs" color="gray.500">
                  {combinedDomainRange
                    ? formatNumber(combinedDomainRange.max)
                    : mapStatistics?.domainRange
                      ? formatNumber(mapStatistics.domainRange.max)
                      : 'High'}
                </Text>
              </HStack>
            </Box>
          )}

          {/* Info footer intentionally hidden */}
        </VStack>
      </Box>
    </Slide>
  );
}

export default ControlPanel;
