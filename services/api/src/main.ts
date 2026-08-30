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
import { closeQueues } from '@lab/jobs';
import { env } from './env.js';
import { activityRoutes } from './routes/activities.js';
import { HttpError, resolveActor } from './access.js';
import { athleteRoutes } from './routes/athletes.js';
import { authRoutes } from './routes/auth.js';
import { curveRoutes } from './routes/curves.js';
import { grantRoutes } from './routes/grants.js';
import { thresholdRoutes } from './routes/thresholds.js';

const app = Fastify({ logger: { level: 'info' } });

// credentials:true is what lets the session cookie travel, and it is exactly
// why the origin can no longer be a wildcard.
await app.register(cors, { origin: env.corsOrigin, credentials: true });

// Authorisation failures are thrown, not returned, so a handler cannot forget
// to send the right status.
app.setErrorHandler((err: unknown, _req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
  app.log.error(err);
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  const message = err instanceof Error ? err.message : 'internal error';
  // Anything unrecognised is reported as a server fault without echoing
  // internals back to the caller.
  return reply.code(status).send({ error: status >= 500 ? 'internal error' : message });
});

app.get('/health', async () => ({ status: 'ok' }));

await app.register(authRoutes);

/**
 * Attach the caller to every request before any handler runs.
 *
 * Resolving here rather than per route means a handler cannot forget to; what
 * a handler can still forget is to *check*, which is why athlete data is only
 * reachable through `requireAthleteAccess`.
 */
app.addHook('preHandler', async (req) => {
  if (req.url.startsWith('/auth/')) return;
  req.actor = (await resolveActor(req)) ?? undefined;
});

await app.register(athleteRoutes);
await app.register(activityRoutes);
await app.register(thresholdRoutes);
await app.register(curveRoutes);
await app.register(grantRoutes);

await app.listen({ port: env.port, host: '0.0.0.0' });
app.log.info(`api listening on :${env.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await closeQueues();
    await pg.end();
    process.exit(0);
  });
}
