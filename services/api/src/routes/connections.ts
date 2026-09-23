import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { athleteConnection, db, encryptToken, signState, verifyState } from '@lab/db';
import {
  IntervalsAuthError, athleteForStravaOwner, createSubscription, deleteSubscription,
  intervalsAthlete, interpretWebhook, markDeauthorized, stravaToken, viewSubscription,
  webhookVerifyToken, type WebhookEvent,
} from '@lab/ingest';
import { requestIntervalsSync, requestStravaSync, stravaSyncQueue } from '@lab/jobs';
import { env } from '../env.js';
import { requireAthleteAccess } from '../access.js';
import { isPubliclyReachable } from '../reachability.js';

/**
 * Linking a Strava account.
 *
 * Strava is deliberately a mirror rather than a source of truth. Its API cannot
 * return the original FIT file — third-party applications get a summary and
 * derived streams — so athlete-uploaded FIT stays canonical and the dedupe key
 * collapses a session that arrives from both.
 *
 * It is also the practical answer to Garmin. Garmin's Connect Developer Program
 * is business-use with manual approval, and the unofficial route means storing
 * somebody's Garmin password, which is not worth doing. Garmin Connect syncs to
 * Strava natively, so this gets Garmin activities without either problem.
 */

const STRAVA_AUTHORIZE = 'https://www.strava.com/oauth/authorize';

/**
 * `activity:read_all` rather than `activity:read`: the narrower scope silently
 * omits private activities, which for most athletes is a meaningful share of
 * their training and would show up as unexplained gaps.
 */
const SCOPES = 'read,activity:read_all';

/** What the provider-generic routes need to know about each provider. */
const PROVIDERS: Record<string, {
  id: 'strava' | 'intervals';
  name: string;
  reauthMessage: string;
  requestSync: (athleteId: string) => Promise<{ jobId: string; alreadyQueued: boolean }>;
}> = {
  strava: {
    id: 'strava',
    name: 'Strava',
    reauthMessage: 'Strava access expired — reconnect to continue',
    requestSync: requestStravaSync,
  },
  intervals: {
    id: 'intervals',
    name: 'intervals.icu',
    reauthMessage: 'intervals.icu rejected the API key — paste a new one to continue',
    requestSync: requestIntervalsSync,
  },
};

