/** What one run of a connector's sync did, and whether it can continue. */
export interface SyncResult {
  status: 'ok' | 'no_connection' | 'rate_limited' | 'error';
  imported: number;
  skipped: number;
  failed: number;
  /** Set when the run stopped early and can be resumed. */
  resumeAfterMs?: number;
  /** The run stopped at its per-run cap with history still left to walk. */
  more?: boolean;
  message?: string;
}

/** When the provider gives no reset time, assume a quarter-hour quota window. */
const QUARTER_HOUR_MS = 15 * 60_000;

/**
 * How long until this sync job should run again, or `null` when it is done.
 *
 * Kept apart from the worker so the decision can be tested without Redis. Two
 * cases continue:
 *
 * - **Rate limited.** Wait out the window the provider reported, then resume from the
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
