import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { activityCurve, db, race, trainingBlock } from '@lab/db';
import { env } from '../env.js';
import { requireAthleteAccess } from '../access.js';
import {
  blockAdvisories, validateBlock, validateRace,
  type BlockInput, type RaceInput,
} from '../seasonRules.js';

/**
 * Races and periodisation blocks.
 *
 * Reads sit under the `training` scope so a coach can see the plan. Writes are
 * the athlete's alone for now — a coach composing an athlete's season is the
 * point of the coach relationship, but it is also a larger permission question
 * than this slice answers, and the safe default is the reversible one.
 */

export async function seasonRoutes(app: FastifyInstance) {
  /** Everything needed to draw a season, in one round trip. */
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/athletes/:id/season',
    async (req) => {
      await requireAthleteAccess(req, req.params.id);

      const raceFilters = [eq(race.athleteId, req.params.id)];
      if (req.query.from) raceFilters.push(gte(race.date, req.query.from));
      if (req.query.to) raceFilters.push(lte(race.date, req.query.to));

      const blockFilters = [eq(trainingBlock.athleteId, req.params.id)];
      // A block overlapping the window counts as inside it: one running from
      // before `from` to after `to` is the most relevant block there is, and a
      // naive range test on startDate would drop exactly that one.
      if (req.query.to) blockFilters.push(lte(trainingBlock.startDate, req.query.to));
      if (req.query.from) blockFilters.push(gte(trainingBlock.endDate, req.query.from));

      const [races, blocks] = await Promise.all([
        db.select().from(race).where(and(...raceFilters)).orderBy(asc(race.date)),
        db.select().from(trainingBlock).where(and(...blockFilters))
          .orderBy(asc(trainingBlock.startDate)),
      ]);
      return { races, blocks };
    },
  );

  async function requireOwnership(req: Parameters<typeof requireAthleteAccess>[0], id: string) {
    const access = await requireAthleteAccess(req, id);
    return access.relationship === 'owner';
  }

  app.post<{ Params: { id: string }; Body: RaceInput }>(
    '/athletes/:id/races',
    async (req, reply) => {
      if (!(await requireOwnership(req, req.params.id))) {
        return reply.code(403).send({ error: 'only the athlete can plan their season' });
      }
      const errors = validateRace(req.body ?? {});
      if (errors.length) return reply.code(400).send({ error: errors.join('; '), errors });

      const [created] = await db.insert(race).values({
        athleteId: req.params.id,
        date: req.body.date!,
        name: req.body.name!.trim(),
        sport: (req.body.sport ?? 'running') as never,
        priority: (req.body.priority ?? 'B') as never,
        distanceM: req.body.distanceM ?? null,
        goalTimeS: req.body.goalTimeS ?? null,
        resultTimeS: req.body.resultTimeS ?? null,
        note: req.body.note?.trim() || null,
      }).returning();
      return reply.code(201).send({ race: created });
    },
  );

  app.patch<{ Params: { id: string; raceId: string }; Body: RaceInput }>(
    '/athletes/:id/races/:raceId',
    async (req, reply) => {
      if (!(await requireOwnership(req, req.params.id))) {
        return reply.code(403).send({ error: 'only the athlete can plan their season' });
      }
      const errors = validateRace(req.body ?? {});
      if (errors.length) return reply.code(400).send({ error: errors.join('; '), errors });

      // Scoped by athlete as well as id: an id alone would let anyone with a
      // uuid edit someone else's race.
      const [updated] = await db.update(race).set({
        date: req.body.date!,
        name: req.body.name!.trim(),
        sport: (req.body.sport ?? 'running') as never,
        priority: (req.body.priority ?? 'B') as never,
        distanceM: req.body.distanceM ?? null,
        goalTimeS: req.body.goalTimeS ?? null,
        resultTimeS: req.body.resultTimeS ?? null,
        note: req.body.note?.trim() || null,
      }).where(and(eq(race.id, req.params.raceId), eq(race.athleteId, req.params.id)))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'no such race' });
      return reply.send({ race: updated });
    },
  );

  app.delete<{ Params: { id: string; raceId: string } }>(
    '/athletes/:id/races/:raceId',
    async (req, reply) => {
      if (!(await requireOwnership(req, req.params.id))) {
        return reply.code(403).send({ error: 'only the athlete can plan their season' });
      }
      const deleted = await db.delete(race)
        .where(and(eq(race.id, req.params.raceId), eq(race.athleteId, req.params.id)))
        .returning({ id: race.id });
      return reply.send({ deleted: deleted.length });
    },
  );

  app.post<{ Params: { id: string }; Body: BlockInput }>(
    '/athletes/:id/blocks',
    async (req, reply) => {
      if (!(await requireOwnership(req, req.params.id))) {
        return reply.code(403).send({ error: 'only the athlete can plan their season' });
      }
      const errors = validateBlock(req.body ?? {});
      if (errors.length) return reply.code(400).send({ error: errors.join('; '), errors });

      const [created] = await db.insert(trainingBlock).values({
        athleteId: req.params.id,
        name: req.body.name!.trim(),
        focus: (req.body.focus ?? 'base') as never,
        startDate: req.body.startDate!,
        endDate: req.body.endDate!,
        targetWeeklyLoad: req.body.targetWeeklyLoad ?? null,
        raceId: req.body.raceId ?? null,
        note: req.body.note?.trim() || null,
      }).returning();
      return reply.code(201).send({ block: created, advisories: blockAdvisories(req.body) });
    },
  );

  app.patch<{ Params: { id: string; blockId: string }; Body: BlockInput }>(
    '/athletes/:id/blocks/:blockId',
    async (req, reply) => {
      if (!(await requireOwnership(req, req.params.id))) {
        return reply.code(403).send({ error: 'only the athlete can plan their season' });
      }
      const errors = validateBlock(req.body ?? {});
      if (errors.length) return reply.code(400).send({ error: errors.join('; '), errors });

      const [updated] = await db.update(trainingBlock).set({
        name: req.body.name!.trim(),
        focus: (req.body.focus ?? 'base') as never,
        startDate: req.body.startDate!,
        endDate: req.body.endDate!,
        targetWeeklyLoad: req.body.targetWeeklyLoad ?? null,
        raceId: req.body.raceId ?? null,
        note: req.body.note?.trim() || null,
      }).where(and(
        eq(trainingBlock.id, req.params.blockId),
        eq(trainingBlock.athleteId, req.params.id),
      )).returning();
      if (!updated) return reply.code(404).send({ error: 'no such block' });
      return reply.send({ block: updated, advisories: blockAdvisories(req.body) });
    },
  );

  app.delete<{ Params: { id: string; blockId: string } }>(
    '/athletes/:id/blocks/:blockId',
    async (req, reply) => {
      if (!(await requireOwnership(req, req.params.id))) {
        return reply.code(403).send({ error: 'only the athlete can plan their season' });
      }
      const deleted = await db.delete(trainingBlock)
        .where(and(
          eq(trainingBlock.id, req.params.blockId),
          eq(trainingBlock.athleteId, req.params.id),
        ))
        .returning({ id: trainingBlock.id });
      return reply.send({ deleted: deleted.length });
    },
  );
}

