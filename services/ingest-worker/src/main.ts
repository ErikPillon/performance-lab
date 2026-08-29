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
app.log.info(`ingest listening on :${env.port}; parse, load and pmc workers running`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, draining`);
    await workers.close();
    await app.close();
    process.exit(0);
  });
}
