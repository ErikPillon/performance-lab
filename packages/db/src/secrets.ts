import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Encryption for third-party OAuth tokens at rest.
 *
 * A Strava refresh token is a long-lived credential to somebody's entire
 * training history. Postgres backups, a `pg_dump` on a laptop and a replica on
 * another box all end up holding whatever is in this column, so it is not
 * stored in the clear.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than silently producing garbage that gets sent to Strava as a bearer token.
 *
 * The key is its own secret rather than derived from `BETTER_AUTH_SECRET`.
 * Rotating the auth secret logs everyone out, which should stay a cheap
 * operation; if it also invalidated every stored token it would quietly become
 * expensive.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const TAG_BYTES = 16;

function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is not set. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must decode to 32 bytes, got ${buf.length}`);
  }
  return buf;
}

/**
 * Encrypt a token. Output is `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 *
 * The version prefix is there so a future key rotation or algorithm change can
 * tell old ciphertext from new instead of guessing.
 */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Decrypt a token produced by `encryptToken`. Throws if it was tampered with. */
export function decryptToken(encoded: string): string {
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('unrecognised token ciphertext format');
  }
  const iv = Buffer.from(parts[1]!, 'base64url');
  const tag = Buffer.from(parts[2]!, 'base64url');
  const ciphertext = Buffer.from(parts[3]!, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('token ciphertext has the wrong shape');
  }
  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * A signed, self-describing OAuth `state` value.
 *
 * Carries the athlete it belongs to and an expiry, so the callback does not
 * have to trust a query parameter or keep server-side session state for a
 * redirect that may never come back. The HMAC is what stops someone pointing
 * their own authorisation at another athlete's account.
 */
export function signState(athleteId: string, ttlMs = 10 * 60_000): string {
  const payload = `${athleteId}.${Date.now() + ttlMs}.${randomBytes(9).toString('base64url')}`;
  const mac = createHmac('sha256', key()).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}

/** Verify a state value, returning the athlete id it was issued for. */
export function verifyState(state: string): string | null {
  const split = state.lastIndexOf('.');
  if (split < 1) return null;

  const encoded = state.slice(0, split);
  const mac = state.slice(split + 1);
  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = createHmac('sha256', key()).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, which would turn a forged state into a 500.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const [athleteId, expiry] = payload.split('.');
  if (!athleteId || !expiry) return null;
  if (Number(expiry) < Date.now()) return null;
  return athleteId;
}