export async function connectionRoutes(app: FastifyInstance) {
  /** What is linked, and whether linking is even possible. */
  app.get<{ Params: { id: string } }>('/athletes/:id/connections', async (req) => {
    const access = await requireAthleteAccess(req, req.params.id);
    const rows = await db
      .select({
        provider: athleteConnection.provider,
        status: athleteConnection.status,
        syncedThrough: athleteConnection.syncedThrough,
        lastSyncAt: athleteConnection.lastSyncAt,
        lastError: athleteConnection.lastError,
        importedCount: athleteConnection.importedCount,
        scope: athleteConnection.scope,
        createdAt: athleteConnection.createdAt,
      })
      .from(athleteConnection)
      .where(eq(athleteConnection.athleteId, req.params.id));

    return {
      // Tokens are never in this response, under any status.
      connections: rows,
      providers: {
        strava: { configured: env.strava.configured },
        // Nothing to register: each athlete brings their own key. It only needs
        // somewhere safe to keep it.
        intervals: { configured: env.tokenEncryption },
      },
      canManage: access.relationship === 'owner',
    };
  });

  /**
   * Begin the OAuth dance.
   *
   * Returns the URL rather than redirecting: the caller is a fetch from the
   * dashboard, and a 302 to strava.com from an XHR would be followed silently
   * and land nowhere useful.
   */
  app.post<{ Params: { id: string } }>('/athletes/:id/connections/strava', async (req, reply) => {
    const access = await requireAthleteAccess(req, req.params.id);
    if (access.relationship !== 'owner') {
      return reply.code(403).send({ error: 'only the athlete can link their own accounts' });
    }
    if (!env.strava.configured) {
      return reply.code(503).send({
        error: 'Strava is not configured on this server (STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET)',
      });
    }

    const url = new URL(STRAVA_AUTHORIZE);
    url.searchParams.set('client_id', env.strava.clientId);
    url.searchParams.set('redirect_uri', `${env.auth.baseUrl}/api/connections/strava/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('approval_prompt', 'auto');
    url.searchParams.set('scope', SCOPES);
    // Signed state carrying the athlete, so the callback does not have to trust
    // a query parameter or hold server-side state for a redirect that may never
    // come back.
    url.searchParams.set('state', signState(req.params.id));

    return reply.send({ url: url.toString() });
  });

  /**
   * Where Strava sends the athlete back.
   *
   * Unauthenticated by necessity — it is a top-level browser redirect from
   * strava.com, and the session cookie is SameSite=Lax so it does travel, but
   * the signed state is what actually authorises the write.
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/connections/strava/callback',
    async (req, reply) => {
      const back = (params: Record<string, string>) =>
        reply.redirect(`${env.auth.baseUrl}/upload?${new URLSearchParams(params)}`);

      if (req.query.error) return back({ strava: 'denied' });
      if (!req.query.code || !req.query.state) return back({ strava: 'missing_code' });

      const athleteId = verifyState(req.query.state);
      if (!athleteId) return back({ strava: 'bad_state' });

      let token;
      try {
        token = await stravaToken({ code: req.query.code });
      } catch (err) {
        req.log.error({ err }, 'strava token exchange failed');
        return back({ strava: 'exchange_failed' });
      }

      const values = {
        athleteId,
        provider: 'strava' as const,
        providerAthleteId: token.athlete?.id ? String(token.athlete.id) : null,
        accessToken: encryptToken(token.access_token),
        refreshToken: encryptToken(token.refresh_token),
        expiresAt: new Date(token.expires_at * 1000),
        scope: token.scope ?? SCOPES,
        status: 'active' as const,
        lastError: null,
      };

      // Reconnecting updates the existing row rather than leaving a trail of
      // dead tokens behind.
      await db
        .insert(athleteConnection)
        .values(values)
        .onConflictDoUpdate({
          target: [athleteConnection.athleteId, athleteConnection.provider],
          set: values,
        });

      return back({ strava: 'connected' });
    },
  );

  /**
   * Ask for a sync now.
   *
   * Enqueued rather than run inline: a first import walks years of history
   * against a rate-limited API, which is not something to hold a request open
   * for. The job id is the athlete, so pressing the button twice collapses onto
   * one run — including one waiting out a rate limit.
   */
  app.post<{ Params: { id: string; provider: string } }>(
    '/athletes/:id/connections/:provider/sync',
    async (req, reply) => {
      const access = await requireAthleteAccess(req, req.params.id);
      if (access.relationship !== 'owner') {
        return reply.code(403).send({ error: 'only the athlete can sync their own accounts' });
      }
      const provider = PROVIDERS[req.params.provider];
      if (!provider) return reply.code(404).send({ error: 'unknown provider' });

      const [row] = await db
        .select({ status: athleteConnection.status })
        .from(athleteConnection)
        .where(and(
          eq(athleteConnection.athleteId, req.params.id),
          eq(athleteConnection.provider, provider.id),
        ))
        .limit(1);

      if (!row || row.status === 'disconnected') {
        return reply.code(409).send({ error: `no ${provider.name} account is linked` });
      }
      if (row.status === 'needs_reauth') {
        return reply.code(409).send({ error: provider.reauthMessage });
      }

      const { jobId, alreadyQueued } = await provider.requestSync(req.params.id);
      return reply.send({ jobId, alreadyRunning: alreadyQueued });
    },
  );

  /**
   * Strava's subscription validation.
   *
   * Creating a subscription makes Strava call this immediately with a challenge
   * that has to be echoed back verbatim. The verify token is what proves the
   * request came from our own subscription attempt rather than from anyone who
   * found the URL.
   */
  app.get<{
    Querystring: Record<string, string | undefined>;
  }>('/connections/strava/webhook', async (req, reply) => {
    const mode = req.query['hub.mode'];
    const challenge = req.query['hub.challenge'];
    const token = req.query['hub.verify_token'];

    if (mode !== 'subscribe' || !challenge) {
      return reply.code(400).send({ error: 'not a subscription validation' });
    }
    if (token !== webhookVerifyToken()) {
      req.log.warn('strava webhook validation with a bad verify token');
      return reply.code(403).send({ error: 'bad verify token' });
    }
    // Strava requires this exact key, dot and all.
    return reply.send({ 'hub.challenge': challenge });
  });

  /**
   * Event delivery.
   *
   * Strava expects a 200 within two seconds and retries otherwise, so nothing
   * is processed here — the event is interpreted, routed to an athlete and
   * enqueued.
   *
   * Payloads are unsigned. Authenticity rests on two things: the verify token
   * used when the subscription was created, and routing on `owner_id`. An event
   * naming a Strava athlete this server has no connection for is discarded, so
   * the worst a forged POST achieves is re-importing an activity the athlete
   * already authorised us to read.
   */
  app.post<{ Body: WebhookEvent }>('/connections/strava/webhook', async (req, reply) => {
    // Answer first, work later. Everything below is deliberately cheap.
    const event = req.body;
    if (!event || typeof event !== 'object') return reply.code(200).send({ ok: true });

    const action = interpretWebhook(event);
    if (action.kind === 'ignore') {
      req.log.info({ reason: action.reason }, 'strava webhook ignored');
      return reply.code(200).send({ ok: true });
    }

    const athleteId = await athleteForStravaOwner(event.owner_id);
    if (!athleteId) {
      // Not an error: Strava sends one subscription's events for every athlete
      // who has authorised the application, including any this server does not
      // know about.
      req.log.info({ owner: event.owner_id }, 'strava webhook for an unknown athlete');
      return reply.code(200).send({ ok: true });
    }

    if (action.kind === 'deauthorized') {
      await markDeauthorized(event.owner_id);
      return reply.code(200).send({ ok: true });
    }

    // Job id keyed on the activity, so Strava's retries and its habitual
    // create-then-update pair collapse into one import.
    await stravaSyncQueue().add(
      'strava-sync',
      { athleteId, stravaActivityId: action.activityId },
      { jobId: `strava-activity-${action.activityId}` },
    );
    return reply.code(200).send({ ok: true });
  });

  /**
   * Subscription management.
   *
   * Owner-only and deliberately manual. A subscription is per *application*,
   * not per athlete — Strava allows exactly one — so this is closer to a server
   * setting than to a user action, and creating one silently on connect would
   * be surprising.
   */
  app.get<{ Params: { id: string } }>(
    '/athletes/:id/connections/strava/subscription',
    async (req, reply) => {
      const access = await requireAthleteAccess(req, req.params.id);
      if (access.relationship !== 'owner') {
        return reply.code(403).send({ error: 'only the athlete can manage this' });
      }
      if (!env.strava.configured) return reply.send({ configured: false, subscription: null });

      const callbackUrl = `${env.auth.baseUrl}/api/connections/strava/webhook`;
      try {
        const subscription = await viewSubscription();
        return reply.send({
          configured: true,
          subscription,
          callbackUrl,
          // Strava has to reach this from the internet, which a LAN or tailnet
          // address cannot satisfy however well it works in a browser.
          reachable: isPubliclyReachable(callbackUrl),
        });
      } catch (err) {
        return reply.code(502).send({
          error: err instanceof Error ? err.message : 'could not reach Strava',
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/athletes/:id/connections/strava/subscription',
    async (req, reply) => {
      const access = await requireAthleteAccess(req, req.params.id);
      if (access.relationship !== 'owner') {
        return reply.code(403).send({ error: 'only the athlete can manage this' });
      }
      if (!env.strava.configured) {
        return reply.code(503).send({ error: 'Strava is not configured on this server' });
      }
      try {
        const subscription = await createSubscription(
          `${env.auth.baseUrl}/api/connections/strava/webhook`,
        );
        return reply.send({ subscription });
      } catch (err) {
        // Almost always "Strava could not reach the callback", which is a
        // deployment fact rather than a bug, so it is reported as given.
        return reply.code(502).send({
          error: err instanceof Error ? err.message : 'could not create the subscription',
        });
      }
    },
  );

  app.delete<{ Params: { id: string; subscriptionId: string } }>(
    '/athletes/:id/connections/strava/subscription/:subscriptionId',
    async (req, reply) => {
      const access = await requireAthleteAccess(req, req.params.id);
      if (access.relationship !== 'owner') {
        return reply.code(403).send({ error: 'only the athlete can manage this' });
      }
      await deleteSubscription(Number(req.params.subscriptionId));
      return reply.send({ deleted: true });
    },
  );

  /**
   * Link intervals.icu with the athlete's personal API key.
   *
   * The key is checked against intervals.icu before anything is stored, so a
   * mistyped one fails here with a message rather than as a sync error ten
   * minutes later. Reconnecting replaces the key and keeps the cursor: a new
   * key for the same account carries on where the old one stopped.
   */
  app.post<{ Params: { id: string }; Body: { apiKey?: unknown } }>(
    '/athletes/:id/connections/intervals',
    async (req, reply) => {
      const access = await requireAthleteAccess(req, req.params.id);
      if (access.relationship !== 'owner') {
        return reply.code(403).send({ error: 'only the athlete can link their own accounts' });
      }
      if (!env.tokenEncryption) {
        return reply.code(503).send({
          error: 'this server has no TOKEN_ENCRYPTION_KEY, so it cannot store an API key safely',
        });
      }
      const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
      if (apiKey.length < 8 || apiKey.length > 200) {
        return reply.code(400).send({ error: 'paste the API key from intervals.icu → Settings → Developer Settings' });
      }

      let owner;
      try {
        owner = await intervalsAthlete(apiKey);
      } catch (err) {
        if (err instanceof IntervalsAuthError) {
          return reply.code(400).send({ error: 'intervals.icu did not accept that key' });
        }
        req.log.error({ err }, 'intervals.icu key check failed');
        return reply.code(502).send({ error: 'could not reach intervals.icu — try again shortly' });
      }

      const values = {
        athleteId: req.params.id,
        provider: 'intervals' as const,
        providerAthleteId: owner.id,
        accessToken: encryptToken(apiKey),
        refreshToken: null,
        expiresAt: null,
        scope: null,
        status: 'active' as const,
        lastError: null,
      };
      await db
        .insert(athleteConnection)
        .values(values)
        .onConflictDoUpdate({
          target: [athleteConnection.athleteId, athleteConnection.provider],
          set: values,
        });

      await requestIntervalsSync(req.params.id);
      return reply.send({ athlete: owner });
    },
  );

  /** Unlink. Deliberately forgets the credentials rather than only marking a flag. */
  app.delete<{ Params: { id: string; provider: string } }>(
    '/athletes/:id/connections/:provider',
    async (req, reply) => {
      const access = await requireAthleteAccess(req, req.params.id);
      if (access.relationship !== 'owner') {
        return reply.code(403).send({ error: 'only the athlete can unlink their own accounts' });
      }
      const provider = PROVIDERS[req.params.provider];
      if (!provider) return reply.code(404).send({ error: 'unknown provider' });

      // Nulled, not deleted: the row keeps what was already imported and when,
      // which is worth more than a clean table. The credentials themselves are
      // gone either way, which is the part that matters.
      const updated = await db
        .update(athleteConnection)
        .set({
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
          status: 'disconnected',
          lastError: null,
        })
        .where(and(
          eq(athleteConnection.athleteId, req.params.id),
          eq(athleteConnection.provider, provider.id),
        ))
        .returning({ id: athleteConnection.id });

      return reply.send({ disconnected: updated.length });
    },
  );
}
