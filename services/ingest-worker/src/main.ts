import { buildServer } from './server.js';
import { startWorker } from './worker.js';
import { env } from './env.js';

/**
 * Server and worker share a process for now. They are separate concerns and the
 * split is already drawn — the worker only needs `startWorker()` in its own
 * entrypoint once backfill volume starts competing with request latency.
 */
const workers = startWorker();
const app = await buildServer();
await app.listen({ port: env.port, host: '0.0.0.0' });
// Named individually rather than as a count: this line is how you tell from a
// log whether a newly added worker actually started.
app.log.info(
  `ingest listening on :${env.port}; workers running: parse, load, pmc, recompute, strava-sync`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, draining`);
    await workers.close();
    await app.close();
    process.exit(0);
  });
}
