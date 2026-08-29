import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { activity, activityLoad, athleteThreshold, db } from '@lab/db';
import { env } from '../env.js';

export async function activityRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/activities/:id', async (req, reply) => {
    const [row] = await db
      .select()
      .from(activity)
      .leftJoin(activityLoad, eq(activityLoad.activityId, activity.id))
      .where(eq(activity.id, req.params.id))
      .limit(1);

    if (!row) return reply.code(404).send({ error: 'unknown activity' });

    // The thresholds this activity was actually scored against, not today's —
    // otherwise the detail view would explain a 2021 ride with 2026 numbers.
    const [thresholds] = await db
      .select()
      .from(athleteThreshold)
      .where(eq(athleteThreshold.athleteId, row.activity.athleteId))
      .orderBy(desc(athleteThreshold.effectiveFrom))
      .limit(1);

    // `hasStreams` rather than the raw key: the client needs to know whether a
    // chart is worth requesting, not where the object lives.
    const { streamsKey, ...activityRow } = row.activity;
    return {
      activity: { ...activityRow, hasStreams: streamsKey !== null },
      load: row.activity_load ?? null,
      thresholds: thresholds ?? null,
    };
  });

  /**
   * Per-sample streams for charting.
   *
   * Proxied to the analytics service, which owns Parquet and does the
   * downsampling: a four-hour ride is ~15,000 samples per channel and no screen
   * has that many pixels. Bucketed min/max, so peaks survive the reduction.
   */
  app.get<{ Params: { id: string }; Querystring: { points?: string; channels?: string } }>(
    '/activities/:id/streams',
    async (req, reply) => {
      const [row] = await db
        .select({ streamsKey: activity.streamsKey })
        .from(activity)
        .where(eq(activity.id, req.params.id))
        .limit(1);

      if (!row) return reply.code(404).send({ error: 'unknown activity' });
      if (!row.streamsKey) {
        // A valid activity that carried no record messages. Not an error.
        return { key: null, sample_count: 0, returned: 0, channels: [], series: {} };
      }

      const params = new URLSearchParams({
        key: row.streamsKey,
        points: String(Math.min(Number(req.query.points ?? 1500), 20_000)),
      });
      if (req.query.channels) params.set('channels', req.query.channels);

      const res = await fetch(`${env.analyticsUrl}/streams?${params}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        return reply.code(502).send({ error: `analytics ${res.status}` });
      }
      return await res.json();
    },
  );
}
