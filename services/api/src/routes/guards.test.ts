import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every athlete-scoped route must resolve access through the guards.
 *
 * This is a structural test rather than a behavioural one on purpose. The
 * dangerous mistake with authorisation is not a broken check — it is a new
 * endpoint that never had one, which no functional test thinks to cover
 * because nobody wrote a test for a route they forgot to protect. Adding a
 * route to this directory without a guard fails here.
 *
 * `/athletes/:id/zones` shipped unguarded and was caught by exactly this audit
 * run by hand; this keeps it running.
 */

const GUARDS = ['requireAthleteAccess', 'requireOwner', 'requireActivityAccess', 'requireActor'];

/**
 * Reachable without a session, deliberately.
 *
 * Neither Strava route can require one — the callback is a top-level redirect
 * from strava.com, and the webhook is a server-to-server POST. Neither is
 * unauthorised, though: the callback is authorised by a signed `state`, and the
 * webhook by a verify token plus routing on an owner this server already knows.
 * Both are asserted below rather than taken on trust. Adding a route to this
 * list without an equivalent proof is how the list stops meaning anything.
 */
const PUBLIC_ROUTES = new Set([
  '/me',
  '/auth/*',
  '/connections/strava/callback',
  '/connections/strava/webhook',
]);

const ROUTES_DIR = new URL('.', import.meta.url).pathname;

function routesIn(file: string): { url: string; guarded: boolean }[] {
  const text = readFileSync(join(ROUTES_DIR, file), 'utf8');
  const pattern = /app\.(?:get|post|put|delete|route)[^'"`]*['"`]([^'"`]+)['"`]/g;
  const marks: [number, string][] = [];
  for (const m of text.matchAll(pattern)) marks.push([m.index!, m[1]!]);

  return marks.map(([pos, url], i) => {
    const end = i + 1 < marks.length ? marks[i + 1]![0] : text.length;
    const body = text.slice(pos, end);
    return { url, guarded: GUARDS.some((g) => body.includes(g)) };
  });
}

test('no athlete-scoped route is reachable without an access check', () => {
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  assert.ok(files.length > 0, 'found no route files to audit');

  const unguarded: string[] = [];
  for (const file of files) {
    // The auth handler is the sign-in surface itself and cannot require a session.
    if (file === 'auth.ts') continue;
    for (const { url, guarded } of routesIn(file)) {
      if (!guarded && !PUBLIC_ROUTES.has(url)) unguarded.push(`${file} ${url}`);
    }
  }

  assert.deepEqual(unguarded, [], `routes missing an authorisation guard:\n  ${unguarded.join('\n  ')}`);
});

test('the audit can actually detect an unguarded route', () => {
  // Guards against the audit silently passing because its regex stopped
  // matching — a test that can never fail is worse than no test.
  const text = `app.get('/athletes/:id/leak', async (req) => { return db.select(); });`;
  const pattern = /app\.(?:get|post|put|delete|route)[^'"`]*['"`]([^'"`]+)['"`]/g;
  const found = [...text.matchAll(pattern)].map((m) => m[1]);
  assert.deepEqual(found, ['/athletes/:id/leak']);
  assert.ok(!GUARDS.some((g) => text.includes(g)));
});

test('every guard name the audit looks for still exists', async () => {
  const access = await import('../access.js');
  for (const guard of GUARDS) {
    assert.equal(typeof (access as Record<string, unknown>)[guard], 'function', `${guard} is missing`);
  }
});

test('the Strava callback verifies its signed state', () => {
  // It is exempt from the session guard because it is a redirect from
  // strava.com. That exemption is only safe because the signed state carries
  // the athlete and is verified here — without this, anyone could point their
  // own Strava authorisation at someone else's account.
  const text = readFileSync(join(ROUTES_DIR, 'connections.ts'), 'utf8');
  const start = text.indexOf("'/connections/strava/callback'");
  assert.ok(start > 0, 'callback route not found');
  const body = text.slice(start, start + 2_000);

  assert.ok(body.includes('verifyState'), 'callback must verify the signed state');
  // And must use what it verified, rather than trusting a parameter.
  assert.ok(
    /athleteId\s*=\s*verifyState/.test(body),
    'the athlete must come from the verified state, not from the request',
  );
  assert.ok(
    /if\s*\(!athleteId\)/.test(body),
    'a state that fails verification must stop the request',
  );
});

test('the Strava webhook checks its verify token and routes by a known owner', () => {
  // Exempt from the session guard because Strava calls it directly. Strava does
  // not sign these payloads, so the only things standing between the open
  // internet and a queued job are the verify token on the validation handshake
  // and the owner lookup on delivery.
  const text = readFileSync(join(ROUTES_DIR, 'connections.ts'), 'utf8');

  const get = text.slice(text.indexOf("app.get<{\n    Querystring"));
  const validation = get.slice(0, get.indexOf('app.post'));
  assert.ok(
    validation.includes('webhookVerifyToken()'),
    'the validation handshake must compare against the verify token',
  );
  assert.ok(
    /!==\s*webhookVerifyToken\(\)/.test(validation),
    'a mismatched verify token must be rejected, not merely logged',
  );

  const post = text.slice(text.indexOf("app.post<{ Body: WebhookEvent }>"));
  const handler = post.slice(0, post.indexOf('Subscription management'));
  assert.ok(
    handler.includes('athleteForStravaOwner'),
    'delivery must resolve the athlete from owner_id rather than trusting the body',
  );
  assert.ok(
    /if\s*\(!athleteId\)/.test(handler),
    'an event for an athlete this server does not know must be discarded',
  );
});

test('the webhook never processes an event inline', () => {
  // Strava retries anything not answered within two seconds, and a retry storm
  // against a slow import is how a webhook turns into an outage.
  const text = readFileSync(join(ROUTES_DIR, 'connections.ts'), 'utf8');
  const post = text.slice(text.indexOf("app.post<{ Body: WebhookEvent }>"));
  const handler = post.slice(0, post.indexOf('Subscription management'));
  assert.ok(handler.includes('stravaSyncQueue()'), 'work must be enqueued');
  assert.ok(
    !/importStravaActivity|syncStrava\(/.test(handler),
    'the handler must not import inline',
  );
});
