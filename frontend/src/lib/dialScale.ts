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
