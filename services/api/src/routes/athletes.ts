import { and, asc, count, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { activity, activityLoad, athlete, athleteDaily, athleteThreshold, db, resolveThresholdsAt } from '@lab/db';

/** ISO date string, or undefined if absent/unparseable. */
function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

export async function athleteRoutes(app: FastifyInstance) {
  app.get('/athletes', async () => {
    // A left join and group-by rather than a correlated subquery: the raw form
    // needs an inner alias, and Drizzle renders the outer table reference in a
    // way that did not bind to it, silently returning zero for every athlete.
    const rows = await db
      .select({
        id: athlete.id,
        displayName: athlete.displayName,
        sex: athlete.sex,
        timezone: athlete.timezone,
        activities: sql<number>`count(${activity.id})::int`,
      })
      .from(athlete)
      .leftJoin(activity, eq(activity.athleteId, athlete.id))
      .groupBy(athlete.id, athlete.displayName, athlete.sex, athlete.timezone)
      .orderBy(asc(athlete.displayName));
    return { athletes: rows };
  });

  /**
   * Everything the dashboard header needs in one call: current fitness state,
   * lifetime totals, and the thresholds those numbers were scaled against.
   */
  app.get<{ Params: { id: string } }>('/athletes/:id/summary', async (req, reply) => {
    const { id } = req.params;
    const [who] = await db.select().from(athlete).where(eq(athlete.id, id)).limit(1);
    if (!who) return reply.code(404).send({ error: 'unknown athlete' });

    // Most recent day with a computed model: today for someone still training,
    // the last training day for someone who has stopped.
    const [current] = await db
      .select()
      .from(athleteDaily)
      .where(eq(athleteDaily.athleteId, id))
      .orderBy(desc(athleteDaily.date))
      .limit(1);

    // Activities with a known-wrong duration are counted but excluded from
    // time and distance, matching how the daily rollup treats them. Otherwise
    // the header would claim 365 lifetime hours while the monthly chart sums
    // to 315, and one hand-entered swim would be the difference.
    const [totals] = await db
      .select({
        activities: count(),
        excluded: sql<number>`count(*) FILTER (
          WHERE ${activity.qualityFlags} @> '["implausible_duration"]'::jsonb)::int`,
        durationS: sql<number>`coalesce(sum(${activity.durationS}) FILTER (
          WHERE NOT ${activity.qualityFlags} @> '["implausible_duration"]'::jsonb), 0)`,
        distanceM: sql<number>`coalesce(sum(${activity.distanceM}) FILTER (
          WHERE NOT ${activity.qualityFlags} @> '["implausible_duration"]'::jsonb), 0)`,
        first: sql<string>`min(${activity.startTime})::text`,
        last: sql<string>`max(${activity.startTime})::text`,
      })
      .from(activity)
      .where(eq(activity.athleteId, id));

    // Coalesced per field rather than the newest row alone, so a CSS measured
    // in 2020 still shows if the newest entry only recorded an FTP test.
    const effective = await resolveThresholdsAt(id, new Date());
    const [newest] = await db
      .select({ effectiveFrom: athleteThreshold.effectiveFrom, note: athleteThreshold.note })
      .from(athleteThreshold)
      .where(eq(athleteThreshold.athleteId, id))
      .orderBy(desc(athleteThreshold.effectiveFrom))
      .limit(1);

    const thresholds = newest
      ? {
          effectiveFrom: newest.effectiveFrom,
          note: newest.note,
          maxHr: effective.max_hr,
          restHr: effective.rest_hr,
          lthr: effective.lthr,
          ftpWatts: effective.ftp_watts,
          cssSecPer100m: effective.css_sec_per_100m,
          thresholdPaceSecPerKm: effective.threshold_pace_sec_per_km,
          weightKg: effective.weight_kg,
          /** Which dated entry each value came from. */
          sources: effective.sources,
        }
      : null;

    const bySport = await db
      .select({
        sport: activity.sport,
        activities: count(),
        durationS: sql<number>`coalesce(sum(${activity.durationS}) FILTER (
          WHERE NOT ${activity.qualityFlags} @> '["implausible_duration"]'::jsonb), 0)`,
        distanceM: sql<number>`coalesce(sum(${activity.distanceM}) FILTER (
          WHERE NOT ${activity.qualityFlags} @> '["implausible_duration"]'::jsonb), 0)`,
        load: sql<number>`coalesce((
          SELECT sum(al.load) FROM ${activityLoad} al
          WHERE al.activity_id IN (
            SELECT a2.id FROM ${activity} a2
            WHERE a2.athlete_id = ${id} AND a2.sport = ${activity.sport}
          )), 0)`,
      })
      .from(activity)
      .where(eq(activity.athleteId, id))
      .groupBy(activity.sport);

    return { athlete: who, current: current ?? null, totals, thresholds, bySport };
  });

  /** The fitness/fatigue/form series. */
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/athletes/:id/pmc',
    async (req) => {
      const { id } = req.params;
      const from = isoDate(req.query.from);
      const to = isoDate(req.query.to);

      const filters = [eq(athleteDaily.athleteId, id)];
      if (from) filters.push(gte(athleteDaily.date, from));
      if (to) filters.push(lte(athleteDaily.date, to));

      const series = await db
        .select({
          date: athleteDaily.date,
          load: athleteDaily.load,
          ctl: athleteDaily.ctl,
          atl: athleteDaily.atl,
          tsb: athleteDaily.tsb,
          rampRate: athleteDaily.rampRate,
          weeklyLoad: athleteDaily.weeklyLoad,
          monotony: athleteDaily.monotony,
          acwr: athleteDaily.acwr,
          activities: athleteDaily.activities,
          durationS: athleteDaily.durationS,
        })
        .from(athleteDaily)
        .where(and(...filters))
        .orderBy(asc(athleteDaily.date));

      return { series };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string; sport?: string; from?: string; to?: string };
  }>('/athletes/:id/activities', async (req) => {
    const { id } = req.params;
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    const filters = [eq(activity.athleteId, id)];
    if (req.query.sport) {
      filters.push(eq(activity.sport, req.query.sport as typeof activity.$inferSelect.sport));
    }
    if (req.query.from) filters.push(gte(activity.startTime, new Date(req.query.from)));
    if (req.query.to) filters.push(lte(activity.startTime, new Date(req.query.to)));

    const where = and(...filters);
    const [total] = await db.select({ n: count() }).from(activity).where(where);

    const rows = await db
      .select({
        id: activity.id,
        startTime: activity.startTime,
        tzOffsetMin: activity.tzOffsetMin,
        sport: activity.sport,
        subSport: activity.subSport,
        durationS: activity.durationS,
        movingS: activity.movingS,
        distanceM: activity.distanceM,
        elevGainM: activity.elevGainM,
        avgHr: activity.avgHr,
        maxHr: activity.maxHr,
        calories: activity.calories,
        qualityFlags: activity.qualityFlags,
        hasStreams: sql<boolean>`${activity.streamsKey} IS NOT NULL`,
        load: activityLoad.load,
        loadMethod: activityLoad.loadMethod,
        trimp: activityLoad.trimp,
        intensityFactor: activityLoad.intensityFactor,
        gapSecPerKm: activityLoad.gapSecPerKm,
        decouplingPct: activityLoad.decouplingPct,
        efficiencyFactor: activityLoad.efficiencyFactor,
      })
      .from(activity)
      .leftJoin(activityLoad, eq(activityLoad.activityId, activity.id))
      .where(where)
      .orderBy(desc(activity.startTime))
      .limit(limit)
      .offset(offset);

    return { activities: rows, total: total?.n ?? 0, limit, offset };
  });

  /** Time in heart-rate zones, aggregated over a window. */
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/athletes/:id/zones',
    async (req) => {
      // Bound parameters go in as ISO strings with an explicit cast: a raw
      // template cannot serialise a JS Date, and an untyped string leaves
      // Postgres to guess at the comparison type.
      const filters = [sql`${activityLoad.athleteId} = ${req.params.id}::uuid`];
      const from = isoDate(req.query.from);
      const to = isoDate(req.query.to);
      if (from) filters.push(sql`${activityLoad.startTime} >= ${from}::date`);
      // Inclusive of the end date: `<= '2025-12-18'::date` would otherwise cut
      // off everything after midnight on the last day.
      if (to) filters.push(sql`${activityLoad.startTime} < (${to}::date + 1)`);

      // jsonb_each_text unpacks {z1_recovery: "1234", ...} into rows so the
      // zones can be summed across activities in one pass.
      const rows = await db.execute<{ zone: string; seconds: number }>(sql`
        SELECT z.key AS zone, sum(z.value::int)::int AS seconds
        FROM ${activityLoad}, jsonb_each_text(${activityLoad.timeInZones}) AS z(key, value)
        WHERE ${activityLoad.timeInZones} IS NOT NULL AND ${sql.join(filters, sql` AND `)}
        GROUP BY z.key ORDER BY z.key
      `);

      return { zones: [...rows] };
    },
  );
}
