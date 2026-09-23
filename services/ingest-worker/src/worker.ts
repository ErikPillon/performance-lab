import { DelayedError, Worker, type Job } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { activity, athleteConnection, db, rawFile } from '@lab/db';
import { stravaConfig } from '@lab/ingest';
import { UnparseableError, parseBlob } from './analytics.js';
import { computeAndStore } from './load.js';
import { rebuildPmc } from './pmc.js';
import { recomputeAthlete } from './recomputeAll.js';
import {
  LOAD_QUEUE,
  PARSE_QUEUE,
  PMC_QUEUE,
  RECOMPUTE_QUEUE,
  connection,
  loadQueue,
  INTERVALS_SYNC_QUEUE,
  STRAVA_SYNC_QUEUE,
  type IntervalsQueueJob,
  type StravaQueueJob,
  requestIntervalsSync,
  requestPmcRebuild,
  requestStravaSync,
  scheduleIntervalsPoll,
  scheduleStravaPoll,
  type LoadJob,
  type ParseJob,
  type PmcJob,
  type RecomputeJob,
} from '@lab/jobs';
import { followUpDelayMs, type SyncResult } from './followUp.js';
import { syncIntervals } from './intervalsSync.js';
import { importStravaActivity, syncStrava } from './stravaSync.js';

/**
 * Decode one raw file into an activity row plus a Parquet stream object.
 *
 * The activity id is minted here rather than by the database so the Parquet
 * object can be written under its final name before the row exists. A crash
 * between the two leaves an orphaned object, which is harmless and cheap;
 * the reverse — a row pointing at a stream that was never written — is not.
 */
async function handle(job: { data: ParseJob }): Promise<string> {
  const { rawFileId, athleteId, blobKey, source } = job.data;

  await db
    .update(rawFile)
    .set({ status: 'parsing', attempts: sql`${rawFile.attempts} + 1` })
    .where(eq(rawFile.id, rawFileId));

  const activityId = randomUUID();
  let parsed;
  try {
    parsed = await parseBlob(blobKey, activityId);
  } catch (err) {
    if (err instanceof UnparseableError) {
      // Structurally valid but unusable. Record why and stop: replaying will
      // not change the outcome, and a poison job must not occupy the queue.
      await db
        .update(rawFile)
        .set({ status: 'skipped', error: err.message, parsedAt: new Date() })
        .where(eq(rawFile.id, rawFileId));
      return 'skipped';
    }
    await db
      .update(rawFile)
      .set({ status: 'failed', error: String(err).slice(0, 2_000) })
      .where(eq(rawFile.id, rawFileId));
    throw err; // transient: let BullMQ back off and retry
  }

  const s = parsed.summary;
  await db
    .insert(activity)
    .values({
      id: activityId,
      athleteId,
      rawFileId,
      source,
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
    })
    /**
     * Re-parsing after a parser improvement refreshes the row in place, and the
     * same session arriving from a second source merges onto it rather than
     * double-counting load.
     *
     * `setWhere` makes which file wins deterministic. The same ride exported
     * twice — once from the head unit, once from Garmin Connect — differs in
     * resolution: one file here carried 3,450 samples across 10 channels and
     * the other 13,664 across 17. Without this the last worker to finish won,
     * and with four running in parallel that is a coin toss. Now the richer
     * recording always wins regardless of order.
     *
     * `>=` rather than `>` so re-parsing the *same* file still refreshes it;
     * that is the path every recompute takes.
     */
    .onConflictDoUpdate({
      target: [activity.athleteId, activity.dedupeKey],
      setWhere: sql`excluded.sample_count >= ${activity.sampleCount}`,
      set: {
        // Provenance follows the data: without this the row kept pointing at
        // whichever file created it, while its samples came from another.
        rawFileId: sql`excluded.raw_file_id`,
        source: sql`excluded.source`,
        sport: sql`excluded.sport`,
        subSport: sql`excluded.sub_sport`,
        rawSport: sql`excluded.raw_sport`,
        durationS: sql`excluded.duration_s`,
        movingS: sql`excluded.moving_s`,
        distanceM: sql`excluded.distance_m`,
        elevGainM: sql`excluded.elev_gain_m`,
        avgHr: sql`excluded.avg_hr`,
        maxHr: sql`excluded.max_hr`,
        avgPowerW: sql`excluded.avg_power_w`,
        maxPowerW: sql`excluded.max_power_w`,
        avgCadence: sql`excluded.avg_cadence`,
        calories: sql`excluded.calories`,
        device: sql`excluded.device`,
        streamsKey: sql`excluded.streams_key`,
        sampleCount: sql`excluded.sample_count`,
        channels: sql`excluded.channels`,
        qualityFlags: sql`excluded.quality_flags`,
        parserVersion: sql`excluded.parser_version`,
      },
    });

  // Load is a separate job so a slow or failing load model cannot block
  // ingestion, and so it can be replayed independently when the model changes.
  //
  // Queued *before* the file is marked parsed: if this throws, the file stays
  // in `parsing` and the retry re-runs the whole step, rather than leaving an
  // activity that looks ingested but has no load job and never gets one.
  // (BullMQ rejects ':' in custom job ids.)
  await loadQueue().add('load', { activityId, athleteId }, { jobId: `load-${activityId}` });

  await db
    .update(rawFile)
    .set({ status: 'parsed', error: null, parsedAt: new Date() })
    .where(eq(rawFile.id, rawFileId));

  return 'parsed';
}

