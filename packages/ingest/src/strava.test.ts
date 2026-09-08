import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { interpretWebhook, webhookVerifyToken, type WebhookEvent } from './strava.js';

const saved = process.env.TOKEN_ENCRYPTION_KEY;
before(() => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});
after(() => {
  if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = saved;
});

function event(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    aspect_type: 'create',
    object_type: 'activity',
    object_id: 1360128428,
    owner_id: 134815,
    event_time: 1516126040,
    subscription_id: 120475,
    ...overrides,
  };
}

test('a new activity is imported', () => {
  assert.deepEqual(interpretWebhook(event()), { kind: 'import', activityId: 1360128428 });
});

test('an updated activity is re-imported', () => {
  // An edit may have changed the type or the privacy of an activity, and
  // re-importing is idempotent, so update and create resolve the same way.
  const action = interpretWebhook(event({ aspect_type: 'update', updates: { title: 'Renamed' } }));
  assert.deepEqual(action, { kind: 'import', activityId: 1360128428 });
});

test('a deletion is deliberately not mirrored', () => {
  // Strava is a mirror. An activity deleted there may still have arrived here
  // as an uploaded FIT, which is the better copy — silently deleting training
  // because a mirror changed is not a trade worth making.
  const action = interpretWebhook(event({ aspect_type: 'delete' }));
  assert.equal(action.kind, 'ignore');
  assert.match((action as { reason: string }).reason, /deletion/);
});

test('deauthorisation is recognised, including that it arrives as a string', () => {
  // Strava sends "false", not false. A truthiness check reads that as revoked
  // access being fine, which is exactly backwards.
  const action = interpretWebhook(
    event({ object_type: 'athlete', aspect_type: 'update', updates: { authorized: 'false' } }),
  );
  assert.deepEqual(action, { kind: 'deauthorized' });
});

test('an athlete event that is not a deauthorisation does nothing', () => {
  assert.equal(
    interpretWebhook(event({ object_type: 'athlete', updates: { authorized: 'true' } })).kind,
    'ignore',
  );
  assert.equal(interpretWebhook(event({ object_type: 'athlete' })).kind, 'ignore');
});

test('an unknown object type is ignored rather than guessed at', () => {
  const action = interpretWebhook(event({ object_type: 'segment' as never }));
  assert.equal(action.kind, 'ignore');
});

test('a malformed object_id is ignored', () => {
  // These arrive unsigned from the open internet; nothing here should trust the
  // shape of the payload.
  for (const bad of [0, -1, Number.NaN, undefined as never]) {
    assert.equal(interpretWebhook(event({ object_id: bad })).kind, 'ignore', `for ${bad}`);
  }
});

test('the verify token is stable and not guessable from the payload', () => {
  const token = webhookVerifyToken();
  assert.equal(token, webhookVerifyToken(), 'must survive a restart to be echoed back');
  assert.ok(token.length >= 32);
});
