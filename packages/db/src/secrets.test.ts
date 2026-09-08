import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { decryptToken, deriveSecret, encryptToken, signState, verifyState } from './secrets.js';

const saved = process.env.TOKEN_ENCRYPTION_KEY;

before(() => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});
after(() => {
  if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = saved;
});

test('a token round-trips', () => {
  const token = 'a1b2c3d4e5f6' .repeat(4);
  assert.equal(decryptToken(encryptToken(token)), token);
});

test('the same token encrypts differently every time', () => {
  // A fresh IV per encryption. Without it, identical tokens would be visible as
  // identical ciphertext in the table.
  const a = encryptToken('same-token');
  const b = encryptToken('same-token');
  assert.notEqual(a, b);
  assert.equal(decryptToken(a), decryptToken(b));
});

test('tampering is detected rather than silently decrypting to garbage', () => {
  const encoded = encryptToken('strava-refresh-token');
  const parts = encoded.split('.');
  // Flip a byte of the ciphertext.
  const bytes = Buffer.from(parts[3]!, 'base64url');
  bytes[0] ^= 0xff;
  parts[3] = bytes.toString('base64url');
  assert.throws(() => decryptToken(parts.join('.')));
});

test('a truncated or reshaped ciphertext is rejected', () => {
  assert.throws(() => decryptToken('nonsense'));
  assert.throws(() => decryptToken('v1.a.b'));
  assert.throws(() => decryptToken(`v2.${encryptToken('x').split('.').slice(1).join('.')}`));
});

test('an empty string round-trips', () => {
  assert.equal(decryptToken(encryptToken('')), '');
});

test('a missing or wrong-sized key fails loudly', () => {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  delete process.env.TOKEN_ENCRYPTION_KEY;
  assert.throws(() => encryptToken('x'), /TOKEN_ENCRYPTION_KEY is not set/);
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.from('too short').toString('base64');
  assert.throws(() => encryptToken('x'), /32 bytes/);
  process.env.TOKEN_ENCRYPTION_KEY = key;
});

test('state round-trips and carries its athlete', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  assert.equal(verifyState(signState(id)), id);
});

test('a forged state is rejected', () => {
  // The whole point: without a valid MAC, anyone could point their own Strava
  // authorisation at someone else's athlete.
  const id = '11111111-2222-3333-4444-555555555555';
  const forged = `${Buffer.from(`${id}.${Date.now() + 60_000}.abc`).toString('base64url')}.notamac`;
  assert.equal(verifyState(forged), null);
});

test('a tampered athlete id is rejected', () => {
  const state = signState('11111111-2222-3333-4444-555555555555');
  const [encoded, mac] = state.split('.');
  const payload = Buffer.from(encoded!, 'base64url').toString('utf8');
  const swapped = payload.replace('11111111', '99999999');
  const tampered = `${Buffer.from(swapped).toString('base64url')}.${mac}`;
  assert.equal(verifyState(tampered), null);
});

test('an expired state is rejected', () => {
  assert.equal(verifyState(signState('abc', -1)), null, 'already expired when issued');
});

test('malformed state values return null rather than throwing', () => {
  // These arrive as query parameters from the open internet.
  for (const bad of ['', '.', 'no-dot', '!!!.###', 'a.b.c']) {
    assert.equal(verifyState(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('a derived secret is stable, and unrelated across purposes', () => {
  // Strava echoes the webhook verify token back at subscription time, so it has
  // to survive a restart — deriving it avoids another environment variable that
  // could drift or go missing.
  assert.equal(deriveSecret('strava-webhook'), deriveSecret('strava-webhook'));
  assert.notEqual(deriveSecret('strava-webhook'), deriveSecret('something-else'));
  assert.ok(deriveSecret('strava-webhook').length >= 32);
});

test('a derived secret changes with the key', () => {
  const before = deriveSecret('strava-webhook');
  const saved = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  assert.notEqual(deriveSecret('strava-webhook'), before);
  process.env.TOKEN_ENCRYPTION_KEY = saved;
});
