import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auth, hasAnyUser } from '../auth.js';
import { accessibleAthletes, resolveActor } from '../access.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/** Fastify's parsed request as the Web Request Better Auth expects. */
function toWebRequest(req: FastifyRequest, baseUrl: string): Request {
  const url = new URL(req.url, baseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (req.rawBody ?? undefined) : undefined,
  });
}

export async function authRoutes(app: FastifyInstance) {
  /**
   * Keep the raw body alongside the parsed one.
   *
   * Better Auth wants a Web Request with an unconsumed body, but Fastify has
   * already read and parsed it by the time a handler runs. Re-serialising the
   * parsed object would work until it did not — key order, dates, precision —
   * so the original string is stashed instead. Registered globally because
   * content type parsers are global in Fastify; ordinary routes still receive
   * their parsed body exactly as before.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = body as string;
    (req as FastifyRequest).rawBody = text;
    if (!text) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Sign-in, sign-up, sign-out, session — all handled by the library.
  app.route({
    method: ['GET', 'POST'],
    url: '/auth/*',
    handler: async (req, reply) => {
      const response = await auth.handler(toWebRequest(req, req.headers.origin ?? 'http://localhost'));
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        // set-cookie may legitimately appear more than once.
        if (key.toLowerCase() === 'set-cookie') reply.header('set-cookie', value);
        else reply.header(key, value);
      });
      const text = await response.text();
      return reply.send(text || null);
    },
  });

  /**
   * Who the caller is and what they can see, in one call.
   *
   * The dashboard needs both on every load, and splitting them means a render
   * where the user is known but their athletes are not.
   */
  app.get('/me', async (req) => {
    const actor = await resolveActor(req);
    if (!actor) {
      // Not an error: the sign-in screen asks this before anyone has signed in.
      return { user: null, athletes: [], signupOpen: !(await hasAnyUser()) };
    }
    const athletes = await accessibleAthletes(actor.userId);
    return { user: actor, athletes, signupOpen: false };
  });
}
