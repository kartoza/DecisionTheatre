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
  Spacer,
} from '@chakra-ui/react';
import { FiChevronRight, FiInfo, FiMapPin } from 'react-icons/fi';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAttributeCanMap, useAttributeCanGraph, useAttributeChartTypes, useAttributeColors, useColumns, useAttributeDetails, useAttributeGroupingVariables, useAttributeVariableTypes, useAttributeAxisLabels, useAttributeIgnoreXGrouping } from '../hooks/useApi';
import { PRISM_CSS_GRADIENT, formatNumber } from './MapView';
import type { Scenario, ComparisonState, MapStatistics, ColorScaleMode, ColorScaleType, ViewMode, RangeMode, SiteIndicators } from '../types';
import { SCENARIOS } from '../types';
import { colors } from '../styles/colors';
import { usePanelWidth } from '../lib/panelWidth';
import PanelResizeHandle from './PanelResizeHandle';

interface ControlPanelProps {
  isOpen: boolean;
  onClose?: () => void;
  /**
   * Single pane's control panel is the only way to reach its factor/scenario
   * controls — there's no per-pane "Configure factor" button to reopen it the
   * way grid view has one for each pane — so it isn't collapsible there.
   */
  canCollapse?: boolean;
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
  colorScaleType: ColorScaleType;
  onColorScaleTypeChange: (scaleType: ColorScaleType) => void;
  rangeMode?: RangeMode;
  onRangeModeChange?: (mode: RangeMode) => void;
  chartGroup?: string | null;
  onChartGroupChange?: (group: string | null) => void;
  chartAxisLabelFilter?: string | null;
  onChartAxisLabelFilterChange?: (axisLabel: string | null) => void;
  chartGraphMode?: 'line' | 'boxplot' | null;
  onChartGraphModeChange?: (mode: 'line' | 'boxplot' | null) => void;
  siteIndicators?: SiteIndicators | null;
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

function resolveAxisLabelForColumn(column: string, axisLabels: Record<string, string>): string {
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
    const label = axisLabels[key];
    if (label && label.trim().length > 0) return label;
  }

  const normalizedColumn = normalizeColumnKey(column);
  for (const [key, label] of Object.entries(axisLabels)) {
    if (normalizeColumnKey(key) === normalizedColumn && label.trim().length > 0) return label;
  }

  return '';
}

// Separates a "Grouping variable" value from an optional axis-label suffix in an
// encoded chartAxisLabelFilter value (see encodeGroupingOption below). Must stay in
// sync with the identical delimiter/decoder in ChartView.tsx.
const GROUP_UNIT_DELIM = '\u0001';

function encodeGroupingOption(group: string, axisLabel: string): string {
  return `${group}${GROUP_UNIT_DELIM}${axisLabel}`;
}

function decodeGroupingFilter(value: string | null | undefined): { group: string; axisLabel: string | null } {
  if (!value) return { group: '', axisLabel: null };
  const idx = value.indexOf(GROUP_UNIT_DELIM);
  if (idx === -1) return { group: value, axisLabel: null };
  return { group: value.slice(0, idx), axisLabel: value.slice(idx + 1) };
}

