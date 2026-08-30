/**
 * The parts of a dial that are not its shape.
 *
 * A dial is two separable things: a scale — where a value sits between a
 * minimum and a maximum, which band of the gradient it falls in, how it is
 * written down — and a rendering of that scale, which happens to be an arc.
 * Only the second is curved. Everything here is the first, so an arc and a flat
 * bar can be two drawings of one scale rather than two implementations of one
 * idea that drift apart.
 */

/** Scenario colours, from the design system (`design-tokens.json`). */
export const SCENARIO_COLORS = {
  reference: '#e65100', // Orange
  current: '#2bb0ed', // Blue
  future: '#4caf50', // Green
} as const;

/** Where `value` sits in `min..max`, clamped to 0..1. */
export function normalize(value: number, min: number, max: number): number {
  const range = max - min;
  if (range === 0) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / range));
}

/**
 * Gradient stops for the condition band: green at the ecological reference,
 * falling away through yellow to red at both extremes.
 *
 * The green zone is centred on the reference value rather than on the middle of
 * the range, because "good" is defined by the reference, not by the midpoint of
 * whatever happens to be on screen.
 */
export function bandGradientStops(
  min: number,
  max: number,
  referenceValue?: number,
  greenWidth = 0.1,
): { offset: number; color: string }[] {
  if (referenceValue === undefined || isNaN(referenceValue)) {
    // No reference to centre on, so there is no "good" to mark — the band
    // shows magnitude only.
    return [
      { offset: 0, color: '#ffdc00' },
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
  const refNorm = normalize(referenceValue, min, max);
  const halfGreen = greenWidth / 2;
  const greenStart = Math.max(0, refNorm - halfGreen);
  const greenEnd = Math.min(1, refNorm + halfGreen);
  const fadeWidth = Math.max(0.01, greenWidth * 0.5);
  const fadeStart = Math.max(0, greenStart - fadeWidth);
  const fadeEnd = Math.min(1, greenEnd + fadeWidth);
  return [
    { offset: 0, color: '#ff4136' },
    { offset: fadeStart, color: '#ffdc00' },
    { offset: greenStart, color: '#b6e86f' },
    { offset: (greenStart + greenEnd) / 2, color: '#2ecc40' },
    { offset: greenEnd, color: '#b6e86f' },
    { offset: fadeEnd, color: '#ffdc00' },
    { offset: 1, color: '#e8003f' },
  ];
}

/**
 * The normalised centre (0..1) of the green zone, or null when there is no
 * reference to place it from.
 *
 * Markers align to this rather than to the raw reference so a marker sitting
 * "on the reference" looks like it is sitting on the green, which is what the
 * viewer is actually reading.
 */
export function greenZoneCenter(
  min: number,
  max: number,
  referenceValue?: number,
  greenWidth = 0.1,
): number | null {
  if (referenceValue === undefined || isNaN(referenceValue)) return null;
  const range = max - min;
  if (range <= 0) return 0.5;
  const refNorm = normalize(referenceValue, min, max);
  const halfGreen = greenWidth / 2;
  return (Math.max(0, refNorm - halfGreen) + Math.min(1, refNorm + halfGreen)) / 2;
}

/**
 * Compact number formatting for a tick or a legend.
 *
 * These labels sit under a scale that already conveys magnitude, so precision
 * past a couple of significant figures costs width and buys nothing.
 */
export function formatValue(value: number): string {
  if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(1) + 'M';
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(1) + 'K';
  if (Math.abs(value) < 0.01 && value !== 0) return value.toExponential(1);
  if (Math.abs(value) < 10) return value.toFixed(2);
  return value.toFixed(1);
}

/** Evenly spaced tick values across the scale, every other one major. */
export function tickValues(min: number, max: number, count = 11) {
  return Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    return { t, value: min + t * (max - min), isMajor: i % 2 === 0 };
  });
}

/** A scale being held still, and what it was held for. */
export interface HeldRange {
  /** What the range was computed for. Changing this re-takes the hold. */
  key: string;
  min: number;
  max: number;
}

/**
 * Decide which scale to draw against when the scale is locked.
 *
 * The axis is normally derived from the values on it, so moving a target moves
 * the axis, and every other marker slides even though nothing about it changed.
 * That makes an edit hard to read: you cannot tell what you moved from what the
 * scale did underneath you. Locking holds the axis so only the values move.
 *
 * The hold is re-taken when `key` changes — a different factor, or a different
 * range mode — because a scale held for one factor means nothing for another,
 * and switching range mode is an explicit request for a different range. What
 * the lock is for is slider movement, and only that.
 *
 * Returns the range to hold, or null when nothing should be held.
 */
