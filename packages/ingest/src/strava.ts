import { and, eq } from 'drizzle-orm';
import { athleteConnection, db, decryptToken, encryptToken } from '@lab/db';

/**
 * Strava API client.
 *
 * Shared between the API, which runs the OAuth exchange, and the worker, which
 * syncs. Keeping the token lifecycle in one place matters more than usual here:
 * Strava rotates the refresh token on every refresh, so two components each
 * holding their own copy would race and lock the athlete out.
 */

const TOKEN_URL = 'https://www.strava.com/oauth/token';
const API = 'https://www.strava.com/api/v3';

/** Refresh this far ahead of expiry rather than on a 401 mid-sync. */
const REFRESH_MARGIN_MS = 10 * 60_000;

export interface StravaConfig {
  clientId: string;
  clientSecret: string;
}

export function stravaConfig(): StravaConfig | null {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
  athlete?: { id: number };
}

/** Exchange an authorization code, or refresh an existing grant. */
export async function stravaToken(
  params: { code: string } | { refreshToken: string },
): Promise<TokenResponse> {
  const config = stravaConfig();
  if (!config) throw new Error('Strava is not configured');

  const grant =
    'code' in params
      ? { code: params.code, grant_type: 'authorization_code' }
      : { refresh_token: params.refreshToken, grant_type: 'refresh_token' };

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...grant,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const error = new Error(`strava token endpoint returned ${res.status}: ${detail.slice(0, 200)}`);
    // 400 and 401 mean the grant itself is dead — revoked, or the app's access
    // withdrawn. That needs the athlete to click something, which is a
    // different situation from Strava being down, and callers act on it.
    (error as { needsReauth?: boolean }).needsReauth = res.status === 400 || res.status === 401;
    throw error;
  }
  return (await res.json()) as TokenResponse;
}

/**
 * A usable access token for an athlete, refreshing when close to expiry.
 *
 * Returns null when there is nothing to work with — no connection, or one the
 * athlete has to re-authorise. The connection row records which.
 */
export async function freshStravaToken(athleteId: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(athleteConnection)
    .where(and(
      eq(athleteConnection.athleteId, athleteId),
      eq(athleteConnection.provider, 'strava'),
    ))
    .limit(1);

  if (!row?.refreshToken || row.status === 'disconnected') return null;

  const expiresAt = row.expiresAt?.getTime() ?? 0;
  if (row.accessToken && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return decryptToken(row.accessToken);
  }

  try {
    const token = await stravaToken({ refreshToken: decryptToken(row.refreshToken) });
    await db
      .update(athleteConnection)
      .set({
        accessToken: encryptToken(token.access_token),
        // Strava rotates the refresh token on every refresh. Keeping the old
        // one would work exactly once more and then lock the athlete out.
        refreshToken: encryptToken(token.refresh_token),
        expiresAt: new Date(token.expires_at * 1000),
        status: 'active',
        lastError: null,
      })
      .where(eq(athleteConnection.id, row.id));
    return token.access_token;
  } catch (err) {
    const needsReauth = !!(err as { needsReauth?: boolean }).needsReauth;
    await db
      .update(athleteConnection)
      .set({
        status: needsReauth ? 'needs_reauth' : 'error',
        lastError: err instanceof Error ? err.message : 'refresh failed',
      })
      .where(eq(athleteConnection.id, row.id));
    return null;
  }
}

export interface StravaActivitySummary {
  id: number;
  start_date: string;
  type?: string;
  sport_type?: string;
  elapsed_time?: number;
  [key: string]: unknown;
}

/** Thrown when Strava says to stop. Carries how long to wait. */
export class RateLimited extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`strava rate limit hit; retry in ${Math.round(retryAfterMs / 1000)}s`);
  }
}

async function call<T>(token: string, path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 429) {
    // Strava's limits reset on the quarter hour and daily. Without a header to
    // read, waiting out the quarter is the only safe assumption.
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const wait = Number.isFinite(reset) && reset > 0
      ? Math.max(reset * 1000 - Date.now(), 60_000)
      : 15 * 60_000;
    throw new RateLimited(wait);
  }
  if (!res.ok) throw new Error(`strava ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

/**
 * One page of activities started after `after`, oldest first.
 *
 * Ascending order is what makes the sync resumable: the cursor can advance as
 * each activity lands, so an interrupted run resumes rather than restarting a
 * multi-year import.
 */
export function listActivities(
  token: string,
  after: Date | null,
  perPage = 50,
): Promise<StravaActivitySummary[]> {
  const params: Record<string, string> = { per_page: String(perPage) };
  if (after) params.after = String(Math.floor(after.getTime() / 1000));
  return call<StravaActivitySummary[]>(token, '/athlete/activities', params);
}

/** The detailed activity, which carries fields the list view omits. */
export function getActivity(token: string, id: number): Promise<Record<string, unknown>> {
  return call<Record<string, unknown>>(token, `/activities/${id}`);
}

const STREAM_KEYS = [
  'time', 'distance', 'latlng', 'altitude', 'velocity_smooth',
  'heartrate', 'cadence', 'watts', 'temp', 'grade_smooth',
].join(',');

/** Every stream Strava will give for an activity, keyed by type. */
export function getStreams(token: string, id: number): Promise<Record<string, unknown>> {
  return call<Record<string, unknown>>(token, `/activities/${id}/streams`, {
    keys: STREAM_KEYS,
    key_by_type: 'true',
  });
}