async function handleLoad(job: { data: LoadJob }): Promise<string> {
  const [row] = await db.select().from(activity).where(eq(activity.id, job.data.activityId)).limit(1);
  if (!row) return 'gone'; // activity merged or deleted since the job was queued

  const result = await computeAndStore(row);
  await requestPmcRebuild(job.data.athleteId);
  return result.load_method;
}

async function handlePmc(job: { data: PmcJob }): Promise<string> {
  const { days } = await rebuildPmc(job.data.athleteId);
  return `${days} days`;
}

/**
 * Full recompute, triggered from the dashboard after a threshold changes.
 *
 * Progress is written back to the job so the UI can show a phase and a count
 * rather than an indeterminate spinner — this takes seconds on a few hundred
 * activities but minutes on a few thousand.
 */
async function handleRecompute(job: {
  data: RecomputeJob;
  updateProgress: (p: object) => Promise<void>;
}): Promise<string> {
  const result = await recomputeAthlete(job.data.athleteId, {
    estimateThresholds: job.data.estimateThresholds,
    preference: job.data.preference,
    onProgress: (update) => {
      void job.updateProgress(update);
    },
  });
  return `${result.activities} activities, ${result.days} days, ${result.failed} failed`;
}


/**
 * Import from a linked Strava account, or fan the scheduled poll out to every
 * linked account.
 */
async function handleStravaSync(job: Job<StravaQueueJob>, token?: string): Promise<string> {
  if ('poll' in job.data) return pollLinked('strava', requestStravaSync);

  const { athleteId, stravaActivityId } = job.data;
  // A webhook names one activity; a manual or scheduled sync walks the history.
  const result = stravaActivityId
    ? await importStravaActivity(athleteId, stravaActivityId)
    : await syncStrava(athleteId);
  return finishOrContinue(job, token, result);
}

/** The same shape for intervals.icu, which has no webhooks to route. */
async function handleIntervalsSync(job: Job<IntervalsQueueJob>, token?: string): Promise<string> {
  if ('poll' in job.data) return pollLinked('intervals', requestIntervalsSync);
  return finishOrContinue(job, token, await syncIntervals(job.data.athleteId));
}

/**
 * A rate limit does not throw. Quotas reset on a fixed window, and BullMQ's
 * exponential backoff would either retry far too soon or far too late.
 * Instead the job moves itself back to delayed until the window the provider
 * reported, keeping its id — so "Sync now" in the meantime finds it waiting
 * rather than starting a second walk. A run that hit its per-run cap does the
 * same with no delay. The cursor makes each resumption pick up where the last
 * one stopped.
 */
async function finishOrContinue(job: Job, token: string | undefined, result: SyncResult): Promise<string> {
  const summary = `${result.status}: ${result.imported} imported, ${result.skipped} already had, ${result.failed} failed`;
  const delay = followUpDelayMs(result);
  if (delay !== null && token) {
    await job.log(`${summary}; resuming in ${Math.round(delay / 1000)}s`);
    await job.moveToDelayed(Date.now() + delay, token);
    throw new DelayedError();
  }
  return summary;
}

