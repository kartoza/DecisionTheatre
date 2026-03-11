import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Box } from '@chakra-ui/react';
import { motion, useAnimation, AnimatePresence } from 'framer-motion';
import type { RangeMode } from '../types';

// Scenario colors from the design system
const SCENARIO_COLORS = {
  reference: '#e65100',  // Orange
  current: '#2bb0ed',    // Blue
  future: '#4caf50',     // Green
};

// Gradient stops for the arc (cool to warm spectrum)
const ARC_GRADIENT_STOPS = [
  { offset: 0, color: '#2ecc40' },     // Green (good/low)
  { offset: 0.15, color: '#01ff70' },  // Light green
  { offset: 0.35, color: '#ffdc00' },  // Yellow
  { offset: 0.55, color: '#ff851b' },  // Orange
  { offset: 0.75, color: '#ff4136' },  // Red-orange
  { offset: 1, color: '#e8003f' },     // Red (high)
];

// Much more padding to prevent clipping
const PADDING = { top: 100, right: 60, bottom: 100, left: 60 };

// Spring-like easing for needle animation
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// Smooth elastic for arc reveal
function easeOutElastic(t: number): number {
  const c4 = (2 * Math.PI) / 3;
  return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
}

// Format a number for display
function formatValue(value: number): string {
  if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(1) + 'M';
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(1) + 'K';
  if (Math.abs(value) < 0.01 && value !== 0) return value.toExponential(1);
  if (Math.abs(value) < 10) return value.toFixed(2);
  return value.toFixed(1);
}

// Convert a value to an angle on the dial (180° arc, left to right)
function valueToAngle(value: number, min: number, max: number): number {
  const range = max - min;
  if (range === 0) return -90; // Point straight up if no range
  const normalized = Math.max(0, Math.min(1, (value - min) / range));
  // Map 0-1 to -180 to 0 degrees (left to right, with 0 being right)
  return -180 + normalized * 180;
}

interface DialChartProps {
  visible: boolean;
  referenceValue?: number;
  currentValue?: number;
  targetValue?: number;
  min: number;
  max: number;
  attribute?: string;
  unit?: string;
  rangeMode?: RangeMode;
}

