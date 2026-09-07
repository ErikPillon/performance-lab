import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { athleteConnection, db, encryptToken, signState, verifyState } from '@lab/db';
import { stravaToken } from '@lab/ingest';
import { stravaSyncQueue } from '@lab/jobs';
import { env } from '../env.js';
import { requireAthleteAccess } from '../access.js';

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
      providers: { strava: { configured: env.strava.configured } },
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
   * Enqueued rather than run inline: a first import walks years of history one
   * page at a time against a rate-limited API, which is not something to hold a
   * request open for. The job id is the athlete, so pressing the button twice
   * collapses onto one run.
   */
  app.post<{ Params: { id: string } }>(
    '/athletes/:id/connections/strava/sync',
    async (req, reply) => {
      const access = await requireAthleteAccess(req, req.params.id);
      if (access.relationship !== 'owner') {
        return reply.code(403).send({ error: 'only the athlete can sync their own accounts' });
      }

      const [row] = await db
        .select({ status: athleteConnection.status })
        .from(athleteConnection)
        .where(and(
          eq(athleteConnection.athleteId, req.params.id),
          eq(athleteConnection.provider, 'strava'),
        ))
        .limit(1);

      if (!row || row.status === 'disconnected') {
        return reply.code(409).send({ error: 'no Strava account is linked' });
      }
      if (row.status === 'needs_reauth') {
        return reply.code(409).send({ error: 'Strava access expired — reconnect to continue' });
      }

      const queue = stravaSyncQueue();
      const jobId = `strava-${req.params.id}`;
      const existing = await queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'waiting' || state === 'active' || state === 'delayed') {
          return reply.send({ jobId, alreadyRunning: true });
        }
        await existing.remove();
      }
      await queue.add('strava-sync', { athleteId: req.params.id }, { jobId });
      return reply.send({ jobId, alreadyRunning: false });
    },
  );

  /** Unlink. Deliberately forgets the tokens rather than only marking a flag. */
  app.delete<{ Params: { id: string } }>(
    '/athletes/:id/connections/strava',
    async (req, reply) => {
      const access = await requireAthleteAccess(req, req.params.id);
      if (access.relationship !== 'owner') {
        return reply.code(403).send({ error: 'only the athlete can unlink their own accounts' });
      }
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
          eq(athleteConnection.provider, 'strava'),
        ))
        .returning({ id: athleteConnection.id });

      return reply.send({ disconnected: updated.length });
    },
  );
}
