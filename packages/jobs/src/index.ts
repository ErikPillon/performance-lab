/**
 * Queue definitions, shared by every service that produces or consumes jobs.
 *
 * These live outside `ingest-worker` because the API enqueues work too — a
 * recompute triggered from the dashboard, for instance. Keeping one definition
 * of each queue's name, payload and retry policy means a producer and a
 * consumer cannot disagree about them.
 */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

// BullMQ requires this to be null: it blocks on brpoplpush and must not have
// commands retried out from under it.
export const connection = new IORedis(url, { maxRetriesPerRequest: null });

export const PARSE_QUEUE = 'parse';
export const LOAD_QUEUE = 'load';
export const PMC_QUEUE = 'pmc';
export const RECOMPUTE_QUEUE = 'recompute';

export interface ParseJob {
  rawFileId: string;
  athleteId: string;
  blobKey: string;
  source: 'upload' | 'strava' | 'garmin' | 'manual';
}

export interface LoadJob {
  activityId: string;
  athleteId: string;
}

export interface PmcJob {
  athleteId: string;
}

export interface RecomputeJob {
  athleteId: string;
  /** Re-derive thresholds from training history before scoring. */
  estimateThresholds?: boolean;
  preference?: 'consistency' | 'precision';
}

const standard = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: { count: 1_000 },
  // Keep failures around: they are the queue's error log.
  removeOnFail: { age: 7 * 24 * 3_600 },
};

export const parseQueue = new Queue<ParseJob>(PARSE_QUEUE, { connection, defaultJobOptions: standard });
export const loadQueue = new Queue<LoadJob>(LOAD_QUEUE, { connection, defaultJobOptions: standard });

export const pmcQueue = new Queue<PmcJob>(PMC_QUEUE, {
  connection,
  defaultJobOptions: { ...standard, removeOnComplete: { count: 50 } },
});

export const recomputeQueue = new Queue<RecomputeJob>(RECOMPUTE_QUEUE, {
  connection,
  defaultJobOptions: {
    // A full recompute is expensive and not idempotent-cheap; one retry only,
    // and failures stay visible rather than being silently re-run.
    attempts: 1,
    removeOnComplete: { count: 20 },
    removeOnFail: { age: 30 * 24 * 3_600 },
  },
});

/**
 * Queue a fitness-model rebuild, collapsing bursts into one run.
 *
 * A 252-file backfill would otherwise trigger 252 full rebuilds of the same
 * series. The athlete id is the job id and the delay is a debounce window, so
 * repeated requests during an import land on a single pending job.
 */
export async function requestPmcRebuild(athleteId: string, delayMs = 15_000) {
  await pmcQueue.remove(athleteId).catch(() => {});
  await pmcQueue.add('pmc', { athleteId }, { jobId: athleteId, delay: delayMs });
}

/** Queue a full recompute. Returns the existing job if one is already pending. */
export async function requestRecompute(job: RecomputeJob): Promise<string> {
  const id = `recompute-${job.athleteId}`;
  const existing = await recomputeQueue.getJob(id);
  if (existing) {
    const state = await existing.getState();
    if (state === 'waiting' || state === 'active' || state === 'delayed') return id;
    await existing.remove();
  }
  await recomputeQueue.add('recompute', job, { jobId: id });
  return id;
}
