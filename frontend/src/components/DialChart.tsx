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
  { offset: 0.25, color: '#01ff70' },  // Light green
  { offset: 0.5, color: '#ffdc00' },   // Yellow (neutral)
  { offset: 0.75, color: '#ff851b' },  // Orange
  { offset: 1, color: '#e8003f' },     // Red (high)
];

const PADDING = { top: 40, right: 40, bottom: 80, left: 40 };

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
  // We want: 0 = left (-180°), 0.5 = top (-90°), 1 = right (0°)
  return -180 + normalized * 180;
}

interface DialChartProps {
  visible: boolean;
  // Data values
  referenceValue?: number;
  currentValue?: number;
  targetValue?: number;
  // Range bounds
  min: number;
  max: number;
  // Labels
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
  const [progress, setProgress] = useState(0);
  const animFrameRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
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

  // Animate progress from 0 to 1 when visible
  const animateTo = useCallback((target: number) => {
    const duration = 1500;
    cancelAnimationFrame(animFrameRef.current);
    startTimeRef.current = performance.now();
    const startVal = target === 1 ? 0 : 1;

    function tick(now: number) {
      const elapsed = now - startTimeRef.current;
      const t = Math.min(elapsed / duration, 1);
      const eased = easeOutElastic(t);
      const val = startVal + (target - startVal) * eased;
      setProgress(val);
      if (t < 1) {
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
        transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] },
      }).then(() => animateTo(1));
    } else {
      setProgress(0);
      controls.start({
        opacity: 0,
        scale: 0.95,
        transition: { duration: 0.3, ease: [0.4, 0, 1, 1] },
      });
    }
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [visible, controls, animateTo]);

  // Calculate dial dimensions
  const { width, height } = size;
  const centerX = width / 2;
  const centerY = height * 0.65; // Position dial center below middle for half-circle
  const radius = Math.min(
    (width - PADDING.left - PADDING.right) / 2,
    (height - PADDING.top - PADDING.bottom) * 0.8
  );
  const arcWidth = Math.max(20, radius * 0.15);

  // Generate tick marks (11 ticks for 10 segments)
  const tickCount = 11;
  const ticks = useMemo(() => {
    const result = [];
    for (let i = 0; i < tickCount; i++) {
      const t = i / (tickCount - 1);
      const angle = -180 + t * 180;
      const radians = (angle * Math.PI) / 180;
      const value = min + t * (max - min);
      const isMajor = i % 2 === 0;
      const innerR = radius - arcWidth / 2 - (isMajor ? 15 : 8);
      const outerR = radius - arcWidth / 2 - 2;
      result.push({
        x1: centerX + Math.cos(radians) * innerR,
        y1: centerY + Math.sin(radians) * innerR,
        x2: centerX + Math.cos(radians) * outerR,
        y2: centerY + Math.sin(radians) * outerR,
        value,
        isMajor,
        labelX: centerX + Math.cos(radians) * (innerR - 20),
        labelY: centerY + Math.sin(radians) * (innerR - 20),
        angle,
      });
    }
    return result;
  }, [centerX, centerY, radius, arcWidth, min, max, tickCount]);

  // Create arc path for the gauge background
  const arcPath = useMemo(() => {
    const innerR = radius - arcWidth;
    const outerR = radius;
    // Arc from left (-180°) to right (0°)
    const startAngle = Math.PI; // 180° in radians
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

  // Create needle for a given value
  const createNeedle = (value: number | undefined, color: string, label: string, isPrimary: boolean) => {
    if (value === undefined) return null;

    const angle = valueToAngle(value, min, max);
    const animatedAngle = -180 + (angle + 180) * progress;
    const radians = (animatedAngle * Math.PI) / 180;

    const needleLength = radius - arcWidth - (isPrimary ? 10 : 25);
    const needleWidth = isPrimary ? 6 : 3;
    const endX = centerX + Math.cos(radians) * needleLength;
    const endY = centerY + Math.sin(radians) * needleLength;

    // Calculate perpendicular for needle base width
    const perpX = Math.sin(radians) * needleWidth;
    const perpY = -Math.cos(radians) * needleWidth;

    const needlePath = isPrimary
      ? `M ${centerX - perpX} ${centerY - perpY} L ${endX} ${endY} L ${centerX + perpX} ${centerY + perpY} Z`
      : `M ${centerX} ${centerY} L ${endX} ${endY}`;

    return (
      <g key={label}>
        {/* Needle shadow for primary */}
        {isPrimary && (
          <path
            d={needlePath}
            fill="rgba(0,0,0,0.3)"
            transform={`translate(2, 2)`}
          />
        )}
        {/* Needle */}
        <path
          d={needlePath}
          fill={isPrimary ? color : 'none'}
          stroke={color}
          strokeWidth={isPrimary ? 0 : 2}
          strokeDasharray={isPrimary ? undefined : '4,4'}
          style={{
            filter: isPrimary ? `drop-shadow(0 0 8px ${color}80)` : undefined,
          }}
        />
        {/* Needle tip glow for primary */}
        {isPrimary && (
          <circle
            cx={endX}
            cy={endY}
            r={4}
            fill={color}
            style={{ filter: `drop-shadow(0 0 6px ${color})` }}
          />
        )}
      </g>
    );
  };

  // Gradient definition ID
  const gradientId = 'dial-arc-gradient';

  // Range mode label
  const rangeModeLabels: Record<RangeMode, string> = {
    domain: 'Full Dataset',
    extent: 'Map Extent',
    site: 'Site Range',
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

              {/* Gradient definition for arc */}
              <defs>
                <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
                  {ARC_GRADIENT_STOPS.map((stop, i) => (
                    <stop key={i} offset={`${stop.offset * 100}%`} stopColor={stop.color} />
                  ))}
                </linearGradient>
                {/* Glow filter */}
                <filter id="dial-glow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feComposite in="SourceGraphic" in2="blur" operator="over" />
                </filter>
              </defs>

              {/* Outer decorative ring */}
              <circle
                cx={centerX}
                cy={centerY}
                r={radius + 8}
                fill="none"
                stroke="#2d3748"
                strokeWidth={2}
                strokeDasharray="2,4"
                opacity={0.5}
              />

              {/* Arc background (dark) */}
              <path
                d={arcPath}
                fill="#2d3748"
                opacity={0.6}
              />

              {/* Arc gradient overlay (progress-based reveal) */}
              <path
                d={arcPath}
                fill={`url(#${gradientId})`}
                opacity={0.9 * progress}
                style={{ filter: 'url(#dial-glow)' }}
              />

              {/* Tick marks */}
              {ticks.map((tick, i) => (
                <g key={i} opacity={progress}>
                  <line
                    x1={tick.x1}
                    y1={tick.y1}
                    x2={tick.x2}
                    y2={tick.y2}
                    stroke={tick.isMajor ? '#a0aec0' : '#4a5568'}
                    strokeWidth={tick.isMajor ? 2 : 1}
                    strokeLinecap="round"
                  />
                  {/* Labels for major ticks at edges and center */}
                  {(i === 0 || i === tickCount - 1 || i === Math.floor(tickCount / 2)) && (
                    <text
                      x={tick.labelX}
                      y={tick.labelY}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="#718096"
                      fontSize={11}
                      fontFamily="Inter, sans-serif"
                    >
                      {formatValue(tick.value)}
                    </text>
                  )}
                </g>
              ))}

              {/* Min/Max labels */}
              <text
                x={centerX - radius - 10}
                y={centerY + 20}
                textAnchor="end"
                fill="#718096"
                fontSize={12}
                fontFamily="Inter, sans-serif"
              >
                MIN
              </text>
              <text
                x={centerX + radius + 10}
                y={centerY + 20}
                textAnchor="start"
                fill="#718096"
                fontSize={12}
                fontFamily="Inter, sans-serif"
              >
                MAX
              </text>

              {/* Center hub */}
              <circle
                cx={centerX}
                cy={centerY}
                r={arcWidth * 0.6}
                fill="#2d3748"
                stroke="#4a5568"
                strokeWidth={2}
              />
              <circle
                cx={centerX}
                cy={centerY}
                r={arcWidth * 0.3}
                fill="#4a5568"
              />

              {/* Needles (reference and target as secondary, current as primary) */}
              {createNeedle(referenceValue, SCENARIO_COLORS.reference, 'Reference', false)}
              {createNeedle(targetValue, SCENARIO_COLORS.future, 'Target', false)}
              {createNeedle(currentValue, SCENARIO_COLORS.current, 'Current', true)}

              {/* Center value display */}
              {currentValue !== undefined && (
                <g opacity={progress}>
                  <text
                    x={centerX}
                    y={centerY + radius * 0.35}
                    textAnchor="middle"
                    fill="white"
                    fontSize={Math.max(24, radius * 0.15)}
                    fontFamily="Inter, sans-serif"
                    fontWeight="bold"
                  >
                    {formatValue(currentValue)}
                  </text>
                  {unit && (
                    <text
                      x={centerX}
                      y={centerY + radius * 0.35 + 24}
                      textAnchor="middle"
                      fill="#718096"
                      fontSize={12}
                      fontFamily="Inter, sans-serif"
                    >
                      {unit}
                    </text>
                  )}
                </g>
              )}

              {/* Attribute label */}
              {attribute && (
                <text
                  x={centerX}
                  y={30}
                  textAnchor="middle"
                  fill="#a0aec0"
                  fontSize={14}
                  fontFamily="Inter, sans-serif"
                  fontWeight="600"
                >
                  {attribute}
                </text>
              )}

              {/* Legend */}
              <g transform={`translate(${centerX - 180}, ${height - 50})`}>
                {/* Reference */}
                <circle cx={0} cy={0} r={5} fill={SCENARIO_COLORS.reference} />
                <line x1={5} y1={0} x2={20} y2={0} stroke={SCENARIO_COLORS.reference} strokeWidth={2} strokeDasharray="4,4" />
                <text x={28} y={4} fill="#a0aec0" fontSize={11} fontFamily="Inter, sans-serif">
                  Reference{referenceValue !== undefined ? `: ${formatValue(referenceValue)}` : ''}
                </text>

                {/* Current */}
                <g transform="translate(140, 0)">
                  <circle cx={0} cy={0} r={6} fill={SCENARIO_COLORS.current} />
                  <text x={12} y={4} fill="#a0aec0" fontSize={11} fontFamily="Inter, sans-serif">
                    Current{currentValue !== undefined ? `: ${formatValue(currentValue)}` : ''}
                  </text>
                </g>

                {/* Target */}
                <g transform="translate(280, 0)">
                  <circle cx={0} cy={0} r={5} fill={SCENARIO_COLORS.future} />
                  <line x1={5} y1={0} x2={20} y2={0} stroke={SCENARIO_COLORS.future} strokeWidth={2} strokeDasharray="4,4" />
                  <text x={28} y={4} fill="#a0aec0" fontSize={11} fontFamily="Inter, sans-serif">
                    Target{targetValue !== undefined ? `: ${formatValue(targetValue)}` : ''}
                  </text>
                </g>
              </g>

              {/* Range mode indicator */}
              <text
                x={width - 20}
                y={height - 20}
                textAnchor="end"
                fill="#4a5568"
                fontSize={10}
                fontFamily="Inter, sans-serif"
              >
                Range: {rangeModeLabels[rangeMode]}
              </text>
            </svg>
          </motion.div>
        )}
      </AnimatePresence>
    </Box>
  );
}

export default DialChart;
