import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Box, Button, HStack, Text } from '@chakra-ui/react';
import { motion, useAnimation, AnimatePresence } from 'framer-motion';
import { getSiteCatchments, getSiteWhiskerBounds, useAttributeAxisLabels, useAttributeGroupingVariables, useAttributeVariableTypes, useColumns, useAttributeUnits, useAttributeXAxisLabels, useAttributeChartTypes } from '../hooks/useApi';
import type { WhiskerBoundsResponse } from '../hooks/useApi';
import type { SiteIndicators, MapExtent, MapStatistics, RangeMode, Scenario, ZoneStats } from '../types';

// Kartoza color scheme: orange, blue, green
const SERIES_COLORS = ['#e65100', '#2bb0ed', '#4caf50'];
const SERIES_LABELS = ['Reference', 'Current', 'Target'];

const PADDING = { top: 50, right: 60, bottom: 140, left: 80 };
const BOXPLOT_PAGE_SIZE = 10;

function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

interface ChartViewProps {
  visible: boolean;
  attribute?: string;
  siteIndicators?: SiteIndicators | null;
  siteId?: string | null;
  mapExtent?: MapExtent | null;
  rangeMode?: RangeMode;
  mapStatistics?: MapStatistics | null;
  leftScenario?: Scenario;
  rightScenario?: Scenario;
  chartGroup?: string | null;
  chartAxisLabelFilter?: string | null;
  chartGraphMode?: 'line' | 'boxplot' | null;
}

/** Returns the mean from whichever stats bucket (left or right) matches the target scenario. */
function statForScenario(
  target: Scenario,
  left: ZoneStats | null | undefined,
  right: ZoneStats | null | undefined,
  leftScenario: Scenario | undefined,
  rightScenario: Scenario | undefined,
): number | undefined {
  if (leftScenario === target && typeof left?.mean === 'number') return left.mean;
  if (rightScenario === target && typeof right?.mean === 'number') return right.mean;
  return undefined;
}

const LARGE_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const STANDARD_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const SMALL_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });

function formatVal(val: number): string {
  if (!Number.isFinite(val)) return '';

  const abs = Math.abs(val);
  if (abs >= 1000) return LARGE_NUMBER_FORMATTER.format(val);
  if (abs >= 1) return STANDARD_NUMBER_FORMATTER.format(val);
  if (abs === 0) return '0';
  return SMALL_NUMBER_FORMATTER.format(val);
}

function composeYAxisLabel(axisLabel?: string, units?: string): string {
  const label = (axisLabel ?? '').trim();
  const unit = (units ?? '').trim();
  if (label && unit) return `${label} (${unit})`;
  return label || unit;
}

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

