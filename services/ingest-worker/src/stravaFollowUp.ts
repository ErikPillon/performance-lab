import type { SyncResult } from './stravaSync.js';

/** When Strava gives no reset time, its quota window is a quarter hour. */
const QUARTER_HOUR_MS = 15 * 60_000;

/**
 * How long until this sync job should run again, or `null` when it is done.
 *
 * Kept apart from the worker so the decision can be tested without Redis. Two
 * cases continue:
 *
 * - **Rate limited.** Wait out the window Strava reported, then resume from the
 *   cursor. Before this the run stopped and recorded where, and nothing ever
 *   came back for it: a multi-year first import needed someone to press the
 *   button every quarter hour for days.
 * - **Capped with history left.** Carry straight on. The per-run cap keeps one
 *   run short; it was never meant to end the import.
 */
export function followUpDelayMs(result: SyncResult): number | null {
  if (result.status === 'rate_limited') return result.resumeAfterMs ?? QUARTER_HOUR_MS;
  if (result.status === 'ok' && result.more) return 0;
  return null;
}
