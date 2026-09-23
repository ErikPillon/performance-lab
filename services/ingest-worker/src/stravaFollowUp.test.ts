import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followUpDelayMs } from './stravaFollowUp.js';

const counts = { imported: 0, skipped: 0, failed: 0 };

test('a rate-limited run resumes when Strava says the window resets', () => {
  const result = { ...counts, status: 'rate_limited' as const, resumeAfterMs: 420_000 };
  assert.equal(followUpDelayMs(result), 420_000);
});

test('a rate limit without a reset time waits out a quarter hour', () => {
  assert.equal(followUpDelayMs({ ...counts, status: 'rate_limited' }), 15 * 60_000);
});

test('a run that hit its cap carries on immediately', () => {
  assert.equal(followUpDelayMs({ ...counts, status: 'ok', more: true }), 0);
});

test('a run that reached the end of history is done', () => {
  assert.equal(followUpDelayMs({ ...counts, status: 'ok', more: false }), null);
  // A webhook import names one activity and never sets `more`.
  assert.equal(followUpDelayMs({ ...counts, status: 'ok', imported: 1 }), null);
});

test('errors and missing connections do not retry themselves', () => {
  // An error waits for the next poll; retrying at once would loop on an outage,
  // and a missing connection will not appear by waiting.
  assert.equal(followUpDelayMs({ ...counts, status: 'error' }), null);
  assert.equal(followUpDelayMs({ ...counts, status: 'no_connection' }), null);
});
