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

// Dynamic gradient stops for the arc: green zone for reference, yellow-red outside
// Center the green zone on the reference value by default
function getArcGradientStops(min: number, max: number, referenceValue?: number, greenWidth = 0.1, _greenBias = 0.08) {
  // greenWidth: fraction of total (e.g. 0.1 = 10% of range)
  if (referenceValue === undefined || isNaN(referenceValue)) {
    // fallback: all yellow-red
    return [
      { offset: 0, color: '#ffdc00' }, // yellow
      { offset: 0.5, color: '#ff851b' },
      { offset: 1, color: '#e8003f' },
    ];
  }
  const range = max - min;
  if (range <= 0) {
    return [
      { offset: 0, color: '#2ecc40' },
      { offset: 1, color: '#2ecc40' },
    ];
  }
  // Center green zone on referenceValue
  let refNorm = (referenceValue - min) / range;
  refNorm = Math.max(0, Math.min(1, refNorm));
  const halfGreen = greenWidth / 2;
  const greenStart = Math.max(0, refNorm - halfGreen);
  const greenEnd = Math.min(1, refNorm + halfGreen);
  // Add intermediate stops for a smoother fade
  const fadeWidth = Math.max(0.01, greenWidth * 0.5);
  const fadeStart = Math.max(0, greenStart - fadeWidth);
  const fadeEnd = Math.min(1, greenEnd + fadeWidth);
  return [
    { offset: 0, color: '#ff4136' }, // red
    { offset: fadeStart, color: '#ffdc00' }, // yellow
    { offset: greenStart, color: '#b6e86f' }, // yellow-green
    { offset: (greenStart + greenEnd) / 2, color: '#2ecc40' }, // green center
    { offset: greenEnd, color: '#b6e86f' }, // yellow-green
    { offset: fadeEnd, color: '#ffdc00' }, // yellow
    { offset: 1, color: '#e8003f' }, // red
  ];
}

// Compute the normalized center (0..1) of the green zone so arrows can align
function computeGreenCenter(min: number, max: number, referenceValue?: number, greenWidth = 0.1, _greenBias = 0.08): number | null {
  if (referenceValue === undefined || isNaN(referenceValue)) return null;
  const range = max - min;
  if (range <= 0) return 0.5;
  let refNorm = (referenceValue - min) / range;
  refNorm = Math.max(0, Math.min(1, refNorm));
  const halfGreen = greenWidth / 2;
  const greenStart = Math.max(0, refNorm - halfGreen);
  const greenEnd = Math.min(1, refNorm + halfGreen);
  return (greenStart + greenEnd) / 2;
}

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
  isSiteAvailable?: boolean;
}

