/**
 * Smoothing for efficiency-factor and decoupling trends.
 *
 * Single activities are far too noisy to read a fitness trend from: an interval
 * session and a long easy run produce very different efficiency factors in the
 * same week, from the same athlete, at the same fitness. What matters is where
 * the middle of that cloud sits over months.
 */

export interface TrendPoint {
  /** Epoch milliseconds. */
  x: number;
  y: number | null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Median over a centred window measured in days, not in activities.
 *
 * A window of "the last 9 sessions" silently spans three weeks in a training
 * block and five months around an injury, which makes the smoothed line claim
 * more than it knows. A calendar window keeps the x-axis honest.
 *
 * Centred rather than trailing because this is a description of the past, not a
 * forecast: a trailing window lags the thing it is describing by half its
 * width, which reads as the athlete improving weeks after they actually did.
 *
 * Windows holding fewer than `minPoints` samples yield null, breaking the line
 * rather than drawing a confident curve through a training gap.
 */
export function rollingMedian(
  points: TrendPoint[],
  { halfWindowDays = 21, minPoints = 3 }: { halfWindowDays?: number; minPoints?: number } = {},
): (number | null)[] {
  const half = halfWindowDays * 86_400_000;
  // Points arrive sorted by time from the API; sorting again here keeps the
  // function correct on its own terms rather than on a caller's promise.
  const sorted = [...points].sort((a, b) => a.x - b.x);

  return sorted.map((point) => {
    const window: number[] = [];
    for (const other of sorted) {
      if (other.x < point.x - half) continue;
      if (other.x > point.x + half) break;
      if (other.y != null && Number.isFinite(other.y)) window.push(other.y);
    }
    return window.length >= minPoints ? median(window) : null;
  });
}

/**
 * Compare the first and last months of a series.
 *
 * Deliberately a comparison of two medians rather than a fitted slope: a slope
 * invites reading significance into what is often a dozen noisy points, and it
 * is not robust to one outlier at either end.
 */
export function compareEnds(
  points: TrendPoint[],
  { spanDays = 60, minPoints = 3 }: { spanDays?: number; minPoints?: number } = {},
): { first: number; last: number; changePct: number; from: number; to: number } | null {
  const usable = points
    .filter((p): p is { x: number; y: number } => p.y != null && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
  if (usable.length < minPoints * 2) return null;

  const span = spanDays * 86_400_000;
  const start = usable[0]!.x;
  const end = usable[usable.length - 1]!.x;
  // Needs enough calendar distance for "first" and "last" to be different
  // periods rather than overlapping views of the same fortnight.
  if (end - start < span) return null;

  const first = median(usable.filter((p) => p.x <= start + span).map((p) => p.y));
  const last = median(usable.filter((p) => p.x >= end - span).map((p) => p.y));
  if (first == null || last == null || first === 0) return null;

  return {
    first,
    last,
    changePct: ((last - first) / Math.abs(first)) * 100,
    from: start,
    to: end,
  };
}

/**
 * Insert an explicit break wherever training stopped for a while.
 *
 * The rolling median is defined on both sides of a layoff — each side has
 * plenty of neighbours of its own — so nothing in the series itself is null and
 * the chart joins them with a straight line. Three months off then reads as
 * three months of steady improvement, which is the opposite of what happened.
 *
 * Returns the series with a null-valued sample dropped into the middle of any
 * gap longer than `maxGapDays`, which is what breaks the line.
 */
export function withGapBreaks(
  points: TrendPoint[],
  { maxGapDays = 42 }: { maxGapDays?: number } = {},
): TrendPoint[] {
  const gap = maxGapDays * 86_400_000;
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const out: TrendPoint[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const point = sorted[i]!;
    const previous = sorted[i - 1];
    if (previous && point.x - previous.x > gap) {
      out.push({ x: previous.x + (point.x - previous.x) / 2, y: null });
    }
    out.push(point);
  }
  return out;
}
