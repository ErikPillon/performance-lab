/**
 * Queue definitions, shared by every service that produces or consumes jobs.
 *
 * These live outside `ingest-worker` because the API enqueues work too — a
 * recompute triggered from the dashboard, for instance. Keeping one definition
 * of each queue's name, payload and retry policy means a producer and a
 * consumer cannot disagree about them.
 *
 * Everything that touches Redis is behind a function call. Importing this
 * module opens no sockets, which is not a style preference: the queues used to
 * be constructed at module load, so `import '@lab/jobs'` connected, and any
 * test that transitively reached it hung until the process was killed. The
 * API's validation rules had to be split into a separate module purely to
 * escape that. A connection is a side effect and side effects should be
 * something a caller asks for.
 */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const PARSE_QUEUE = 'parse';
export const LOAD_QUEUE = 'load';
export const PMC_QUEUE = 'pmc';
export const RECOMPUTE_QUEUE = 'recompute';
export const STRAVA_SYNC_QUEUE = 'strava-sync';
export const INTERVALS_SYNC_QUEUE = 'intervals-sync';
export const COVERAGE_QUEUE = 'coverage';

export interface ParseJob {
  rawFileId: string;
  athleteId: string;
  blobKey: string;
  source: 'upload' | 'strava' | 'garmin' | 'manual' | 'intervals';
}

export interface LoadJob {
  activityId: string;
  athleteId: string;
}

export interface PmcJob {
  athleteId: string;
}

export interface StravaSyncJob {
  athleteId: string;
  /**
   * One specific Strava activity, from a webhook.
   *
   * Absent means "walk the history from the cursor". A webhook names the exact
   * activity, and re-walking a paginated history to find a single new session
   * would burn the rate limit for nothing.
   */
  stravaActivityId?: number;
}

/** Walk one athlete's intervals.icu history forward from the cursor. */
export interface IntervalsSyncJob {
  athleteId: string;
}

/**
 * Enqueue a sync for every account linked to a provider.
 *
 * Polling is what makes a mirror eventually correct: webhooks can be missed,
 * replayed or never subscribed at all (a server the provider cannot reach),
 * and without this a linked account only moved when someone pressed a button.
 */
export interface PollJob {
  poll: true;
}

export type StravaQueueJob = StravaSyncJob | PollJob;
export type IntervalsQueueJob = IntervalsSyncJob | PollJob;

/** Rediscover an athlete's areas and recompute their street coverage. */
export interface CoverageJob {
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

let redis: IORedis | undefined;
const queues = new Map<string, Queue>();

/**
 * The shared Redis connection, opened on first call.
 *
 * Read REDIS_URL here rather than at module load so a test or a script can set
 * it after importing, and so an unset value fails at the point of use with a
 * usable stack rather than during someone else's import.
 */
export function connection(): IORedis {
  if (!redis) {
    // BullMQ requires this to be null: it blocks on brpoplpush and must not
    // have commands retried out from under it.
    redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
  }
  return redis;
}

function queue<T>(name: string, defaultJobOptions: object): Queue<T> {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: connection(), defaultJobOptions });
    queues.set(name, q);
  }
  return q as Queue<T>;
}

export const parseQueue = () => queue<ParseJob>(PARSE_QUEUE, standard);
export const loadQueue = () => queue<LoadJob>(LOAD_QUEUE, standard);

export const pmcQueue = () =>
  queue<PmcJob>(PMC_QUEUE, { ...standard, removeOnComplete: { count: 50 } });

/**
 * One sync per athlete at a time. The job id is the athlete, so a second
 * request while one is running collapses onto it rather than sending two
 * walkers through the same paginated history.
 */
