import { eq, sql } from 'drizzle-orm';
import { activity, activityLoad, athleteDaily, db } from '@lab/db';
import { computePmc } from './analytics.js';
import { EXCLUDED_METHOD } from './load.js';

/**
 * Rebuild the daily rollup and fitness model for one athlete.
 *
 * Always a full rebuild rather than an incremental update. Every day's CTL
 * depends on every day before it, so a late-arriving activity from last week
 * invalidates everything after it — and at a few thousand rows the whole series
 * costs less than working out which part of it to patch.
 */
export async function rebuildPmc(athleteId: string): Promise<{ days: number; latest: unknown }> {
  const rows = await db
    .select({
      // The athlete's local calendar day, not the UTC one.
      //
      // The dashboard's calendar has always bucketed by local date and this
      // rollup by UTC, so the two views could disagree about which day a
      // session belonged to. They agree on every activity in this corpus —
      // all of it is daytime in CET/CEST — but a session starting just after
      // local midnight, or anything trained after long-haul travel, would land
      // on different days in the two places. Nothing in the stored series
      // changes today; this stops it going wrong later.
      date: sql<string>`(
        (${activityLoad.startTime} AT TIME ZONE 'UTC')
        + (coalesce(${activity.tzOffsetMin}, 0) || ' minutes')::interval
      )::date::text`,
      load: sql<number>`coalesce(sum(${activityLoad.load}), 0)`,
      durationS: sql<number>`coalesce(sum(${activity.durationS}), 0)`,
      distanceM: sql<number>`coalesce(sum(${activity.distanceM}), 0)`,
      n: sql<number>`count(*)::int`,
    })
    .from(activityLoad)
    .innerJoin(activity, eq(activity.id, activityLoad.activityId))
    .where(
      sql`${activityLoad.athleteId} = ${athleteId}
          AND ${activityLoad.loadMethod} <> ${EXCLUDED_METHOD}`,
    )
    .groupBy(sql`1`);

  const daily: Record<string, number> = {};
  const meta = new Map<string, { durationS: number; distanceM: number; n: number }>();
  for (const row of rows) {
    daily[row.date] = Number(row.load);
    meta.set(row.date, {
      durationS: Number(row.durationS),
      distanceM: Number(row.distanceM),
      n: row.n,
    });
  }
  if (Object.keys(daily).length === 0) return { days: 0, latest: null };

  const { series, latest } = await computePmc(daily);

  await db.delete(athleteDaily).where(eq(athleteDaily.athleteId, athleteId));
  const CHUNK = 500;
  for (let i = 0; i < series.length; i += CHUNK) {
    await db.insert(athleteDaily).values(
      series.slice(i, i + CHUNK).map((d) => {
        const extra = meta.get(d.date);
        return {
          athleteId,
          date: d.date,
          load: d.load,
          durationS: extra?.durationS ?? 0,
          distanceM: extra?.distanceM ?? 0,
          activities: extra?.n ?? 0,
          ctl: d.ctl,
          atl: d.atl,
          tsb: d.tsb,
          rampRate: d.ramp_rate,
          weeklyLoad: d.weekly_load,
          monotony: d.monotony,
          strain: d.strain,
          acwr: d.acwr,
          calcVersion: d.calc_version,
        };
      }),
    );
  }
  return { days: series.length, latest };
}
