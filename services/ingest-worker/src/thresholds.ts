import { and, desc, eq, lte } from 'drizzle-orm';
import { athlete, athleteThreshold, db } from '@lab/db';
import type { ThresholdSet } from './analytics.js';

/**
 * The thresholds in effect for an athlete at a given instant.
 *
 * Deliberately not "the athlete's current thresholds". FTP and LTHR drift over
 * years, so scoring a 2021 ride against a 2026 FTP would misstate it badly.
 * Every load computation resolves the row whose `effective_from` is the latest
 * one at or before the activity's start.
 */
export async function resolveThresholds(athleteId: string, at: Date): Promise<ThresholdSet> {
  const [profile] = await db
    .select({ sex: athlete.sex })
    .from(athlete)
    .where(eq(athlete.id, athleteId))
    .limit(1);

  const [row] = await db
    .select()
    .from(athleteThreshold)
    .where(
      and(
        eq(athleteThreshold.athleteId, athleteId),
        lte(athleteThreshold.effectiveFrom, at.toISOString().slice(0, 10)),
      ),
    )
    .orderBy(desc(athleteThreshold.effectiveFrom))
    .limit(1);

  return {
    max_hr: row?.maxHr ?? null,
    rest_hr: row?.restHr ?? null,
    lthr: row?.lthr ?? null,
    ftp_watts: row?.ftpWatts ?? null,
    css_sec_per_100m: row?.cssSecPer100m ?? null,
    threshold_pace_sec_per_km: row?.thresholdPaceSecPerKm ?? null,
    sex: profile?.sex ?? 'unspecified',
  };
}
