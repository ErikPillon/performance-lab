import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

/**
 * The regression this file exists for.
 *
 * Queues used to be constructed at module load, so importing this package —
 * or anything that transitively reached it — opened a Redis socket. A test
 * that touched the API's route modules would then hang forever instead of
 * failing, and the validation rules had to be moved into a separate module
 * purely to get out from under it.
 *
 * This test must not need a running Redis. If it ever does, the invariant it
 * guards has already been broken.
 */
test('importing the module opens no connection', async () => {
  const jobs = await import('./index.js');
  assert.equal(jobs.isConnected(), false, 'import should not have connected');
});

test('naming a queue still does not connect until it is used', async () => {
  const jobs = await import('./index.js');
  assert.equal(typeof jobs.parseQueue, 'function');
  assert.equal(jobs.PARSE_QUEUE, 'parse');
  assert.equal(jobs.isConnected(), false);
});

/** Whether something is listening, so the live checks can skip in CI. */
async function redisReachable(): Promise<boolean> {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return new Promise((resolve) => {
    const sock = net
      .connect({ host: url.hostname, port: Number(url.port || 6379) })
      .on('connect', () => { sock.destroy(); resolve(true); })
      .on('error', () => resolve(false));
    sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
  });
}

test('accessors memoise, and closeQueues resets', async (t) => {
  if (!(await redisReachable())) return t.skip('no redis reachable');
  const jobs = await import('./index.js');

  const a = jobs.parseQueue();
  const b = jobs.parseQueue();
  assert.equal(a, b, 'the same queue should be handed out twice');
  assert.equal(jobs.connection(), jobs.connection(), 'one shared connection');
  assert.equal(jobs.isConnected(), true);

  await jobs.closeQueues();
  assert.equal(jobs.isConnected(), false, 'closeQueues should release it');

  // And it can be brought back up, which is what lets a long-lived process
  // reconnect rather than having to restart.
  assert.ok(jobs.parseQueue());
  assert.equal(jobs.isConnected(), true);
  await jobs.closeQueues();
});

test('closeQueues is safe when nothing ever connected', async () => {
  const jobs = await import('./index.js');
  await jobs.closeQueues();
  assert.equal(jobs.isConnected(), false);
});