export function resolveHeldRange(
  held: HeldRange | null,
  incoming: HeldRange | null,
  locked: boolean,
): HeldRange | null {
  if (!locked) return null;
  // Nothing real to hold yet. A dial renders once before its values arrive,
  // and taking the hold then froze the placeholder range — the lock pinned the
  // scale to 0..100 and never let go.
  if (incoming === null) return held;
  if (held === null || held.key !== incoming.key) return incoming;
  return held;
}

/** A metadata cap on how far a scale may run, from `Target_min`/`Target_max`. */
export interface ScaleCap {
  min?: number | null;
  max?: number | null;
}

/**
 * Constrain a derived range to the bounds metadata declares for the factor.
 *
 * The three range modes each answer a different question — what the whole
 * dataset covers, what is on screen, what the site covers — and any of them can
 * run past what the factor can physically be. Where `metadata.csv` says so, the
 * declared bound wins: a scale that runs to a value the factor cannot take
 * spends its width on impossible readings and squeezes the real ones together.
 *
 * Only applied where the cap is actually specified and actually exceeded, so a
 * factor with no declared bounds keeps its derived range untouched, and a range
 * already inside them is left alone.
 */
export function capRange(
  range: { min: number; max: number },
  cap?: ScaleCap,
): { min: number; max: number } {
  let { min, max } = range;
  if (cap) {
    if (typeof cap.min === 'number' && Number.isFinite(cap.min) && min < cap.min) min = cap.min;
    if (typeof cap.max === 'number' && Number.isFinite(cap.max) && max > cap.max) max = cap.max;
  }
  // Capping both ends can cross them over on a factor whose declared bounds are
  // narrower than its data. A collapsed scale would divide by zero downstream,
  // so the derived range wins in that case — the cap is a sanity bound, not a
  // licence to draw nothing.
  if (!(max > min)) return range;
  return { min, max };
}

/**
 * The spread of one attribute across a set of catchments.
 *
 * Site mode used to size its scale from the three plotted values with a 10%
 * pad, which made the axis a function of the target: move the target and every
 * other marker slid. The site's actual spread does not move when a target does.
 */
export function attributeSpread(
  catchments: Array<{ reference?: Record<string, number>; current?: Record<string, number> }>,
  attribute: string,
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const catchment of catchments) {
    for (const values of [catchment.reference, catchment.current]) {
      const raw = values?.[attribute];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      if (raw < min) min = raw;
      if (raw > max) max = raw;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  return { min, max };
}

/** One value on the dial, and where it came from. */
export interface TracedValue {
  value: number | undefined;
  /** Which computation produced it — the dial does not use one source. */
  source: string;
}

/**
 * How a dial arrived at the scale it is drawing.
 *
 * The scale is the product of half a dozen steps — a range per mode, a
 * metadata cap, an expansion to fit the plotted values, a balance cap, an
 * optional hold — and by the time it is on screen it is two numbers with no
 * account of itself. That is fine until someone asks why a marker is where it
 * is, at which point the only way to answer has been to read the code and
 * guess which branch ran.
 *
 * This records the workings so the question can be answered from the screen.
 * Every field is nullable: a range that has not loaded is reported as absent
 * rather than filled in with a plausible number, because a diagnostic that
 * invents values is worse than none.
 */
export interface ScaleDerivation {
  attribute: string;
  unit: string;
  activeMode: string;
  /** What each mode would give, whether or not it is the active one. */
  candidates: {
    domain: { min: number; max: number } | null;
    extent: { min: number; max: number } | null;
    site: { min: number; max: number } | null;
  };
  /** Metadata bounds from `Target_min`/`Target_max`, where declared. */
  cap: { min: number | null; max: number | null } | null;
  /** The active mode's range, before and after the cap was applied. */
  beforeCap: { min: number; max: number } | null;
  afterCap: { min: number; max: number } | null;
  /** After widening to contain the plotted values, and after the balance cap. */
  afterValues: { min: number; max: number } | null;
  /** The range being held by the scale lock, when one is. */
  held: { min: number; max: number } | null;
  /** What the dial is actually drawn against. */
  final: { min: number; max: number };
  /** True when the scale was centred on zero for a signed factor. */
  zeroCentred: boolean;
  reference: TracedValue;
  current: TracedValue;
  target: TracedValue;
}
