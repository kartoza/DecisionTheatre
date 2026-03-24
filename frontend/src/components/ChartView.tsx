import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Box } from '@chakra-ui/react';
import { motion, useAnimation, AnimatePresence } from 'framer-motion';
import { getSiteCatchments, useAttributeAxisLabels } from '../hooks/useApi';
import type { SiteIndicators, MapStatistics, RangeMode, Scenario, ZoneStats } from '../types';

// Kartoza color scheme: orange, blue, green
const SERIES_COLORS = ['#e65100', '#2bb0ed', '#4caf50'];
const SERIES_LABELS = ['Reference', 'Current', 'Ideal Future'];

const PADDING = { top: 50, right: 60, bottom: 70, left: 70 };

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

function ChartView({
  visible,
  attribute,
  siteIndicators,
  siteId,
  rangeMode = 'site',
  mapStatistics,
  leftScenario,
  rightScenario,
}: ChartViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [progress, setProgress] = useState(0);
  const animFrameRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const controls = useAnimation();

  const { axisLabels } = useAttributeAxisLabels();

  // Fallback catchment data when no siteIndicators
  const [catchmentData, setCatchmentData] = useState<{
    reference: Record<string, number>;
    current: Record<string, number>;
  } | null>(null);

  useEffect(() => {
    if (!visible || !attribute) return;
    // extent and domain use mapStatistics (already computed) — no fetch needed
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

  // Build chart data for the selected attribute only
  const chartData = useMemo(() => {
    if (!attribute) return null;

    let refVal: number | undefined;
    let curVal: number | undefined;

    switch (rangeMode) {
      case 'extent':
        // Use map viewport stats for whichever scenarios are visible; fall back to site data for the rest
        refVal = statForScenario('reference', mapStatistics?.leftStats, mapStatistics?.rightStats, leftScenario, rightScenario)
          ?? siteIndicators?.reference?.[attribute];
        curVal = statForScenario('current', mapStatistics?.leftStats, mapStatistics?.rightStats, leftScenario, rightScenario)
          ?? siteIndicators?.current?.[attribute];
        break;
      case 'domain':
        refVal = statForScenario('reference', mapStatistics?.fullStats?.left, mapStatistics?.fullStats?.right, leftScenario, rightScenario)
          ?? siteIndicators?.reference?.[attribute];
        curVal = statForScenario('current', mapStatistics?.fullStats?.left, mapStatistics?.fullStats?.right, leftScenario, rightScenario)
          ?? siteIndicators?.current?.[attribute];
        break;
      case 'site':
      default:
        refVal = siteIndicators?.reference?.[attribute] ?? catchmentData?.reference?.[attribute];
        curVal = siteIndicators?.current?.[attribute] ?? catchmentData?.current?.[attribute];
        break;
    }

    const idealVal = siteIndicators?.ideal?.[attribute] ?? refVal;

    const hasData = [refVal, curVal, idealVal].some(
      (v): v is number => typeof v === 'number' && Number.isFinite(v),
    );
    if (!hasData) return null;

    const xLabel = axisLabels[attribute] ?? attribute.replace(/_/g, ' ');

    return {
      xLabel,
      values: [
        typeof refVal === 'number' && Number.isFinite(refVal) ? refVal : null,
        typeof curVal === 'number' && Number.isFinite(curVal) ? curVal : null,
        typeof idealVal === 'number' && Number.isFinite(idealVal) ? idealVal : null,
      ] as (number | null)[],
    };
  }, [attribute, axisLabels, rangeMode, mapStatistics, leftScenario, rightScenario, siteIndicators, catchmentData]);

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

  const hasChartData = chartData !== null;

  useEffect(() => {
    if (visible && hasChartData) {
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
  }, [visible, hasChartData, controls, animateTo]);

  const { width, height } = size;

  if (!chartData) {
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
        {visible ? (attribute ? 'Loading…' : 'No attribute selected') : null}
      </Box>
    );
  }

  const { xLabel, values } = chartData;
  const numericVals = values.filter((v): v is number => v !== null);
  const minVal = Math.min(...numericVals) * (Math.min(...numericVals) >= 0 ? 0.9 : 1.1);
  const maxVal = Math.max(...numericVals) * (Math.max(...numericVals) >= 0 ? 1.1 : 0.9);
  const range = maxVal - minVal || 1;

  const plotW = width - PADDING.left - PADDING.right;
  const plotH = height - PADDING.top - PADDING.bottom;

  const xTickLabels = ['Reference', 'Current', 'Target'];
  const stepX = plotW / (values.length - 1);

  const yTickCount = 5;
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) =>
    minVal + (range / yTickCount) * i,
  );

  const pointX = (i: number) => PADDING.left + i * stepX;
  const pointY = (val: number) => {
    const animatedVal = minVal + (val - minVal) * progress;
    return PADDING.top + plotH - ((animatedVal - minVal) / range) * plotH;
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
            <svg
              width={width}
              height={height}
              viewBox={`0 0 ${width} ${height}`}
              style={{ display: 'block' }}
            >
              {/* Background */}
              <rect width={width} height={height} fill="#1a202c" />

              {/* Grid lines */}
              {yTicks.map((val, ti) => {
                const y = PADDING.top + plotH - ((val - minVal) / range) * plotH;
                const label = Math.abs(val) >= 10000
                  ? val.toExponential(1)
                  : parseFloat(val.toPrecision(3)).toString();
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
                      {label}
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

              {/* Area fill under line */}
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

              {/* Line connecting points */}
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

              {/* Data points */}
              {values.map((val, i) => {
                if (val === null) return null;
                const cx = pointX(i);
                const cy = pointY(val);
                return (
                  <g key={`pt-${i}`}>
                    <circle cx={cx} cy={cy} r={10} fill={SERIES_COLORS[i]} fillOpacity={0.15} />
                    <circle cx={cx} cy={cy} r={6} fill={SERIES_COLORS[i]} stroke="#1a202c" strokeWidth={2} />
                    {/* Value label above point */}
                    {progress > 0.8 && (
                      <text
                        x={cx} y={cy - 14}
                        textAnchor="middle" fill={SERIES_COLORS[i]}
                        fontSize={11} fontFamily="Inter, sans-serif" fontWeight={600}
                      >
                        {parseFloat(val.toPrecision(3)).toString()}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* X-axis tick labels (scenario names) */}
              {xTickLabels.map((label, i) => (
                <text
                  key={`xtick-${i}`}
                  x={pointX(i)} y={PADDING.top + plotH + 20}
                  textAnchor="middle" fill="#718096"
                  fontSize={12} fontFamily="Inter, sans-serif"
                >
                  {label}
                </text>
              ))}

              {/* X-axis title (axis label from metadata) */}
              <text
                x={PADDING.left + plotW / 2}
                y={height - 8}
                textAnchor="middle" fill="#a0aec0"
                fontSize={13} fontFamily="Inter, sans-serif" fontWeight={500}
              >
                {xLabel}
              </text>

              {/* Legend */}
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
          </motion.div>
        )}
      </AnimatePresence>
    </Box>
  );
}

export default ChartView;
