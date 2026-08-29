import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

// max:5 — the worker runs a small fixed concurrency; no need for a large pool.
export const sql = postgres(url, { max: 5, onnotice: () => {} });
export const db = drizzle(sql, { schema });
export * from './schema.js';
export { schema };
