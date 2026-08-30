import { and, desc, eq, lte } from 'drizzle-orm';
import { db } from './index.js';
import { athlete, athleteThreshold } from './schema.js';

export interface ResolvedThresholds {
  max_hr: number | null;
  rest_hr: number | null;
  lthr: number | null;
  ftp_watts: number | null;
  css_sec_per_100m: number | null;
  threshold_pace_sec_per_km: number | null;
  weight_kg: number | null;
  sex: string;
  /** Which dated entry each value came from, for display and debugging. */
  sources: Record<string, string>;
}

const FIELDS = [
  ['max_hr', 'maxHr'],
  ['rest_hr', 'restHr'],
  ['lthr', 'lthr'],
  ['ftp_watts', 'ftpWatts'],
  ['css_sec_per_100m', 'cssSecPer100m'],
  ['threshold_pace_sec_per_km', 'thresholdPaceSecPerKm'],
  ['weight_kg', 'weightKg'],
] as const;

type ThresholdRowish = {
  effectiveFrom: string;
  maxHr: number | null;
  restHr: number | null;
  lthr: number | null;
  ftpWatts: number | null;
  cssSecPer100m: number | null;
  thresholdPaceSecPerKm: number | null;
  weightKg: number | null;
};

/**
 * Fold dated threshold entries into the values in effect, **per field**.
 *
 * Thresholds are independent measurements taken at different times: an FTP test
 * in March says nothing about the CSS measured last year, and that CSS remains
 * the best estimate until it is re-measured. Taking the newest row wholesale
 * means entering one new value silently blanks every field that row leaves
 * empty — which on this dataset dropped grade-adjusted pace scoring from 193
 * activities at a stroke.
 *
 * `rows` must be ordered newest first; the first non-null value wins.
 */
export function coalesceThresholds(rows: ThresholdRowish[], sex = 'unspecified'): ResolvedThresholds {
  const resolved: ResolvedThresholds = {
    max_hr: null,
    rest_hr: null,
    lthr: null,
    ftp_watts: null,
    css_sec_per_100m: null,
    threshold_pace_sec_per_km: null,
    weight_kg: null,
    sex,
    sources: {},
  };

  for (const row of rows) {
    for (const [key, column] of FIELDS) {
      const value = row[column];
      if (resolved[key] === null && value !== null && value !== undefined) {
        resolved[key] = value as number;
        resolved.sources[key] = row.effectiveFrom;
      }
    }
  }

  return resolved;
}

/**
 * The thresholds in effect for an athlete at a given instant.
 *
 * Effective-dating holds: only entries at or before `at` are considered, so a
 * 2021 ride is never scored against a threshold set in 2026. Resolution within
 * that window is per field — see `coalesceThresholds`.
 */
export async function resolveThresholdsAt(
  athleteId: string,
  at: Date,
): Promise<ResolvedThresholds> {
  const [profile] = await db
    .select({ sex: athlete.sex })
    .from(athlete)
    .where(eq(athlete.id, athleteId))
    .limit(1);

  const rows = await db
    .select()
    .from(athleteThreshold)
    .where(
      and(
        eq(athleteThreshold.athleteId, athleteId),
        lte(athleteThreshold.effectiveFrom, at.toISOString().slice(0, 10)),
      ),
    )
    .orderBy(desc(athleteThreshold.effectiveFrom));

  return coalesceThresholds(rows, profile?.sex ?? 'unspecified');
}
