import { eq, sql } from 'drizzle-orm';
import { activity, activityLoad, db } from '@lab/db';
import { computeLoad, type LoadResult } from './analytics.js';
import { resolveThresholds } from './thresholds.js';

/** Models that measure load rather than infer it from duration alone. */
export const DIRECT_METHODS = ['power_tss', 'pace_tss', 'swim_tss', 'hr_tss'] as const;

/**
 * A session whose duration is known to be wrong cannot be rescued by a
 * duration-based estimate — that would hand the fitness model the very number
 * the flag exists to distrust. The corpus has a 750 m swim recorded as 50
 * hours; estimating its load from duration would produce a season's training
 * in one afternoon.
 */
export const EXCLUDED_METHOD = 'excluded_implausible';
export const ESTIMATE_METHOD = 'duration_estimate';

export type ActivityRow = typeof activity.$inferSelect;

/** Compute and persist load for one activity. */
export async function computeAndStore(
  row: ActivityRow,
  preference: 'consistency' | 'precision' = 'consistency',
): Promise<LoadResult> {
  const thresholds = await resolveThresholds(row.athleteId, row.startTime);

  const summary = {
    sport: row.sport,
    sub_sport: row.subSport,
    duration_s: row.durationS,
    moving_s: row.movingS,
    distance_m: row.distanceM,
    avg_hr: row.avgHr,
    quality_flags: row.qualityFlags,
    sample_count: row.sampleCount,
  };

  const result = await computeLoad(summary, row.streamsKey, thresholds, preference);

  const excluded = (row.qualityFlags ?? []).includes('implausible_duration');
  const method = excluded ? EXCLUDED_METHOD : result.load_method;
  const load = excluded ? null : result.load;

  await db
    .insert(activityLoad)
    .values({
      activityId: row.id,
      athleteId: row.athleteId,
      startTime: row.startTime,
      load,
      loadMethod: method,
      trimp: result.trimp ?? null,
      hrTss: result.hr_tss ?? null,
      paceTss: result.pace_tss ?? null,
      powerTss: result.power_tss ?? null,
      swimTss: result.swim_tss ?? null,
      intensityFactor: result.intensity_factor ?? null,
      npWatts: result.np_w ?? null,
      variabilityIndex: result.variability_index ?? null,
      ngpMps: result.ngp_mps ?? null,
      gapSecPerKm: result.gap_sec_per_km ?? null,
      swimPaceSecPer100m: result.swim_pace_sec_per_100m ?? null,
      efficiencyFactor: result.efficiency_factor ?? null,
      decouplingPct: result.decoupling_pct ?? null,
      modelAgreement: result.model_agreement ?? null,
      timeInZones: result.time_in_zones ?? null,
      calcVersion: result.calc_version,
    })
    .onConflictDoUpdate({
      target: activityLoad.activityId,
      set: {
        load: sql`excluded.load`,
        loadMethod: sql`excluded.load_method`,
        trimp: sql`excluded.trimp`,
        hrTss: sql`excluded.hr_tss`,
        paceTss: sql`excluded.pace_tss`,
        powerTss: sql`excluded.power_tss`,
        swimTss: sql`excluded.swim_tss`,
        intensityFactor: sql`excluded.intensity_factor`,
        npWatts: sql`excluded.np_w`,
        variabilityIndex: sql`excluded.variability_index`,
        ngpMps: sql`excluded.ngp_mps`,
        gapSecPerKm: sql`excluded.gap_sec_per_km`,
        swimPaceSecPer100m: sql`excluded.swim_pace_sec_per_100m`,
        efficiencyFactor: sql`excluded.efficiency_factor`,
        decouplingPct: sql`excluded.decoupling_pct`,
        modelAgreement: sql`excluded.model_agreement`,
        timeInZones: sql`excluded.time_in_zones`,
        calcVersion: sql`excluded.calc_version`,
        computedAt: sql`now()`,
      },
    });

  return { ...result, load, load_method: method };
}

/**
 * Fill in activities no direct model could score.
 *
 * Half this athlete's cycling has no heart-rate data at all — 111 of 179 hours.
 * Dropping those would understate chronic training load badly, so they are
 * scored at the athlete's own median load-per-hour for that sport, calibrated
 * from the sessions that *were* directly measured. Marked `duration_estimate`
 * so the inference stays visible rather than passing as measurement.
 */
export async function calibrateEstimates(athleteId: string): Promise<Record<string, number>> {
  const measured = await db
    .select({
      sport: activity.sport,
      load: activityLoad.load,
      durationS: activity.durationS,
    })
    .from(activityLoad)
    .innerJoin(activity, eq(activity.id, activityLoad.activityId))
    .where(sql`${activityLoad.athleteId} = ${athleteId}
               AND ${activityLoad.loadMethod} = ANY(${sql.raw(`ARRAY['${DIRECT_METHODS.join("','")}']`)})
               AND ${activityLoad.load} IS NOT NULL
               AND ${activity.durationS} > 300`);

  const bySport = new Map<string, number[]>();
  for (const row of measured) {
    if (!row.load || !row.durationS) continue;
    const perHour = row.load / (row.durationS / 3600);
    if (!Number.isFinite(perHour) || perHour <= 0) continue;
    const list = bySport.get(row.sport) ?? [];
    list.push(perHour);
    bySport.set(row.sport, list);
  }

  const rates: Record<string, number> = {};
  for (const [sport, values] of bySport) {
    values.sort((a, b) => a - b);
    // Median, not mean: one mis-scored session should not move the rate.
    rates[sport] = values[Math.floor(values.length / 2)]!;
  }
  const allRates = Object.values(rates).sort((a, b) => a - b);
  const globalRate = allRates.length ? allRates[Math.floor(allRates.length / 2)]! : 60;

  const pending = await db
    .select({ id: activity.id, sport: activity.sport, durationS: activity.durationS })
    .from(activityLoad)
    .innerJoin(activity, eq(activity.id, activityLoad.activityId))
    .where(sql`${activityLoad.athleteId} = ${athleteId} AND ${activityLoad.loadMethod} = 'none'`);

  for (const row of pending) {
    if (!row.durationS || row.durationS <= 0) continue;
    const rate = rates[row.sport] ?? globalRate;
    await db
      .update(activityLoad)
      .set({
        load: Math.round(rate * (row.durationS / 3600) * 10) / 10,
        loadMethod: ESTIMATE_METHOD,
        computedAt: new Date(),
      })
      .where(eq(activityLoad.activityId, row.id));
  }

  return rates;
}
