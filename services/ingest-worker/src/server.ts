import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { count, eq, sql } from 'drizzle-orm';
import { activity, activityLoad, athlete, athleteDaily, db, rawFile } from '@lab/db';
import { env } from './env.js';
import { ingestBytes } from './ingest.js';
import { loadQueue, parseQueue, pmcQueue } from '@lab/jobs';

export async function buildServer() {
  const app = Fastify({ logger: { level: 'info' } });
  await app.register(multipart, { limits: { fileSize: env.maxUploadBytes, files: 20 } });

  app.get('/health', async () => {
    const [athletes] = await db.select({ n: count() }).from(athlete);
    return {
      status: 'ok',
      athletes: athletes?.n ?? 0,
      queues: {
        parse: await parseQueue().getJobCounts(),
        load: await loadQueue().getJobCounts(),
        pmc: await pmcQueue().getJobCounts(),
      },
    };
  });

  /**
   * Upload one or more activity files. This is the canonical ingestion path:
   * every source ultimately produces FIT, so connectors feed this rather than
   * bypassing it.
   */
  app.post<{ Params: { athleteId: string } }>(
    '/athletes/:athleteId/files',
    async (req, reply) => {
      const { athleteId } = req.params;
      const [found] = await db
        .select({ id: athlete.id })
        .from(athlete)
        .where(eq(athlete.id, athleteId))
        .limit(1);
      if (!found) return reply.code(404).send({ error: 'unknown athlete' });

      const results = [];
      for await (const part of req.files()) {
        const bytes = await part.toBuffer();
        results.push({
          filename: part.filename,
          ...(await ingestBytes({
            athleteId,
            bytes,
            filename: part.filename,
            contentType: part.mimetype,
          })),
        });
      }
      if (results.length === 0) return reply.code(400).send({ error: 'no files in request' });
      return reply.code(202).send({ accepted: results });
    },
  );

  /** Ingestion health at a glance: what came in, what made it through. */
  app.get('/ingest/status', async () => {
    const files = await db
      .select({ status: rawFile.status, n: count() })
      .from(rawFile)
      .groupBy(rawFile.status);
    const [totals] = await db
      .select({
        activities: count(),
        samples: sql<number>`coalesce(sum(${activity.sampleCount}), 0)::int`,
      })
      .from(activity);
    const flagged = await db
      .select({ flag: sql<string>`jsonb_array_elements_text(${activity.qualityFlags})`, n: count() })
      .from(activity)
      .groupBy(sql`1`);
    const methods = await db
      .select({ method: activityLoad.loadMethod, n: count() })
      .from(activityLoad)
      .groupBy(activityLoad.loadMethod);
    const [pmc] = await db
      .select({
        days: count(),
        latestDate: sql<string>`max(${athleteDaily.date})::text`,
        peakCtl: sql<number>`round(max(${athleteDaily.ctl})::numeric, 1)`,
      })
      .from(athleteDaily);

    return {
      files,
      activities: totals?.activities ?? 0,
      samples: totals?.samples ?? 0,
      flagged,
      load: { methods, pmc },
      queues: {
        parse: await parseQueue().getJobCounts(),
        load: await loadQueue().getJobCounts(),
        pmc: await pmcQueue().getJobCounts(),
      },
    };
  });

  return app;
}