/**
 * Queue a sync for every account that can still sync. `error` is included on
 * purpose: it means the provider or the network failed last time, which the
 * next attempt is exactly what fixes. `needs_reauth` is not — only the athlete
 * can fix that.
 */
async function pollLinked(
  provider: 'strava' | 'intervals',
  request: (athleteId: string) => Promise<{ alreadyQueued: boolean }>,
): Promise<string> {
  const linked = await db
    .select({ athleteId: athleteConnection.athleteId })
    .from(athleteConnection)
    .where(and(
      eq(athleteConnection.provider, provider),
      inArray(athleteConnection.status, ['active', 'error']),
    ));
  let queued = 0;
  for (const { athleteId } of linked) {
    if (!(await request(athleteId)).alreadyQueued) queued++;
  }
  return `${linked.length} linked, ${queued} queued`;
}

export function startWorker() {
  // One connection, shared by all four workers.
  const conn = connection();
  // Concurrency 4: decoding is CPU-bound in the analytics service, so this is
  // sized to keep it busy without queueing requests inside it.
  const parse = new Worker<ParseJob>(PARSE_QUEUE, handle, { connection: conn, concurrency: 4 });
  const load = new Worker<LoadJob>(LOAD_QUEUE, handleLoad, { connection: conn, concurrency: 4 });
  // Concurrency 1: the rebuild deletes and rewrites the whole series, so two at
  // once for the same athlete would race.
  const pmc = new Worker<PmcJob>(PMC_QUEUE, handlePmc, { connection: conn, concurrency: 1 });
  // Concurrency 1 for the same reason as pmc, and because a recompute walks
  // every activity: two at once would double the load on the analytics service.
  // Concurrency 1: Strava's rate limit is per application, not per athlete,
  // so parallel syncs would race each other into it.
  const stravaSync = new Worker<StravaQueueJob>(STRAVA_SYNC_QUEUE, handleStravaSync, {
    connection: conn,
    concurrency: 1,
    // A first import walks years of history one page at a time.
    lockDuration: 30 * 60_000,
  });
  // Re-asserted at every start, so the schedule follows the configuration:
  // removing the Strava credentials stops the poll on the next restart.
  scheduleStravaPoll(stravaConfig() !== null).catch((err) =>
    console.error('[strava-sync] could not schedule the poll:', err.message),
  );

  // Concurrency 1 for the same reason: the personal-key quota is per key, and
  // one walker per athlete is already guaranteed by the job id.
  const intervalsSync = new Worker<IntervalsQueueJob>(INTERVALS_SYNC_QUEUE, handleIntervalsSync, {
    connection: conn,
    concurrency: 1,
    lockDuration: 30 * 60_000,
  });
  // Always on: with nobody linked, a poll is one indexed query and nothing else.
  scheduleIntervalsPoll(true).catch((err) =>
    console.error('[intervals-sync] could not schedule the poll:', err.message),
  );

  const recompute = new Worker<RecomputeJob>(RECOMPUTE_QUEUE, handleRecompute, {
    connection: conn,
    concurrency: 1,
    // A few thousand activities can take minutes; the default lock would expire
    // mid-run and the job would be picked up a second time.
    lockDuration: 15 * 60_000,
  });

  for (const [name, worker] of [
    ['parse', parse],
    ['load', load],
    ['pmc', pmc],
    ['recompute', recompute],
    ['strava-sync', stravaSync],
    ['intervals-sync', intervalsSync],
  ] as const) {
    worker.on('failed', (job, err) =>
      console.error(`[${name}] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message),
    );
    worker.on('error', (err) => console.error(`[${name}] worker error:`, err.message));
  }

  return {
    parse,
    load,
    pmc,
    recompute,
    stravaSync,
    intervalsSync,
    async close() {
      await Promise.all([
        parse.close(), load.close(), pmc.close(), recompute.close(),
        stravaSync.close(), intervalsSync.close(),
      ]);
    },
  };
}
