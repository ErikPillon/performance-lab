import Fastify from 'fastify';
import { count, eq, sql } from 'drizzle-orm';
import { activity, activityLoad, athlete, athleteDaily, db, rawFile } from '@lab/db';
import { loadQueue, parseQueue, pmcQueue } from '@lab/jobs';

export async function buildServer() {
  const app = Fastify({ logger: { level: 'info' } });

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

    /*
     * The upload route used to live here. It now sits on the API, which is the
     * only service the edge proxy forwards to — while the route was here, a
     * browser had no reachable way to import a file in any real deployment.
     *
     * The CLI backfill still calls ingestBytes directly rather than over HTTP.
     */

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
