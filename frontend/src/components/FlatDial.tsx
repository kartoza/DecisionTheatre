/**
 * The flat dial: a horizontal condition band read like a belt.
 *
 * The arc gauge spends most of its box on curvature. In a six-pane grid that is
 * the scarcest space in the application, and the curve carries no information —
 * a value's position along the scale is the whole message, and a straight line
 * says that at a fraction of the height.
 *
 * The three scenarios are drawn as three different *kinds* of thing, not three
 * colours of the same thing, because they are not the same kind of quantity:
 *
 *   - **Reference and current** are observations. They are vertical lines that
 *     bisect the band — a reading taken at a point, marked at that point.
 *   - **Target** is a setting. It is a buckle: a frame that grips the band and
 *     can be slid along it. It looks adjustable because it is.
 *
 * That distinction is the point of the design. On the arc gauge all three were
 * arrows from a common hub, which made an aspiration look like a measurement.
 */
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Box, Spinner } from '@chakra-ui/react';
import { motion, useAnimation, AnimatePresence } from 'framer-motion';
import {
  SCENARIO_COLORS,
  bandGradientStops,
  formatValue,
  greenZoneCenter,
  normalize,
  tickValues,
} from '../lib/dialScale';

export interface FlatDialProps {
  visible: boolean;
  referenceValue?: number;
  currentValue?: number;
  targetValue?: number;
  min: number;
  max: number;
  attribute?: string;
  unit?: string;
  compact?: boolean;
  denseLayout?: boolean;
  paneCount?: number;
  isLoading?: boolean;
  zeroCentered?: boolean;
}

