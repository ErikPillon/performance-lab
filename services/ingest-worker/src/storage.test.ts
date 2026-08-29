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
