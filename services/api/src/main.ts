/**
 * Read API for the dashboard.
 *
 * Separate from the ingest worker so a backfill storm cannot starve interactive
 * requests, and so this is the only process that ever needs a public origin.
 * It owns no queues: reads come from Postgres, and per-sample streams are
 * proxied to the analytics service, which owns Parquet.
 */
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { sql as pg } from '@lab/db';
import { env } from './env.js';
import { activityRoutes } from './routes/activities.js';
import { athleteRoutes } from './routes/athletes.js';

const app = Fastify({ logger: { level: 'info' } });

await app.register(cors, { origin: env.corsOrigin });

app.get('/health', async () => ({ status: 'ok' }));
await app.register(athleteRoutes);
await app.register(activityRoutes);

await app.listen({ port: env.port, host: '0.0.0.0' });
app.log.info(`api listening on :${env.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await pg.end();
    process.exit(0);
  });
}
