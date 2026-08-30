import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawKey, sha256 } from './keys.js';

test('sha256 is stable and content-dependent', () => {
  const a = Buffer.from('activity bytes');
  assert.equal(sha256(a), sha256(Buffer.from('activity bytes')));
  assert.notEqual(sha256(a), sha256(Buffer.from('other bytes')));
  assert.match(sha256(a), /^[0-9a-f]{64}$/);
});

test('rawKey shards by hash prefix so no directory grows unbounded', () => {
  const hash = sha256(Buffer.from('x'));
  const key = rawKey(hash);
  assert.equal(key, `raw/${hash.slice(0, 2)}/${hash}.fit`);
  // Same bytes must always address the same object: this is what makes
  // re-ingestion idempotent rather than duplicating storage.
  assert.equal(key, rawKey(sha256(Buffer.from('x'))));
});

test('importing the package builds no S3 client', async () => {
  const storage = await import('./storage.js');
  assert.equal(storage.isConnected(), false, 'import should not have built a client');
});

test('importing the package does not demand S3 credentials', async () => {
  // The old module read env at import and threw on a missing key, so anything
  // that transitively imported it — a route module under test, say — failed
  // before its own first line ran.
  const saved = { ...process.env };
  delete process.env.S3_ACCESS_KEY;
  delete process.env.S3_SECRET_KEY;
  try {
    const fresh = await import(`./storage.js?nocreds=${Date.now()}`);
    assert.equal(typeof fresh.putRaw, 'function');
  } finally {
    Object.assign(process.env, saved);
  }
});
