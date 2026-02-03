import { useEffect, useRef, useState, useCallback } from 'react';
import { Box } from '@chakra-ui/react';
import { motion, useAnimation, AnimatePresence } from 'framer-motion';

// Kartoza color scheme: orange, blue, gray
const SERIES_COLORS = ['#e65100', '#2bb0ed', '#6b7280'];
const SERIES_LABELS = ['Reference', 'Current', 'Ideal Future'];

// Generated sample data: 3 series, 10 points each
const SAMPLE_DATA: number[][] = [
  [12, 28, 45, 38, 56, 72, 65, 80, 74, 90],
  [8, 22, 35, 50, 48, 62, 78, 70, 85, 95],
  [5, 15, 30, 25, 40, 55, 50, 60, 68, 75],
];

const X_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];

const PADDING = { top: 40, right: 40, bottom: 50, left: 60 };

function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function buildPath(
  data: number[],
  width: number,
  height: number,
  maxVal: number,
  progress: number,
): string {
  const plotW = width - PADDING.left - PADDING.right;
  const plotH = height - PADDING.top - PADDING.bottom;
  const stepX = plotW / (data.length - 1);

  return data
    .map((val, i) => {
      const x = PADDING.left + i * stepX;
      const animatedVal = val * progress;
      const y = PADDING.top + plotH - (animatedVal / maxVal) * plotH;
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

function buildAreaPath(
  data: number[],
  width: number,
  height: number,
  maxVal: number,
  progress: number,
): string {
  const plotW = width - PADDING.left - PADDING.right;
  const plotH = height - PADDING.top - PADDING.bottom;
  const stepX = plotW / (data.length - 1);
  const baseline = PADDING.top + plotH;

  const points = data.map((val, i) => {
    const x = PADDING.left + i * stepX;
    const animatedVal = val * progress;
    const y = PADDING.top + plotH - (animatedVal / maxVal) * plotH;
    return `${x},${y}`;
  });

  const firstX = PADDING.left;
  const lastX = PADDING.left + (data.length - 1) * stepX;

  return `M${firstX},${baseline} L${points.join(' L')} L${lastX},${baseline} Z`;
}

interface ChartViewProps {
  visible: boolean;
}

function ChartView({ visible }: ChartViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
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

  // Animate data from 0 to 1 when visible
  const animateTo = useCallback((target: number) => {
    const duration = 2000; // 2 seconds
    cancelAnimationFrame(animFrameRef.current);
    startTimeRef.current = performance.now();
    const startVal = target === 1 ? 0 : 1;

    function tick(now: number) {
      const elapsed = now - startTimeRef.current;
      const t = Math.min(elapsed / duration, 1);
      const eased = easeOutExpo(t);
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
      // Sequence: fade in container, then animate data
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

  const { width, height } = size;
  const maxVal = Math.max(...SAMPLE_DATA.flat()) * 1.1;
  const plotW = width - PADDING.left - PADDING.right;
  const plotH = height - PADDING.top - PADDING.bottom;
  const stepX = plotW / (X_LABELS.length - 1);

  // Y-axis tick values
  const yTicks = [0, 25, 50, 75, 100].filter((v) => v <= maxVal);

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
              <rect width={width} height={height} fill="#1a202c" rx={0} />

              {/* Grid lines */}
              {yTicks.map((val) => {
                const y = PADDING.top + plotH - (val / maxVal) * plotH;
                return (
                  <g key={`grid-${val}`}>
                    <line
                      x1={PADDING.left}
                      y1={y}
                      x2={width - PADDING.right}
                      y2={y}
                      stroke="#2d3748"
                      strokeWidth={1}
                    />
                    <text
                      x={PADDING.left - 12}
                      y={y + 4}
                      textAnchor="end"
                      fill="#718096"
                      fontSize={12}
                      fontFamily="Inter, sans-serif"
                    >
                      {val}
                    </text>
                  </g>
                );
              })}

              {/* X-axis labels */}
              {X_LABELS.map((label, i) => {
                const x = PADDING.left + i * stepX;
                return (
                  <text
                    key={`xlabel-${i}`}
                    x={x}
                    y={height - PADDING.bottom + 24}
                    textAnchor="middle"
                    fill="#718096"
                    fontSize={12}
                    fontFamily="Inter, sans-serif"
                  >
                    {label}
                  </text>
                );
              })}

              {/* X-axis tick marks */}
              {X_LABELS.map((_, i) => {
                const x = PADDING.left + i * stepX;
                return (
                  <line
                    key={`xtick-${i}`}
                    x1={x}
                    y1={PADDING.top + plotH}
                    x2={x}
                    y2={PADDING.top + plotH + 6}
                    stroke="#4a5568"
                    strokeWidth={1}
                  />
                );
              })}

              {/* Axes */}
              <line
                x1={PADDING.left}
                y1={PADDING.top}
                x2={PADDING.left}
                y2={PADDING.top + plotH}
                stroke="#4a5568"
                strokeWidth={1}
              />
              <line
                x1={PADDING.left}
                y1={PADDING.top + plotH}
                x2={width - PADDING.right}
                y2={PADDING.top + plotH}
                stroke="#4a5568"
                strokeWidth={1}
              />

              {/* Area fills (rendered first, behind lines) */}
              {SAMPLE_DATA.map((series, si) => (
                <path
                  key={`area-${si}`}
                  d={buildAreaPath(series, width, height, maxVal, progress)}
                  fill={SERIES_COLORS[si]}
                  fillOpacity={0.08}
                />
              ))}

              {/* Line paths */}
              {SAMPLE_DATA.map((series, si) => (
                <path
                  key={`line-${si}`}
                  d={buildPath(series, width, height, maxVal, progress)}
                  fill="none"
                  stroke={SERIES_COLORS[si]}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}

              {/* Data points (dots) - staggered appearance */}
              {SAMPLE_DATA.map((series, si) =>
                series.map((val, pi) => {
                  const x = PADDING.left + pi * stepX;
                  const animatedVal = val * progress;
                  const y = PADDING.top + plotH - (animatedVal / maxVal) * plotH;
                  // Stagger: each point waits a bit longer
                  const pointProgress = Math.max(
                    0,
                    Math.min(1, (progress - pi * 0.06) / 0.4),
                  );
                  const r = 4 * pointProgress;
                  return (
                    <circle
                      key={`dot-${si}-${pi}`}
                      cx={x}
                      cy={y}
                      r={r}
                      fill={SERIES_COLORS[si]}
                      stroke="#1a202c"
                      strokeWidth={2}
                    />
                  );
                }),
              )}

              {/* Legend */}
              {SERIES_LABELS.map((label, i) => {
                const legendX = PADDING.left + i * 140;
                const legendY = height - 12;
                return (
                  <g key={`legend-${i}`}>
                    <circle cx={legendX} cy={legendY - 4} r={5} fill={SERIES_COLORS[i]} />
                    <text
                      x={legendX + 12}
                      y={legendY}
                      fill="#a0aec0"
                      fontSize={12}
                      fontFamily="Inter, sans-serif"
                      fontWeight={500}
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
