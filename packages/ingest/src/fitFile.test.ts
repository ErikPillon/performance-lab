import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { FIT_FILENAME, unwrapFit } from './fitFile.js';

// A FIT header: 14 bytes, ending in the ".FIT" signature.
const fit = Buffer.from([14, 0x10, 0x00, 0x08, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0]);

test('a plain FIT file passes through as the same buffer', () => {
  assert.equal(unwrapFit(fit), fit);
});

test('a gzipped FIT file is unwrapped to the original bytes', () => {
  assert.deepEqual(unwrapFit(gzipSync(fit)), fit);
});

test('detection is by content, so a renamed file still works', () => {
  // Nothing about the call names a file; the magic number decides.
  assert.deepEqual(unwrapFit(gzipSync(fit)), unwrapFit(fit));
});

test('an archive that inflates past the cap is refused, not buffered', () => {
  const bomb = gzipSync(Buffer.alloc(65 * 1024 * 1024));
  assert.throws(() => unwrapFit(bomb), RangeError);
});

test('a corrupt gzip is an error, not a silently stored blob', () => {
  const truncated = gzipSync(fit).subarray(0, 12);
  assert.throws(() => unwrapFit(truncated));
});

test('only FIT files are accepted, compressed or not', () => {
  for (const name of ['ride.fit', 'RIDE.FIT', '123456.fit.gz', 'a.b.FIT.GZ']) {
    assert.match(name, FIT_FILENAME);
  }
  // A Strava archive holds these too; the parser cannot read them.
  for (const name of ['run.gpx.gz', 'swim.tcx.gz', 'archive.gz', 'notes.fit.txt', 'fit']) {
    assert.doesNotMatch(name, FIT_FILENAME);
  }
});
