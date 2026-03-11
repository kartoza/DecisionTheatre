import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Box, HStack, Button, Tooltip } from '@chakra-ui/react';
import { motion, useAnimation, AnimatePresence } from 'framer-motion';
import { FiGlobe, FiSquare, FiTarget } from 'react-icons/fi';
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

// Range mode config
const RANGE_MODES: { id: RangeMode; label: string; icon: React.ReactNode; description: string }[] = [
  { id: 'domain', label: 'Full', icon: <FiGlobe size={14} />, description: 'Entire dataset' },
  { id: 'extent', label: 'Extent', icon: <FiSquare size={14} />, description: 'Visible map area' },
  { id: 'site', label: 'Site', icon: <FiTarget size={14} />, description: 'Site catchments' },
];

// Padding for the dial
const PADDING = { top: 80, right: 80, bottom: 140, left: 80 };

// Spring-like easing for needle animation
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// Format a number for display
function formatValue(value: number): string {
  if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(1) + 'M';
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(1) + 'K';
  if (Math.abs(value) < 0.01 && value !== 0) return value.toExponential(1);
  if (Math.abs(value) < 10) return value.toFixed(2);
  return value.toFixed(1);
}

// Convert a value to an angle on the dial
// 0 = left (min), 180 = right (max) - arc curves UPWARD
function valueToAngle(value: number, min: number, max: number): number {
  const range = max - min;
  if (range === 0) return 90; // Point straight up if no range
  const normalized = Math.max(0, Math.min(1, (value - min) / range));
  // Map 0-1 to 180° to 0° (left to right, curving upward)
  return 180 - normalized * 180;
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
  onRangeModeChange?: (mode: RangeMode) => void;
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
  onRangeModeChange,
}: DialChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [needleProgress, setNeedleProgress] = useState(0);
  const [arcProgress, setArcProgress] = useState(0);
  const animFrameRef = useRef<number>(0);
  const controls = useAnimation();
  const prevValuesRef = useRef({ currentValue, referenceValue, targetValue, min, max });

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

  // Animation function
  const runAnimation = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);

    const arcDuration = 600;
    const needleDelay = 200;
    const needleDuration = 1000;
    const startTime = performance.now();

    function tick(now: number) {
      const elapsed = now - startTime;

      // Arc animation
      const arcT = Math.min(elapsed / arcDuration, 1);
      setArcProgress(arcT);

      // Needle animation (starts after delay)
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

  // Re-animate when values change
  useEffect(() => {
    const prev = prevValuesRef.current;
    const changed =
      prev.currentValue !== currentValue ||
      prev.referenceValue !== referenceValue ||
      prev.targetValue !== targetValue ||
      prev.min !== min ||
      prev.max !== max;

    if (changed && visible) {
      prevValuesRef.current = { currentValue, referenceValue, targetValue, min, max };
      runAnimation();
    }
  }, [currentValue, referenceValue, targetValue, min, max, visible, runAnimation]);

  // Initial animation
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
        transition: { duration: 0.3 },
      });
    }
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [visible, controls, runAnimation]);

  // Calculate dial dimensions - HORIZONTAL half-circle (arc above, flat bottom)
  const { width, height } = size;
  const centerX = width / 2;
  // Center is at bottom of the arc area, arc curves upward
  const centerY = height - PADDING.bottom;
  const radius = Math.min(
    (width - PADDING.left - PADDING.right) / 2,
    height - PADDING.top - PADDING.bottom
  ) * 0.85;
  const arcWidth = Math.max(40, radius * 0.15);

  // Generate tick marks around the arc
  const tickCount = 11;
  const ticks = useMemo(() => {
    const result = [];
    for (let i = 0; i < tickCount; i++) {
      const t = i / (tickCount - 1);
      // Angle from 180° (left) to 0° (right), curving upward
      const angleDeg = 180 - t * 180;
      const angleRad = (angleDeg * Math.PI) / 180;
      const value = min + t * (max - min);
      const isMajor = i % 2 === 0;
      const tickLength = isMajor ? 20 : 12;
      const outerR = radius + arcWidth / 2 + 8;
      const innerR = outerR + tickLength;
      result.push({
        x1: centerX + Math.cos(angleRad) * outerR,
        y1: centerY - Math.sin(angleRad) * outerR,
        x2: centerX + Math.cos(angleRad) * innerR,
        y2: centerY - Math.sin(angleRad) * innerR,
        value,
        isMajor,
        labelX: centerX + Math.cos(angleRad) * (innerR + 25),
        labelY: centerY - Math.sin(angleRad) * (innerR + 25),
      });
    }
    return result;
  }, [centerX, centerY, radius, arcWidth, min, max]);

  // Create arc path - UPWARD curving half-circle
  const arcPath = useMemo(() => {
    const innerR = radius - arcWidth / 2;
    const outerR = radius + arcWidth / 2;

    // Start at left (180°), end at right (0°), arc above center
    const x1 = centerX + Math.cos(Math.PI) * outerR; // Left outer
    const y1 = centerY - Math.sin(Math.PI) * outerR;
    const x2 = centerX + Math.cos(0) * outerR; // Right outer
    const y2 = centerY - Math.sin(0) * outerR;
    const x3 = centerX + Math.cos(0) * innerR; // Right inner
    const y3 = centerY - Math.sin(0) * innerR;
    const x4 = centerX + Math.cos(Math.PI) * innerR; // Left inner
    const y4 = centerY - Math.sin(Math.PI) * innerR;

    return `M ${x1} ${y1} A ${outerR} ${outerR} 0 0 1 ${x2} ${y2} L ${x3} ${y3} A ${innerR} ${innerR} 0 0 0 ${x4} ${y4} Z`;
  }, [centerX, centerY, radius, arcWidth]);

  // Create arrow needle
  const createArrowNeedle = (
    value: number | undefined,
    color: string,
    isPrimary: boolean
  ) => {
    if (value === undefined) return null;

    const targetAngle = valueToAngle(value, min, max);
    // Animate from 90° (pointing up) to target
    const animatedAngle = 90 + (targetAngle - 90) * needleProgress;
    const angleRad = (animatedAngle * Math.PI) / 180;

    const needleLength = radius - arcWidth / 2 - (isPrimary ? 15 : 35);
    const arrowHeadSize = isPrimary ? 18 : 12;
    const shaftWidth = isPrimary ? 8 : 4;

    // Arrow tip
    const tipX = centerX + Math.cos(angleRad) * needleLength;
    const tipY = centerY - Math.sin(angleRad) * needleLength;

    // Arrow base (near center)
    const baseDistance = isPrimary ? 30 : 20;
    const baseX = centerX + Math.cos(angleRad) * baseDistance;
    const baseY = centerY - Math.sin(angleRad) * baseDistance;

    // Perpendicular for shaft width
    const perpAngle = angleRad + Math.PI / 2;
    const perpX = Math.cos(perpAngle);
    const perpY = -Math.sin(perpAngle);

    // Arrow head base
    const headBaseX = centerX + Math.cos(angleRad) * (needleLength - arrowHeadSize);
    const headBaseY = centerY - Math.sin(angleRad) * (needleLength - arrowHeadSize);

    const arrowPath = isPrimary ? `
      M ${baseX - perpX * shaftWidth} ${baseY - perpY * shaftWidth}
      L ${headBaseX - perpX * shaftWidth} ${headBaseY - perpY * shaftWidth}
      L ${headBaseX - perpX * arrowHeadSize} ${headBaseY - perpY * arrowHeadSize}
      L ${tipX} ${tipY}
      L ${headBaseX + perpX * arrowHeadSize} ${headBaseY + perpY * arrowHeadSize}
      L ${headBaseX + perpX * shaftWidth} ${headBaseY + perpY * shaftWidth}
      L ${baseX + perpX * shaftWidth} ${baseY + perpY * shaftWidth}
      Z
    ` : `M ${baseX} ${baseY} L ${tipX} ${tipY}`;

    return (
      <g key={color}>
        {/* Glow */}
        {isPrimary && (
          <path
            d={arrowPath}
            fill={color}
            opacity={0.5 * needleProgress}
            style={{ filter: 'blur(12px)' }}
          />
        )}
        {/* Shadow */}
        {isPrimary && (
          <path
            d={arrowPath}
            fill="rgba(0,0,0,0.5)"
            transform="translate(3, 3)"
            opacity={needleProgress}
          />
        )}
        {/* Main needle */}
        <path
          d={arrowPath}
          fill={isPrimary ? color : 'none'}
          stroke={color}
          strokeWidth={isPrimary ? 2 : 4}
          strokeLinecap="round"
          strokeDasharray={isPrimary ? undefined : '10,8'}
          opacity={needleProgress}
          style={{
            filter: isPrimary ? `drop-shadow(0 0 10px ${color})` : undefined,
          }}
        />
        {/* Tip highlight */}
        {isPrimary && (
          <circle
            cx={tipX}
            cy={tipY}
            r={4}
            fill="white"
            opacity={0.9 * needleProgress}
          />
        )}
      </g>
    );
  };

  const gradientId = 'dial-gradient-main';

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
            initial={{ opacity: 0, scale: 0.9 }}
            animate={controls}
            exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.3 } }}
            style={{ width: '100%', height: '100%', position: 'relative' }}
          >
            {/* Range mode toggle - positioned inside chart area */}
            {onRangeModeChange && (
              <Box
                position="absolute"
                top={4}
                right={4}
                zIndex={10}
                bg="blackAlpha.600"
                borderRadius="xl"
                p={1}
                backdropFilter="blur(8px)"
              >
                <HStack spacing={1}>
                  {RANGE_MODES.map((mode) => {
                    const isActive = rangeMode === mode.id;
                    return (
                      <Tooltip key={mode.id} label={mode.description} placement="bottom">
                        <Button
                          size="sm"
                          leftIcon={mode.icon as React.ReactElement}
                          onClick={() => onRangeModeChange(mode.id)}
                          variant="ghost"
                          bg={isActive ? 'cyan.500' : 'transparent'}
                          color={isActive ? 'white' : 'gray.300'}
                          _hover={{ bg: isActive ? 'cyan.400' : 'whiteAlpha.200' }}
                          fontSize="xs"
                          fontWeight={isActive ? '600' : '400'}
                          px={3}
                        >
                          {mode.label}
                        </Button>
                      </Tooltip>
                    );
                  })}
                </HStack>
              </Box>
            )}

            <svg
              width={width}
              height={height}
              viewBox={`0 0 ${width} ${height}`}
              style={{ display: 'block' }}
            >
              {/* Background */}
              <rect width={width} height={height} fill="#1a202c" />

              {/* Gradient definition */}
              <defs>
                <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
                  {ARC_GRADIENT_STOPS.map((stop, i) => (
                    <stop key={i} offset={`${stop.offset * 100}%`} stopColor={stop.color} />
                  ))}
                </linearGradient>
                <filter id="arc-glow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="6" result="blur" />
                  <feComposite in="SourceGraphic" in2="blur" operator="over" />
                </filter>
              </defs>

              {/* Decorative rings */}
              <path
                d={`M ${centerX - radius - arcWidth/2 - 20} ${centerY} A ${radius + arcWidth/2 + 20} ${radius + arcWidth/2 + 20} 0 0 1 ${centerX + radius + arcWidth/2 + 20} ${centerY}`}
                fill="none"
                stroke="#2d3748"
                strokeWidth={1}
                strokeDasharray="4,8"
                opacity={0.5 * arcProgress}
              />

              {/* Arc background */}
              <path
                d={arcPath}
                fill="#1e2533"
                stroke="#2d3748"
                strokeWidth={2}
                opacity={arcProgress}
              />

              {/* Arc gradient */}
              <path
                d={arcPath}
                fill={`url(#${gradientId})`}
                opacity={0.95 * arcProgress}
                style={{ filter: 'url(#arc-glow)' }}
              />

              {/* Tick marks */}
              {ticks.map((tick, i) => (
                <g key={i} opacity={arcProgress}>
                  <line
                    x1={tick.x1}
                    y1={tick.y1}
                    x2={tick.x2}
                    y2={tick.y2}
                    stroke={tick.isMajor ? '#e2e8f0' : '#718096'}
                    strokeWidth={tick.isMajor ? 3 : 2}
                    strokeLinecap="round"
                  />
                  {tick.isMajor && (
                    <text
                      x={tick.labelX}
                      y={tick.labelY}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="#f7fafc"
                      fontSize={18}
                      fontFamily="Inter, system-ui, sans-serif"
                      fontWeight="700"
                    >
                      {formatValue(tick.value)}
                    </text>
                  )}
                </g>
              ))}

              {/* MIN / MAX labels */}
              <text
                x={centerX - radius - arcWidth/2 - 50}
                y={centerY + 10}
                textAnchor="middle"
                fill="#a0aec0"
                fontSize={16}
                fontFamily="Inter, system-ui, sans-serif"
                fontWeight="600"
                opacity={arcProgress}
              >
                MIN
              </text>
              <text
                x={centerX + radius + arcWidth/2 + 50}
                y={centerY + 10}
                textAnchor="middle"
                fill="#a0aec0"
                fontSize={16}
                fontFamily="Inter, system-ui, sans-serif"
                fontWeight="600"
                opacity={arcProgress}
              >
                MAX
              </text>

              {/* Center hub */}
              <circle cx={centerX} cy={centerY} r={40} fill="#1a202c" stroke="#3d4a5c" strokeWidth={4} opacity={arcProgress} />
              <circle cx={centerX} cy={centerY} r={30} fill="#2d3748" opacity={arcProgress} />
              <circle cx={centerX} cy={centerY} r={20} fill="#4a5568" opacity={arcProgress} />
              <circle cx={centerX} cy={centerY} r={10} fill="#5a6a7c" opacity={arcProgress} />

              {/* Needles */}
              {createArrowNeedle(referenceValue, SCENARIO_COLORS.reference, false)}
              {createArrowNeedle(targetValue, SCENARIO_COLORS.future, false)}
              {createArrowNeedle(currentValue, SCENARIO_COLORS.current, true)}

              {/* Center cap */}
              <circle cx={centerX} cy={centerY} r={12} fill="#4a5568" stroke="#718096" strokeWidth={2} opacity={needleProgress} />

              {/* Current value display */}
              {currentValue !== undefined && (
                <g opacity={needleProgress}>
                  <text
                    x={centerX}
                    y={centerY - radius * 0.4}
                    textAnchor="middle"
                    fill="white"
                    fontSize={Math.max(48, radius * 0.25)}
                    fontFamily="Inter, system-ui, sans-serif"
                    fontWeight="bold"
                    style={{ filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.8))' }}
                  >
                    {formatValue(currentValue)}
                  </text>
                  {unit && (
                    <text
                      x={centerX}
                      y={centerY - radius * 0.4 + 40}
                      textAnchor="middle"
                      fill="#a0aec0"
                      fontSize={18}
                      fontFamily="Inter, system-ui, sans-serif"
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
                  y={50}
                  textAnchor="middle"
                  fill="#f7fafc"
                  fontSize={20}
                  fontFamily="Inter, system-ui, sans-serif"
                  fontWeight="700"
                  opacity={arcProgress}
                >
                  {attribute}
                </text>
              )}

              {/* Legend */}
              <g transform={`translate(${centerX - 220}, ${height - 50})`} opacity={needleProgress}>
                {/* Reference */}
                <g>
                  <line x1={0} y1={0} x2={30} y2={0} stroke={SCENARIO_COLORS.reference} strokeWidth={4} strokeDasharray="8,6" />
                  <polygon points="30,-5 42,0 30,5" fill={SCENARIO_COLORS.reference} />
                  <text x={50} y={5} fill="#e2e8f0" fontSize={14} fontFamily="Inter, system-ui, sans-serif" fontWeight="600">
                    Reference: {referenceValue !== undefined ? formatValue(referenceValue) : 'N/A'}
                  </text>
                </g>

                {/* Current */}
                <g transform="translate(220, 0)">
                  <rect x={0} y={-8} width={35} height={16} rx={3} fill={SCENARIO_COLORS.current} />
                  <polygon points="35,-8 48,0 35,8" fill={SCENARIO_COLORS.current} />
                  <text x={56} y={5} fill="#e2e8f0" fontSize={14} fontFamily="Inter, system-ui, sans-serif" fontWeight="700">
                    Current: {currentValue !== undefined ? formatValue(currentValue) : 'N/A'}
                  </text>
                </g>

                {/* Target */}
                <g transform="translate(440, 0)">
                  <line x1={0} y1={0} x2={30} y2={0} stroke={SCENARIO_COLORS.future} strokeWidth={4} strokeDasharray="8,6" />
                  <polygon points="30,-5 42,0 30,5" fill={SCENARIO_COLORS.future} />
                  <text x={50} y={5} fill="#e2e8f0" fontSize={14} fontFamily="Inter, system-ui, sans-serif" fontWeight="600">
                    Target: {targetValue !== undefined ? formatValue(targetValue) : 'N/A'}
                  </text>
                </g>
              </g>
            </svg>
          </motion.div>
        )}
      </AnimatePresence>
    </Box>
  );
}

export default DialChart;
