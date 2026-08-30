import { and, asc, eq, gte, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { activity, activityLoad, db } from '@lab/db';
import { requireAthleteAccess } from '../access.js';

/**
 * Efficiency factor and aerobic decoupling over time.
 *
 * Both are already computed per activity and, until now, were only visible one
 * session at a time. In trend they are the clearest read on aerobic fitness
 * available without a lab: EF rising while heart rate falls is the signature of
 * an improving aerobic base.
 *
 * The endpoint returns raw per-activity points. Smoothing is the client's job —
 * a rolling median is cheap there, trivially testable, and lets the window be
 * changed without a round trip.
 */

/**
 * EF is `mean effort / mean heart rate`, and "effort" is watts when a power
 * meter was present and grade-adjusted speed otherwise. Those are different
 * quantities roughly sixty times apart in magnitude, so a series that mixed
 * them would show a cliff where the athlete merely changed bike.
 *
 * Points are therefore grouped by effort source as well as sport. In the
 * current corpus running is entirely speed-based and cycling entirely
 * power-based, so the split is invisible — which is exactly why it would have
 * been easy to skip and painful to discover later.
 */
type EffortSource = 'power' | 'speed';

const UNIT: Record<EffortSource, string> = {
  power: 'W per beat',
  speed: 'm/s per beat',
};

export async function trendRoutes(app: FastifyInstance) {
  app.get<{
    Params: { id: string };
    Querystring: { sport?: string; from?: string; to?: string };
  }>('/athletes/:id/trends', async (req) => {
    await requireAthleteAccess(req, req.params.id);

    const athleteFilter = eq(activityLoad.athleteId, req.params.id);
    // A row is only useful here if it has at least one of the two metrics.
    const hasMetric = or(
      isNotNull(activityLoad.efficiencyFactor),
      isNotNull(activityLoad.decouplingPct),
    );

    // What the sport selector should offer. Computed over the whole history
    // rather than the requested window, so narrowing the dates does not make
    // the control flicker between one and two options.
    const availableRows = await db
      .select({
        sport: activity.sport,
        activities: sql<number>`count(*)::int`,
        withEf: sql<number>`count(${activityLoad.efficiencyFactor})::int`,
        withDecoupling: sql<number>`count(${activityLoad.decouplingPct})::int`,
      })
      .from(activityLoad)
      .innerJoin(activity, eq(activity.id, activityLoad.activityId))
      .where(and(athleteFilter, hasMetric))
      .groupBy(activity.sport)
      .orderBy(sql`count(*) desc`);

    const available = availableRows.filter((r) => r.activities > 0);
    const sport = req.query.sport ?? available[0]?.sport ?? 'running';

    const filters = [athleteFilter, hasMetric, eq(activity.sport, sport as never)];
    if (req.query.from) filters.push(gte(activityLoad.startTime, new Date(req.query.from)));
    if (req.query.to) filters.push(lte(activityLoad.startTime, new Date(req.query.to)));

    const rows = await db
      .select({
        activityId: activityLoad.activityId,
        startTime: activityLoad.startTime,
        efficiencyFactor: activityLoad.efficiencyFactor,
        decouplingPct: activityLoad.decouplingPct,
        avgHr: activity.avgHr,
        durationS: activity.durationS,
        distanceM: activity.distanceM,
        // Power is the marker for which quantity `efficiencyFactor` is in.
        npWatts: activityLoad.npWatts,
      })
      .from(activityLoad)
      .innerJoin(activity, eq(activity.id, activityLoad.activityId))
      .where(and(...filters))
      .orderBy(asc(activityLoad.startTime));

    type Point = {
      activityId: string;
      startTime: string;
      efficiencyFactor: number | null;
      decouplingPct: number | null;
      avgHr: number | null;
      durationS: number | null;
      distanceM: number | null;
    };
    const groups = new Map<EffortSource, Point[]>();

    for (const row of rows) {
      const source: EffortSource = row.npWatts != null ? 'power' : 'speed';
      const bucket = groups.get(source) ?? [];
      bucket.push({
        activityId: row.activityId,
        startTime: row.startTime.toISOString(),
        efficiencyFactor: row.efficiencyFactor,
        decouplingPct: row.decouplingPct,
        avgHr: row.avgHr,
        durationS: row.durationS,
        distanceM: row.distanceM,
      });
      groups.set(source, bucket);
    }

    return {
      sport,
      available,
      groups: [...groups.entries()]
        // Largest first: with a mixed history the dominant series should be the
        // one drawn by default.
        .sort((a, b) => b[1].length - a[1].length)
        .map(([effortSource, pts]) => ({
          effortSource,
          unit: UNIT[effortSource],
          points: pts,
        })),
    };
  });
}