function resolveMapValueForColumn(
  values: Record<string, number> | null | undefined,
  column: string,
): number | undefined {
  if (!values) return undefined;

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
    const value = values[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  const normalizedColumn = normalizeColumnKey(column);
  for (const [key, value] of Object.entries(values)) {
    if (normalizeColumnKey(key) === normalizedColumn && typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function resolveChartTypeForColumn(column: string, chartTypes: Record<string, string>): string | undefined {
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
}

/** Resolve a value for a given attribute column from site/catchment/map data. */
function resolveValue(
  column: string,
  scenario: 'reference' | 'current' | 'ideal',
  siteIndicators: SiteIndicators | null | undefined,
  catchmentData: { reference: Record<string, number>; current: Record<string, number> } | null,
  rangeMode: RangeMode,
  mapStatistics: MapStatistics | null | undefined,
  leftScenario: Scenario | undefined,
  rightScenario: Scenario | undefined,
): number | undefined {
  if (scenario === 'ideal') {
    return siteIndicators?.ideal?.[column] ?? resolveValue(column, 'reference', siteIndicators, catchmentData, rangeMode, mapStatistics, leftScenario, rightScenario);
  }
  const scenarioKey: Scenario = scenario;
  switch (rangeMode) {
    case 'extent':
      return statForScenario(scenarioKey, mapStatistics?.leftStats, mapStatistics?.rightStats, leftScenario, rightScenario)
        ?? catchmentData?.[scenario]?.[column];
    case 'domain':
      return statForScenario(scenarioKey, mapStatistics?.fullStats?.left, mapStatistics?.fullStats?.right, leftScenario, rightScenario)
        ?? catchmentData?.[scenario]?.[column];
    case 'site':
    default:
      // Use site-specific values when available; return undefined (not 0) for absent columns
      // so group scatter points are omitted rather than plotted at zero.
      if (siteIndicators) {
        const val = resolveMapValueForColumn(siteIndicators[scenario], column);
        return typeof val === 'number' ? val : undefined;
      }
      return resolveMapValueForColumn(catchmentData?.[scenario] ?? null, column);
  }
}

function ChartView({
  visible,
  attribute,
  siteIndicators,
  siteId,
  mapExtent,
  rangeMode = 'site',
  mapStatistics,
  leftScenario,
  rightScenario,
  chartGroup,
  chartAxisLabelFilter,
  chartGraphMode,
}: ChartViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [progress, setProgress] = useState(0);
  const animFrameRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const controls = useAnimation();

  const { axisLabels } = useAttributeAxisLabels();
  const { units } = useAttributeUnits();
  const { variableTypes } = useAttributeVariableTypes();
  const { columns } = useColumns();
  const { groupingVariables } = useAttributeGroupingVariables();
  const { xAxisLabels } = useAttributeXAxisLabels();
  const { chartTypes } = useAttributeChartTypes();
  const filteredChartColumns = useMemo(() => {
    let candidates: string[];
    if (rangeMode === 'site') {
      // Keep deterministic order across backend restarts: preserve column order first,
      // then append metadata-only keys in sorted order.
      const columnSet = new Set(columns);
      const extras = Array.from(new Set([
        ...Object.keys(variableTypes),
        ...Object.keys(groupingVariables),
      ]))
        .filter((k) => !columnSet.has(k))
        .sort((a, b) => a.localeCompare(b));
      candidates = [...columns, ...extras];
    } else {
      candidates = columns;
    }

    return candidates.filter((col) => {
      if (chartGroup && resolveVariableTypeForColumn(col, variableTypes) !== chartGroup) return false;
      if (chartAxisLabelFilter && resolveGroupingVariableForColumn(col, groupingVariables) !== chartAxisLabelFilter) return false;
      return true;
    });
  }, [rangeMode, columns, chartGroup, chartAxisLabelFilter, variableTypes, groupingVariables]);

  const groupedDisplayColumns = useMemo(() => {
    if (filteredChartColumns.length === 0) return filteredChartColumns;

    // Herbivores/Diet includes multiple metric families sharing the same x-axis labels
    // (kgkm2, counts, dmi, ch4). Mixing them corrupts grouped line/boxplot rendering.
    if (chartGroup === 'Herbivores' && chartAxisLabelFilter === 'Diet') {
      const familyByColumn = new Map<string, string>();
      const familyOrder: string[] = [];

      for (const col of filteredChartColumns) {
        const parts = normalizeColumnKey(col).split('.');
        if (parts.length >= 4 && parts[0] === 'herbs' && parts[1] === 'diet') {
          const family = parts[2];
          familyByColumn.set(col, family);
          if (!familyOrder.includes(family)) familyOrder.push(family);
        }
      }

      if (familyOrder.length > 1) {
        const preferred = ['kgkm2', 'counts', 'dmi', 'ch4'];
        const selectedFamily = preferred.find((f) => familyOrder.includes(f)) ?? familyOrder[0];
        const filtered = filteredChartColumns.filter((col) => familyByColumn.get(col) === selectedFamily);
        if (filtered.length > 0) return filtered;
      }
    }

    return filteredChartColumns;
  }, [filteredChartColumns, chartGroup, chartAxisLabelFilter]);

  // Fallback catchment data when no siteIndicators
  const [catchmentData, setCatchmentData] = useState<{
    reference: Record<string, number>;
    current: Record<string, number>;
  } | null>(null);
  const [groupedRangeData, setGroupedRangeData] = useState<{
    reference: Record<string, number>;
    current: Record<string, number>;
  } | null>(null);
  const [groupedRangeLoading, setGroupedRangeLoading] = useState(false);
  const [whiskerBounds, setWhiskerBounds] = useState<WhiskerBoundsResponse | null>(null);
  const [boxplotPage, setBoxplotPage] = useState(0);

  useEffect(() => {
    if (!visible) return;
    if (!siteId) {
      setCatchmentData(null);
      setWhiskerBounds(null);
      return;
    }

    let whiskerCancelled = false;
    getSiteWhiskerBounds(siteId).then((bounds) => {
      if (!whiskerCancelled) setWhiskerBounds(bounds);
    }).catch(() => {
      if (!whiskerCancelled) setWhiskerBounds(null);
    });

    if (rangeMode !== 'site') {
      setCatchmentData(null);
      return () => { whiskerCancelled = true; };
    }

    let cancelled = false;

    getSiteCatchments(siteId)
      .then((catchments) => {
        if (cancelled || !catchments || catchments.length === 0) return;

        const weightedCatchments: Array<{
          id: string;
          validArea: number;
          reference?: Record<string, number>;
          current?: Record<string, number>;
        }> = [];

        for (const catchment of catchments) {
          const fractionCovered = catchment.aoiFraction ?? 1.0;
          const validArea = catchment.areaKm2 * fractionCovered;
          if (!Number.isFinite(validArea) || validArea <= 0) continue;

          weightedCatchments.push({
            id: catchment.id,
            validArea,
            reference: catchment.reference,
            current: catchment.current,
          });
        }

        const totalArea = weightedCatchments.reduce((sum, entry) => sum + entry.validArea, 0);
        if (!(totalArea > 0)) {
          if (!cancelled) setCatchmentData(null);
          return;
        }

        const reference: Record<string, number> = {};
        const current: Record<string, number> = {};

        for (const entry of weightedCatchments) {
          const weight = entry.validArea / totalArea;

          if (entry.reference) {
            for (const [col, value] of Object.entries(entry.reference)) {
              if (typeof value !== 'number' || !Number.isFinite(value)) continue;
              reference[col] = (reference[col] ?? 0) + value * weight;
            }
          }

          if (entry.current) {
            for (const [col, value] of Object.entries(entry.current)) {
              if (typeof value !== 'number' || !Number.isFinite(value)) continue;
              current[col] = (current[col] ?? 0) + value * weight;
            }
          }
        }

        if (cancelled) return;

        if (Object.keys(reference).length === 0 && Object.keys(current).length === 0) return;

        if (!cancelled) {
          setCatchmentData({ reference, current });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatchmentData(null);
        }
      });

    return () => { cancelled = true; whiskerCancelled = true; };
  }, [siteIndicators, siteId, visible, rangeMode]);

  useEffect(() => {
    if (!visible || !chartGroup || !chartAxisLabelFilter) {
      setGroupedRangeData(null);
      setGroupedRangeLoading(false);
      return;
    }

    if (rangeMode === 'site') {
      setGroupedRangeData(null);
      setGroupedRangeLoading(false);
      return;
    }

    const groupColumns = groupedDisplayColumns;
    if (groupColumns.length === 0) {
      setGroupedRangeData(null);
      setGroupedRangeLoading(false);
      return;
    }

    if (rangeMode === 'extent' && !mapExtent?.bounds) {
      setGroupedRangeData(null);
      setGroupedRangeLoading(false);
      return;
    }

    let cancelled = false;
    setGroupedRangeLoading(true);

    const fetchAggregates = async (scenario: Scenario): Promise<Record<string, number>> => {
      // Large groups like "functional group" can exceed practical URL/query limits
      // when sent as one comma-separated list; request in chunks and merge.
      const batchSize = 12;
      const batches: string[][] = [];
      for (let i = 0; i < groupColumns.length; i += batchSize) {
        batches.push(groupColumns.slice(i, i + batchSize));
      }

      const merged: Record<string, number> = {};
      for (const batch of batches) {
        const params = new URLSearchParams({
          scenario,
          attributes: batch.join(','),
        });

        if (rangeMode === 'extent' && mapExtent?.bounds) {
          const [minx, miny, maxx, maxy] = mapExtent.bounds;
          params.set('minx', String(minx));
          params.set('miny', String(miny));
          params.set('maxx', String(maxx));
          params.set('maxy', String(maxy));
        }

        const resp = await fetch(`/api/aggregate?${params.toString()}`);
        if (!resp.ok) {
          throw new Error(`Failed to fetch aggregate data: ${resp.status}`);
        }

        const payload = await resp.json() as Record<string, number>;
        Object.assign(merged, payload);
      }

      return merged;
    };

    Promise.all([
      fetchAggregates('reference'),
      fetchAggregates('current'),
    ]).then(([reference, current]) => {
      if (cancelled) return;

      if (Object.keys(reference).length === 0 && Object.keys(current).length === 0) {
        setGroupedRangeData(null);
      } else {
        setGroupedRangeData({ reference, current });
      }
      setGroupedRangeLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setGroupedRangeData(null);
      setGroupedRangeLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [visible, chartGroup, chartAxisLabelFilter, rangeMode, mapExtent, groupedDisplayColumns]);

  // Build summary chart data (existing behavior)
  const summaryData = useMemo(() => {
    if (!attribute) return null;

    const refVal = resolveValue(attribute, 'reference', siteIndicators, catchmentData, rangeMode, mapStatistics, leftScenario, rightScenario);
    const curVal = resolveValue(attribute, 'current', siteIndicators, catchmentData, rangeMode, mapStatistics, leftScenario, rightScenario);
    const idealVal = siteIndicators?.ideal?.[attribute] ?? refVal;

    const hasData = [refVal, curVal, idealVal].some(
      (v): v is number => typeof v === 'number' && Number.isFinite(v),
    );
    if (!hasData) return null;

    const xLabel = axisLabels[attribute] ?? attribute.replace(/_/g, ' ');
    const chartType = 'line';

    return {
      xLabel,
      chartType,
      values: [
        typeof refVal === 'number' && Number.isFinite(refVal) ? refVal : null,
        typeof curVal === 'number' && Number.isFinite(curVal) ? curVal : null,
        typeof idealVal === 'number' && Number.isFinite(idealVal) ? idealVal : null,
      ] as (number | null)[],
    };
  }, [attribute, axisLabels, rangeMode, mapStatistics, leftScenario, rightScenario, siteIndicators, catchmentData]);

  // Build grouped chart data for all columns where Grouping variable matches the selected group.
  const groupedChartData = useMemo(() => {
    if (!chartGroup || !chartAxisLabelFilter) return null;

    const groupColumns = groupedDisplayColumns;
    if (groupColumns.length === 0) return null;

    const points: {
      label: string;
      ref: number | null;
      cur: number | null;
      target: number | null;
      refUpper: number | null;
      refLower: number | null;
      curUpper: number | null;
      curLower: number | null;
      refCount: number;
      curCount: number;
      targetCount: number;
      refUpperCount: number;
      refLowerCount: number;
      curUpperCount: number;
      curLowerCount: number;
    }[] = [];
    const labelIndex = new Map<string, number>();

    for (const col of groupColumns) {
      const siteRef = resolveMapValueForColumn(siteIndicators?.reference, col);
      const siteCur = resolveMapValueForColumn(siteIndicators?.current, col);
      const siteTarget = resolveMapValueForColumn(siteIndicators?.ideal, col);

      const refVal = rangeMode === 'site'
        ? (typeof siteRef === 'number'
          ? siteRef
          : resolveMapValueForColumn(catchmentData?.reference ?? null, col))
        : resolveMapValueForColumn(groupedRangeData?.reference ?? null, col);
      const curVal = rangeMode === 'site'
        ? (typeof siteCur === 'number'
          ? siteCur
          : resolveMapValueForColumn(catchmentData?.current ?? null, col))
        : resolveMapValueForColumn(groupedRangeData?.current ?? null, col);
      const targetVal = siteTarget ?? (typeof refVal === 'number' ? refVal : undefined);
      const label = xAxisLabels[col] ?? col;

      const normalizedRef = typeof refVal === 'number' && Number.isFinite(refVal) ? refVal : null;
      const normalizedCur = typeof curVal === 'number' && Number.isFinite(curVal) ? curVal : null;
      const normalizedTarget = typeof targetVal === 'number' && Number.isFinite(targetVal) ? targetVal : null;

      const refUpperRaw = whiskerBounds ? resolveMapValueForColumn(whiskerBounds.referenceUpper, col) : undefined;
      const refLowerRaw = whiskerBounds ? resolveMapValueForColumn(whiskerBounds.referenceLower, col) : undefined;
      const curUpperRaw = whiskerBounds ? resolveMapValueForColumn(whiskerBounds.currentUpper, col) : undefined;
      const curLowerRaw = whiskerBounds ? resolveMapValueForColumn(whiskerBounds.currentLower, col) : undefined;
      const normalizedRefUpper = normalizedRef !== null && typeof refUpperRaw === 'number' && Number.isFinite(refUpperRaw) ? refUpperRaw : null;
      const normalizedRefLower = normalizedRef !== null && typeof refLowerRaw === 'number' && Number.isFinite(refLowerRaw) ? refLowerRaw : null;
      const normalizedCurUpper = normalizedCur !== null && typeof curUpperRaw === 'number' && Number.isFinite(curUpperRaw) ? curUpperRaw : null;
      const normalizedCurLower = normalizedCur !== null && typeof curLowerRaw === 'number' && Number.isFinite(curLowerRaw) ? curLowerRaw : null;

      const existingIndex = labelIndex.get(label);
      if (existingIndex === undefined) {
        labelIndex.set(label, points.length);
        points.push({
          label,
          ref: normalizedRef,
          cur: normalizedCur,
          target: normalizedTarget,
          refUpper: normalizedRefUpper,
          refLower: normalizedRefLower,
          curUpper: normalizedCurUpper,
          curLower: normalizedCurLower,
          refCount: normalizedRef !== null ? 1 : 0,
          curCount: normalizedCur !== null ? 1 : 0,
          targetCount: normalizedTarget !== null ? 1 : 0,
          refUpperCount: normalizedRefUpper !== null ? 1 : 0,
          refLowerCount: normalizedRefLower !== null ? 1 : 0,
          curUpperCount: normalizedCurUpper !== null ? 1 : 0,
          curLowerCount: normalizedCurLower !== null ? 1 : 0,
        });
      } else {
        // Average duplicate display labels rather than summing, which inflates values.
        const existing = points[existingIndex];
        if (normalizedRef !== null) {
          existing.ref = (existing.ref ?? 0) + normalizedRef;
          existing.refCount += 1;
        }
        if (normalizedCur !== null) {
          existing.cur = (existing.cur ?? 0) + normalizedCur;
          existing.curCount += 1;
        }
        if (normalizedTarget !== null) {
          existing.target = (existing.target ?? 0) + normalizedTarget;
          existing.targetCount += 1;
        }
        if (normalizedRefUpper !== null) {
          existing.refUpper = (existing.refUpper ?? 0) + normalizedRefUpper;
          existing.refUpperCount += 1;
        }
        if (normalizedRefLower !== null) {
          existing.refLower = (existing.refLower ?? 0) + normalizedRefLower;
          existing.refLowerCount += 1;
        }
        if (normalizedCurUpper !== null) {
          existing.curUpper = (existing.curUpper ?? 0) + normalizedCurUpper;
          existing.curUpperCount += 1;
        }
        if (normalizedCurLower !== null) {
          existing.curLower = (existing.curLower ?? 0) + normalizedCurLower;
          existing.curLowerCount += 1;
        }
      }
    }

    for (const p of points) {
      p.ref = p.refCount > 0 && p.ref !== null ? p.ref / p.refCount : null;
      p.cur = p.curCount > 0 && p.cur !== null ? p.cur / p.curCount : null;
      p.target = p.targetCount > 0 && p.target !== null ? p.target / p.targetCount : null;
      p.refUpper = p.refUpperCount > 0 && p.refUpper !== null ? p.refUpper / p.refUpperCount : null;
      p.refLower = p.refLowerCount > 0 && p.refLower !== null ? p.refLower / p.refLowerCount : null;
      p.curUpper = p.curUpperCount > 0 && p.curUpper !== null ? p.curUpper / p.curUpperCount : null;
      p.curLower = p.curLowerCount > 0 && p.curLower !== null ? p.curLower / p.curLowerCount : null;
    }

    const hideNoRefOrCur = chartGroup === 'Herbivores' && chartAxisLabelFilter === 'Species';
    const valid = points.filter((p) => {
      if (hideNoRefOrCur) {
        const refVal = p.ref ?? 0;
        const curVal = p.cur ?? 0;
        return !(refVal === 0 && curVal === 0);
      }
      return p.ref !== null || p.cur !== null || p.target !== null;
    }).map((p) => ({
      label: p.label,
      ref: p.ref,
      cur: p.cur,
      target: p.target,
      refUpper: p.refUpper,
      refLower: p.refLower,
      curUpper: p.curUpper,
      curLower: p.curLower,
    }));
    return valid.length > 0 ? valid : null;
  }, [chartGroup, chartAxisLabelFilter, groupedDisplayColumns, siteIndicators, catchmentData, groupedRangeData, rangeMode, xAxisLabels, whiskerBounds]);

  const groupedYAxisLabel = useMemo(() => {
    if (!chartGroup || !chartAxisLabelFilter) return '';
    const firstColumn = groupedDisplayColumns[0];
    if (!firstColumn) return '';
    return composeYAxisLabel(axisLabels[firstColumn], units[firstColumn]);
  }, [chartGroup, chartAxisLabelFilter, groupedDisplayColumns, axisLabels, units]);

  const groupedChartType = useMemo<string>(() => {
    if (!groupedChartData || !chartGroup) return 'line';

    const groupChartTypes = groupedDisplayColumns
      .map((col) => resolveChartTypeForColumn(col, chartTypes))
      .filter((ct): ct is string => typeof ct === 'string');

    const hasBoxplotType = groupChartTypes.some((ct) => {
      const normalized = ct.toLowerCase();
      return normalized.includes('boxplot') || normalized.includes('box');
    });

    const canRenderBoxplot = hasBoxplotType;
    if (chartGraphMode === 'boxplot') return canRenderBoxplot ? 'boxplot' : 'line';
    if (chartGraphMode === 'line') return 'line';
    return canRenderBoxplot ? 'boxplot' : 'line';
  }, [groupedChartData, chartGroup, groupedDisplayColumns, chartTypes, rangeMode, chartGraphMode]);

  const boxplotPageCount = useMemo(() => {
    if (groupedChartType !== 'boxplot' || !groupedChartData) return 1;
    return Math.max(1, Math.ceil(groupedChartData.length / BOXPLOT_PAGE_SIZE));
  }, [groupedChartType, groupedChartData]);

  useEffect(() => {
    setBoxplotPage((prev) => {
      if (boxplotPageCount <= 1) return 0;
      return Math.min(prev, boxplotPageCount - 1);
    });
  }, [boxplotPageCount]);

  const pagedGroupedChartData = useMemo(() => {
    if (!groupedChartData) return null;
    if (groupedChartType !== 'boxplot') return groupedChartData;
    const start = boxplotPage * BOXPLOT_PAGE_SIZE;
    return groupedChartData.slice(start, start + BOXPLOT_PAGE_SIZE);
  }, [groupedChartData, groupedChartType, boxplotPage]);

  useEffect(() => {
    if (!visible || !chartGroup || !chartAxisLabelFilter) return;

    const debugRows = groupedDisplayColumns.slice(0, 40).map((col) => {
      const siteRef = resolveMapValueForColumn(siteIndicators?.reference, col);
      const siteCur = resolveMapValueForColumn(siteIndicators?.current, col);
      const siteTarget = resolveMapValueForColumn(siteIndicators?.ideal, col);

      const refVal = rangeMode === 'site'
        ? (typeof siteRef === 'number'
          ? siteRef
          : resolveMapValueForColumn(catchmentData?.reference ?? null, col))
        : resolveMapValueForColumn(groupedRangeData?.reference ?? null, col);
      const curVal = rangeMode === 'site'
        ? (typeof siteCur === 'number'
          ? siteCur
          : resolveMapValueForColumn(catchmentData?.current ?? null, col))
        : resolveMapValueForColumn(groupedRangeData?.current ?? null, col);

      return {
        column: col,
        label: xAxisLabels[col] ?? col,
        variableType: resolveVariableTypeForColumn(col, variableTypes),
        groupingVariable: resolveGroupingVariableForColumn(col, groupingVariables),
        ref: refVal ?? null,
        cur: curVal ?? null,
        target: siteTarget ?? null,
      };
    });

    // Debug chart data resolution for grouped views (e.g. Fire/Season, Fire/Total).
    console.groupCollapsed('[ChartView] Grouped chart debug');
    console.log('selection', {
      chartGroup,
      chartAxisLabelFilter,
      rangeMode,
      filteredColumnCount: groupedDisplayColumns.length,
      hasGroupedRangeData: Boolean(groupedRangeData),
      hasCatchmentData: Boolean(catchmentData),
      hasSiteIndicators: Boolean(siteIndicators),
      hasGroupedChartData: Boolean(groupedChartData),
    });
    console.table(debugRows);
    if (groupedDisplayColumns.length > 40) {
      console.log(`truncated ${groupedDisplayColumns.length - 40} additional columns`);
    }
    console.groupEnd();
  }, [
    visible,
    chartGroup,
    chartAxisLabelFilter,
    rangeMode,
    groupedDisplayColumns,
    groupedRangeData,
    catchmentData,
    siteIndicators,
    groupedChartData,
    xAxisLabels,
    variableTypes,
    groupingVariables,
  ]);

  // Responsive sizing
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Animate when both visible and data are ready
  const animateTo = useCallback((target: number) => {
    const duration = 1500;
    cancelAnimationFrame(animFrameRef.current);
    startTimeRef.current = performance.now();

    function tick(now: number) {
      const elapsed = now - startTimeRef.current;
      const t = Math.min(elapsed / duration, 1);
      setProgress(easeOutExpo(t) * target);
      if (t < 1) animFrameRef.current = requestAnimationFrame(tick);
    }
    animFrameRef.current = requestAnimationFrame(tick);
  }, []);

  const hasData = Boolean(chartGroup && chartAxisLabelFilter) && groupedChartData !== null;

  useEffect(() => {
    if (visible && hasData) {
      setProgress(0);
      controls.start({
        opacity: 1,
        scale: 1,
        transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] },
      }).then(() => animateTo(1));
    } else if (!visible) {
      setProgress(0);
      controls.start({
        opacity: 0,
        scale: 0.95,
        transition: { duration: 0.3, ease: [0.4, 0, 1, 1] },
      });
    }
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [visible, hasData, controls, animateTo]);

  const { width, height } = size;

  if (!hasData) {
    return (
      <Box
        ref={containerRef}
        position="absolute"
        top={0} left={0} right={0} bottom={0}
        overflow="hidden"
        display="flex"
        alignItems="center"
        justifyContent="center"
        color="gray.500"
        fontSize="sm"
        bg="#1a202c"
      >
        {visible
          ? (
            chartGroup
              ? (chartAxisLabelFilter
                ? (groupedRangeLoading ? 'Loading\u2026' : 'No grouped chart data for this selection')
                : 'Select a grouping variable to show chart data')
              : 'Select a variable type to show chart data'
          )
          : null}
      </Box>
    );
  }

  const svgHeight = height;
  const plotW = width - PADDING.left - PADDING.right;
  const plotH = svgHeight - PADDING.top - PADDING.bottom;

  const yTickCount = 5;

  const renderGroupedChart = () => {
    if (!groupedChartData || !chartGroup) return null;
    const chartData = pagedGroupedChartData ?? groupedChartData;

    const allVals = groupedChartData.flatMap((p) => [
      p.ref, p.cur, p.target,
      p.refUpper, p.refLower, p.curUpper, p.curLower,
    ].filter((v): v is number => v !== null));
    if (allVals.length === 0) return null;

    const minRaw = Math.min(...allVals);
    const maxRaw = Math.max(...allVals);
    const minVal = Math.min(0, minRaw);
    const maxVal = maxRaw === minVal ? minVal + 1 : maxRaw * (maxRaw >= 0 ? 1.1 : 0.9);
    const range = maxVal - minVal || 1;
    const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) => minVal + (range / yTickCount) * i);

    const categoryCount = chartData.length;
    const categoryW = plotW / Math.max(categoryCount, 1);
    const groupPad = Math.min(12, categoryW * 0.15);
    const innerW = Math.max(categoryW - groupPad * 2, 10);
    const barGap = Math.min(6, innerW * 0.08);
    const barW = Math.max((innerW - barGap * 2) / 3, 2);

    const yAt = (val: number) => PADDING.top + plotH - ((val - minVal) / range) * plotH;
    const xBase = (i: number) => PADDING.left + i * categoryW + groupPad;
    const xCenter = (i: number) => xBase(i) + innerW / 2;

    return (
      <svg
        width={width}
        height={svgHeight}
        viewBox={`0 0 ${width} ${svgHeight}`}
        style={{ display: 'block' }}
      >
        <rect width={width} height={svgHeight} fill="#1a202c" />

        {yTicks.map((val, ti) => {
          const y = yAt(val);
          return (
            <g key={`group-grid-${ti}`}>
              <line
                x1={PADDING.left} y1={y}
                x2={width - PADDING.right} y2={y}
                stroke="#2d3748" strokeWidth={1}
              />
              <text
                x={PADDING.left - 8} y={y + 4}
                textAnchor="end" fill="#718096"
                fontSize={11} fontFamily="Inter, sans-serif"
              >
                {formatVal(val)}
              </text>
            </g>
          );
        })}

        <line
          x1={PADDING.left} y1={PADDING.top}
          x2={PADDING.left} y2={PADDING.top + plotH}
          stroke="#4a5568" strokeWidth={1}
        />
        <line
          x1={PADDING.left} y1={PADDING.top + plotH}
          x2={width - PADDING.right} y2={PADDING.top + plotH}
          stroke="#4a5568" strokeWidth={1}
        />

        {groupedYAxisLabel && (
          <text
            x={20}
            y={PADDING.top + plotH / 2}
            transform={`rotate(-90 20 ${PADDING.top + plotH / 2})`}
            textAnchor="middle"
            fill="#a0aec0"
            fontSize={12}
            fontFamily="Inter, sans-serif"
            fontWeight={500}
          >
            {groupedYAxisLabel}
          </text>
        )}

        {groupedChartType === 'bar' ? (
          chartData.map((item, i) => {
            const baseX = xBase(i);
            const values = [item.ref, item.cur, item.target];

            return (
              <g key={`group-cat-${i}`}>
                {values.map((val, si) => {
                  if (val === null) return null;
                  const x = baseX + si * (barW + barGap);
                  const scaledVal = minVal + (val - minVal) * progress;
                  const y = yAt(scaledVal);
                  const h = Math.max((PADDING.top + plotH) - y, 0);

                  return (
                    <g key={`group-bar-${i}-${si}`}>
                      <rect
                        x={x}
                        y={y}
                        width={barW}
                        height={h}
                        fill={SERIES_COLORS[si]}
                        fillOpacity={0.85}
                        rx={2}
                      />
                      {progress > 0.8 && (
                        <text
                          x={x + barW / 2}
                          y={y - 6}
                          textAnchor="middle"
                          fill={SERIES_COLORS[si]}
                          fontSize={10}
                          fontFamily="Inter, sans-serif"
                          fontWeight={600}
                        >
                          {formatVal(val)}
                        </text>
                      )}
                    </g>
                  );
                })}

                <text
                  x={xCenter(i)}
                  y={PADDING.top + plotH + 24}
                  transform={`rotate(-50 ${xCenter(i)} ${PADDING.top + plotH + 24})`}
                  textAnchor="end"
                  fill="#718096"
                  fontSize={9}
                  fontFamily="Inter, sans-serif"
                >
                  {item.label}
                </text>
              </g>
            );
          })
        ) : groupedChartType === 'boxplot' ? (
          // Boxplot rendering
          chartData.map((item, i) => {
            const values = [item.ref, item.cur, item.target];
            const x = xCenter(i);
            const boxWidth = Math.min(30, innerW * 0.6);

            // Render each scenario's boxplot
            return (
              <g key={`group-boxplot-${i}`}>
                {[0, 1, 2].map((si) => {
                  const val = values[si];
                  if (val === null) return null;

                  // si=0: reference, si=1: current, si=2: target (uses reference bounds)
                  // Use area-weighted whisker bounds from CSV data; fall back to median when absent
                  const upperWhisker = si === 1
                    ? (item.curUpper ?? val)
                    : (item.refUpper ?? val);
                  const lowerWhisker = si === 1
                    ? (item.curLower ?? val)
                    : (item.refLower ?? val);

                  const yMedian = yAt(minVal + (val - minVal) * progress);
                  const yUpper = yAt(minVal + (upperWhisker - minVal) * progress);
                  const yLower = yAt(minVal + (lowerWhisker - minVal) * progress);

                  // Box dimensions (IQR approximation)
                  const q1 = val - (val - lowerWhisker) * 0.5;
                  const q3 = val + (upperWhisker - val) * 0.5;
                  const yQ1 = yAt(minVal + (q1 - minVal) * progress);
                  const yQ3 = yAt(minVal + (q3 - minVal) * progress);
                  const boxHeight = Math.abs(yQ3 - yQ1);

                  // Offset boxes horizontally for different scenarios
                  const xOffset = (si - 1) * (boxWidth + 4);
                  const boxX = x + xOffset - boxWidth / 2;

                  return (
                    <g key={`boxplot-${i}-${si}`} opacity={progress}>
                      {/* Whisker lines */}
                      <line
                        x1={x + xOffset}
                        y1={yUpper}
                        x2={x + xOffset}
                        y2={yQ3}
                        stroke={SERIES_COLORS[si]}
                        strokeWidth={1.5}
                      />
                      <line
                        x1={x + xOffset}
                        y1={yLower}
                        x2={x + xOffset}
                        y2={yQ1}
                        stroke={SERIES_COLORS[si]}
                        strokeWidth={1.5}
                      />
                      {/* Whisker caps */}
                      <line
                        x1={boxX}
                        y1={yUpper}
                        x2={boxX + boxWidth}
                        y2={yUpper}
                        stroke={SERIES_COLORS[si]}
                        strokeWidth={1.5}
                      />
                      <line
                        x1={boxX}
                        y1={yLower}
                        x2={boxX + boxWidth}
                        y2={yLower}
                        stroke={SERIES_COLORS[si]}
                        strokeWidth={1.5}
                      />
                      {/* Box */}
                      <rect
                        x={boxX}
                        y={yQ3}
                        width={boxWidth}
                        height={boxHeight}
                        fill={SERIES_COLORS[si]}
                        fillOpacity={0.3}
                        stroke={SERIES_COLORS[si]}
                        strokeWidth={2}
                        rx={2}
                      />
                      {/* Median line */}
                      <line
                        x1={boxX}
                        y1={yMedian}
                        x2={boxX + boxWidth}
                        y2={yMedian}
                        stroke={SERIES_COLORS[si]}
                        strokeWidth={3}
                      />
                      {/* Value label */}
                      {progress > 0.8 && (
                        <text
                          x={x + xOffset}
                          y={yMedian - 12}
                          textAnchor="middle"
                          fill={SERIES_COLORS[si]}
                          fontSize={9}
                          fontFamily="Inter, sans-serif"
                          fontWeight={600}
                        >
                          {formatVal(val)}
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* X-axis label */}
                <text
                  x={xCenter(i)}
                  y={PADDING.top + plotH + 24}
                  transform={`rotate(-50 ${xCenter(i)} ${PADDING.top + plotH + 24})`}
                  textAnchor="end"
                  fill="#718096"
                  fontSize={9}
                  fontFamily="Inter, sans-serif"
                >
                  {item.label}
                </text>
              </g>
            );
          })
        ) : (
          <>
            {[2, 1, 0].map((si) => {
              const values = chartData.map((item) => [item.ref, item.cur, item.target][si]);
              const path = values
                .map((val, i) => {
                  if (val === null) return null;
                  const y = yAt(minVal + (val - minVal) * progress);
                  return `${i === 0 ? 'M' : 'L'}${xCenter(i)},${y}`;
                })
                .filter(Boolean)
                .join(' ');

              return path ? (
                <path
                  key={`group-line-${si}`}
                  d={path}
                  fill="none"
                  stroke={SERIES_COLORS[si]}
                  strokeWidth={2}
                  strokeOpacity={0.9}
                  strokeDasharray={si === 2 ? '5 4' : undefined}
                />
              ) : null;
            })}

            {chartData.map((item, i) => {
              const values = [item.ref, item.cur, item.target];
              return (
                <g key={`group-line-points-${i}`}>
                  {[2, 1, 0].map((si) => {
                    const val = values[si];
                    if (val === null) return null;
                    const x = xCenter(i);
                    const y = yAt(minVal + (val - minVal) * progress);
                    return (
                      <g key={`group-point-${i}-${si}`}>
                        <circle cx={x} cy={y} r={si === 2 ? 4 : 5} fill={SERIES_COLORS[si]} stroke="#1a202c" strokeWidth={1.5} />
                        {progress > 0.8 && (
                          <text
                            x={x}
                            y={y - 8 - (si === 2 ? 1 : 0)}
                            textAnchor="middle"
                            fill={SERIES_COLORS[si]}
                            fontSize={10}
                            fontFamily="Inter, sans-serif"
                            fontWeight={600}
                          >
                            {formatVal(val)}
                          </text>
                        )}
                      </g>
                    );
                  })}

                  <text
                    x={xCenter(i)}
                    y={PADDING.top + plotH + 24}
                    transform={`rotate(-50 ${xCenter(i)} ${PADDING.top + plotH + 24})`}
                    textAnchor="end"
                    fill="#718096"
                    fontSize={9}
                    fontFamily="Inter, sans-serif"
                  >
                    {item.label}
                  </text>
                </g>
              );
            })}
          </>
        )}

        <text
          x={PADDING.left + plotW / 2}
          y={svgHeight - 8}
          textAnchor="middle" fill="#a0aec0"
          fontSize={13} fontFamily="Inter, sans-serif" fontWeight={500}
        >
          {`(Variable type: ${chartGroup}; Grouping variable: ${chartAxisLabelFilter})`}
        </text>

        {SERIES_LABELS.map((label, i) => {
          const legendX = PADDING.left + i * 150;
          return (
            <g key={`group-legend-${i}`}>
              <circle cx={legendX + 6} cy={14} r={6} fill={SERIES_COLORS[i]} />
              <text
                x={legendX + 18} y={19}
                fill="#a0aec0" fontSize={12}
                fontFamily="Inter, sans-serif" fontWeight={500}
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    );
  };

  const renderSummaryChart = () => {
    if (!summaryData) return null;
    const { xLabel, chartType, values } = summaryData;
    const yLabel = attribute ? composeYAxisLabel(axisLabels[attribute], units[attribute]) : '';
    const isBar = chartType === 'bar';
    const numericVals = values.filter((v): v is number => v !== null);
    const minVal = isBar ? 0 : Math.min(...numericVals) * (Math.min(...numericVals) >= 0 ? 0.9 : 1.1);
    const maxVal = Math.max(...numericVals) * (Math.max(...numericVals) >= 0 ? 1.1 : 0.9);
    const range = maxVal - minVal || 1;

    const barCount = values.length;
    const barGap = plotW * 0.1;
    const barWidth = (plotW - barGap * (barCount + 1)) / barCount;
    const stepX = plotW / (values.length - 1);

    const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) =>
      minVal + (range / yTickCount) * i,
    );

    const pointX = (i: number) => PADDING.left + i * stepX;
    const barXPos = (i: number) => PADDING.left + barGap + i * (barWidth + barGap);
    const pointY = (val: number) => {
      const animatedVal = minVal + (val - minVal) * progress;
      return PADDING.top + plotH - ((animatedVal - minVal) / range) * plotH;
    };

    const xTickLabels = ['Reference', 'Current', 'Target'];

    return (
      <svg
        width={width}
        height={svgHeight}
        viewBox={`0 0 ${width} ${svgHeight}`}
        style={{ display: 'block' }}
      >
        <rect width={width} height={svgHeight} fill="#1a202c" />

        {/* Grid lines */}
        {yTicks.map((val, ti) => {
          const y = PADDING.top + plotH - ((val - minVal) / range) * plotH;
          return (
            <g key={`grid-${ti}`}>
              <line
                x1={PADDING.left} y1={y}
                x2={width - PADDING.right} y2={y}
                stroke="#2d3748" strokeWidth={1}
              />
              <text
                x={PADDING.left - 8} y={y + 4}
                textAnchor="end" fill="#718096"
                fontSize={11} fontFamily="Inter, sans-serif"
              >
                {formatVal(val)}
              </text>
            </g>
          );
        })}

        {/* Axes */}
        <line
          x1={PADDING.left} y1={PADDING.top}
          x2={PADDING.left} y2={PADDING.top + plotH}
          stroke="#4a5568" strokeWidth={1}
        />
        <line
          x1={PADDING.left} y1={PADDING.top + plotH}
          x2={width - PADDING.right} y2={PADDING.top + plotH}
          stroke="#4a5568" strokeWidth={1}
        />

        {yLabel && (
          <text
            x={20}
            y={PADDING.top + plotH / 2}
            transform={`rotate(-90 20 ${PADDING.top + plotH / 2})`}
            textAnchor="middle"
            fill="#a0aec0"
            fontSize={12}
            fontFamily="Inter, sans-serif"
            fontWeight={500}
          >
            {yLabel}
          </text>
        )}

        {isBar ? (
          values.map((val, i) => {
            if (val === null) return null;
            const x = barXPos(i);
            const barH = ((val - minVal) / range) * plotH * progress;
            const y = PADDING.top + plotH - barH;
            return (
              <g key={`bar-${i}`}>
                <rect
                  x={x} y={y}
                  width={barWidth} height={barH}
                  fill={SERIES_COLORS[i]} fillOpacity={0.8}
                  rx={3}
                />
                {progress > 0.8 && (
                  <text
                    x={x + barWidth / 2} y={y - 8}
                    textAnchor="middle" fill={SERIES_COLORS[i]}
                    fontSize={11} fontFamily="Inter, sans-serif" fontWeight={600}
                  >
                    {formatVal(val)}
                  </text>
                )}
              </g>
            );
          })
        ) : (
          <>
            {(() => {
              const pts = values
                .map((val, i) => val !== null ? `${pointX(i)},${pointY(val)}` : null)
                .filter(Boolean) as string[];
              if (pts.length < 2) return null;
              const baseline = PADDING.top + plotH;
              return (
                <path
                  d={`M${pointX(0)},${baseline} L${pts.join(' L')} L${pointX(values.length - 1)},${baseline} Z`}
                  fill="#2bb0ed"
                  fillOpacity={0.06}
                />
              );
            })()}
            {(() => {
              const pts = values
                .map((val, i) => val !== null ? `${i === 0 ? 'M' : 'L'}${pointX(i)},${pointY(val)}` : null)
                .filter(Boolean)
                .join(' ');
              return pts ? (
                <path
                  d={pts}
                  fill="none"
                  stroke="#4a5568"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
              ) : null;
            })()}
            {values.map((val, i) => {
              if (val === null) return null;
              const cx = pointX(i);
              const cy = pointY(val);
              return (
                <g key={`pt-${i}`}>
                  <circle cx={cx} cy={cy} r={10} fill={SERIES_COLORS[i]} fillOpacity={0.15} />
                  <circle cx={cx} cy={cy} r={6} fill={SERIES_COLORS[i]} stroke="#1a202c" strokeWidth={2} />
                  {progress > 0.8 && (
                    <text
                      x={cx} y={cy - 14}
                      textAnchor="middle" fill={SERIES_COLORS[i]}
                      fontSize={11} fontFamily="Inter, sans-serif" fontWeight={600}
                    >
                      {formatVal(val)}
                    </text>
                  )}
                </g>
              );
            })}
          </>
        )}

        {xTickLabels.map((label, i) => (
          <text
            key={`xtick-${i}`}
            x={isBar ? barXPos(i) + barWidth / 2 : pointX(i)}
            y={PADDING.top + plotH + 20}
            textAnchor="middle" fill="#718096"
            fontSize={12} fontFamily="Inter, sans-serif"
          >
            {label}
          </text>
        ))}

        <text
          x={PADDING.left + plotW / 2}
          y={svgHeight - 8}
          textAnchor="middle" fill="#a0aec0"
          fontSize={13} fontFamily="Inter, sans-serif" fontWeight={500}
        >
          {xLabel}
        </text>

        {SERIES_LABELS.map((label, i) => {
          if (values[i] === null) return null;
          const legendX = PADDING.left + i * 150;
          return (
            <g key={`legend-${i}`}>
              <circle cx={legendX + 6} cy={14} r={6} fill={SERIES_COLORS[i]} />
              <text
                x={legendX + 18} y={19}
                fill="#a0aec0" fontSize={12}
                fontFamily="Inter, sans-serif" fontWeight={500}
              >
                {label}
              </text>
            </g>
          );
        })}

      </svg>
    );
  };

  return (
    <Box
      ref={containerRef}
      position="absolute"
      top={0} left={0} right={0} bottom={0}
      overflow="hidden"
    >
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={controls}
            exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.3 } }}
            style={{ width: '100%', height: '100%' }}
          >
            {chartGroup ? renderGroupedChart() : renderSummaryChart()}
          </motion.div>
        )}
      </AnimatePresence>

      {visible && chartGroup && groupedChartType === 'boxplot' && boxplotPageCount > 1 && (
        <HStack
          position="absolute"
          left={4}
          bottom={4}
          zIndex={5}
          pointerEvents="auto"
          spacing={2}
          bg="rgba(26, 32, 44, 0.9)"
          border="1px solid"
          borderColor="#2d3748"
          borderRadius="md"
          px={2}
          py={1}
        >
          <Button
            size="xs"
            variant="outline"
            colorScheme="gray"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setBoxplotPage((p) => Math.max(0, p - 1));
            }}
            isDisabled={boxplotPage === 0}
          >
            Prev
          </Button>
          <Text fontSize="xs" color="gray.300" minW="72px" textAlign="center">
            Page {boxplotPage + 1} / {boxplotPageCount}
          </Text>
          <Button
            size="xs"
            variant="outline"
            colorScheme="gray"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setBoxplotPage((p) => Math.min(boxplotPageCount - 1, p + 1));
            }}
            isDisabled={boxplotPage >= boxplotPageCount - 1}
          >
            Next
          </Button>
        </HStack>
      )}
    </Box>
  );
}

export default ChartView;
