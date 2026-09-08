import { and, eq } from 'drizzle-orm';
import { athleteConnection, db, decryptToken, deriveSecret, encryptToken } from '@lab/db';

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

/* ---------------------------------------------------------------------------
 * Webhook subscriptions
 *
 * Strava pushes an event when an activity is created, updated or deleted, and
 * when an athlete deauthorises the application. It is a latency optimisation
 * rather than a correctness mechanism: deliveries can be missed, replayed or
 * arrive out of order, so the polling sync remains what makes the system
 * eventually correct. The webhook only makes it fast.
 *
 * Three constraints shape everything here:
 *
 *  1. Creating a subscription makes Strava immediately GET the callback with a
 *     `hub.challenge` that must be echoed back. So a subscription cannot exist
 *     before the callback is publicly reachable.
 *  2. Events must be answered within two seconds or Strava retries. Nothing is
 *     processed inline; the handler enqueues and returns.
 *  3. Payloads are not signed. Authenticity comes from the verify token at
 *     subscription time and from routing on `owner_id` — an event naming an
 *     athlete this server has no connection for is discarded.
 * ------------------------------------------------------------------------ */

const SUBSCRIPTION_URL = 'https://www.strava.com/api/v3/push_subscriptions';

/** Echoed back by Strava when it validates the callback. Stable across restarts. */
export function webhookVerifyToken(): string {
  return deriveSecret('strava-webhook-verify');
}

export interface StravaSubscription {
  id: number;
  callback_url: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Register the callback with Strava.
 *
 * Strava validates it synchronously — it calls the URL before this request
 * returns — so a failure here usually means the callback is not reachable from
 * the internet rather than that anything is wrong with the credentials.
 */
export async function createSubscription(callbackUrl: string): Promise<StravaSubscription> {
  const config = stravaConfig();
  if (!config) throw new Error('Strava is not configured');

  const res = await fetch(SUBSCRIPTION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      callback_url: callbackUrl,
      verify_token: webhookVerifyToken(),
    }),
    // Longer than the other calls: this waits on Strava calling back.
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `strava subscription failed (${res.status}): ${detail.slice(0, 300)}. ` +
        'Strava must be able to reach the callback URL from the internet.',
    );
  }
  return (await res.json()) as StravaSubscription;
}

/** The application's current subscription, if any. Strava allows exactly one. */
export async function viewSubscription(): Promise<StravaSubscription | null> {
  const config = stravaConfig();
  if (!config) return null;
  const url = new URL(SUBSCRIPTION_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('client_secret', config.clientSecret);

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`strava subscription lookup returned ${res.status}`);
  const list = (await res.json()) as StravaSubscription[];
  return list[0] ?? null;
}

export async function deleteSubscription(id: number): Promise<void> {
  const config = stravaConfig();
  if (!config) throw new Error('Strava is not configured');
  const url = new URL(`${SUBSCRIPTION_URL}/${id}`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('client_secret', config.clientSecret);

  const res = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(15_000) });
  // 204 is success; 404 means it is already gone, which is the same outcome.
  if (!res.ok && res.status !== 404) {
    throw new Error(`strava subscription delete returned ${res.status}`);
  }
}

export interface WebhookEvent {
  aspect_type: 'create' | 'update' | 'delete';
  object_type: 'activity' | 'athlete';
  object_id: number;
  owner_id: number;
  event_time?: number;
  subscription_id?: number;
  updates?: Record<string, string>;
}

/** What a received event should cause, decided without touching the network. */
export type WebhookAction =
  | { kind: 'ignore'; reason: string }
  | { kind: 'import'; activityId: number }
  | { kind: 'deauthorized' };

/**
 * Interpret an event.
 *
 * Pure, and separated from the handler on purpose: this is where the decisions
 * live that are worth testing without a Strava account.
 *
 * Deletions are deliberately *not* acted on. Strava is a mirror, and an
 * activity removed there may still have arrived here as an uploaded FIT, which
 * is the better copy. Silently deleting an athlete's training because a mirror
 * changed is not a trade worth making; a deletion that matters is a manual act.
 */
export function interpretWebhook(event: WebhookEvent): WebhookAction {
  if (event.object_type === 'athlete') {
    // Strava sends updates.authorized === "false" when access is revoked. It is
    // a string, not a boolean, which is exactly the sort of thing that silently
    // reads as truthy.
    if (event.updates?.authorized === 'false') return { kind: 'deauthorized' };
    return { kind: 'ignore', reason: 'athlete event with nothing actionable' };
  }

  if (event.object_type !== 'activity') {
    return { kind: 'ignore', reason: `unknown object_type ${event.object_type}` };
  }
  if (event.aspect_type === 'delete') {
    return { kind: 'ignore', reason: 'deletions are not mirrored' };
  }
  if (!Number.isFinite(event.object_id) || event.object_id <= 0) {
    return { kind: 'ignore', reason: 'missing object_id' };
  }
  // create and update both resolve to "fetch it again": an edited activity may
  // have had its type or privacy changed, and re-importing is idempotent.
  return { kind: 'import', activityId: event.object_id };
}

/** The athlete a Strava owner id belongs to, or null if none is connected. */
export async function athleteForStravaOwner(ownerId: number): Promise<string | null> {
  const [row] = await db
    .select({ athleteId: athleteConnection.athleteId, status: athleteConnection.status })
    .from(athleteConnection)
    .where(and(
      eq(athleteConnection.provider, 'strava'),
      eq(athleteConnection.providerAthleteId, String(ownerId)),
    ))
    .limit(1);
  if (!row || row.status === 'disconnected') return null;
  return row.athleteId;
}

/** Record that Strava access was revoked, so the UI can ask for a reconnect. */
export async function markDeauthorized(ownerId: number): Promise<void> {
  await db
    .update(athleteConnection)
    .set({
      status: 'needs_reauth',
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      lastError: 'Access was revoked from Strava',
    })
    .where(and(
      eq(athleteConnection.provider, 'strava'),
      eq(athleteConnection.providerAthleteId, String(ownerId)),
    ));
}
