import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { activity, athleteConnection, db, rawFile } from '@lab/db';
import {
  RateLimited, freshStravaToken, getActivity, getStreams, listActivities,
  putRaw, rawKey, sha256,
} from '@lab/ingest';
import { requestPmcRebuild } from '@lab/jobs';
import { parseStravaActivity, UnparseableError } from './analytics.js';
import { loadQueue } from '@lab/jobs';

/**
 * Import an athlete's Strava activities.
 *
 * Resumable by construction. Strava is asked for activities *after* a cursor,
 * oldest first, and the cursor advances as each one lands — so a run
 * interrupted by a rate limit, a restart or a network blip resumes where it
 * stopped rather than replaying a multi-year history.
 *
 * The raw JSON is stored the same way an uploaded FIT is: content-addressed in
 * object storage, indexed by `raw_file`. That is not ceremony. It keeps the
 * property the whole system is built on — everything downstream is derived and
 * rebuildable from bytes that were actually received — and it means a later
 * improvement to the converter can be replayed without asking Strava again.
 */

/** Strava's own page size cap for this endpoint. */
const PAGE = 50;

/** Stop well short of the 15-minute quota so an interactive sync stays polite. */
const MAX_ACTIVITIES_PER_RUN = 200;

export interface SyncResult {
  status: 'ok' | 'no_connection' | 'rate_limited' | 'error';
  imported: number;
  skipped: number;
  failed: number;
  /** Set when the run stopped early and can be resumed. */
  resumeAfterMs?: number;
  message?: string;
}

export async function syncStrava(athleteId: string): Promise<SyncResult> {
  const token = await freshStravaToken(athleteId);
  if (!token) {
    return { status: 'no_connection', imported: 0, skipped: 0, failed: 0 };
  }

  const [connection] = await db
    .select()
    .from(athleteConnection)
    .where(and(
      eq(athleteConnection.athleteId, athleteId),
      eq(athleteConnection.provider, 'strava'),
    ))
    .limit(1);
  if (!connection) return { status: 'no_connection', imported: 0, skipped: 0, failed: 0 };

  let cursor = connection.syncedThrough;
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  try {
    while (imported + skipped + failed < MAX_ACTIVITIES_PER_RUN) {
      const page = await listActivities(token, cursor, PAGE);
      if (page.length === 0) break;

      for (const summary of page) {
        const startedAt = new Date(summary.start_date);
        try {
          const outcome = await importOne(athleteId, token, summary.id);
          if (outcome === 'imported') imported++;
          else skipped++;
        } catch (err) {
          if (err instanceof RateLimited) throw err;
          failed++;
          // One bad activity must not stop the walk. The cursor still advances
          // past it, because retrying it forever would block everything newer.
        }
        // Advanced per activity, not per page: an interruption mid-page keeps
        // what it already did.
        cursor = startedAt;
        await db
          .update(athleteConnection)
          .set({ syncedThrough: cursor })
          .where(eq(athleteConnection.id, connection.id));
      }

      if (page.length < PAGE) break;
    }
  } catch (err) {
    if (err instanceof RateLimited) {
      await db
        .update(athleteConnection)
        .set({ lastSyncAt: new Date(), lastError: err.message })
        .where(eq(athleteConnection.id, connection.id));
      return {
        status: 'rate_limited',
        imported, skipped, failed,
        resumeAfterMs: err.retryAfterMs,
        message: err.message,
      };
    }
    await db
      .update(athleteConnection)
      .set({
        status: 'error',
        lastSyncAt: new Date(),
        lastError: err instanceof Error ? err.message.slice(0, 500) : 'sync failed',
      })
      .where(eq(athleteConnection.id, connection.id));
    return {
      status: 'error', imported, skipped, failed,
      message: err instanceof Error ? err.message : 'sync failed',
    };
  }

  await db
    .update(athleteConnection)
    .set({
      lastSyncAt: new Date(),
      lastError: null,
      importedCount: sql`${athleteConnection.importedCount} + ${imported}`,
    })
    .where(eq(athleteConnection.id, connection.id));

  // One rebuild for the whole batch, debounced, rather than one per activity.
  if (imported > 0) await requestPmcRebuild(athleteId);

  return { status: 'ok', imported, skipped, failed };
}

