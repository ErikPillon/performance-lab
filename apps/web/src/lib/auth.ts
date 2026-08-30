import { createAuthClient } from 'better-auth/react';

/**
 * Auth client.
 *
 * Same origin as the app — nginx proxies /api to the API service and Better
 * Auth is mounted under /api/auth — so the session cookie is first-party and
 * needs no cross-site exemption.
 */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
});

export const { signIn, signUp, signOut, useSession } = authClient;
