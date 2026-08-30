/**
 * Full recompute of everything derived from stored activities.
 *
 * Load, its calibration and the fitness model are all disposable by design:
 * they can be rebuilt from streams already in object storage without touching a
 * FIT file or a vendor API. That is what makes changing a threshold or
 * improving a model a recompute rather than a re-import.
 *
 * Shared by the CLI and the queue worker so a recompute triggered from the
 * dashboard does exactly what one triggered from a terminal does.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { activity, athlete, athleteThreshold, db } from '@lab/db';
import { estimateThresholds } from './analytics.js';
import { calibrateEstimates, computeAndStore } from './load.js';
import { rebuildPmc } from './pmc.js';

export interface RecomputeOptions {
  estimateThresholds?: boolean;
  preference?: 'consistency' | 'precision';
  /** Called as work progresses, for CLI output or job progress reporting. */
  onProgress?: (update: { phase: string; done?: number; total?: number; message?: string }) => void;
}

export interface RecomputeResult {
  activities: number;
  failed: number;
  thresholdWarnings: string[];
  rates: Record<string, number>;
  days: number;
  elapsedMs: number;
}

/** Derive thresholds from the athlete's own mean-maximal efforts and store them. */
export async function seedThresholds(athleteId: string): Promise<string[]> {
  const rows = await db
    .select({
      streams_key: activity.streamsKey,
      sport: activity.sport,
      sub_sport: activity.subSport,
      duration_s: activity.durationS,
      distance_m: activity.distanceM,
      quality_flags: activity.qualityFlags,
    })
    .from(activity)
    .where(eq(activity.athleteId, athleteId));

  if (rows.length === 0) return ['no activities to estimate thresholds from'];

  const est = (await estimateThresholds(rows)) as Record<string, any>;

  // Effective from the first recorded activity: these are derived from the
  // whole history, so they are the best single estimate for all of it. Later
  // dated rows get added as real test results arrive.
  const [first] = await db
    .select({ start: activity.startTime })
    .from(activity)
    .where(eq(activity.athleteId, athleteId))
    .orderBy(asc(activity.startTime))
    .limit(1);
  const effectiveFrom = (first?.start ?? new Date()).toISOString().slice(0, 10);

  await db
    .insert(athleteThreshold)
    .values({
      athleteId,
      effectiveFrom,
      maxHr: est.max_hr ?? null,
      restHr: est.rest_hr ?? null,
      lthr: est.lthr ?? null,
      ftpWatts: est.ftp_watts ?? null,
      cssSecPer100m: est.css_sec_per_100m ?? null,
      thresholdPaceSecPerKm: est.threshold_pace_sec_per_km ?? null,
      note: `auto-estimated ${est.estimator_version}; review and correct`,
    })
    .onConflictDoUpdate({
      target: [athleteThreshold.athleteId, athleteThreshold.effectiveFrom],
      set: {
        maxHr: sql`excluded.max_hr`,
        restHr: sql`excluded.rest_hr`,
        lthr: sql`excluded.lthr`,
        ftpWatts: sql`excluded.ftp_watts`,
        cssSecPer100m: sql`excluded.css_sec_per_100m`,
        thresholdPaceSecPerKm: sql`excluded.threshold_pace_sec_per_km`,
        note: sql`excluded.note`,
      },
    });

  return (est.warnings as string[]) ?? [];
}

export async function recomputeAthlete(
  athleteId: string,
  opts: RecomputeOptions = {},
): Promise<RecomputeResult> {
  const started = Date.now();
  const progress = opts.onProgress ?? (() => {});
  const preference = opts.preference ?? 'consistency';

  let thresholdWarnings: string[] = [];

  // Load is meaningless without thresholds to scale against, so an athlete who
  // has none gets them estimated rather than every session scoring as
  // unmeasurable.
  const [existing] = await db
    .select({ id: athleteThreshold.id })
    .from(athleteThreshold)
    .where(eq(athleteThreshold.athleteId, athleteId))
    .limit(1);

  if (opts.estimateThresholds || !existing) {
    progress({ phase: 'thresholds', message: 'estimating from training history' });
    thresholdWarnings = await seedThresholds(athleteId);
  }

  const activities = await db
    .select()
    .from(activity)
    .where(eq(activity.athleteId, athleteId))
    .orderBy(asc(activity.startTime));

  progress({ phase: 'load', done: 0, total: activities.length });

  let failed = 0;
  for (const [index, row] of activities.entries()) {
    try {
      await computeAndStore(row, preference);
    } catch {
      failed++;
    }
    if ((index + 1) % 25 === 0 || index === activities.length - 1) {
      progress({ phase: 'load', done: index + 1, total: activities.length });
    }
  }

  progress({ phase: 'calibrate' });
  const rates = await calibrateEstimates(athleteId);

  progress({ phase: 'pmc' });
  const { days } = await rebuildPmc(athleteId);

  progress({ phase: 'done' });
  return {
    activities: activities.length,
    failed,
    thresholdWarnings,
    rates,
    days,
    elapsedMs: Date.now() - started,
  };
}

/** Resolve an athlete by display name, for the CLI. */
export async function findAthlete(name: string) {
  const [row] = await db
    .select({ id: athlete.id, displayName: athlete.displayName })
    .from(athlete)
    .where(eq(athlete.displayName, name))
    .limit(1);
  return row ?? null;
}
