import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  IntervalsAuthError, downloadIntervalsFile, intervalsAthlete, listIntervalsActivities, planImports,
} from './intervals.js';
import { RateLimited } from './rateLimit.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Replace fetch with one canned response, recording what was asked. */
function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const seen: { url: URL; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: URL, init: RequestInit) => {
    seen.push({ url: new URL(url), init });
    const payload = (body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit;
    return new Response(payload, { status, headers });
  }) as typeof fetch;
  return seen;
}

test('requests authenticate as API_KEY with basic auth, and say who is asking', async () => {
  const seen = respond(200, { id: 'i123', name: 'Erik' });
  assert.deepEqual(await intervalsAthlete('secret-key'), { id: 'i123', name: 'Erik' });

  const headers = new Headers(seen[0]!.init.headers);
  assert.equal(headers.get('authorization'), `Basic ${Buffer.from('API_KEY:secret-key').toString('base64')}`);
  assert.match(headers.get('user-agent') ?? '', /performance-lab/);
  assert.equal(seen[0]!.url.pathname, '/api/v1/athlete/0');
});

test('the activity list asks for a date window and only the fields the planner reads', async () => {
  const seen = respond(200, []);
  await listIntervalsActivities('k', new Date('2024-03-10T18:00:00Z'), new Date('2026-09-23T22:00:00Z'));
  const url = seen[0]!.url;
  assert.equal(url.pathname, '/api/v1/athlete/0/activities');
  assert.equal(url.searchParams.get('oldest'), '2024-03-10');
  assert.equal(url.searchParams.get('newest'), '2026-09-24');
  assert.equal(url.searchParams.get('fields'), 'id,start_date,start_date_local,type,file_type,source');
});

test('the original file and the generated FIT come from different endpoints', async () => {
  const seen = respond(200, new Uint8Array([0x1f, 0x8b]));
  await downloadIntervalsFile('k', 'i9', 'original');
  await downloadIntervalsFile('k', 'i9', 'generated');
  assert.deepEqual(seen.map((s) => s.url.pathname), [
    '/api/v1/activity/i9/file',
    '/api/v1/activity/i9/fit-file',
  ]);
});

test('a rejected key is its own error, so the connection can ask for a new one', async () => {
  respond(401, { error: 'unauthorized' });
  await assert.rejects(intervalsAthlete('bad'), IntervalsAuthError);
});

test('a rate limit carries the wait intervals.icu asked for', async () => {
  respond(429, {}, { 'retry-after': '90' });
  const err = await intervalsAthlete('k').catch((e: unknown) => e);
  assert.ok(err instanceof RateLimited);
  assert.equal(err.retryAfterMs, 90_000);
});

test('a rate limit without Retry-After waits out a quarter hour', async () => {
  respond(429, {});
  const err = await intervalsAthlete('k').catch((e: unknown) => e);
  assert.ok(err instanceof RateLimited);
  assert.equal(err.retryAfterMs, 15 * 60_000);
});

test('the plan is oldest first, strictly after the cursor', () => {
  const plan = planImports([
    { id: 'c', start_date: '2026-09-22T07:00:00Z', file_type: 'fit', source: 'GARMIN_CONNECT' },
    { id: 'a', start_date: '2026-09-20T07:00:00Z', file_type: 'fit', source: 'GARMIN_CONNECT' },
    // Exactly the cursor: already imported, listed again because the window is by date.
    { id: 'x', start_date: '2026-09-19T06:00:00Z', file_type: 'fit', source: 'GARMIN_CONNECT' },
    { id: 'b', start_date: '2026-09-21T07:00:00Z', file_type: 'fit', source: 'COROS' },
  ], new Date('2026-09-19T06:00:00Z'));
  assert.deepEqual(plan.toImport.map((p) => p.id), ['a', 'b', 'c']);
  assert.equal(plan.skipped, 0);
});

test('Strava-sourced and manual activities are skipped, not fetched', () => {
  const plan = planImports([
    { id: 's', start_date: '2026-09-20T07:00:00Z', file_type: 'fit', source: 'STRAVA' },
    { id: 'm', start_date: '2026-09-20T08:00:00Z', file_type: null, source: 'MANUAL' },
    { id: 'g', start_date: '2026-09-20T09:00:00Z', file_type: 'fit', source: 'GARMIN_CONNECT' },
  ], null);
  assert.deepEqual(plan.toImport.map((p) => p.id), ['g']);
  assert.equal(plan.skipped, 2);
});

test('a GPX or TCX original is fetched as the FIT intervals.icu generates', () => {
  const plan = planImports([
    { id: 'f', start_date: '2026-09-20T07:00:00Z', file_type: 'FIT', source: 'UPLOAD' },
    { id: 'g', start_date: '2026-09-20T08:00:00Z', file_type: 'gpx', source: 'UPLOAD' },
  ], null);
  assert.deepEqual(plan.toImport.map((p) => [p.id, p.kind]), [['f', 'original'], ['g', 'generated']]);
});

test('an activity without a usable start time is skipped rather than guessed', () => {
  const plan = planImports([{ id: 'n', file_type: 'fit', source: 'UPLOAD' }], null);
  assert.equal(plan.toImport.length, 0);
  assert.equal(plan.skipped, 1);
});
