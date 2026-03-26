import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Box } from '@chakra-ui/react';
import { motion, useAnimation, AnimatePresence } from 'framer-motion';
import { getSiteCatchments, useAttributeAxisLabels, useAttributeChartTypes, useAttributeVariableTypes, useColumns, useAttributeCanGraph } from '../hooks/useApi';
import type { SiteIndicators, MapStatistics, RangeMode, Scenario, ZoneStats } from '../types';

// Kartoza color scheme: orange, blue, green
const SERIES_COLORS = ['#e65100', '#2bb0ed', '#4caf50'];
const SERIES_LABELS = ['Reference', 'Current', 'Target'];
// Lighter pastel variants used for the group scatter overlay dots
const GROUP_SCATTER_COLORS = ['#ffccbc', '#b3e5fc', '#c8e6c9'];

const PADDING = { top: 50, right: 60, bottom: 100, left: 80 };

function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

interface ChartViewProps {
  visible: boolean;
  attribute?: string;
  siteIndicators?: SiteIndicators | null;
  siteId?: string | null;
  rangeMode?: RangeMode;
  mapStatistics?: MapStatistics | null;
  leftScenario?: Scenario;
  rightScenario?: Scenario;
  chartGroup?: string | null;
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

function formatVal(val: number): string {
  if (Math.abs(val) >= 10000) return val.toExponential(1);
  return parseFloat(val.toPrecision(3)).toString();
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
        const val = siteIndicators[scenario]?.[column];
        return typeof val === 'number' ? val : undefined;
      }
      return catchmentData?.[scenario]?.[column];
  }
}

