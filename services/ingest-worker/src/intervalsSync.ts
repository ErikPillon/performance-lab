import { and, eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { athleteConnection, db, decryptToken } from '@lab/db';
import {
  IntervalsAuthError, RateLimited, downloadIntervalsFile, ingestBytes,
  listIntervalsActivities, planImports,
} from '@lab/ingest';
import type { SyncResult } from './followUp.js';

/**
 * Import new activities from intervals.icu.
 *
 * Unlike the Strava mirror there is no conversion here. Each activity's
 * original file is downloaded and handed to `ingestBytes` — the same entry
 * point as a browser upload — so it is hashed, stored, deduplicated against
 * anything already imported by hand, and parsed by the normal FIT path. A
 * session that arrives both ways is one raw file, not two.
 *
 * The cursor advances per activity, oldest first, so a run interrupted by a
 * rate limit or a restart resumes rather than restarting a multi-year import.
 */

/** Keeps one run short; the job continues itself when more remain. */
const MAX_FILES_PER_RUN = 100;

/** Where a first sync starts: everything intervals.icu holds. */
const BEGINNING = new Date('2000-01-01T00:00:00Z');

export async function syncIntervals(athleteId: string): Promise<SyncResult> {
  const [connection] = await db
    .select()
    .from(athleteConnection)
    .where(and(
      eq(athleteConnection.athleteId, athleteId),
      eq(athleteConnection.provider, 'intervals'),
    ))
    .limit(1);
  if (!connection?.accessToken || connection.status === 'disconnected' || connection.status === 'needs_reauth') {
    return { status: 'no_connection', imported: 0, skipped: 0, failed: 0 };
  }

  const apiKey = decryptToken(connection.accessToken);
  let cursor = connection.syncedThrough;
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let more = false;

  const record = (values: PgUpdateSetSource<typeof athleteConnection>) =>
    db.update(athleteConnection).set(values).where(eq(athleteConnection.id, connection.id));

  try {
    const plan = planImports(await listIntervalsActivities(apiKey, cursor ?? BEGINNING), cursor);
    skipped += plan.skipped;
    const batch = plan.toImport.slice(0, MAX_FILES_PER_RUN);
    more = plan.toImport.length > batch.length;

    for (const item of batch) {
      try {
        const bytes = await downloadIntervalsFile(apiKey, item.id, item.kind);
        const outcome = await ingestBytes({
          athleteId,
          bytes,
          filename: `intervals-${item.id}.fit`,
          source: 'intervals',
        });
        if (outcome.status === 'queued') imported++;
        else skipped++;
      } catch (err) {
        if (err instanceof RateLimited || err instanceof IntervalsAuthError) throw err;
        // One bad activity must not stop the walk; the cursor still moves past
        // it, as the Strava sync does, or it would block everything newer.
        failed++;
      }
      cursor = item.startedAt;
      await record({ syncedThrough: cursor });
    }
  } catch (err) {
    if (err instanceof RateLimited) {
      await record({ lastSyncAt: new Date(), lastError: err.message });
      return {
        status: 'rate_limited', imported, skipped, failed,
        resumeAfterMs: err.retryAfterMs, message: err.message,
      };
    }
    // A rejected key never fixes itself: stop polling it and say so, rather
    // than retrying a dead credential every ten minutes.
    const needsReauth = err instanceof IntervalsAuthError;
    const message = err instanceof Error ? err.message.slice(0, 500) : 'sync failed';
    await record({ status: needsReauth ? 'needs_reauth' : 'error', lastSyncAt: new Date(), lastError: message });
    return { status: 'error', imported, skipped, failed, message };
  }

  await record({
    // Clears an `error` left by an earlier outage, but never overwrites a
    // disconnect or a rejected key that landed while this run was going.
    status: sql`case when ${athleteConnection.status} = 'error'
      then 'active'::connection_status else ${athleteConnection.status} end`,
    lastSyncAt: new Date(),
    lastError: null,
    importedCount: sql`${athleteConnection.importedCount} + ${imported}`,
  });

  return { status: 'ok', imported, skipped, failed, more };
}
