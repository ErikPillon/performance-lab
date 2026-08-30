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

/** Reachable without a session, deliberately. */
const PUBLIC_ROUTES = new Set(['/me', '/auth/*']);

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