function DialChart({
  visible,
  referenceValue,
  currentValue,
  targetValue,
  min,
  max,
  attribute = '',
  unit = '',
  rangeMode = 'domain',
}: DialChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 400 });
  const [arcProgress, setArcProgress] = useState(0);
  const [needleProgress, setNeedleProgress] = useState(0);
  const animFrameRef = useRef<number>(0);
  const controls = useAnimation();

  // Responsive sizing
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Staged animation: arc first, then needle
  const runAnimation = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);

    const arcDuration = 800;
    const needleDelay = 400;
    const needleDuration = 1200;
    const startTime = performance.now();

    function tick(now: number) {
      const elapsed = now - startTime;

      // Arc animation (0-800ms)
      const arcT = Math.min(elapsed / arcDuration, 1);
      setArcProgress(easeOutElastic(arcT));

      // Needle animation (starts at 400ms, runs for 1200ms)
      if (elapsed > needleDelay) {
        const needleT = Math.min((elapsed - needleDelay) / needleDuration, 1);
        setNeedleProgress(easeOutBack(needleT));
      }

      if (elapsed < needleDelay + needleDuration) {
        animFrameRef.current = requestAnimationFrame(tick);
      }
    }
    animFrameRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    if (visible) {
      controls.start({
        opacity: 1,
        scale: 1,
        transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] },
      }).then(() => runAnimation());
    } else {
      setArcProgress(0);
      setNeedleProgress(0);
      controls.start({
        opacity: 0,
        scale: 0.9,
        transition: { duration: 0.3, ease: [0.4, 0, 1, 1] },
      });
    }
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [visible, controls, runAnimation]);

  // Calculate dial dimensions with better centering
  const { width, height } = size;
  const centerX = width / 2;
  // Position center lower to give room for the arc at top
  const centerY = height * 0.55;
  const radius = Math.min(
    (width - PADDING.left - PADDING.right) / 2,
    (height - PADDING.top - PADDING.bottom) * 0.75
  );
  const arcWidth = Math.max(30, radius * 0.12);

  // Generate tick marks
  const tickCount = 21;
  const ticks = useMemo(() => {
    const result = [];
    for (let i = 0; i < tickCount; i++) {
      const t = i / (tickCount - 1);
      const angle = -180 + t * 180;
      const radians = (angle * Math.PI) / 180;
      const value = min + t * (max - min);
      const isMajor = i % 5 === 0;
      const tickLength = isMajor ? 18 : 10;
      const innerR = radius + arcWidth / 2 + 4;
      const outerR = innerR + tickLength;
      result.push({
        x1: centerX + Math.cos(radians) * innerR,
        y1: centerY + Math.sin(radians) * innerR,
        x2: centerX + Math.cos(radians) * outerR,
        y2: centerY + Math.sin(radians) * outerR,
        value,
        isMajor,
        labelX: centerX + Math.cos(radians) * (outerR + 18),
        labelY: centerY + Math.sin(radians) * (outerR + 18),
        angle,
      });
    }
    return result;
  }, [centerX, centerY, radius, arcWidth, min, max, tickCount]);

  // Create arc path for the gauge
  const arcPath = useMemo(() => {
    const innerR = radius - arcWidth / 2;
    const outerR = radius + arcWidth / 2;
    const startAngle = Math.PI;
    const endAngle = 0;

    const x1 = centerX + Math.cos(startAngle) * outerR;
    const y1 = centerY + Math.sin(startAngle) * outerR;
    const x2 = centerX + Math.cos(endAngle) * outerR;
    const y2 = centerY + Math.sin(endAngle) * outerR;
    const x3 = centerX + Math.cos(endAngle) * innerR;
    const y3 = centerY + Math.sin(endAngle) * innerR;
    const x4 = centerX + Math.cos(startAngle) * innerR;
    const y4 = centerY + Math.sin(startAngle) * innerR;

    return `M ${x1} ${y1} A ${outerR} ${outerR} 0 0 1 ${x2} ${y2} L ${x3} ${y3} A ${innerR} ${innerR} 0 0 0 ${x4} ${y4} Z`;
  }, [centerX, centerY, radius, arcWidth]);

  // Create arrow needle with proper arrowhead
  const createArrowNeedle = (
    value: number | undefined,
    color: string,
    label: string,
    isPrimary: boolean
  ) => {
    if (value === undefined) return null;

    const targetAngle = valueToAngle(value, min, max);
    // Animate from -90 (pointing up/center) to target
    const animatedAngle = -90 + (targetAngle + 90) * needleProgress;
    const radians = (animatedAngle * Math.PI) / 180;

    const needleLength = radius - arcWidth / 2 - (isPrimary ? 20 : 40);
    const arrowHeadSize = isPrimary ? 16 : 10;
    const shaftWidth = isPrimary ? 6 : 3;

    // Calculate arrow components
    const tipX = centerX + Math.cos(radians) * needleLength;
    const tipY = centerY + Math.sin(radians) * needleLength;

    // Arrow shaft base (near center)
    const baseDistance = isPrimary ? 25 : 15;
    const baseX = centerX + Math.cos(radians) * baseDistance;
    const baseY = centerY + Math.sin(radians) * baseDistance;

    // Perpendicular for shaft width
    const perpX = Math.sin(radians);
    const perpY = -Math.cos(radians);

    // Arrow head base (where head meets shaft)
    const headBaseX = centerX + Math.cos(radians) * (needleLength - arrowHeadSize);
    const headBaseY = centerY + Math.sin(radians) * (needleLength - arrowHeadSize);

    // Build the arrow path
    const arrowPath = isPrimary ? `
      M ${baseX - perpX * shaftWidth} ${baseY - perpY * shaftWidth}
      L ${headBaseX - perpX * shaftWidth} ${headBaseY - perpY * shaftWidth}
      L ${headBaseX - perpX * (arrowHeadSize * 0.8)} ${headBaseY - perpY * (arrowHeadSize * 0.8)}
      L ${tipX} ${tipY}
      L ${headBaseX + perpX * (arrowHeadSize * 0.8)} ${headBaseY + perpY * (arrowHeadSize * 0.8)}
      L ${headBaseX + perpX * shaftWidth} ${headBaseY + perpY * shaftWidth}
      L ${baseX + perpX * shaftWidth} ${baseY + perpY * shaftWidth}
      Z
    ` : `
      M ${baseX} ${baseY}
      L ${tipX} ${tipY}
    `;

    const glowIntensity = isPrimary ? 12 : 6;

    return (
      <g key={label}>
        {/* Glow effect */}
        {isPrimary && (
          <path
            d={arrowPath}
            fill={color}
            opacity={0.4 * needleProgress}
            style={{ filter: `blur(${glowIntensity}px)` }}
          />
        )}
        {/* Shadow */}
        {isPrimary && (
          <path
            d={arrowPath}
            fill="rgba(0,0,0,0.4)"
            transform="translate(3, 3)"
            opacity={needleProgress}
          />
        )}
        {/* Main needle */}
        <path
          d={arrowPath}
          fill={isPrimary ? color : 'none'}
          stroke={color}
          strokeWidth={isPrimary ? 1 : 3}
          strokeLinecap="round"
          strokeDasharray={isPrimary ? undefined : '8,6'}
          opacity={needleProgress}
          style={{
            filter: isPrimary ? `drop-shadow(0 0 ${glowIntensity}px ${color})` : undefined,
          }}
        />
        {/* Arrowhead tip highlight for primary */}
        {isPrimary && (
          <circle
            cx={tipX}
            cy={tipY}
            r={3}
            fill="white"
            opacity={0.8 * needleProgress}
          />
        )}
      </g>
    );
  };

  // Gradient IDs
  const gradientId = 'dial-arc-gradient';
  const glowFilterId = 'dial-glow-filter';

  // Range mode labels
  const rangeModeLabels: Record<RangeMode, string> = {
    domain: 'Full Dataset Range',
    extent: 'Visible Extent Range',
    site: 'Site Catchments Range',
  };

  return (
    <Box
      ref={containerRef}
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      overflow="hidden"
    >
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, scale: 0.85, rotate: -10 }}
            animate={controls}
            exit={{ opacity: 0, scale: 0.85, rotate: 10, transition: { duration: 0.3 } }}
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

              {/* Definitions */}
              <defs>
                {/* Arc gradient */}
                <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
                  {ARC_GRADIENT_STOPS.map((stop, i) => (
                    <stop key={i} offset={`${stop.offset * 100}%`} stopColor={stop.color} />
                  ))}
                </linearGradient>

                {/* Glow filter */}
                <filter id={glowFilterId} x="-100%" y="-100%" width="300%" height="300%">
                  <feGaussianBlur stdDeviation="8" result="blur" />
                  <feComposite in="SourceGraphic" in2="blur" operator="over" />
                </filter>

                {/* Inner shadow for arc */}
                <filter id="arc-inner-shadow">
                  <feOffset dx="0" dy="2" />
                  <feGaussianBlur stdDeviation="3" />
                  <feComposite operator="out" in="SourceGraphic" />
                </filter>
              </defs>

              {/* Decorative outer rings */}
              <circle
                cx={centerX}
                cy={centerY}
                r={radius + arcWidth / 2 + 30}
                fill="none"
                stroke="#2d3748"
                strokeWidth={1}
                strokeDasharray="3,8"
                opacity={0.4 * arcProgress}
              />
              <circle
                cx={centerX}
                cy={centerY}
                r={radius + arcWidth / 2 + 45}
                fill="none"
                stroke="#2d3748"
                strokeWidth={1}
                strokeDasharray="2,12"
                opacity={0.25 * arcProgress}
              />

              {/* Arc background (dark) */}
              <path
                d={arcPath}
                fill="#1e2533"
                stroke="#2d3748"
                strokeWidth={2}
                opacity={arcProgress}
              />

              {/* Arc gradient fill with glow */}
              <path
                d={arcPath}
                fill={`url(#${gradientId})`}
                opacity={0.95 * arcProgress}
                style={{ filter: `url(#${glowFilterId})` }}
              />

              {/* Arc highlight (top edge) */}
              <path
                d={arcPath}
                fill="none"
                stroke="rgba(255,255,255,0.15)"
                strokeWidth={2}
                opacity={arcProgress}
              />

              {/* Tick marks */}
              {ticks.map((tick, i) => (
                <g key={i} opacity={arcProgress}>
                  <line
                    x1={tick.x1}
                    y1={tick.y1}
                    x2={tick.x2}
                    y2={tick.y2}
                    stroke={tick.isMajor ? '#718096' : '#4a5568'}
                    strokeWidth={tick.isMajor ? 2.5 : 1.5}
                    strokeLinecap="round"
                  />
                  {tick.isMajor && (
                    <text
                      x={tick.labelX}
                      y={tick.labelY}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="#a0aec0"
                      fontSize={12}
                      fontFamily="Inter, system-ui, sans-serif"
                      fontWeight="500"
                    >
                      {formatValue(tick.value)}
                    </text>
                  )}
                </g>
              ))}

              {/* Center hub - multi-layered for depth */}
              <circle
                cx={centerX}
                cy={centerY}
                r={35}
                fill="#1a202c"
                stroke="#2d3748"
                strokeWidth={3}
                opacity={arcProgress}
              />
              <circle
                cx={centerX}
                cy={centerY}
                r={28}
                fill="#2d3748"
                opacity={arcProgress}
              />
              <circle
                cx={centerX}
                cy={centerY}
                r={20}
                fill="#3d4a5c"
                opacity={arcProgress}
              />
              <circle
                cx={centerX}
                cy={centerY}
                r={12}
                fill="#4a5568"
                opacity={arcProgress}
              />
              {/* Center highlight */}
              <circle
                cx={centerX - 4}
                cy={centerY - 4}
                r={6}
                fill="rgba(255,255,255,0.1)"
                opacity={arcProgress}
              />

              {/* Arrow needles - render in order: reference, target, current (current on top) */}
              {createArrowNeedle(referenceValue, SCENARIO_COLORS.reference, 'Reference', false)}
              {createArrowNeedle(targetValue, SCENARIO_COLORS.future, 'Target', false)}
              {createArrowNeedle(currentValue, SCENARIO_COLORS.current, 'Current', true)}

              {/* Center cap (on top of needles) */}
              <circle
                cx={centerX}
                cy={centerY}
                r={8}
                fill="#4a5568"
                stroke="#5a6a7c"
                strokeWidth={2}
                opacity={needleProgress}
              />

              {/* Current value display below dial */}
              {currentValue !== undefined && (
                <g opacity={needleProgress}>
                  <text
                    x={centerX}
                    y={centerY + radius * 0.5}
                    textAnchor="middle"
                    fill="white"
                    fontSize={Math.max(32, radius * 0.18)}
                    fontFamily="Inter, system-ui, sans-serif"
                    fontWeight="bold"
                    style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))' }}
                  >
                    {formatValue(currentValue)}
                  </text>
                  {unit && (
                    <text
                      x={centerX}
                      y={centerY + radius * 0.5 + 28}
                      textAnchor="middle"
                      fill="#718096"
                      fontSize={14}
                      fontFamily="Inter, system-ui, sans-serif"
                    >
                      {unit}
                    </text>
                  )}
                </g>
              )}

              {/* Attribute label at top */}
              {attribute && (
                <text
                  x={centerX}
                  y={40}
                  textAnchor="middle"
                  fill="#e2e8f0"
                  fontSize={16}
                  fontFamily="Inter, system-ui, sans-serif"
                  fontWeight="600"
                  opacity={arcProgress}
                >
                  {attribute}
                </text>
              )}

              {/* Legend - horizontal layout at bottom */}
              <g transform={`translate(${centerX - 200}, ${height - 60})`} opacity={needleProgress}>
                {/* Reference */}
                <g>
                  <line x1={0} y1={0} x2={24} y2={0} stroke={SCENARIO_COLORS.reference} strokeWidth={3} strokeDasharray="6,4" />
                  <polygon points="24,-4 32,0 24,4" fill={SCENARIO_COLORS.reference} />
                  <text x={40} y={4} fill="#a0aec0" fontSize={12} fontFamily="Inter, system-ui, sans-serif">
                    Reference{referenceValue !== undefined ? `: ${formatValue(referenceValue)}` : ''}
                  </text>
                </g>

                {/* Current */}
                <g transform="translate(0, 28)">
                  <rect x={0} y={-6} width={32} height={12} rx={2} fill={SCENARIO_COLORS.current} />
                  <polygon points="32,-6 42,0 32,6" fill={SCENARIO_COLORS.current} />
                  <text x={50} y={4} fill="#a0aec0" fontSize={12} fontFamily="Inter, system-ui, sans-serif" fontWeight="600">
                    Current{currentValue !== undefined ? `: ${formatValue(currentValue)}` : ''}
                  </text>
                </g>

                {/* Target */}
                <g transform="translate(220, 0)">
                  <line x1={0} y1={0} x2={24} y2={0} stroke={SCENARIO_COLORS.future} strokeWidth={3} strokeDasharray="6,4" />
                  <polygon points="24,-4 32,0 24,4" fill={SCENARIO_COLORS.future} />
                  <text x={40} y={4} fill="#a0aec0" fontSize={12} fontFamily="Inter, system-ui, sans-serif">
                    Target{targetValue !== undefined ? `: ${formatValue(targetValue)}` : ''}
                  </text>
                </g>
              </g>

              {/* Range mode badge */}
              <g transform={`translate(${width - 20}, ${height - 20})`} opacity={arcProgress}>
                <text
                  textAnchor="end"
                  fill="#4a5568"
                  fontSize={11}
                  fontFamily="Inter, system-ui, sans-serif"
                >
                  {rangeModeLabels[rangeMode]}
                </text>
              </g>
            </svg>
          </motion.div>
        )}
      </AnimatePresence>
    </Box>
  );
}

export default DialChart;