/**
 * Which channel a race should be predicted from, per sport.
 *
 * Grade-adjusted speed where it exists: a training block full of hills
 * otherwise predicts a flat race too slowly. Falls back to raw speed.
 */
const PREDICT_METRIC: Record<string, string[]> = {
  running: ['gap_mps', 'speed_mps'],
  cycling: ['speed_mps'],
  swimming: ['speed_mps'],
  rowing: ['speed_mps'],
};

export async function racePredictionRoutes(app: FastifyInstance) {
  /**
   * Predicted finish times for the athlete's planned races.
   *
   * Separate from `/season` because it costs a call into the analytics service
   * and most views of the page do not need it — and because a prediction being
   * unavailable should not stop the season itself from loading.
   */
  app.get<{ Params: { id: string } }>('/athletes/:id/races/predictions', async (req) => {
    await requireAthleteAccess(req, req.params.id);

    const races = await db
      .select()
      .from(race)
      .where(and(eq(race.athleteId, req.params.id), gte(race.date, todayIso())))
      .orderBy(asc(race.date));

    // Only races with a distance can be predicted, and only sports whose curve
    // measures distance covered.
    const wanted = races.filter((r) => r.distanceM && PREDICT_METRIC[r.sport]);
    if (wanted.length === 0) return { predictions: [] };

    const out: Record<string, unknown> = {};
    // Grouped by sport: one curve fetch and one analytics call per sport,
    // rather than per race.
    for (const sport of new Set(wanted.map((r) => r.sport))) {
      const metric = await firstAvailableMetric(req.params.id, sport);
      if (!metric) continue;

      const points = await db
        .selectDistinctOn([activityCurve.durationS], {
          durationS: activityCurve.durationS,
          value: activityCurve.value,
        })
        .from(activityCurve)
        .where(and(
          eq(activityCurve.athleteId, req.params.id),
          eq(activityCurve.sport, sport as never),
          eq(activityCurve.metric, metric),
        ))
        .orderBy(activityCurve.durationS, desc(activityCurve.value));
      if (points.length < 3) continue;

      const distances = wanted.filter((r) => r.sport === sport).map((r) => r.distanceM!);
      try {
        const res = await fetch(`${env.analyticsUrl}/curve/predict`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            curve: Object.fromEntries(points.map((p) => [p.durationS, p.value])),
            distances_m: distances,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { predictions: { distance_m: number }[] };
        for (const prediction of body.predictions) {
          // Matched back by distance, which is what was sent.
          for (const r of wanted) {
            if (r.sport === sport && Math.abs((r.distanceM ?? 0) - prediction.distance_m) < 1) {
              out[r.id] = prediction;
            }
          }
        }
      } catch {
        /* a race without a prediction is still a race */
      }
    }

    return { predictions: out };
  });

  async function firstAvailableMetric(athleteId: string, sport: string): Promise<string | null> {
    const available = await db
      .selectDistinct({ metric: activityCurve.metric })
      .from(activityCurve)
      .where(and(eq(activityCurve.athleteId, athleteId), eq(activityCurve.sport, sport as never)));
    const present = new Set(available.map((r) => r.metric));
    return (PREDICT_METRIC[sport] ?? []).find((m) => present.has(m)) ?? null;
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