function DialChart({
  visible,
  referenceValue,
  currentValue,
  targetValue,
  min: _inputMin,
  max: inputMax,
  attribute = '',
  unit = '',
  rangeMode = 'domain',
  onRangeModeChange,
  isSiteAvailable = true,
}: DialChartProps) {
  // Determine minimum for the dial. Prefer the provided input min, but never
  // assume 0 if any of the values go negative — expand the minimum to include
  // negative current/reference/target values so the needle and ticks render correctly.
  let min = typeof _inputMin === 'number' && !isNaN(_inputMin) ? _inputMin : 0;
  // Ensure we include zero unless input explicitly larger; then allow negatives
  min = Math.min(min, 0);
  const negativeCandidates = [currentValue, referenceValue, targetValue].filter(
    (v): v is number => typeof v === 'number' && !isNaN(v) && v < min
  );
  if (negativeCandidates.length > 0) {
    min = Math.min(min, ...negativeCandidates);
  }
  // Adjust max if current or target is above 100
  let max = inputMax;
  if ((currentValue !== undefined && currentValue > 100) || (targetValue !== undefined && targetValue > 100)) {
    max = Math.max(inputMax, currentValue ?? -Infinity, targetValue ?? -Infinity);
    // Optionally add a small buffer
    max = Math.ceil(max * 1.05);
  }
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

  // Calculate radius based on available space
  const availableWidth = width - PADDING.left - PADDING.right;
  const availableHeight = height - PADDING.top - PADDING.bottom;
  // For a half-circle: height needed = radius (arc) + ~120px (labels below center)
  const maxRadiusFromWidth = availableWidth / 2;
  const maxRadiusFromHeight = availableHeight - 120; // Reserve space for labels below
  // Reduce scale so dial is narrower and leaves room for top labels
  const radius = Math.min(maxRadiusFromWidth, maxRadiusFromHeight) * 0.62;
  const arcWidth = Math.max(40, radius * 0.15);

  // Center the dial vertically within the container
  // The dial visual occupies: radius above center + ~100px below center
  const spaceAbove = radius + arcWidth / 2 + 60; // arc + ticks + tick labels
  const spaceBelow = 100; // MIN/MAX labels + legend
  const totalDialHeight = spaceAbove + spaceBelow;
  const verticalOffset = (availableHeight - totalDialHeight) / 2;
  const centerY = PADDING.top + spaceAbove + verticalOffset;

  const startAngle = -90; // or whatever your arc starts at
  const arcAngle = 180;    // semicircle gauge

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
  // If isPrimary or isTarget, render filled arrow; else, render line
  const createArrowNeedle = (
    value: number | undefined,
    color: string,
    isPrimary: boolean,
    isTarget?: boolean
  ) => {
    if (value === undefined) return null;

    const targetAngle = valueToAngle(value, min, max);
    // Animate from 90° (pointing up) to target
    const animatedAngle = 90 + (targetAngle - 90) * needleProgress;
    const angleRad = (animatedAngle * Math.PI) / 180;

    // Current uses a filled arrow; target uses a dashed shaft with a triangular head
    const filled = !!isPrimary;
    const needleLength = radius - arcWidth / 2 - (filled ? 15 : 35);
    const arrowHeadSize = filled ? 18 : 12;
    const shaftWidth = filled ? 8 : 4;

    // Arrow tip
    const tipX = centerX + Math.cos(angleRad) * needleLength;
    const tipY = centerY - Math.sin(angleRad) * needleLength;

    // Arrow base (near center)
    const baseDistance = filled ? 30 : 20;
    const baseX = centerX + Math.cos(angleRad) * baseDistance;
    const baseY = centerY - Math.sin(angleRad) * baseDistance;

    // Perpendicular for shaft width
    const perpAngle = angleRad + Math.PI / 2;
    const perpX = Math.cos(perpAngle);
    const perpY = -Math.sin(perpAngle);

    // Arrow head base
    const headBaseX = centerX + Math.cos(angleRad) * (needleLength - arrowHeadSize);
    const headBaseY = centerY - Math.sin(angleRad) * (needleLength - arrowHeadSize);

    // For filled arrows (current) keep the richer rendering
    if (filled) {
      const arrowPath = `
      M ${baseX - perpX * shaftWidth} ${baseY - perpY * shaftWidth}
      L ${headBaseX - perpX * shaftWidth} ${headBaseY - perpY * shaftWidth}
      L ${headBaseX - perpX * arrowHeadSize} ${headBaseY - perpY * arrowHeadSize}
      L ${tipX} ${tipY}
      L ${headBaseX + perpX * arrowHeadSize} ${headBaseY + perpY * arrowHeadSize}
      L ${headBaseX + perpX * shaftWidth} ${headBaseY + perpY * shaftWidth}
      L ${baseX + perpX * shaftWidth} ${baseY + perpY * shaftWidth}
      Z
    `;

      return (
        <g key={color + (isTarget ? '-target' : '')}>
          {/* Glow */}
          <path
            d={arrowPath}
            fill={color}
            opacity={0.5 * needleProgress}
            style={{ filter: 'blur(12px)' }}
          />
          {/* Shadow */}
          <path
            d={arrowPath}
            fill="rgba(0,0,0,0.5)"
            transform="translate(3, 3)"
            opacity={needleProgress}
          />
          {/* Main needle */}
          <path
            d={arrowPath}
            fill={color}
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            opacity={needleProgress}
            style={{ filter: `drop-shadow(0 0 10px ${color})` }}
          />
          {/* Tip highlight */}
          <circle
            cx={tipX}
            cy={tipY}
            r={4}
            fill="white"
            opacity={0.9 * needleProgress}
          />
        </g>
      );
    }

    // For target arrows: draw a dashed shaft and a triangular head matching the legend
    const linePath = `M ${baseX} ${baseY} L ${tipX} ${tipY}`;
    const leftX = headBaseX - perpX * arrowHeadSize;
    const leftY = headBaseY - perpY * arrowHeadSize;
    const rightX = headBaseX + perpX * arrowHeadSize;
    const rightY = headBaseY + perpY * arrowHeadSize;

    return (
      <g key={color + (isTarget ? '-target' : '')}>
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={4}
          strokeDasharray="8,6"
          strokeLinecap="round"
          opacity={needleProgress}
        />
        <polygon
          points={`${leftX} ${leftY} ${tipX} ${tipY} ${rightX} ${rightY}`}
          fill={color}
          opacity={needleProgress}
        />
      </g>
    );
  };


  const gradientId = 'dial-gradient-main';
  const arcGradientStops = useMemo(
    () => getArcGradientStops(min, max, referenceValue, 0.12, 0.08),
    [min, max, referenceValue]
  );

  // Normalized center of the green zone (0..1) so needles can be aligned visually
  const greenCenter = useMemo(
    () => computeGreenCenter(min, max, referenceValue, 0.12, 0.08),
    [min, max, referenceValue]
  );

  // If the target equals the reference and a green center exists, render the target arrow
  // at the visual center of the green zone so arrow and gradient match.
  const targetRenderValue = (targetValue !== undefined && referenceValue !== undefined && targetValue === referenceValue && greenCenter !== null)
    ? min + (max - min) * greenCenter
    : targetValue;

  // Compute final tip coordinates for the target (used for a verification marker).
  const targetTip = useMemo(() => {
    if (targetRenderValue === undefined || targetRenderValue === null) return null;
    const targetAngle = valueToAngle(targetRenderValue, min, max);
    const angleRad = (targetAngle * Math.PI) / 180;
    const needleLength = radius - arcWidth / 2 - 15; // matches filled target arrow
    return {
      x: centerX + Math.cos(angleRad) * needleLength,
      y: centerY - Math.sin(angleRad) * needleLength,
    };
  }, [targetRenderValue, min, max, radius, arcWidth, centerX, centerY]);

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
                    const isDisabled = mode.id === 'site' && !isSiteAvailable;
                    return (
                      <Tooltip key={mode.id} label={isDisabled ? 'No site selected' : mode.description} placement="bottom">
                        <Button
                          size="sm"
                          leftIcon={mode.icon as React.ReactElement}
                          onClick={() => !isDisabled && onRangeModeChange(mode.id)}
                          variant="ghost"
                          bg={isActive ? 'cyan.500' : 'transparent'}
                          color={isActive ? 'white' : isDisabled ? 'gray.600' : 'gray.300'}
                          _hover={{ bg: isDisabled ? 'transparent' : isActive ? 'cyan.400' : 'whiteAlpha.200' }}
                          fontSize="xs"
                          fontWeight={isActive ? '600' : '400'}
                          px={3}
                          cursor={isDisabled ? 'not-allowed' : 'pointer'}
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
              {/* Conic gradient */}
              <radialGradient id={`${gradientId}-fallback`} cx="50%" cy="50%" r="50%">
                {arcGradientStops.map((stop, i) => (
                  <stop key={i} offset={`${stop.offset * 100}%`} stopColor={stop.color} />
                ))}
              </radialGradient>

              {/* Mask that cuts gradient into the exact arc shape (use filled path) */}
              <mask id={`${gradientId}-mask`}>
                <rect width={width} height={height} fill="black" />
                <path d={arcPath} fill="white" />
              </mask>

              <filter id="arc-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="5" result="blur" />
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
              
              {/* Conic gradient arc */}
              <foreignObject
                x="0"
                y="0"
                width={width}
                height={height}
                mask={`url(#${gradientId}-mask)`}
                style={{ filter: 'url(#arc-glow)' }}
                opacity={0.95 * arcProgress}
              >
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    background: `conic-gradient(
                      from ${startAngle}deg at ${centerX}px ${centerY}px,
                      ${arcGradientStops
                        .map(stop => `${stop.color} ${stop.offset * arcAngle}deg`)
                        .join(", ")},
                      transparent ${arcAngle}deg
                    )`
                  }}
                />
              </foreignObject>

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

              {/* MIN / MAX labels - positioned below the dial, much bigger */}
              <g opacity={arcProgress}>
                {/* MIN label and value */}
                <text
                  x={centerX - radius * 0.6}
                  y={centerY + 50}
                  textAnchor="middle"
                  fill="#a0aec0"
                  fontSize={28}
                  fontFamily="Inter, system-ui, sans-serif"
                  fontWeight="700"
                >
                  MIN
                </text>
                <text
                  x={centerX - radius * 0.6}
                  y={centerY + 85}
                  textAnchor="middle"
                  fill="#f7fafc"
                  fontSize={32}
                  fontFamily="Inter, system-ui, sans-serif"
                  fontWeight="800"
                >
                  {formatValue(min)}
                </text>

                {/* MAX label and value */}
                <text
                  x={centerX + radius * 0.6}
                  y={centerY + 50}
                  textAnchor="middle"
                  fill="#a0aec0"
                  fontSize={28}
                  fontFamily="Inter, system-ui, sans-serif"
                  fontWeight="700"
                >
                  MAX
                </text>
                <text
                  x={centerX + radius * 0.6}
                  y={centerY + 85}
                  textAnchor="middle"
                  fill="#f7fafc"
                  fontSize={32}
                  fontFamily="Inter, system-ui, sans-serif"
                  fontWeight="800"
                >
                  {formatValue(max)}
                </text>
              </g>

              {/* Center hub */}
              <circle cx={centerX} cy={centerY} r={40} fill="#1a202c" stroke="#3d4a5c" strokeWidth={4} opacity={arcProgress} />
              <circle cx={centerX} cy={centerY} r={30} fill="#2d3748" opacity={arcProgress} />
              <circle cx={centerX} cy={centerY} r={20} fill="#4a5568" opacity={arcProgress} />
              <circle cx={centerX} cy={centerY} r={10} fill="#5a6a7c" opacity={arcProgress} />

              {/* Needles */}
              {/* Reference arrow removed as requested */}
              {/* If target equals reference, use the center of the green zone for the arrow */}
              {createArrowNeedle(
                targetRenderValue,
                SCENARIO_COLORS.future,
                false,
                true
              )}
              {createArrowNeedle(currentValue, SCENARIO_COLORS.current, true)}

              {/* Verification marker: final target tip position (helps confirm arrow alignment) */}
              {targetTip && (
                <g opacity={Math.min(1, 0.6 + 0.4 * needleProgress)}>
                  <circle cx={targetTip.x} cy={targetTip.y} r={7} fill={SCENARIO_COLORS.future} stroke="#fff" strokeWidth={1.5} />
                </g>
              )}

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
              <g transform={`translate(${centerX - 380}, ${centerY + 100})`} opacity={needleProgress}>
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
