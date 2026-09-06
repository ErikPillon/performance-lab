import { weekStart } from './weeks';
import type { PmcDay } from './api';

/**
 * Planned against actual, week by week.
 *
 * A block with a name and dates is a label. A block with a weekly load target
 * is a plan, and this is what turns it into a comparison.
 */

export interface Block {
  id: string;
  name: string;
  focus: string;
  startDate: string;
  endDate: string;
  targetWeeklyLoad: number | null;
}

export interface PlannedWeek {
  start: string;
  planned: number | null;
  actual: number;
  /** actual / planned, or null when the block set no target. */
  ratio: number | null;
  /**
   * `complete` — a whole week, entirely inside the block, entirely in the past.
   * Only these are scored.
   * `partial` — clipped by the block's own start or end, or still running.
   * `future` — has not started. Shown as a plan, never as a shortfall.
   */
  state: 'complete' | 'partial' | 'future';
}

export interface BlockProgress {
  block: Block;
  weeks: PlannedWeek[];
  plannedTotal: number | null;
  actualTotal: number;
  /** Over complete weeks only; a week still in progress would drag it down. */
  compliance: number | null;
  status: 'upcoming' | 'active' | 'done';
}

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Weekly actual load inside a block, against its target.
 *
 * Partial weeks — the block starting on a Wednesday — are reported but excluded
 * from compliance. A block beginning mid-week would otherwise open with a 40%
 * score for a week it was only present for three days of, which reads as
 * failure rather than as arithmetic.
 */
export function blockProgress(
  block: Block,
  daily: Pick<PmcDay, 'date' | 'load'>[],
  today = new Date(),
): BlockProgress {
  const start = Date.parse(`${block.startDate}T00:00:00Z`);
  const end = Date.parse(`${block.endDate}T00:00:00Z`);
  const now = Date.parse(`${iso(today)}T00:00:00Z`);

  const loadByDate = new Map(daily.map((d) => [d.date, d.load ?? 0]));
  const weeks: PlannedWeek[] = [];

  for (let cursor = weekStart(new Date(start)).getTime(); cursor <= end; cursor += 7 * DAY) {
    let actual = 0;
    let daysInBlock = 0;
    for (let i = 0; i < 7; i++) {
      const day = cursor + i * DAY;
      if (day < start || day > end) continue;
      daysInBlock++;
      actual += loadByDate.get(iso(new Date(day))) ?? 0;
    }
    // A week can only be judged once it is over: a Wednesday reading of a
    // seven-day target is not a shortfall. And a week that has not begun is
    // not a shortfall either — reporting it as 0% made an upcoming block look
    // like a season already failed.
    const finished = cursor + 6 * DAY <= now;
    const started = cursor <= now;
    weeks.push({
      start: iso(new Date(cursor)),
      planned: block.targetWeeklyLoad,
      actual,
      ratio: block.targetWeeklyLoad ? actual / block.targetWeeklyLoad : null,
      state: !started ? 'future' : daysInBlock === 7 && finished ? 'complete' : 'partial',
    });
  }

  const judged = weeks.filter((w) => w.state === 'complete');
  const plannedTotal = block.targetWeeklyLoad != null ? block.targetWeeklyLoad * weeks.length : null;
  const plannedJudged = block.targetWeeklyLoad != null ? block.targetWeeklyLoad * judged.length : 0;

  return {
    block,
    weeks,
    plannedTotal,
    actualTotal: weeks.reduce((sum, w) => sum + w.actual, 0),
    compliance:
      plannedJudged > 0 ? judged.reduce((sum, w) => sum + w.actual, 0) / plannedJudged : null,
    status: now < start ? 'upcoming' : now > end ? 'done' : 'active',
  };
}

/** Days until a race, negative once it has been run. */
export function daysUntil(date: string, today = new Date()): number {
  return Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${iso(today)}T00:00:00Z`)) / DAY,
  );
}

/**
 * Where an athlete is in their season, in one sentence's worth of facts.
 *
 * Only A races count as "the next race": the whole point of priorities is that
 * a C race is a training day, and counting down to one would bury the race the
 * season is actually built around.
 */
export function nextRace<T extends { date: string; priority: string }>(
  races: T[],
  today = new Date(),
): T | null {
  const upcoming = races
    .filter((r) => daysUntil(r.date, today) >= 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  return upcoming.find((r) => r.priority === 'A') ?? upcoming[0] ?? null;
}
