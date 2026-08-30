/**
 * Backfill a directory of activity files.
 *
 *   npm run backfill -- ./inputs --athlete "Erik"
 *
 * Safe to re-run: ingestion is keyed on content hash, so files already present
 * are recognised as duplicates and skipped without re-reading or re-parsing.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { athlete, athleteThreshold, db, sql as pg } from '@lab/db';
import { ingestBytes } from './ingest.js';
import { closeQueues, parseQueue } from '@lab/jobs';

const SUPPORTED = new Set(['.fit']);

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function resolveAthlete(name: string): Promise<string> {
  const [existing] = await db
    .select({ id: athlete.id })
    .from(athlete)
    .where(eq(athlete.displayName, name))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(athlete)
    .values({ displayName: name })
    .returning({ id: athlete.id });
  console.log(`created athlete "${name}" (${created!.id})`);
  return created!.id;
}

/** Bounded parallelism: enough to keep the queue fed, not enough to exhaust the pool. */
async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(runners);
}

// npm runs workspace scripts with cwd set to the package directory, so a
// relative path typed at the repo root would resolve to the wrong place.
// INIT_CWD is where the user actually invoked the command.
const base = process.env.INIT_CWD ?? process.cwd();
const dir = resolve(base, arg('--dir') ?? process.argv[2] ?? 'inputs');
const athleteName = arg('--athlete') ?? 'Default Athlete';

if (!(await stat(dir).catch(() => null))?.isDirectory()) {
  console.error(`not a directory: ${dir}`);
  process.exit(1);
}

const files = (await readdir(dir))
  .filter((f) => SUPPORTED.has(extname(f).toLowerCase()))
  .sort();

if (files.length === 0) {
  console.error(`no supported files in ${dir} (looking for ${[...SUPPORTED].join(', ')})`);
  process.exit(1);
}

const athleteId = await resolveAthlete(athleteName);
console.log(`backfilling ${files.length} files from ${dir} for athlete ${athleteId}\n`);

const started = Date.now();
let queued = 0;
let duplicate = 0;
let failed = 0;

await pooled(files, 8, async (file) => {
  try {
    const bytes = await readFile(join(dir, file));
    const result = await ingestBytes({
      athleteId,
      bytes,
      filename: basename(file),
      source: 'upload',
    });
    if (result.status === 'queued') queued++;
    else duplicate++;
  } catch (err) {
    failed++;
    console.error(`  ! ${file}: ${err instanceof Error ? err.message : err}`);
  }
  const done = queued + duplicate + failed;
  if (done % 25 === 0 || done === files.length) {
    process.stdout.write(`  ${done}/${files.length} queued=${queued} dup=${duplicate} err=${failed}\n`);
  }
});

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nenqueued in ${elapsed}s: ${queued} new, ${duplicate} already present, ${failed} errors`);
console.log('queue:', await parseQueue().getJobCounts());
console.log('\nthe parse worker drains this in the background; watch it with:');
console.log('  curl -s localhost:8002/ingest/status | jq');

const [threshold] = await db
  .select({ id: athleteThreshold.id })
  .from(athleteThreshold)
  .where(eq(athleteThreshold.athleteId, athleteId))
  .limit(1);
if (!threshold) {
  console.log('\nno thresholds on file yet, so nothing can be scored. once parsing');
  console.log('finishes, estimate them from this history and build the fitness model:');
  console.log(`  npm run recompute -- --athlete "${athleteName}"`);
}

await closeQueues();
await pg.end();
