import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from './env.js';

// BullMQ requires this to be null: it blocks on brpoplpush and must not have
// commands retried out from under it.
export const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

export const PARSE_QUEUE = 'parse';
export const LOAD_QUEUE = 'load';
export const PMC_QUEUE = 'pmc';

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

export const parseQueue = new Queue<ParseJob>(PARSE_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { count: 1_000 },
    // Keep failures around: they are the queue's error log.
    removeOnFail: { age: 7 * 24 * 3_600 },
  },
});

export const loadQueue = new Queue<LoadJob>(LOAD_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { age: 7 * 24 * 3_600 },
  },
});

export const pmcQueue = new Queue<PmcJob>(PMC_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { age: 7 * 24 * 3_600 },
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
