import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { count, eq, isNull } from 'drizzle-orm';
import { athlete, db, schema, user } from '@lab/db';
import { env } from './env.js';

/**
 * Authentication.
 *
 * Better Auth as a library rather than a hosted identity service, so sessions
 * live in the same Postgres as the training data. That is what lets a coach's
 * access to an athlete be a foreign key instead of a reconciliation against
 * some external system — and it means this runs on a home server with no
 * outbound dependency.
 *
 * Email and password only for now. Social sign-in is a configuration change
 * here plus a provider app; it is deliberately not a prerequisite for using
 * the thing on your own network.
 */
export const auth = betterAuth({
  appName: 'Performance Lab',
  secret: env.auth.secret,
  baseURL: env.auth.baseUrl,
  // The API is reached through the dashboard's own origin, so cookies are
  // first-party and no cross-site exemption is needed.
  basePath: '/auth',
  trustedOrigins: [env.auth.baseUrl, 'http://localhost:3100'],

  database: drizzleAdapter(db, { provider: 'pg', schema }),

  emailAndPassword: {
    enabled: true,
    // No mail server on a home box, so an unverified address is the norm.
    // Verification becomes worth enabling when this is reachable publicly.
    requireEmailVerification: false,
    minPasswordLength: 10,
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },

  advanced: {
    useSecureCookies: env.auth.secureCookies,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
    },
  },

  databaseHooks: {
    user: {
      create: {
        async before(data) {
          // Signup can be closed once the owner's account exists. Checked here
          // rather than only in the UI, because the endpoint is reachable
          // directly.
          if (!env.auth.allowSignup) {
            const [existing] = await db.select({ n: count() }).from(user);
            if ((existing?.n ?? 0) > 0) {
              throw new Error('Registration is closed on this server');
            }
          }
          return { data };
        },
        async after(created) {
          // Bootstrap: activities imported before authentication existed have
          // no owner. The first account to be created claims them, so the
          // person who set the server up does not have to reach for psql.
          // Only ever fires once — afterwards there is always a user.
          const [total] = await db.select({ n: count() }).from(user);
          if ((total?.n ?? 0) !== 1) return;
          const claimed = await db
            .update(athlete)
            .set({ userId: created.id })
            .where(isNull(athlete.userId))
            .returning({ id: athlete.id });
          if (claimed.length > 0) {
            console.log(`[auth] first account ${created.email} claimed ${claimed.length} athlete(s)`);
          }
        },
      },
    },
  },
});

export type AuthSession = typeof auth.$Infer.Session;

/** Whether any account exists yet, for the signup screen to offer bootstrap. */
export async function hasAnyUser(): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(user);
  return (row?.n ?? 0) > 0;
}

/** The athlete owned by a user, if any. */
export async function ownedAthlete(userId: string) {
  const [row] = await db
    .select({ id: athlete.id })
    .from(athlete)
    .where(eq(athlete.userId, userId))
    .limit(1);
  return row ?? null;
}
