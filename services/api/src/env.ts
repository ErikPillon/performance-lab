function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  analyticsUrl: process.env.ANALYTICS_URL ?? 'http://localhost:8001',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  ingestUrl: process.env.INGEST_URL ?? 'http://localhost:8002',
  port: Number(process.env.API_PORT ?? 8003),
  /**
   * Credentialed requests cannot use a wildcard origin, so once cookies are in
   * play this must name the real origin. Defaults to the dev app.
   */
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3100',
  auth: {
    secret: required('BETTER_AUTH_SECRET'),
    baseUrl: process.env.AUTH_BASE_URL ?? 'http://localhost:3100',
    allowSignup: (process.env.AUTH_ALLOW_SIGNUP ?? 'true') === 'true',
    /**
     * Secure cookies require HTTPS. Off by default so local HTTP works, and
     * derived from the base URL so a real deployment turns it on by itself.
     */
    secureCookies: (process.env.AUTH_BASE_URL ?? '').startsWith('https://'),
  },
} as const;
