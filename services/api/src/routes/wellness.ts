import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { athleteWellness, db } from '@lab/db';
import { requireAthleteAccess } from '../access.js';
import { advisories, hasMeasurement, validate, type WellnessInput } from '../wellnessRules.js';

/**
 * Morning wellness readings.
 *
 * Read under the `wellness` scope rather than `training`: a coach granted
 * access to an athlete's training does not thereby get their weight and sleep.
 * Writes are the athlete's alone.
 */

export async function wellnessRoutes(app: FastifyInstance) {
  app.get<{
    Params: { id: string };
    Querystring: { from?: string; to?: string; limit?: string };
  }>('/athletes/:id/wellness', async (req) => {
    await requireAthleteAccess(req, req.params.id, 'wellness');

    const filters = [eq(athleteWellness.athleteId, req.params.id)];
    if (req.query.from) filters.push(gte(athleteWellness.date, req.query.from));
    if (req.query.to) filters.push(lte(athleteWellness.date, req.query.to));

    const rows = await db
      .select()
      .from(athleteWellness)
      .where(and(...filters))
      .orderBy(desc(athleteWellness.date))
      .limit(Math.min(Number(req.query.limit ?? 400), 1000));

    // Coverage, so the UI can say "42 of the last 90 days" rather than implying
    // a gap in the data is a gap in the athlete.
    const [counts] = await db
      .select({
        days: sql<number>`count(*)::int`,
        withRestingHr: sql<number>`count(${athleteWellness.restingHr})::int`,
        withHrv: sql<number>`count(${athleteWellness.hrvRmssdMs})::int`,
        withWeight: sql<number>`count(${athleteWellness.weightKg})::int`,
        withSleep: sql<number>`count(${athleteWellness.sleepHours})::int`,
      })
      .from(athleteWellness)
      .where(eq(athleteWellness.athleteId, req.params.id));

    // Ascending for charting; the query above is descending so `limit` keeps
    // the most recent days rather than the oldest.
    return { entries: rows.reverse(), coverage: counts ?? null };
  });

  app.post<{ Params: { id: string }; Body: WellnessInput }>(
    '/athletes/:id/wellness',
    async (req, reply) => {
      const access = await requireAthleteAccess(req, req.params.id, 'wellness');
      if (access.relationship !== 'owner') {
        return reply.code(403).send({ error: 'only the athlete can record wellness' });
      }

      const errors = validate(req.body ?? {});
      if (errors.length) return reply.code(400).send({ error: errors.join('; '), errors });
      if (!hasMeasurement(req.body)) {
        return reply.code(400).send({ error: 'nothing to record' });
      }

      const values = {
        athleteId: req.params.id,
        date: req.body.date!,
        restingHr: req.body.restingHr ?? null,
        hrvRmssdMs: req.body.hrvRmssdMs ?? null,
        sleepHours: req.body.sleepHours ?? null,
        sleepScore: req.body.sleepScore ?? null,
        weightKg: req.body.weightKg ?? null,
        feel: req.body.feel ?? null,
        note: req.body.note?.trim() || null,
        source: 'manual' as const,
      };

      // Upsert: one row per day, so correcting this morning's entry overwrites
      // it rather than being rejected or silently duplicated.
      const [entry] = await db
        .insert(athleteWellness)
        .values(values)
        .onConflictDoUpdate({
          target: [athleteWellness.athleteId, athleteWellness.date],
          set: { ...values, recordedAt: new Date() },
        })
        .returning();

      return reply.code(200).send({ entry, advisories: advisories(req.body) });
    },
  );

  app.delete<{ Params: { id: string; date: string } }>(
    '/athletes/:id/wellness/:date',
    async (req, reply) => {
      const access = await requireAthleteAccess(req, req.params.id, 'wellness');
      if (access.relationship !== 'owner') {
        return reply.code(403).send({ error: 'only the athlete can delete wellness' });
      }
      const deleted = await db
        .delete(athleteWellness)
        .where(
          and(
            eq(athleteWellness.athleteId, req.params.id),
            eq(athleteWellness.date, req.params.date),
          ),
        )
        .returning({ date: athleteWellness.date });
      return reply.send({ deleted: deleted.length });
    },
  );

  /**
   * What the athlete's measured resting heart rate actually is.
   *
   * Resting HR cannot be recovered from activity files, so `athlete_threshold`
   * has been carrying a hardcoded 50 into every heart-rate-reserve calculation
   * in the system. This is the endpoint that gives it a source.
   *
   * A median rather than a mean, over a window rather than the latest reading:
   * one bad night moves a mean and does not move a median, and resting heart
   * rate on any single morning is noise around a slow-moving true value.
   */
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/athletes/:id/wellness/resting-hr',
    async (req) => {
      await requireAthleteAccess(req, req.params.id, 'wellness');
      const days = Math.min(Math.max(Number(req.query.days ?? 60), 7), 365);

      const [result] = await db.execute<{
        samples: number;
        median: number | null;
        low: number | null;
        first: string | null;
        last: string | null;
      }>(sql`
        SELECT count(*)::int AS samples,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY ${athleteWellness.restingHr}) AS median,
               min(${athleteWellness.restingHr})::int AS low,
               min(${athleteWellness.date})::text AS first,
               max(${athleteWellness.date})::text AS last
        FROM ${athleteWellness}
        WHERE ${athleteWellness.athleteId} = ${req.params.id}::uuid
          AND ${athleteWellness.restingHr} IS NOT NULL
          AND ${athleteWellness.date} >= (current_date - ${days}::int)
      `);

      const samples = Number(result?.samples ?? 0);
      return {
        days,
        samples,
        // Below about a fortnight of mornings this is one week's sleep quality,
        // not a resting heart rate. Say so rather than offering it.
        suggestion: samples >= 14 && result?.median != null ? Math.round(Number(result.median)) : null,
        median: result?.median != null ? Number(result.median) : null,
        low: result?.low != null ? Number(result.low) : null,
        first: result?.first ?? null,
        last: result?.last ?? null,
      };
    },
  );
}
