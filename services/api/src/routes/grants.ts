import { randomBytes } from 'node:crypto';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { athlete, coachAthleteGrant, db, user } from '@lab/db';
import { HttpError, requireActor, requireAthleteAccess, requireOwner, type Scope } from '../access.js';

const VALID_SCOPES: Scope[] = ['training', 'wellness', 'location'];

/**
 * Invite codes.
 *
 * 160 bits from a CSPRNG, base32-ish for legibility over a phone call. These
 * are bearer credentials until redeemed, so they must not be guessable and
 * must not be derived from anything about the athlete.
 */
function makeInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  const bytes = randomBytes(20);
  const body = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15, 20)}`;
}

export async function grantRoutes(app: FastifyInstance) {
  /** Everyone with access to this athlete, and every outstanding invite. */
  app.get<{ Params: { id: string } }>('/athletes/:id/grants', async (req) => {
    await requireOwner(req, req.params.id);
    const rows = await db
      .select({
        id: coachAthleteGrant.id,
        status: coachAthleteGrant.status,
        scopes: coachAthleteGrant.scopes,
        note: coachAthleteGrant.note,
        inviteCode: coachAthleteGrant.inviteCode,
        createdAt: coachAthleteGrant.createdAt,
        expiresAt: coachAthleteGrant.expiresAt,
        acceptedAt: coachAthleteGrant.acceptedAt,
        coachName: user.name,
        coachEmail: user.email,
      })
      .from(coachAthleteGrant)
      .leftJoin(user, eq(user.id, coachAthleteGrant.coachUserId))
      .where(
        and(eq(coachAthleteGrant.athleteId, req.params.id), ne(coachAthleteGrant.status, 'revoked')),
      )
      .orderBy(desc(coachAthleteGrant.createdAt));
    return { grants: rows };
  });

  /**
   * Create an invite.
   *
   * Athlete-initiated by design: there is no endpoint where a coach names an
   * athlete and asks for access. The athlete generates a code and hands it
   * over, which is the right default for health data and removes any way to
   * probe for whether a given athlete exists.
   */
  app.post<{
    Params: { id: string };
    Body: { scopes?: string[]; note?: string; expiresInDays?: number };
  }>('/athletes/:id/grants', async (req, reply) => {
    await requireOwner(req, req.params.id);

    const requested = req.body?.scopes ?? ['training'];
    const scopes = requested.filter((s): s is Scope => VALID_SCOPES.includes(s as Scope));
    if (scopes.length === 0) {
      throw new HttpError(422, `scopes must include at least one of ${VALID_SCOPES.join(', ')}`);
    }

    const days = req.body?.expiresInDays ?? 14;
    const [row] = await db
      .insert(coachAthleteGrant)
      .values({
        athleteId: req.params.id,
        inviteCode: makeInviteCode(),
        scopes,
        note: req.body?.note ?? null,
        // Invites expire by default: an unredeemed code sitting in a chat log
        // forever is a standing key to your training data.
        expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000) : null,
      })
      .returning();

    return reply.code(201).send({ grant: row });
  });

  /** Revoke an invite or an active grant. Takes effect on the next request. */
  app.delete<{ Params: { id: string; grantId: string } }>(
    '/athletes/:id/grants/:grantId',
    async (req) => {
      await requireOwner(req, req.params.id);
      const revoked = await db
        .update(coachAthleteGrant)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(
          and(
            eq(coachAthleteGrant.id, req.params.grantId),
            eq(coachAthleteGrant.athleteId, req.params.id),
          ),
        )
        .returning({ id: coachAthleteGrant.id });
      if (revoked.length === 0) throw new HttpError(404, 'no such grant');
      return { revoked: revoked.length };
    },
  );

  /** Redeem an invite code. The caller becomes a coach for that athlete. */
  app.post<{ Body: { code?: string } }>('/grants/accept', async (req) => {
    const actor = requireActor(req);
    const code = (req.body?.code ?? '').trim().toUpperCase();
    if (!code) throw new HttpError(422, 'an invite code is required');

    const [invite] = await db
      .select()
      .from(coachAthleteGrant)
      .where(eq(coachAthleteGrant.inviteCode, code))
      .limit(1);

    // One message for every failure mode: a wrong code, a used code and an
    // expired code must be indistinguishable, or this becomes an oracle.
    const unusable =
      !invite ||
      invite.status !== 'pending' ||
      (invite.expiresAt !== null && invite.expiresAt < new Date());
    if (unusable) throw new HttpError(404, 'that invite code is not valid');

    const [owner] = await db
      .select({ userId: athlete.userId, displayName: athlete.displayName })
      .from(athlete)
      .where(eq(athlete.id, invite.athleteId))
      .limit(1);
    if (owner?.userId === actor.userId) {
      throw new HttpError(409, 'that is your own athlete');
    }

    const [accepted] = await db
      .update(coachAthleteGrant)
      .set({ coachUserId: actor.userId, status: 'active', acceptedAt: new Date() })
      .where(eq(coachAthleteGrant.id, invite.id))
      .returning();

    return { grant: accepted, athlete: owner?.displayName ?? null };
  });

  /** Athletes this user coaches, for a coach's own view. */
  app.get('/coaching', async (req) => {
    const actor = requireActor(req);
    const rows = await db
      .select({
        athleteId: coachAthleteGrant.athleteId,
        displayName: athlete.displayName,
        scopes: coachAthleteGrant.scopes,
        since: coachAthleteGrant.acceptedAt,
      })
      .from(coachAthleteGrant)
      .innerJoin(athlete, eq(athlete.id, coachAthleteGrant.athleteId))
      .where(
        and(eq(coachAthleteGrant.coachUserId, actor.userId), eq(coachAthleteGrant.status, 'active')),
      );
    return { coaching: rows };
  });

  /** An athlete can see who they have shared with, from the reading side too. */
  app.get<{ Params: { id: string } }>('/athletes/:id/shared-with', async (req) => {
    await requireAthleteAccess(req, req.params.id);
    const rows = await db
      .select({ name: user.name, email: user.email, scopes: coachAthleteGrant.scopes })
      .from(coachAthleteGrant)
      .innerJoin(user, eq(user.id, coachAthleteGrant.coachUserId))
      .where(
        and(eq(coachAthleteGrant.athleteId, req.params.id), eq(coachAthleteGrant.status, 'active')),
      );
    return { coaches: rows };
  });
}
