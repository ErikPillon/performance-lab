/**
 * Training intensity distribution.
 *
 * The five heart-rate zones are useful for reading a single session; the shape
 * of a training block is conventionally described in three, split at the two
 * physiological thresholds. Collapsing to three is what makes "polarised" and
 * "pyramidal" meaningful terms rather than adjectives.
 */

export const ZONE_ORDER = [
  'z1_recovery',
  'z2_aerobic',
  'z3_tempo',
  'z4_threshold',
  'z5_vo2max',
] as const;

export const ZONE_LABEL: Record<string, string> = {
  z1_recovery: 'Z1 Recovery',
  z2_aerobic: 'Z2 Aerobic',
  z3_tempo: 'Z3 Tempo',
  z4_threshold: 'Z4 Threshold',
  z5_vo2max: 'Z5 VO₂max',
};

/**
 * Cool through warm, so intensity reads without consulting the legend.
 *
 * Shared with the dashboard's zone bars deliberately: the same zone showing a
 * different colour on two pages is the kind of small inconsistency that makes
 * a reader distrust both.
 */
export const ZONE_COLOR: Record<string, string> = {
  z1_recovery: '#64748b',
  z2_aerobic: 'var(--run)',
  z3_tempo: 'var(--warn)',
  z4_threshold: 'var(--atl)',
  z5_vo2max: 'var(--bad)',
};

/**
 * The three-zone model, mapped from the five stored zones.
 *
 * The analytics service cuts the five zones at 0.81, 0.89, 0.93 and 0.99 of
 * LTHR. The first aerobic threshold sits at the 0.89 edge and the second at
 * LTHR itself, so `easy` is everything below Z3, `moderate` is the band between
 * the thresholds, and `hard` is above LTHR. Those two edges are the whole
 * reason the mapping is 2/2/1 rather than an even split.
 */
export interface ThreeZone {
  easy: number;
  moderate: number;
  hard: number;
  total: number;
}

export function toThreeZone(zones: Record<string, number>): ThreeZone {
  const easy = (zones.z1_recovery ?? 0) + (zones.z2_aerobic ?? 0);
  const moderate = (zones.z3_tempo ?? 0) + (zones.z4_threshold ?? 0);
  const hard = zones.z5_vo2max ?? 0;
  return { easy, moderate, hard, total: easy + moderate + hard };
}

export type Shape = 'polarised' | 'pyramidal' | 'threshold' | 'insufficient';

/**
 * Name the shape of a distribution.
 *
 * Deliberately the ordering-based definitions rather than a single polarisation
 * index. The published indices are a compressed function of the same three
 * numbers, they disagree with each other, and a scalar invites reading a
 * decimal place of significance into what is a coarse description of a training
 * block. The orderings below are unambiguous and need no citation:
 *
 *   pyramidal  easy > moderate > hard   — the default endurance shape
 *   polarised  easy > hard > moderate   — the middle deliberately hollowed out
 *   threshold  moderate is not the smallest of the two working zones and the
 *              block is not easy-dominated — the "grey zone" pattern
 */
export function classify(z: ThreeZone, { minHours = 5 }: { minHours?: number } = {}): Shape {
  if (z.total < minHours * 3600) return 'insufficient';
  const easy = z.easy / z.total;
  const moderate = z.moderate / z.total;
  const hard = z.hard / z.total;

  // An easy-dominated block with essentially no hard work is pyramidal, not
  // polarised, however small the moderate share is. Without this an athlete
  // doing 95% easy and nothing else flips shape on a single hard session.
  if (easy < 0.6) return 'threshold';
  return hard > moderate ? 'polarised' : 'pyramidal';
}

export function percentages(z: ThreeZone): { easy: number; moderate: number; hard: number } {
  if (z.total === 0) return { easy: 0, moderate: 0, hard: 0 };
  return {
    easy: (z.easy / z.total) * 100,
    moderate: (z.moderate / z.total) * 100,
    hard: (z.hard / z.total) * 100,
  };
}

/** Sum many periods into one distribution. */
export function sumZones(periods: { zones: Record<string, number> }[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const period of periods) {
    for (const [zone, seconds] of Object.entries(period.zones)) {
      total[zone] = (total[zone] ?? 0) + seconds;
    }
  }
  return total;
}