function columnMatchesGroupingFilter(
  column: string,
  filterValue: string | null | undefined,
  groupingVariables: Record<string, string>,
  axisLabels: Record<string, string>,
): boolean {
  if (!filterValue) return true;
  const { group, axisLabel } = decodeGroupingFilter(filterValue);
  if (resolveGroupingVariableForColumn(column, groupingVariables) !== group) return false;
  if (axisLabel !== null && resolveAxisLabelForColumn(column, axisLabels) !== axisLabel) return false;
  return true;
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
  containerMt = 10,
  fallbackLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; sublabel?: string }[];
  placeholder?: string;
  focusColor?: string;
  allowClear?: boolean;
  containerMt?: number | string;
  /** Label to show when value isn't among options (e.g. set programmatically, not user-selectable). */
  fallbackLabel?: string;
}) {
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const dropdownBg = useColorModeValue('white', 'gray.700');
  const hoverBg = useColorModeValue('gray.100', 'gray.600');
  const dropdownBorderColor = useColorModeValue('gray.200', 'gray.600');
  const inputBg = useColorModeValue('gray.50', 'gray.700');

  const selectedLabel = useMemo(
    () => options.find((o) => o.value === value)?.label ?? (value ? fallbackLabel : undefined) ?? '',
    [options, value, fallbackLabel],
  );

  const filtered = useMemo(() => {
    if (!search) return options;
    const q = search.toLowerCase();
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.sublabel?.toLowerCase().includes(q),
    );
  }, [options, search]);

  const handleSelect = (val: string) => {
    onChange(val);
    setSearch('');
    setIsOpen(false);
  };

  return (
    <Box position="relative" mt={containerMt}>
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
                {opt.sublabel && (
                  <Box
                    as="span"
                    ml={2}
                    fontSize="xs"
                    opacity={0.6}
                    fontWeight="400"
                    fontFamily="mono"
                  >
                    {opt.sublabel}
                  </Box>
                )}
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
}: {
  label: string;
  value: Scenario;
  onChange: (s: Scenario) => void;
  side: 'left' | 'right';
  zoneStats?: ZoneStats | null;
  hideLabel?: boolean;
}) {
  const selectedInfo = SCENARIOS.find((s) => s.id === value);

  return (
    <Box>
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
        <Box mt={3}>
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
  onClose,
  canCollapse = true,
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
  colorScaleType,
  onColorScaleTypeChange,
  rangeMode = 'domain',
  chartGroup,
  onChartGroupChange,
  chartAxisLabelFilter,
  onChartAxisLabelFilterChange,
  chartGraphMode,
  onChartGraphModeChange,
  siteIndicators,
}: ControlPanelProps) {
  const { columns, loading: columnsLoading } = useColumns();
  const { colors: attributeColors } = useAttributeColors();
  const { details: attributeDetails } = useAttributeDetails();
  const { canMap } = useAttributeCanMap();
  const { canGraph } = useAttributeCanGraph();
  const { chartTypes } = useAttributeChartTypes();
  const { groupingVariables } = useAttributeGroupingVariables();
  const { variableTypes } = useAttributeVariableTypes();
  const { axisLabels } = useAttributeAxisLabels();
  const { ignoreXGrouping } = useAttributeIgnoreXGrouping();
  const bgColor = useColorModeValue('gray.50', 'gray.800');
  const borderColor = useColorModeValue('gray.200', 'gray.700');

  const [factorDerivedMode, setFactorDerivedMode] = useState(false);
  const [factorDerivedValue, setFactorDerivedValue] = useState('');

  // factorDerivedMode/factorDerivedValue are local UI state (not lifted to
  // App), so demo tours drive the "Individual factor" selection here.
  useEffect(() => {
    const handler = (e: Event) => {
      const attribute = (e as CustomEvent).detail?.attribute as string | undefined;
      if (!attribute) return;
      setFactorDerivedMode(true);
      setFactorDerivedValue(attribute);
    };
    window.addEventListener('dt:demo-chart-individual-factor', handler);
    return () => window.removeEventListener('dt:demo-chart-individual-factor', handler);
  }, []);

  // Arriving at the chart view from map/dial with an attribute already
  // selected should behave as if that attribute had just been picked from the
  // INDIVIDUAL FACTOR select, so the GROUPING VARIABLE list is filtered by its
  // axis label without requiring the user to re-pick the factor. This only
  // fires on the actual map/dial -> chart transition (tracked via a ref), not
  // on every re-render while already in chart view — otherwise clearing the
  // INDIVIDUAL FACTOR select would immediately re-derive it from the
  // still-set comparison.attribute and undo the clear.
  const previousViewModeRef = useRef<ViewMode | undefined>(undefined);
  useEffect(() => {
    const previousViewMode = previousViewModeRef.current;
    previousViewModeRef.current = viewMode;
    if (viewMode !== 'chart' || previousViewMode === 'chart') return;

    const attribute = comparison.attribute;
    if (!attribute) return;

    const vt = resolveVariableTypeForColumn(attribute, variableTypes);
    if (!vt || vt === 'catchID') return;

    setFactorDerivedMode(true);
    setFactorDerivedValue(attribute);
    if (chartGroup !== vt) {
      onChartGroupChange?.(vt);
      onChartAxisLabelFilterChange?.(null);
    }
  }, [viewMode, comparison.attribute, variableTypes, chartGroup, onChartGroupChange, onChartAxisLabelFilterChange]);

  const uniqueVariableTypes = useMemo(
    () => [...new Set(Object.values(variableTypes))].filter((t) => t && t !== 'catchID').sort(),
    [variableTypes],
  );

  const groupingVariableOptions = useMemo(() => {
    if (!chartGroup) return [];

    const fromChartableColumns = columns
      .filter((col) => canGraph[col] && resolveVariableTypeForColumn(col, variableTypes) === chartGroup);

    const sourceColumns = fromChartableColumns.length > 0
      ? fromChartableColumns
      : Object.keys(groupingVariables)
          .filter((col) => resolveVariableTypeForColumn(col, variableTypes) === chartGroup);

    // Mixing indicators that plot on different axes into one chart produces a
    // meaningless combined y-axis (e.g. burned area and fuel load on the same
    // scale), so split any grouping-variable bucket whose columns span multiple
    // "axis label" values into one option per axis label.
    const axisLabelsByGroup = new Map<string, Set<string>>();
    for (const col of sourceColumns) {
      const group = resolveGroupingVariableForColumn(col, groupingVariables);
      if (!group || group === 'catchID') continue;
      const axisLabel = resolveAxisLabelForColumn(col, axisLabels) || 'unspecified axis label';
      if (!axisLabelsByGroup.has(group)) axisLabelsByGroup.set(group, new Set());
      axisLabelsByGroup.get(group)!.add(axisLabel);
    }

    const options: { value: string; label: string; axisLabel: string }[] = [];
    for (const [group, labelSet] of axisLabelsByGroup) {
      if (labelSet.size <= 1) {
        const [axisLabel] = labelSet;
        options.push({ value: group, label: group.replace(/_/g, ' '), axisLabel });
        continue;
      }
      for (const axisLabel of labelSet) {
        options.push({
          value: encodeGroupingOption(group, axisLabel),
          label: `${group.replace(/_/g, ' ')} (${axisLabel})`,
          axisLabel,
        });
      }
    }

    const sortedOptions = options.sort((a, b) => a.label.localeCompare(b.label));

    // Some variable types mix several unrelated axes by design (e.g. cover
    // fraction alongside biomass), flagged in metadata.csv via
    // ignore_x_grouping — those keep the plain alphabetical order instead of
    // being narrowed down to the individual factor's axis label.
    if (sourceColumns.some((col) => ignoreXGrouping[col])) return sortedOptions;

    // Once an individual factor has been picked, only offer sibling grouping
    // variables that share its axis label — combining different axes on one
    // chart is meaningless (see the axisLabelsByGroup split above).
    const selectedFactorColumn = factorDerivedMode && factorDerivedValue && !factorDerivedValue.startsWith('__group__|')
      ? factorDerivedValue
      : null;
    const selectedFactorAxisLabel = selectedFactorColumn
      ? resolveAxisLabelForColumn(selectedFactorColumn, axisLabels)
      : '';
    if (!selectedFactorAxisLabel) return sortedOptions;

    const matchingOptions = sortedOptions.filter((option) => option.axisLabel === selectedFactorAxisLabel);
    return matchingOptions.length > 0 ? matchingOptions : sortedOptions;
  }, [chartGroup, columns, canGraph, variableTypes, groupingVariables, axisLabels, ignoreXGrouping, factorDerivedMode, factorDerivedValue]);

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
      return columnMatchesGroupingFilter(col, chartAxisLabelFilter, groupingVariables, axisLabels);
    });

    return groupColumns.some((col) => {
      const chartType = (resolveChartTypeForColumn(col) ?? '').toLowerCase().replace(/\s+/g, '');
      return chartType.includes('line/boxplot');
    });
  }, [viewMode, chartGroup, chartAxisLabelFilter, columns, canGraph, variableTypes, groupingVariables, chartTypes, axisLabels]);

  useEffect(() => {
    if (chartAxisLabelFilter && !groupingVariableOptions.some((option) => option.value === chartAxisLabelFilter)) {
      onChartAxisLabelFilterChange?.(null);
    }
  }, [chartAxisLabelFilter, groupingVariableOptions, onChartAxisLabelFilterChange]);

  useEffect(() => {
    if (groupingVariableOptions.length === 1 && chartGroup && chartAxisLabelFilter !== groupingVariableOptions[0].value) {
      onChartAxisLabelFilterChange?.(groupingVariableOptions[0].value);
    }
  }, [groupingVariableOptions, chartGroup, chartAxisLabelFilter, onChartAxisLabelFilterChange]);

  // The flat dial is the same indicator, drawn as a band instead of a gauge,
  // so it shares the dial's control-panel behavior rather than the chart's.
  const isDialView = viewMode === 'dial' || viewMode === 'flat';

  const factorOptions = useMemo(() => {
    const useGraphable = viewMode === 'chart' || isDialView;
    const isAggregateTableView = viewMode === 'table';
    const filterMap = useGraphable ? canGraph : canMap;
    const filtered = Object.keys(filterMap).length > 0
      ? columns.filter((col) => {
          if (isAggregateTableView) return true;
          if (!filterMap[col]) return false;
          if (isDialView) {
            const chartType = (chartTypes[col] || '').toLowerCase();
            if (!chartType.includes('dial')) return false;
          }
          if (viewMode === 'chart' && chartGroup && resolveVariableTypeForColumn(col, variableTypes) !== chartGroup) {
            return false;
          }
          if (viewMode === 'chart' && chartAxisLabelFilter) {
            if (!columnMatchesGroupingFilter(col, chartAxisLabelFilter, groupingVariables, axisLabels)) return false;
          }
          return true;
        })
      : columns;
    return filtered.map((col) => ({
      value: col,
      label: attributeDetails[col] || col,
      sublabel: attributeDetails[col] ? col : undefined,
    }));
  }, [viewMode, isDialView, canGraph, canMap, chartTypes, columns, chartGroup, chartAxisLabelFilter, groupingVariables, variableTypes, attributeDetails, axisLabels]);

  const allGraphableFactorOptions = useMemo(
    () => columns
      .filter((col) => canMap[col])
      .map((col) => ({ value: col, label: attributeDetails[col] || col })),
    [columns, canMap, attributeDetails],
  );

  // Variable types that already have at least one mapable column in the factor dropdown
  const variableTypesWithMapableColumns = useMemo(
    () => new Set(
      columns
        .filter((col) => canMap[col])
        .map((col) => resolveVariableTypeForColumn(col, variableTypes))
        .filter((vt): vt is string => Boolean(vt && vt !== 'catchID')),
    ),
    [columns, canMap, variableTypes],
  );

  // For each variable type, collect the unique graphable grouping variable values
  const variableTypeGroupMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const col of columns) {
      if (!canGraph[col]) continue;
      const vt = resolveVariableTypeForColumn(col, variableTypes);
      if (!vt || vt === 'catchID') continue;
      const gv = resolveGroupingVariableForColumn(col, groupingVariables);
      if (!gv || gv === 'catchID') continue;
      if (!map.has(vt)) map.set(vt, new Set());
      map.get(vt)!.add(gv);
    }
    return map;
  }, [columns, canGraph, variableTypes, groupingVariables]);

  // Virtual entries for variable types that have no mapable columns but exactly
  // one graphable grouping variable — these are surfaced directly in the
  // INDIVIDUAL FACTOR dropdown (e.g. TreeBiomassProp → "Tree biomass class").
  const singleGroupVirtualOptions = useMemo(() => {
    const result: { value: string; label: string }[] = [];
    for (const [vt, groups] of variableTypeGroupMap.entries()) {
      if (variableTypesWithMapableColumns.has(vt)) continue;
      if (groups.size !== 1) continue;
      const [gv] = groups;
      result.push({ value: `__group__|${vt}|${gv}`, label: gv });
    }
    return result;
  }, [variableTypeGroupMap, variableTypesWithMapableColumns]);

  const attributeColor = colorScaleMode === 'metadata' && comparison.attribute
    ? attributeColors[comparison.attribute]
    : undefined;
  const effectiveRangeMode: RangeMode = isSiteAggregationActive ? 'site' : rangeMode;
  const leftZoneStatsRaw = effectiveRangeMode === 'domain'
    ? mapStatistics?.fullStats?.left ?? null
    : effectiveRangeMode === 'site'
      ? mapStatistics?.siteStats?.left ?? null
      : mapStatistics?.leftStats ?? null;
  const rightZoneStatsRaw = effectiveRangeMode === 'domain'
    ? mapStatistics?.fullStats?.right ?? null
    : effectiveRangeMode === 'site'
      ? mapStatistics?.siteStats?.right ?? null
      : mapStatistics?.rightStats ?? null;

  // When in site range mode, prefer the cached site-level aggregate's mean
  // (same area-weighted logic as the aggregate table and site indicator page)
  // over the live per-catchment mean — but only when it actually falls within
  // the live min/max range. siteIndicators is a snapshot from the last
  // extraction; if the boundary/catchments changed since (e.g. an edit that
  // updates site.Catchments without re-extracting), it goes stale and can
  // disagree with the aggregate table, which always computes fresh from the
  // live per-catchment data — so an out-of-range value is rejected in favor
  // of the live mean instead of silently displaying a mismatched number.
  // Count is always the live per-catchment count for the same reason.
  const applySiteIndicatorOverrides = (
    stats: ZoneStats | null,
    scenario: string,
  ): ZoneStats | null => {
    if (!stats || effectiveRangeMode !== 'site' || !siteIndicators || !comparison.attribute) return stats;
    const key = scenario === 'reference' ? 'reference' : scenario === 'future' ? 'ideal' : 'current';
    const mean = siteIndicators[key as keyof Pick<SiteIndicators, 'reference' | 'current' | 'ideal'>]?.[comparison.attribute];
    const meanInRange = typeof mean === 'number' && Number.isFinite(mean) && mean >= stats.min && mean <= stats.max;
    return meanInRange ? { ...stats, mean } : stats;
  };

  const leftZoneStats = applySiteIndicatorOverrides(leftZoneStatsRaw, comparison.leftScenario);
  const rightZoneStats = applySiteIndicatorOverrides(rightZoneStatsRaw, comparison.rightScenario);

  // The color scale is stretched to whichever zone is selected (Full/Extent/Site):
  // 'Full' uses the attribute's global domain across every catchment, while
  // 'Extent'/'Site' stretch to that zone's local min/max so subtle local
  // variation isn't washed out by the full dataset's range. MapView publishes
  // whichever range it actually painted with as domainRange, so this always
  // matches what's on the map.
  const combinedDomainRange: { min: number; max: number } | null = mapStatistics?.domainRange
    ? { min: mapStatistics.domainRange.min, max: mapStatistics.domainRange.max }
    : null;
  const { width: panelWidth, startResize } = usePanelWidth();

  // The application header is content-sized, not a fixed height, so the
  // docked panel measures it instead of repeating a magic number that goes
  // stale the moment the header's contents change — same approach as the
  // chart-details and target-editor panels that share this slot.
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

  // The pane number identifies the card the factor belongs to, so it sits on
  // that card rather than on the panel heading. Defined once: the chart view
  // and the map/dial/table view each draw their own factor card, and this is
  // the same badge in both.
  const paneBadge = paneIndex !== null ? (
    <Badge bg={colors.brightGreen} color={colors.dark} variant="subtle" fontSize="xs" borderRadius="full">
      Pane {paneIndex + 1}
    </Badge>
  ) : null;

  const panelContent = (
    <VStack spacing={6} p={6} align="stretch">
          {/* Create Site button - shown prominently at top in explore mode */}
          {isExploreMode && onNavigateToCreateSite && (
            <Box pt={2}>
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
            <Heading size="sm" mb={1}>
              Indicator
            </Heading>
          </Box>

          <Divider />

          {/* The Zone Range control (Full / Extent / Site) was here. It is the
              same control the header already carries in its range group, and
              two copies of one setting is one too many. The catchment count
              it also showed is now in the header beside the site area. */}

          {/* Parent Group selector — chart view only */}
          {viewMode === 'chart' && (
            <Box>
              <HStack mb={2}>
                <Badge bg={colors.pastelLightBlue} color={colors.dark} variant="subtle" fontSize="xs" borderRadius="full">
                  INDIVIDUAL FACTOR
                </Badge>
                <Tooltip label="View a single factor as a chart">
                  <Box cursor="help">
                    <FiInfo size={14} color="gray" />
                  </Box>
                </Tooltip>
                <Spacer />
                {paneBadge}
              </HStack>

              <SearchableSelect
                value={factorDerivedMode ? factorDerivedValue : (!chartGroup ? (comparison.attribute ?? '') : '')}
                onChange={(val) => {
                  if (!val) {
                    setFactorDerivedMode(false);
                    setFactorDerivedValue('');
                    onChartGroupChange?.(null);
                    onChartAxisLabelFilterChange?.(null);
                    return;
                  }
                  if (val.startsWith('__group__|')) {
                    const withoutPrefix = val.slice('__group__|'.length);
                    const pipeIndex = withoutPrefix.indexOf('|');
                    const vt = withoutPrefix.slice(0, pipeIndex);
                    const gv = withoutPrefix.slice(pipeIndex + 1);
                    setFactorDerivedMode(true);
                    setFactorDerivedValue(val);
                    onChartGroupChange?.(vt);
                    onChartAxisLabelFilterChange?.(gv);
                    return;
                  }
                  onAttributeChange(val);
                  const vt = resolveVariableTypeForColumn(val, variableTypes);
                  if (vt && vt !== 'catchID') {
                    setFactorDerivedMode(true);
                    setFactorDerivedValue(val);
                    onChartGroupChange?.(vt);
                    onChartAxisLabelFilterChange?.(null);
                  } else {
                    setFactorDerivedMode(false);
                    setFactorDerivedValue('');
                    onChartGroupChange?.(null);
                    onChartAxisLabelFilterChange?.(null);
                  }
                }}
                options={[...allGraphableFactorOptions, ...singleGroupVirtualOptions]}
                placeholder="Select a factor to view"
                focusColor="#2bb0ed"
                allowClear
              />

              {factorDerivedMode && chartGroup && groupingVariableOptions.length > 1 && (
                <Box mt={3}>
                  <HStack mb={2}>
                    <Badge bg={colors.pastelLightGreen} color={colors.dark} variant="subtle" fontSize="xs" borderRadius="full">
                      GROUPING VARIABLE
                    </Badge>
                    <Tooltip label="Select a grouping variable to drill down into">
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
                </Box>
              )}

              {factorDerivedMode && lineBoxplotToggleAvailable && (
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

              {!factorDerivedMode && (
                <>
                  <Box mt={4} mb={2} borderTop="1px" borderColor={borderColor} />

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
                      {groupingVariableOptions.length !== 1 && (
                        <>
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
                        </>
                      )}

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
                </>
              )}
            </Box>
          )}

          {viewMode !== 'chart' && (
            <Box id="demo-attribute-selector">
              <HStack mb={2}>
                <Badge bg={colors.brightGreen} color={colors.dark} variant="subtle" fontSize="xs" borderRadius="full">
                  FACTOR
                </Badge>
                <Tooltip label="Select a data attribute to visualize on the map">
                  <Box cursor="help">
                    <FiInfo size={14} color="gray" />
                  </Box>
                </Tooltip>
                <Spacer />
                {paneBadge}
              </HStack>

              <SearchableSelect
                value={comparison.attribute ?? ''}
                onChange={onAttributeChange}
                options={factorOptions}
                placeholder={columnsLoading ? 'Loading...' : 'Select an attribute'}
                focusColor="#4caf50"
                containerMt={2}
                fallbackLabel={attributeDetails[comparison.attribute ?? '']}
              />

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

          {!isDialView && !hideScenarioSelectors && (
            <>
              {/* Scenario 1 (Left) */}
              <ScenarioSelector
                label="Scenario 1"
                value={comparison.leftScenario}
                onChange={onLeftChange}
                side="left"
                zoneStats={leftZoneStats}
                hideLabel={isSiteAggregationActive}
              />

              {/* Scenario 2 (Right) */}
              {isSwiperEnabled && !isSiteAggregationActive && (
                <ScenarioSelector
                  label="Scenario 2"
                  value={comparison.rightScenario}
                  onChange={onRightChange}
                  side="right"
                  zoneStats={rightZoneStats}
                />
              )}
            </>
          )}

          {/* Legend */}
          {comparison.attribute && !isDialView && !hideColorScale && (
            <Box>
              <HStack justify="space-between" align="center" mb={2}>
                <Text fontSize="xs" fontWeight="600" color="gray.500">
                  SCALE TYPE
                </Text>
                <ButtonGroup size="xs" isAttached variant="outline">
                  <Button
                    onClick={() => onColorScaleTypeChange('linear')}
                    variant={colorScaleType === 'linear' ? 'solid' : 'outline'}
                    bg={colorScaleType === 'linear' ? colors.pastelDarkGreen : undefined}
                  >
                    Linear
                  </Button>
                  {/* <Button
                    onClick={() => onColorScaleTypeChange('logistic')}
                    variant={colorScaleType === 'logistic' ? 'solid' : 'outline'}
                    bg={colorScaleType === 'logistic' ? colors.pastelDarkGreen : undefined}
                  >
                    Logistic
                  </Button>
                  <Button
                    onClick={() => onColorScaleTypeChange('logarithmic')}
                    variant={colorScaleType === 'logarithmic' ? 'solid' : 'outline'}
                    bg={colorScaleType === 'logarithmic' ? colors.pastelDarkGreen : undefined}
                  >
                    Log
                  </Button> */}
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
  );

  return (
    <Slide
      direction="right"
      in={isOpen}
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
        id="tour-control-panel"
        w={{ base: '100vw', md: `${panelWidth}px` }}
        h="100%"
        bg={bgColor}
        borderLeft="1px"
        borderColor={borderColor}
        overflowY="auto"
        boxShadow="-4px 0 24px rgba(0,0,0,0.15)"
        pt="48px"
        position="relative"
      >
        <PanelResizeHandle onResizeStart={startResize} />
        {/*
          Collapse, in the same corner as the chart-details and target-editor
          panels that share this slot. It used to sit at top:2 of a box padded
          for a hardcoded 70px header, which put it visually underneath the
          real (content-sized) header rather than below it — invisible and
          unclickable in grid view's "Configure factor" panel. The panel now
          docks below the measured header instead, so the button sits in the
          clear. Single pane has no equivalent button to reopen it, so it's
          omitted there rather than left as a dead end.
        */}
        {canCollapse && (
          <Box position="absolute" top={2} right={2} zIndex={3}>
            <Tooltip label="Collapse panel" placement="left">
              <IconButton
                aria-label="Collapse panel"
                icon={<FiChevronRight />}
                size="sm"
                variant="ghost"
                onClick={() => onClose?.()}
              />
            </Tooltip>
          </Box>
        )}

        {panelContent}
      </Box>
    </Slide>
  );
}

export default ControlPanel;
