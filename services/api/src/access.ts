import { and, eq, or, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { athlete, coachAthleteGrant, db } from '@lab/db';
import { auth } from './auth.js';

/**
 * Authorisation.
 *
 * Every route that touches an athlete's data resolves access through this
 * module and nowhere else. The point of one choke point is that adding a route
 * cannot accidentally add a way around the rules — a new endpoint that forgets
 * to call `requireAthleteAccess` fails closed, because it has no athlete id to
 * work with until this hands one over.
 */

export type Scope = 'training' | 'wellness' | 'location';

export interface Actor {
  userId: string;
  email: string;
  name: string;
}

export interface AthleteAccess {
  athleteId: string;
  /** Owners hold every scope implicitly; coaches hold what was granted. */
  scopes: Scope[];
  relationship: 'owner' | 'coach';
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

/** Read the session cookie, if there is a valid one. */
export async function resolveActor(req: FastifyRequest): Promise<Actor | null> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }

  const result = await auth.api.getSession({ headers });
  if (!result?.user) return null;
  return { userId: result.user.id, email: result.user.email, name: result.user.name };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function requireActor(req: FastifyRequest): Actor {
  if (!req.actor) throw new HttpError(401, 'not signed in');
  return req.actor;
}

/**
 * Every athlete this user may read, with the scopes they hold on each.
 *
 * Ownership and coaching grants are unioned here rather than checked in two
 * places, so "which athletes can I see" has exactly one answer.
 */
export async function accessibleAthletes(userId: string): Promise<AthleteAccess[]> {
  const owned = await db
    .select({ athleteId: athlete.id })
    .from(athlete)
    .where(eq(athlete.userId, userId));

  const coached = await db
    .select({ athleteId: coachAthleteGrant.athleteId, scopes: coachAthleteGrant.scopes })
    .from(coachAthleteGrant)
    .where(
      and(
        eq(coachAthleteGrant.coachUserId, userId),
        eq(coachAthleteGrant.status, 'active'),
        or(
          sql`${coachAthleteGrant.expiresAt} IS NULL`,
          sql`${coachAthleteGrant.expiresAt} > now()`,
        ),
      ),
    );

  const byId = new Map<string, AthleteAccess>();
  for (const row of owned) {
    byId.set(row.athleteId, {
      athleteId: row.athleteId,
      scopes: ['training', 'wellness', 'location'],
      relationship: 'owner',
    });
  }
  for (const row of coached) {
    // Ownership already implies everything, so a grant never narrows it.
    if (byId.has(row.athleteId)) continue;
    byId.set(row.athleteId, {
      athleteId: row.athleteId,
      scopes: (row.scopes ?? ['training']) as Scope[],
      relationship: 'coach',
    });
  }
  return [...byId.values()];
}

/**
 * Access to one athlete, or a thrown error.
 *
 * Returns 404 rather than 403 for an athlete the caller cannot see: telling an
 * unauthorised caller that an id exists is itself a disclosure, and it turns
 * the endpoint into a way to enumerate athletes.
 */
export async function requireAthleteAccess(
  req: FastifyRequest,
  athleteId: string,
  scope: Scope = 'training',
): Promise<AthleteAccess> {
  const actor = requireActor(req);
  const all = await accessibleAthletes(actor.userId);
  const match = all.find((a) => a.athleteId === athleteId);
  if (!match) throw new HttpError(404, 'no such athlete');
  if (!match.scopes.includes(scope)) {
    throw new HttpError(403, `your access to this athlete does not include ${scope}`);
  }
  return match;
}

/** Access to the athlete owning an activity, resolved from the activity id. */
export async function requireActivityAccess(
  req: FastifyRequest,
  activityId: string,
  scope: Scope = 'training',
): Promise<{ access: AthleteAccess; athleteId: string }> {
  const { activity } = await import('@lab/db');
  const [row] = await db
    .select({ athleteId: activity.athleteId })
    .from(activity)
    .where(eq(activity.id, activityId))
    .limit(1);
  if (!row) throw new HttpError(404, 'no such activity');
  const access = await requireAthleteAccess(req, row.athleteId, scope);
  return { access, athleteId: row.athleteId };
}

/** Only the owner may change settings or trigger work. */
export async function requireOwner(req: FastifyRequest, athleteId: string): Promise<void> {
  const access = await requireAthleteAccess(req, athleteId);
  if (access.relationship !== 'owner') {
    throw new HttpError(403, 'only the athlete can change this');
  }
}

/** Turn a thrown HttpError into a response; anything else stays a 500. */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
  throw err;
}
