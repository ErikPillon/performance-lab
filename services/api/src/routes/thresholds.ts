import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { activityLoad, athleteThreshold, db } from '@lab/db';
import { recomputeQueue, requestRecompute } from '@lab/jobs';
import { env } from '../env.js';
import { advisories, validate, type ThresholdInput } from '../thresholdRules.js';
import { requireAthleteAccess, requireOwner } from '../access.js';

export async function thresholdRoutes(app: FastifyInstance) {
  /** Full effective-dated history, newest first. */
  app.get<{ Params: { id: string } }>('/athletes/:id/thresholds', async (req) => {
    await requireAthleteAccess(req, req.params.id);
    const rows = await db
      .select()
      .from(athleteThreshold)
      .where(eq(athleteThreshold.athleteId, req.params.id))
      .orderBy(desc(athleteThreshold.effectiveFrom));
    return { thresholds: rows };
  });

  /**
   * Record a threshold set effective from a date.
   *
   * Upserts on (athlete, effectiveFrom) rather than editing in place: changing
   * today's FTP must not retroactively rescore a ride from 2021. Correcting a
   * value means adding a row dated when it actually became true.
   */
  app.post<{ Params: { id: string }; Body: ThresholdInput }>(
    '/athletes/:id/thresholds',
    async (req, reply) => {
      // Only the athlete changes their own thresholds. A coach reading them is
      // fine; a coach rescaling every load number in the history is not.
      await requireOwner(req, req.params.id);
      const errors = validate(req.body ?? {});
      if (errors.length) return reply.code(422).send({ error: 'invalid thresholds', errors });

      const effectiveFrom = (req.body.effectiveFrom ?? new Date().toISOString()).slice(0, 10);
      const values = {
        athleteId: req.params.id,
        effectiveFrom,
        maxHr: req.body.maxHr ?? null,
        restHr: req.body.restHr ?? null,
        lthr: req.body.lthr ?? null,
        ftpWatts: req.body.ftpWatts ?? null,
        cssSecPer100m: req.body.cssSecPer100m ?? null,
        thresholdPaceSecPerKm: req.body.thresholdPaceSecPerKm ?? null,
        weightKg: req.body.weightKg ?? null,
        note: req.body.note ?? 'entered manually',
      };

      const [row] = await db
        .insert(athleteThreshold)
        .values(values)
        .onConflictDoUpdate({
          target: [athleteThreshold.athleteId, athleteThreshold.effectiveFrom],
          set: {
            maxHr: values.maxHr,
            restHr: values.restHr,
            lthr: values.lthr,
            ftpWatts: values.ftpWatts,
            cssSecPer100m: values.cssSecPer100m,
            thresholdPaceSecPerKm: values.thresholdPaceSecPerKm,
            weightKg: values.weightKg,
            note: values.note,
          },
        })
        .returning();

      // Stored load is now scaled against superseded numbers. The client is
      // told rather than a recompute being started implicitly: it is minutes of
      // work and the caller should choose when.
      return reply.code(201).send({
        threshold: row,
        advisories: advisories(req.body),
        recomputeRequired: true,
      });
    },
  );

  app.delete<{ Params: { id: string; effectiveFrom: string } }>(
    '/athletes/:id/thresholds/:effectiveFrom',
    async (req, reply) => {
      await requireOwner(req, req.params.id);
      const deleted = await db
        .delete(athleteThreshold)
        .where(
          and(
            eq(athleteThreshold.athleteId, req.params.id),
            eq(athleteThreshold.effectiveFrom, req.params.effectiveFrom),
          ),
        )
        .returning({ id: athleteThreshold.id });

      if (deleted.length === 0) return reply.code(404).send({ error: 'no such threshold row' });
      return { deleted: deleted.length, recomputeRequired: true };
    },
  );

  /** Enqueue a full recompute; returns immediately with a job id. */
  app.post<{ Params: { id: string }; Body: { estimateThresholds?: boolean; preference?: string } }>(
    '/athletes/:id/recompute',
    async (req, reply) => {
      // A recompute is minutes of work on shared infrastructure; the athlete
      // decides when it runs.
      await requireOwner(req, req.params.id);
      const preference = req.body?.preference ?? 'consistency';
      if (!['consistency', 'precision'].includes(preference)) {
        return reply.code(422).send({ error: 'preference must be "consistency" or "precision"' });
      }
      const jobId = await requestRecompute({
        athleteId: req.params.id,
        estimateThresholds: req.body?.estimateThresholds ?? false,
        preference: preference as 'consistency' | 'precision',
      });
      return reply.code(202).send({ jobId });
    },
  );

  /**
   * Recompute state: the running job if there is one, plus whether stored
   * results are behind the code that would produce them now.
   */
  app.get<{ Params: { id: string } }>('/athletes/:id/recompute', async (req) => {
    await requireAthleteAccess(req, req.params.id);
    const job = await recomputeQueue().getJob(`recompute-${req.params.id}`);
    const state = job ? await job.getState() : null;

    const versions = await db
      .select({ version: activityLoad.calcVersion, n: sql<number>`count(*)::int` })
      .from(activityLoad)
      .where(eq(activityLoad.athleteId, req.params.id))
      .groupBy(activityLoad.calcVersion);

    // Compare stored calc_version against what the analytics service reports
    // today. A mismatch means the load model has moved on and these rows are
    // explaining old numbers with old maths.
    let currentVersion: string | null = null;
    try {
      const res = await fetch(`${env.analyticsUrl}/health`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) currentVersion = ((await res.json()) as { load_version?: string }).load_version ?? null;
    } catch {
      /* analytics down; staleness simply cannot be determined right now */
    }

    const stale = currentVersion ? versions.filter((v) => v.version !== currentVersion) : [];

    return {
      job: job
        ? {
            id: job.id,
            state,
            progress: job.progress,
            failedReason: job.failedReason ?? null,
            finishedOn: job.finishedOn ?? null,
          }
        : null,
      currentVersion,
      versions,
      staleRows: stale.reduce((sum, v) => sum + v.n, 0),
    };
  });
}