/** Fetch, store and convert one activity. Returns whether it was new. */
export async function importOne(
  athleteId: string,
  token: string,
  stravaId: number,
): Promise<'imported' | 'skipped'> {
  const detail = await getActivity(token, stravaId);

  // A manually entered activity has no samples, and asking for them returns a
  // 404 that is not worth treating as a failure.
  let streams: Record<string, unknown> | null = null;
  if (!detail.manual) {
    streams = await getStreams(token, stravaId).catch(() => null);
  }

  // The payload as received, content-addressed. Re-running a sync over
  // activities already imported is then a hash lookup rather than a re-import.
  const bytes = Buffer.from(JSON.stringify({ activity: detail, streams }), 'utf8');
  const hash = sha256(bytes);

  const [existing] = await db
    .select({ id: rawFile.id })
    .from(rawFile)
    .where(and(eq(rawFile.athleteId, athleteId), eq(rawFile.sha256, hash)))
    .limit(1);
  if (existing) return 'skipped';

  const key = rawKey(hash, 'json');
  await putRaw(key, bytes, 'application/json');

  const [raw] = await db
    .insert(rawFile)
    .values({
      athleteId,
      sha256: hash,
      source: 'strava',
      originalFilename: `strava-${stravaId}.json`,
      contentType: 'application/json',
      byteSize: bytes.byteLength,
      blobKey: key,
      status: 'parsing',
    })
    .onConflictDoNothing({ target: [rawFile.athleteId, rawFile.sha256] })
    .returning({ id: rawFile.id });

  // Lost a race with a concurrent sync of the same activity.
  if (!raw) return 'skipped';

  const activityId = randomUUID();
  let parsed;
  try {
    parsed = await parseStravaActivity(detail, streams, activityId);
  } catch (err) {
    await db
      .update(rawFile)
      .set({
        status: err instanceof UnparseableError ? 'skipped' : 'failed',
        error: err instanceof Error ? err.message.slice(0, 2_000) : 'parse failed',
        parsedAt: new Date(),
      })
      .where(eq(rawFile.id, raw.id));
    if (err instanceof UnparseableError) return 'skipped';
    throw err;
  }

  const s = parsed.summary;
  const values = {
    id: activityId,
    athleteId,
    rawFileId: raw.id,
    source: 'strava' as const,
    sourceId: String(stravaId),
    dedupeKey: parsed.dedupe_key,
    sport: s.sport as typeof activity.$inferInsert.sport,
    subSport: s.sub_sport,
    rawSport: s.raw_sport,
    startTime: new Date(s.start_time),
    tzOffsetMin: s.tz_offset_min,
    durationS: s.duration_s,
    movingS: s.moving_s,
    distanceM: s.distance_m,
    elevGainM: s.elev_gain_m,
    avgHr: s.avg_hr,
    maxHr: s.max_hr,
    avgPowerW: s.avg_power_w,
    maxPowerW: s.max_power_w,
    avgCadence: s.avg_cadence,
    calories: s.calories,
    device: s.device,
    streamsKey: parsed.streams_key,
    sampleCount: s.sample_count,
    channels: s.channels,
    qualityFlags: s.quality_flags,
    parserVersion: s.parser_version,
  };

  /**
   * The same guard the FIT path uses, and the reason Strava can be a mirror
   * without double-counting: a session that already arrived as an uploaded FIT
   * shares this dedupe key, and `setWhere` keeps whichever recording is richer.
   *
   * That ordering matters here specifically. Strava's streams are derived and
   * smoothed; a FIT of the same session almost always carries more samples and
   * more channels, so the FIT wins on merit rather than on arrival order.
   */
  const [row] = await db
    .insert(activity)
    .values(values)
    .onConflictDoUpdate({
      target: [activity.athleteId, activity.dedupeKey],
      setWhere: sql`excluded.sample_count >= ${activity.sampleCount}`,
      set: values,
    })
    .returning({ id: activity.id });

  await db
    .update(rawFile)
    .set({ status: 'parsed', parsedAt: new Date(), error: null })
    .where(eq(rawFile.id, raw.id));

  // Scoring happens on the load queue, as it does for an uploaded file.
  if (row) {
    await loadQueue().add('load', { activityId: row.id, athleteId }, { jobId: `load-${row.id}` });
  }
  return 'imported';
}

/**
 * Import one activity named by a webhook.
 *
 * Separate from `syncStrava` because the shapes differ: a webhook already knows
 * which activity changed, so there is nothing to paginate and no cursor to
 * advance. The cursor belongs to the polling walk, and moving it here would
 * make a single out-of-order delivery skip everything between.
 */
export async function importStravaActivity(
  athleteId: string,
  stravaActivityId: number,
): Promise<SyncResult> {
  const token = await freshStravaToken(athleteId);
  if (!token) return { status: 'no_connection', imported: 0, skipped: 0, failed: 0 };

  try {
    const outcome = await importOne(athleteId, token, stravaActivityId);
    if (outcome === 'imported') {
      await db
        .update(athleteConnection)
        .set({
          lastSyncAt: new Date(),
          lastError: null,
          importedCount: sql`${athleteConnection.importedCount} + 1`,
        })
        .where(and(
          eq(athleteConnection.athleteId, athleteId),
          eq(athleteConnection.provider, 'strava'),
        ));
      await requestPmcRebuild(athleteId);
      return { status: 'ok', imported: 1, skipped: 0, failed: 0 };
    }
    return { status: 'ok', imported: 0, skipped: 1, failed: 0 };
  } catch (err) {
    if (err instanceof RateLimited) {
      return {
        status: 'rate_limited', imported: 0, skipped: 0, failed: 0,
        resumeAfterMs: err.retryAfterMs, message: err.message,
      };
    }
    return {
      status: 'error', imported: 0, skipped: 0, failed: 1,
      message: err instanceof Error ? err.message : 'import failed',
    };
  }
}