const syncOptions = {
  attempts: 1,
  removeOnComplete: { count: 20 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

export const stravaSyncQueue = () => queue<StravaQueueJob>(STRAVA_SYNC_QUEUE, syncOptions);

/** Same shape and the same one-walker-per-athlete rule as Strava. */
export const intervalsSyncQueue = () => queue<IntervalsQueueJob>(INTERVALS_SYNC_QUEUE, syncOptions);

/** Long and polite: the first run of an area waits on OpenStreetMap. */
export const coverageQueue = () =>
  queue<CoverageJob>(COVERAGE_QUEUE, {
    attempts: 1,
    removeOnComplete: { count: 20 },
    removeOnFail: { age: 7 * 24 * 3_600 },
  });

export const recomputeQueue = () =>
  queue<RecomputeJob>(RECOMPUTE_QUEUE, {
    // A full recompute is expensive and not idempotent-cheap; one retry only,
    // and failures stay visible rather than being silently re-run.
    attempts: 1,
    removeOnComplete: { count: 20 },
    removeOnFail: { age: 30 * 24 * 3_600 },
  });

/**
 * Close whatever was opened. Safe to call when nothing ever connected, which
 * is what lets a caller shut down unconditionally without knowing whether the
 * request it served happened to touch a queue.
 */
export async function closeQueues(): Promise<void> {
  const opened = [...queues.values()];
  queues.clear();
  const client = redis;
  redis = undefined;

  // A clean QUIT needs a server to answer it. When Redis is already gone —
  // the container stopped, the network dropped — both of these wait for a
  // reply that is never coming, and a process handling SIGTERM hangs until
  // something kills it harder. Bound the graceful path, then drop the socket.
  await withTimeout(Promise.all(opened.map((q) => q.close())), 2_000);
  if (client) {
    await withTimeout(client.quit(), 2_000);
    client.disconnect();
  }
}

async function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        // Do not hold the event loop open purely to wait for this.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Whether anything has actually opened a connection. Exported for tests. */
export function isConnected(): boolean {
  return redis !== undefined;
}

/**
 * Queue a fitness-model rebuild, collapsing bursts into one run.
 *
 * A 252-file backfill would otherwise trigger 252 full rebuilds of the same
 * series. The athlete id is the job id and the delay is a debounce window, so
 * repeated requests during an import land on a single pending job.
 */
export async function requestPmcRebuild(athleteId: string, delayMs = 15_000) {
  const q = pmcQueue();
  await q.remove(athleteId).catch(() => {});
  await q.add('pmc', { athleteId }, { jobId: athleteId, delay: delayMs });
}

/**
 * Queue a history sync for one athlete, unless one is already queued, running,
 * or waiting out a rate limit — all three are the same walk, and a second one
 * would only race it into the quota. Used by the API's "Sync now" and by the
 * scheduled poll, so a press during a poll collapses onto it and vice versa.
 */
async function requestSync(
  q: Queue<StravaQueueJob> | Queue<IntervalsQueueJob>,
  name: string,
  athleteId: string,
): Promise<{ jobId: string; alreadyQueued: boolean }> {
  const jobId = `${name}-${athleteId}`;
  const existing = await q.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'waiting' || state === 'active' || state === 'delayed') {
      return { jobId, alreadyQueued: true };
    }
    await existing.remove();
  }
  await (q as Queue<{ athleteId: string }>).add(`${name}-sync`, { athleteId }, { jobId });
  return { jobId, alreadyQueued: false };
}

export const requestStravaSync = (athleteId: string) =>
  requestSync(stravaSyncQueue(), 'strava', athleteId);

export const requestIntervalsSync = (athleteId: string) =>
  requestSync(intervalsSyncQueue(), 'intervals', athleteId);

/** How often every linked Strava account is re-walked from its cursor. */
export const STRAVA_POLL_EVERY_MS = 6 * 3_600_000;

/**
 * How often intervals.icu is asked for anything new. Much tighter than Strava:
 * the personal-key quota is 5,000 requests a day and a poll with nothing new
 * costs one, and without webhooks this interval *is* the import latency.
 */
export const INTERVALS_POLL_EVERY_MS = 10 * 60_000;

/**
 * Turn a recurring poll on or off. Idempotent: it runs at every worker start,
 * and an upsert replaces the previous definition rather than stacking another.
 */
async function schedulePoll(
  q: Queue<StravaQueueJob> | Queue<IntervalsQueueJob>,
  id: string,
  every: number,
  enabled: boolean,
): Promise<void> {
  const target = q as Queue<PollJob>;
  if (!enabled) {
    await target.removeJobScheduler(id);
    return;
  }
  await target.upsertJobScheduler(id, { every }, { name: id, data: { poll: true } });
}

/** Off when Strava is not configured, so clearing the credentials stops it too. */
export const scheduleStravaPoll = (enabled: boolean) =>
  schedulePoll(stravaSyncQueue(), 'strava-poll', STRAVA_POLL_EVERY_MS, enabled);

export const scheduleIntervalsPoll = (enabled: boolean) =>
  schedulePoll(intervalsSyncQueue(), 'intervals-poll', INTERVALS_POLL_EVERY_MS, enabled);

/** Queue a full recompute. Returns the existing job if one is already pending. */
export async function requestRecompute(job: RecomputeJob): Promise<string> {
  const q = recomputeQueue();
  const id = `recompute-${job.athleteId}`;
  const existing = await q.getJob(id);
  if (existing) {
    const state = await existing.getState();
    if (state === 'waiting' || state === 'active' || state === 'delayed') return id;
    await existing.remove();
  }
  await q.add('recompute', job, { jobId: id });
  return id;
}

export const coverageJobId = (athleteId: string) => `coverage-${athleteId}`;

/**
 * Queue a coverage refresh, collapsing bursts into one run.
 *
 * The same debounce as the fitness model: an import of a season's files, or a
 * morning's sync, lands on a single pending job ten minutes after the last
 * activity rather than recomputing every commune once per file. A refresh
 * already running is left alone; the next activity schedules the next one.
 */
export async function requestCoverageRefresh(athleteId: string, delayMs = 10 * 60_000) {
  const q = coverageQueue();
  const id = coverageJobId(athleteId);
  const existing = await q.getJob(id);
  if (existing) {
    const state = await existing.getState();
    if (state === 'active') return;
    await existing.remove().catch(() => {});
  }
  await q.add('coverage', { athleteId }, { jobId: id, delay: delayMs });
}