function ChartView({
  visible,
  attribute,
  siteIndicators,
  siteId,
  rangeMode = 'site',
  mapStatistics,
  leftScenario,
  rightScenario,
  chartGroup,
}: ChartViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [progress, setProgress] = useState(0);
  const animFrameRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const controls = useAnimation();

  const { axisLabels } = useAttributeAxisLabels();
  const { chartTypes } = useAttributeChartTypes();
  const { columns } = useColumns();
  const { variableTypes } = useAttributeVariableTypes();
  const { canGraph } = useAttributeCanGraph();

  // Fallback catchment data when no siteIndicators
  const [catchmentData, setCatchmentData] = useState<{
    reference: Record<string, number>;
    current: Record<string, number>;
  } | null>(null);

  useEffect(() => {
    if (!visible || !attribute) return;
    if (siteIndicators || !siteId || rangeMode !== 'site') {
      setCatchmentData(null);
      return;
    }

    let cancelled = false;

    getSiteCatchments(siteId)
      .then((catchments) => {
        if (cancelled || !catchments || catchments.length === 0) return;

        let refSum = 0;
        let curSum = 0;
        let totalArea = 0;

        for (const catchment of catchments) {
          const fractionCovered = catchment.aoiFraction ?? 1.0;
          const validArea = catchment.areaKm2 * fractionCovered;
          if (!Number.isFinite(validArea) || validArea <= 0) continue;

          const refVal = catchment.reference?.[attribute];
          const curVal = catchment.current?.[attribute];
          if (typeof refVal === 'number') refSum += refVal * validArea;
          if (typeof curVal === 'number') curSum += curVal * validArea;
          totalArea += validArea;
        }

        if (totalArea <= 0 || cancelled) return;

        if (!cancelled) {
          setCatchmentData({
            reference: { [attribute]: refSum / totalArea },
            current: { [attribute]: curSum / totalArea },
          });
        }
      })
      .catch(() => { if (!cancelled) setCatchmentData(null); });

    return () => { cancelled = true; };
  }, [siteIndicators, siteId, attribute, visible, rangeMode]);

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
    const chartType = chartTypes[attribute] ?? 'line';

    return {
      xLabel,
      chartType,
      values: [
        typeof refVal === 'number' && Number.isFinite(refVal) ? refVal : null,
        typeof curVal === 'number' && Number.isFinite(curVal) ? curVal : null,
        typeof idealVal === 'number' && Number.isFinite(idealVal) ? idealVal : null,
      ] as (number | null)[],
    };
  }, [attribute, axisLabels, chartTypes, rangeMode, mapStatistics, leftScenario, rightScenario, siteIndicators, catchmentData]);

  // Build scatter data for all columns in the selected parent group
  const groupData = useMemo(() => {
    if (!chartGroup) return null;

    const groupColumns = columns.filter(
      (col) => variableTypes[col] === chartGroup && canGraph[col],
    );
    if (groupColumns.length === 0) return null;

    const points: { ref: number | null; cur: number | null; target: number | null }[] = [];

    for (const col of groupColumns) {
      const refVal = resolveValue(col, 'reference', siteIndicators, catchmentData, rangeMode, mapStatistics, leftScenario, rightScenario);
      const curVal = resolveValue(col, 'current', siteIndicators, catchmentData, rangeMode, mapStatistics, leftScenario, rightScenario);
      const targetVal = siteIndicators?.ideal?.[col] ?? (typeof refVal === 'number' ? refVal : undefined);

      points.push({
        ref: typeof refVal === 'number' && Number.isFinite(refVal) ? refVal : null,
        cur: typeof curVal === 'number' && Number.isFinite(curVal) ? curVal : null,
        target: typeof targetVal === 'number' && Number.isFinite(targetVal) ? targetVal : null,
      });
    }

    const valid = points.filter((p) => p.ref !== null || p.cur !== null || p.target !== null);
    return valid.length > 0 ? valid : null;
  }, [chartGroup, columns, variableTypes, canGraph, siteIndicators, catchmentData, rangeMode, mapStatistics, leftScenario, rightScenario]);

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

  const hasData = summaryData !== null;

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
        {visible ? (attribute ? 'Loading\u2026' : 'No attribute selected') : null}
      </Box>
    );
  }

  const svgHeight = height;
  const plotW = width - PADDING.left - PADDING.right;
  const plotH = svgHeight - PADDING.top - PADDING.bottom;

  const yTickCount = 5;

  const renderSummaryChart = () => {
    if (!summaryData) return null;
    const { xLabel, chartType, values } = summaryData;
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

        {/* Group scatter overlay */}
        {groupData && (() => {
          const allGroupVals = groupData.flatMap((p) =>
            [p.ref, p.cur, p.target].filter((v): v is number => v !== null),
          );
          if (allGroupVals.length === 0) return null;
          const gMin = Math.min(...allGroupVals);
          const gMax = Math.max(...allGroupVals);
          const gRange = gMax - gMin || 1;
          const groupY = (val: number) =>
            PADDING.top + plotH - ((val - gMin) / gRange) * plotH * progress;

          return (
            <g opacity={0.6}>
              {/* Right axis label */}
              <text
                x={width - PADDING.right + 10}
                y={PADDING.top}
                fill="#718096" fontSize={10}
                fontFamily="Inter, sans-serif"
                textAnchor="start"
              >
                Group
              </text>
              <text
                x={width - PADDING.right + 10}
                y={PADDING.top + 12}
                fill="#718096" fontSize={10}
                fontFamily="Inter, sans-serif"
                textAnchor="start"
              >
                (norm.)
              </text>
              {/* 0% and 100% tick marks on right axis */}
              <line
                x1={width - PADDING.right} y1={PADDING.top}
                x2={width - PADDING.right + 4} y2={PADDING.top}
                stroke="#4a5568" strokeWidth={1}
              />
              <text x={width - PADDING.right + 6} y={PADDING.top + 4} fill="#4a5568" fontSize={9} fontFamily="Inter, sans-serif">max</text>
              <line
                x1={width - PADDING.right} y1={PADDING.top + plotH}
                x2={width - PADDING.right + 4} y2={PADDING.top + plotH}
                stroke="#4a5568" strokeWidth={1}
              />
              <text x={width - PADDING.right + 6} y={PADDING.top + plotH + 4} fill="#4a5568" fontSize={9} fontFamily="Inter, sans-serif">min</text>

              {(() => {
                const means = ([
                  groupData.map((p) => p.ref),
                  groupData.map((p) => p.cur),
                  groupData.map((p) => p.target),
                ] as (number | null)[][]).map((vals) => {
                  const nums = vals.filter((v): v is number => v !== null);
                  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
                });
                return means.map((val, si) => {
                  if (val === null) return null;
                  const cx = isBar ? barXPos(si) + barWidth / 2 : pointX(si);
                  const cy = groupY(val);
                  return (
                    <circle
                      key={`group-summary-${si}`}
                      cx={cx} cy={cy}
                      r={5}
                      fill={GROUP_SCATTER_COLORS[si]}
                      fillOpacity={0.85}
                      stroke={SERIES_COLORS[si]}
                      strokeWidth={1.5}
                      strokeOpacity={0.8}
                    />
                  );
                });
              })()}
            </g>
          );
        })()}
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
            {renderSummaryChart()}
          </motion.div>
        )}
      </AnimatePresence>
    </Box>
  );
}

export default ChartView;
