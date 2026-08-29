function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  analyticsUrl: process.env.ANALYTICS_URL ?? 'http://localhost:8001',
  ingestUrl: process.env.INGEST_URL ?? 'http://localhost:8002',
  port: Number(process.env.API_PORT ?? 8003),
  /** Dev default is permissive; tighten to the real origin once auth lands. */
  corsOrigin: process.env.CORS_ORIGIN ?? true,
} as const;
