import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const client = postgres(url, { max: 1 });

await migrate(drizzle(client), { migrationsFolder });
await client.end();
console.log('migrations applied');
