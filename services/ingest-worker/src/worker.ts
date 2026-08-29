import { Worker } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { activity, db, rawFile } from '@lab/db';
import { UnparseableError, parseBlob } from './analytics.js';
import { computeAndStore } from './load.js';
import { rebuildPmc } from './pmc.js';
import {
  LOAD_QUEUE,
  PARSE_QUEUE,
  PMC_QUEUE,
  connection,
  loadQueue,
  requestPmcRebuild,
  type LoadJob,
  type ParseJob,
  type PmcJob,
} from './queue.js';

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
    // Re-parsing after a parser improvement should refresh the row in place,
    // and the same session arriving from a second source should merge onto it,
    // so the natural key wins over the surrogate id.
    .onConflictDoUpdate({
      target: [activity.athleteId, activity.dedupeKey],
      set: {
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
  await loadQueue.add('load', { activityId, athleteId }, { jobId: `load-${activityId}` });

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

export function startWorker() {
  // Concurrency 4: decoding is CPU-bound in the analytics service, so this is
  // sized to keep it busy without queueing requests inside it.
  const parse = new Worker<ParseJob>(PARSE_QUEUE, handle, { connection, concurrency: 4 });
  const load = new Worker<LoadJob>(LOAD_QUEUE, handleLoad, { connection, concurrency: 4 });
  // Concurrency 1: the rebuild deletes and rewrites the whole series, so two at
  // once for the same athlete would race.
  const pmc = new Worker<PmcJob>(PMC_QUEUE, handlePmc, { connection, concurrency: 1 });

  for (const [name, worker] of [['parse', parse], ['load', load], ['pmc', pmc]] as const) {
    worker.on('failed', (job, err) =>
      console.error(`[${name}] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message),
    );
    worker.on('error', (err) => console.error(`[${name}] worker error:`, err.message));
  }

  return { parse, load, pmc, async close() { await Promise.all([parse.close(), load.close(), pmc.close()]); } };
}
