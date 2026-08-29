/**
 * Recompute derived training metrics for an athlete.
 *
 *   npm run recompute -- --athlete "Erik"
 *   npm run recompute -- --athlete "Erik" --estimate-thresholds
 *
 * Everything below `activity` is derived and disposable: this rebuilds load and
 * the fitness model from stored streams without re-reading a single FIT file or
 * touching a vendor API. That is the point of keeping raw bytes — a better load
 * model is a recompute, not a re-download.
 */
import { asc, eq, sql } from 'drizzle-orm';
import {
  activity,
  activityLoad,
  athlete,
  athleteDaily,
  athleteThreshold,
  db,
  sql as pg,
} from '@lab/db';
import { computePmc, estimateThresholds } from './analytics.js';
import { EXCLUDED_METHOD, calibrateEstimates, computeAndStore } from './load.js';
import { connection } from './queue.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

const name = arg('--athlete') ?? 'Erik';
const preference = (arg('--preference') ?? 'consistency') as 'consistency' | 'precision';
if (!['consistency', 'precision'].includes(preference)) {
  console.error(`--preference must be "consistency" or "precision", got "${preference}"`);
  process.exit(1);
}
const [target] = await db
  .select({ id: athlete.id, displayName: athlete.displayName })
  .from(athlete)
  .where(eq(athlete.displayName, name))
  .limit(1);

if (!target) {
  console.error(`no athlete named "${name}"`);
  process.exit(1);
}
console.log(`recomputing for ${target.displayName} (${target.id})\n`);

// ---------------------------------------------------------------- thresholds
// Load is meaningless without thresholds to scale against, so an athlete who
// has none gets them estimated automatically rather than silently scoring
// every session as unmeasurable. The flag forces a re-estimate once they exist.
const [existingThreshold] = await db
  .select({ id: athleteThreshold.id })
  .from(athleteThreshold)
  .where(eq(athleteThreshold.athleteId, target.id))
  .limit(1);

if (has('--estimate-thresholds') || !existingThreshold) {
  if (!existingThreshold) {
    console.log('no thresholds on file - estimating from training history\n');
  }
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
    .where(eq(activity.athleteId, target.id));

  console.log(`estimating thresholds from ${rows.length} activities...`);
  const est = (await estimateThresholds(rows)) as Record<string, any>;

  for (const w of (est.warnings as string[]) ?? []) console.log(`  ! ${w}`);

  // Effective from the first recorded activity: these are derived from the
  // whole history, so they are the best single estimate for all of it. Add
  // later dated rows as real test results arrive rather than editing this one.
  const [first] = await db
    .select({ start: activity.startTime })
    .from(activity)
    .where(eq(activity.athleteId, target.id))
    .orderBy(asc(activity.startTime))
    .limit(1);
  const effectiveFrom = (first?.start ?? new Date()).toISOString().slice(0, 10);

  await db
    .insert(athleteThreshold)
    .values({
      athleteId: target.id,
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
  console.log(`  seeded thresholds effective ${effectiveFrom}\n`);
}

// ---------------------------------------------------------------------- load
const activities = await db
  .select()
  .from(activity)
  .where(eq(activity.athleteId, target.id))
  .orderBy(asc(activity.startTime));

console.log(`computing load for ${activities.length} activities (${preference} preference)...`);
const started = Date.now();
let done = 0;
let failed = 0;

for (const row of activities) {
  try {
    await computeAndStore(row, preference);
  } catch (err) {
    failed++;
    console.error(`  ! ${row.id}: ${err instanceof Error ? err.message : err}`);
  }
  if (++done % 50 === 0) console.log(`  ${done}/${activities.length}`);
}
console.log(`  ${done} done, ${failed} failed in ${((Date.now() - started) / 1000).toFixed(1)}s`);

const rates = await calibrateEstimates(target.id);
console.log('\ncalibrated load-per-hour from directly measured sessions:');
for (const [sport, rate] of Object.entries(rates)) {
  console.log(`  ${sport.padEnd(10)} ${rate.toFixed(1)} load/hour`);
}

// ----------------------------------------------------------------- rollup
const days = await db
  .select({
    date: sql<string>`(${activityLoad.startTime} AT TIME ZONE 'UTC')::date::text`,
    load: sql<number>`coalesce(sum(${activityLoad.load}), 0)`,
    durationS: sql<number>`coalesce(sum(${activity.durationS}), 0)`,
    distanceM: sql<number>`coalesce(sum(${activity.distanceM}), 0)`,
    n: sql<number>`count(*)::int`,
  })
  .from(activityLoad)
  .innerJoin(activity, eq(activity.id, activityLoad.activityId))
  // Activities whose duration is known to be wrong are excluded outright, not
  // merely zeroed for load: counting a 750 m swim recorded as 50 hours toward
  // monthly training time overstates that month by fifty hours.
  .where(
    sql`${activityLoad.athleteId} = ${target.id}
        AND ${activityLoad.loadMethod} <> ${EXCLUDED_METHOD}`,
  )
  .groupBy(sql`1`);

const daily: Record<string, number> = {};
const meta = new Map<string, { durationS: number; distanceM: number; n: number }>();
for (const d of days) {
  daily[d.date] = Number(d.load);
  meta.set(d.date, { durationS: Number(d.durationS), distanceM: Number(d.distanceM), n: d.n });
}

console.log(`\nbuilding fitness model over ${Object.keys(daily).length} training days...`);
const { series, latest } = await computePmc(daily);

await db.delete(athleteDaily).where(eq(athleteDaily.athleteId, target.id));
const CHUNK = 500;
for (let i = 0; i < series.length; i += CHUNK) {
  await db.insert(athleteDaily).values(
    series.slice(i, i + CHUNK).map((d) => {
      const extra = meta.get(d.date);
      return {
        athleteId: target.id,
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
console.log(`  wrote ${series.length} daily rows`);

if (latest) {
  console.log(
    `\ncurrent: CTL ${latest.ctl.toFixed(1)}  ATL ${latest.atl.toFixed(1)}  ` +
      `TSB ${latest.tsb.toFixed(1)}  (${latest.form})`,
  );
}

await connection.quit();
await pg.end();
