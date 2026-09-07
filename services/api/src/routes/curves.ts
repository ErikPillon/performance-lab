import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { activityCurve, db } from '@lab/db';
import { env } from '../env.js';
import { requireAthleteAccess } from '../access.js';

/**
 * Which channel best represents sustained effort, per sport.
 *
 * Running prefers grade-adjusted speed: a hill repeat otherwise reads as a slow
 * interval. Cycling prefers power where a meter exists and falls back to speed,
 * which is a weak proxy outdoors — wind and drafting move it far more than
 * fitness does — but is meaningful on a trainer.
 */
const DEFAULT_METRIC: Record<string, string[]> = {
  running: ['gap_mps', 'speed_mps', 'heart_rate'],
  cycling: ['power_w', 'speed_mps', 'heart_rate'],
  swimming: ['speed_mps', 'heart_rate'],
  rowing: ['power_w', 'speed_mps', 'heart_rate'],
};

export async function curveRoutes(app: FastifyInstance) {
  /**
   * Aggregated mean-maximal curve: the best each duration has ever seen within
   * the window, and which activity produced it.
   */
  app.get<{
    Params: { id: string };
    Querystring: { sport?: string; metric?: string; from?: string; to?: string };
  }>('/athletes/:id/curve', async (req, reply) => {
    await requireAthleteAccess(req, req.params.id);
    const sport = req.query.sport ?? 'running';

    // Pick the first preferred metric that actually has data, so the default
    // view is never an empty chart just because there is no power meter.
    let metric = req.query.metric;
    if (!metric) {
      const available = await db
        .selectDistinct({ metric: activityCurve.metric })
        .from(activityCurve)
        .where(and(eq(activityCurve.athleteId, req.params.id), eq(activityCurve.sport, sport as never)));
      const present = new Set(available.map((r) => r.metric));
      metric = (DEFAULT_METRIC[sport] ?? ['speed_mps']).find((m) => present.has(m));
      // Every field the populated response carries, so a client never has to
      // distinguish "no curve" from "a curve shaped differently".
      if (!metric) {
        return reply.send({
          sport, metric: null, points: [], critical: null,
          predictions: [], vdot: null, available: [],
        });
      }
    }

    const filters = [
      eq(activityCurve.athleteId, req.params.id),
      eq(activityCurve.sport, sport as never),
      eq(activityCurve.metric, metric),
    ];
    if (req.query.from) filters.push(gte(activityCurve.startTime, new Date(req.query.from)));
    if (req.query.to) filters.push(lte(activityCurve.startTime, new Date(req.query.to)));

    // DISTINCT ON gives the best value per duration and the activity that set
    // it in one pass, which a plain MAX aggregate cannot do.
    const points = await db
      .selectDistinctOn([activityCurve.durationS], {
        durationS: activityCurve.durationS,
        value: activityCurve.value,
        activityId: activityCurve.activityId,
        startTime: activityCurve.startTime,
      })
      .from(activityCurve)
      .where(and(...filters))
      .orderBy(activityCurve.durationS, desc(activityCurve.value));

    // Fit critical speed/power from the aggregated curve, not per activity: the
    // model wants best efforts, and no single session contains all of them.
    let critical = null;
    // Race predictions come back with the fit rather than from a second call:
    // one of the two models is built from that very fit, and the curve has
    // already been sent.
    let predictions: unknown[] = [];
    let vdot: unknown = null;
    // Only meaningful for distance-covering channels. A prediction off a heart
    // rate curve would be a number with no units behind it.
    const predictable = metric === 'gap_mps' || metric === 'speed_mps';
    if (points.length >= 3) {
      try {
        const res = await fetch(`${env.analyticsUrl}/curve/critical`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            curve: Object.fromEntries(points.map((p) => [p.durationS, p.value])),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const body = (await res.json()) as {
            fit: unknown;
            predictions?: unknown[];
            vdot?: unknown;
          };
          critical = body.fit;
          if (predictable) {
            predictions = body.predictions ?? [];
            // VDOT is a running number. Daniels' equations are fitted to
            // running economy, so quoting one off a cycling or swimming curve
            // would be a category error dressed as a measurement.
            if (sport === 'running') vdot = body.vdot ?? null;
          }
        }
      } catch {
        /* the curve is still worth returning without a fit */
      }
    }

    const available = await db
      .selectDistinct({ metric: activityCurve.metric })
      .from(activityCurve)
      .where(and(eq(activityCurve.athleteId, req.params.id), eq(activityCurve.sport, sport as never)));

    return {
      sport,
      metric,
      points,
      critical,
      predictions,
      vdot,
      available: available.map((r) => r.metric),
    };
  });

  /** Which sports have curve data, so the UI offers only real options. */
  app.get<{ Params: { id: string } }>('/athletes/:id/curve/sports', async (req) => {
    await requireAthleteAccess(req, req.params.id);
    const rows = await db
      .select({ sport: activityCurve.sport, activities: sql<number>`count(DISTINCT ${activityCurve.activityId})::int` })
      .from(activityCurve)
      .where(eq(activityCurve.athleteId, req.params.id))
      .groupBy(activityCurve.sport)
      .orderBy(desc(sql`count(DISTINCT ${activityCurve.activityId})`));
    return { sports: rows };
  });
}