function FlatDial({
  visible,
  referenceValue,
  currentValue,
  targetValue,
  min: inputMin,
  max: inputMax,
  attribute = '',
  unit = '',
  compact = false,
  // Accepted for interface parity with DialChart, which uses it to trade label
  // room against arc radius. A flat band has no radius to trade, and its labels
  // already scale off `compact` and `paneCount`, so it has nothing to apply.
  denseLayout: _denseLayout = false,
  paneCount = 1,
  isLoading = false,
  zeroCentered = false,
}: FlatDialProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 300 });
  const controls = useAnimation();
  // Namespaced so two panes never collide on one `url(#…)` reference.
  const gradientId = `flatdial-${useId()}`;

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    controls.start(
      visible
        ? { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } }
        : { opacity: 0, y: 8, transition: { duration: 0.25 } },
    );
  }, [visible, controls]);

  // The range handed down is the range. It is already fixed upstream — by the
  // metadata bound where one is declared, otherwise by the range mode's own
  // minima and maxima — and widening it here to fit the plotted values would
  // undo that, because the target is one of those values. A value outside the
  // scale renders at the end of the band, which is the honest reading of a
  // value outside what the data or the metadata says is reachable.
  const min = typeof inputMin === 'number' && !isNaN(inputMin) ? inputMin : 0;
  const max = inputMax;

  const veryDense = compact && paneCount > 5;
  const { width, height } = size;

  // --- Geometry -----------------------------------------------------------
  //
  // A flat band needs a fraction of the arc's vertical budget, which is the
  // reason for the shape. What it does need is horizontal room for the end
  // labels, so the padding is wide and shallow rather than the reverse.
  const padX = compact ? (veryDense ? 34 : 46) : 72;
  const barH = compact ? (veryDense ? 16 : 22) : 34;
  const fontTick = veryDense ? 9 : compact ? 11 : 13;
  const fontLegend = veryDense ? 10 : compact ? 12 : 14;
  const tickLen = compact ? 7 : 10;

  // The band, its marker labels, its ticks and its legend are one block, and
  // the block is centred. Pinning the band itself to a fraction of the height
  // instead leaves the whole thing riding high with dead space underneath,
  // which wastes the vertical room the flat shape was chosen to save.
  const markerOverhang = barH * (compact ? 0.62 : 0.7);
  const aboveBand = markerOverhang + (veryDense ? 6 : fontTick + (compact ? 8 : 12));
  const ticksH = 4 + tickLen + fontTick + 4;
  const legendGap = veryDense ? 18 : compact ? 26 : 40;
  const legendH = fontLegend + 12;
  const clusterH = aboveBand + barH + ticksH + legendGap + legendH;

  // Room for the pane's header row above the band, which now carries the
  // factor name and both scenario labels.
  const titleReserve = veryDense ? 30 : compact ? 40 : 54;

  const barX = padX;
  const barW = Math.max(40, width - padX * 2);
  const bandY = Math.round(
    titleReserve + Math.max(0, (height - titleReserve - clusterH) / 2) + aboveBand + barH / 2,
  );
  const barTop = bandY - barH / 2;
  const barBottom = bandY + barH / 2;

  const xFor = (value: number) => barX + normalize(value, min, max) * barW;

  const stops = useMemo(
    () => bandGradientStops(min, max, referenceValue, 0.12),
    [min, max, referenceValue],
  );
  const greenCenter = useMemo(
    () => greenZoneCenter(min, max, referenceValue, 0.12),
    [min, max, referenceValue],
  );
  const ticks = useMemo(() => tickValues(min, max, veryDense ? 5 : 11), [min, max, veryDense]);

  // A target sitting exactly on the reference is drawn at the visual centre of
  // the green zone, so the buckle straddles the green rather than its edge.
  const targetDrawValue =
    targetValue !== undefined && referenceValue !== undefined &&
    targetValue === referenceValue && greenCenter !== null
      ? min + (max - min) * greenCenter
      : targetValue;

  /**
   * An observation: a line that bisects the band, with a cap above it.
   *
   * It runs past the band top and bottom so the reading is legible where the
   * band's own colour is darkest, and so two markers close together still read
   * as two.
   */
  const bisector = (
    value: number | undefined,
    color: string,
    label: string,
    dashed: boolean,
  ) => {
    if (value === undefined || isNaN(value)) return null;
    const x = xFor(value);
    const overhang = barH * (compact ? 0.62 : 0.7);
    const top = barTop - overhang;
    const bottom = barBottom + overhang;
    return (
      <g>
        {/* Dark backing so the line stays readable over the yellow band. */}
        <line x1={x} y1={top} x2={x} y2={bottom} stroke="#1a202c" strokeWidth={5} opacity={0.55} />
        <line
          x1={x}
          y1={top}
          x2={x}
          y2={bottom}
          stroke={color}
          strokeWidth={compact ? 2.5 : 3}
          strokeDasharray={dashed ? '6 4' : undefined}
          strokeLinecap="round"
        />
        <circle cx={x} cy={top} r={compact ? 3 : 4} fill={color} />
        {!veryDense && (
          <text
            x={x}
            y={top - (compact ? 6 : 9)}
            textAnchor="middle"
            fill={color}
            fontSize={fontTick}
            fontWeight={600}
          >
            {label}
          </text>
        )}
      </g>
    );
  };

  /**
   * The target: a buckle astride the band.
   *
   * An outer frame grips the band top and bottom, an inner frame gives it the
   * doubled edge a real buckle has, and a prong crosses the opening. It is
   * deliberately the only marker with area — a thing you could take hold of and
   * slide, as against the two readings that are simply where they are.
   */
  const buckle = (value: number | undefined) => {
    if (value === undefined || isNaN(value)) return null;
    const x = xFor(value);
    const color = SCENARIO_COLORS.future;
    const h = barH * (compact ? 2.2 : 2.3);
    const w = barH * (compact ? 1.7 : 1.8);
    const top = bandY - h / 2;
    const inset = compact ? 4 : 5.5;
    const r = compact ? 5 : 7;
    const outer = compact ? 3 : 4;
    return (
      <g>
        {/* Dark backing behind the frame only, so the buckle holds its edge
            against the brightest part of the band without filling its opening. */}
        <rect
          x={x - w / 2}
          y={top}
          width={w}
          height={h}
          rx={r}
          fill="none"
          stroke="#1a202c"
          strokeWidth={outer + 3}
          opacity={0.6}
        />
        <rect
          x={x - w / 2}
          y={top}
          width={w}
          height={h}
          rx={r}
          fill="none"
          stroke={color}
          strokeWidth={outer}
        />
        {/* The doubled edge a real buckle has. */}
        <rect
          x={x - w / 2 + inset}
          y={top + inset}
          width={w - inset * 2}
          height={h - inset * 2}
          rx={Math.max(1, r - 2)}
          fill="none"
          stroke={color}
          strokeWidth={compact ? 1.2 : 1.5}
          opacity={0.8}
        />
        {/* The prong, crossing the opening. The band shows through either side
            of it — the buckle is on the belt, not covering it. */}
        <line
          x1={x}
          y1={top + inset}
          x2={x}
          y2={top + h - inset}
          stroke="#1a202c"
          strokeWidth={(compact ? 2.4 : 3) + 2.5}
          opacity={0.6}
        />
        <line
          x1={x}
          y1={top + inset}
          x2={x}
          y2={top + h - inset}
          stroke={color}
          strokeWidth={compact ? 2.4 : 3}
          strokeLinecap="round"
        />
      </g>
    );
  };

  const legend: { color: string; label: string; kind: 'line' | 'buckle'; dashed?: boolean }[] = [
    { color: SCENARIO_COLORS.reference, label: `Reference: ${referenceValue !== undefined ? formatValue(referenceValue) : 'N/A'}`, kind: 'line', dashed: true },
    { color: SCENARIO_COLORS.current, label: `Current: ${currentValue !== undefined ? formatValue(currentValue) : 'N/A'}`, kind: 'line' },
    { color: SCENARIO_COLORS.future, label: `Target: ${targetValue !== undefined ? formatValue(targetValue) : 'N/A'}`, kind: 'buckle' },
  ];
  const legendY = barBottom + ticksH + legendGap;

  return (
    <Box ref={containerRef} position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={controls}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.25 } }}
            style={{ width: '100%', height: '100%', position: 'relative' }}
          >
            {/* The Full / Extent / Site cluster was here. The header carries
                the same control in every layout, and this copy only ever
                appeared in single-pane view — so the one place it existed was
                the one place it was a duplicate. */}

            {isLoading && (
              <Box position="absolute" inset={0} display="flex" alignItems="center" justifyContent="center" zIndex={5}>
                <Spinner size="lg" color="cyan.400" thickness="3px" speed="0.7s" />
              </Box>
            )}

            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
              {/* The visible title is the pane's, beside the scenario labels.
                  This is what a screen reader reads, so the chart still says
                  what it is without depending on its neighbour. */}
              <title>{attribute}{unit ? ` (${unit})` : ''}</title>
              <rect width={width} height={height} fill="#1a202c" />

              <defs>
                <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
                  {stops.map((s, i) => (
                    <stop key={i} offset={`${s.offset * 100}%`} stopColor={s.color} />
                  ))}
                </linearGradient>
              </defs>

              {/* The factor title is drawn by the pane, alongside the two
                  scenario labels, so that the three read as one header rather
                  than overlapping each other. */}

              {/* The belt. */}
              <rect
                x={barX}
                y={barTop}
                width={barW}
                height={barH}
                rx={barH / 2}
                fill={`url(#${gradientId})`}
              />
              <rect
                x={barX}
                y={barTop}
                width={barW}
                height={barH}
                rx={barH / 2}
                fill="none"
                stroke="rgba(0,0,0,0.35)"
                strokeWidth={1}
              />

              {/* Ticks below the band. */}
              {ticks.map((tick, i) => {
                const x = barX + tick.t * barW;
                const len = tick.isMajor ? tickLen : Math.round(tickLen * 0.6);
                return (
                  <g key={i}>
                    <line
                      x1={x}
                      y1={barBottom + 4}
                      x2={x}
                      y2={barBottom + 4 + len}
                      stroke={tick.isMajor ? '#718096' : '#4a5568'}
                      strokeWidth={1}
                    />
                    {tick.isMajor && (
                      <text
                        x={x}
                        y={barBottom + 4 + len + fontTick + 2}
                        textAnchor="middle"
                        fill="#718096"
                        fontSize={fontTick}
                      >
                        {formatValue(tick.value)}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Zero, when the scale straddles it — otherwise it hides on an
                  unlabelled minor tick and the scale reads as all-positive. */}
              {zeroCentered && min < 0 && max > 0 && (
                <line
                  x1={xFor(0)}
                  y1={barTop - barH * 0.35}
                  x2={xFor(0)}
                  y2={barBottom + barH * 0.35}
                  stroke="#a0aec0"
                  strokeWidth={1}
                  strokeDasharray="2 3"
                />
              )}

              {/* Markers, target last so the buckle sits over the readings. */}
              {bisector(referenceValue, SCENARIO_COLORS.reference, 'REF', true)}
              {bisector(currentValue, SCENARIO_COLORS.current, 'NOW', false)}
              {buckle(targetDrawValue)}

              {/* Legend: each entry drawn as the mark it explains. */}
              {legend.map((item, i) => {
                const colW = barW / 3;
                const cx = barX + colW * i + 14;
                return (
                  <g key={item.label}>
                    {item.kind === 'buckle' ? (
                      <>
                        <rect x={cx - 6} y={legendY - 8} width={12} height={16} rx={3} fill="none" stroke={item.color} strokeWidth={2} />
                        <line x1={cx} y1={legendY - 5} x2={cx} y2={legendY + 5} stroke={item.color} strokeWidth={1.5} />
                      </>
                    ) : (
                      <line
                        x1={cx}
                        y1={legendY - 8}
                        x2={cx}
                        y2={legendY + 8}
                        stroke={item.color}
                        strokeWidth={2.5}
                        strokeDasharray={item.dashed ? '4 3' : undefined}
                        strokeLinecap="round"
                      />
                    )}
                    <text x={cx + 12} y={legendY + fontLegend / 3} fill="#cbd5e0" fontSize={fontLegend}>
                      {item.label}
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

export default memo(FlatDial);
