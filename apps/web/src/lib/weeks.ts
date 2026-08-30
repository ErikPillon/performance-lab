import type { ActivityRow, PmcDay } from './api';

/**
 * Grouping activities into training weeks.
 *
 * Weeks start Monday: that is how training is planned and reviewed, and a
 * Sunday-start grid splits the weekend that most long sessions land on.
 */

export interface DayCell {
  date: string;
  activities: ActivityRow[];
  load: number;
  durationS: number;
}

export interface WeekRow {
  start: string;
  days: DayCell[];
  load: number;
  durationS: number;
  distanceM: number;
  sessions: number;
  restDays: number;
  /** Fitness at the end of the week, from the stored model. */
  ctl: number | null;
  acwr: number | null;
  rampRate: number | null;
  monotony: number | null;
  /** Load change against the previous week, as a fraction. */
  changeVsPrevious: number | null;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `date`. */
export function weekStart(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}

/**
 * The calendar day an activity belongs to, in the athlete's own local time.
 *
 * A session is remembered by the day it happened where the athlete was, not by
 * its UTC date. Those diverge only for sessions starting just after local
 * midnight — none in this dataset, but they would differ widely after travel.
 */
/**
 * Whether an activity's duration and distance can be summed.
 *
 * A session flagged for an implausible duration still appears on the calendar —
 * it happened, and hiding it would be worse — but it must not contribute to
 * week totals. The corpus holds a 750 m swim hand-entered as 50 hours; summed
 * naively it turned one week into 53 hours of training.
 */
export function countsTowardTotals(activity: ActivityRow): boolean {
  return !activity.qualityFlags.includes('implausible_duration');
}

export function localDate(activity: ActivityRow): string {
  const start = new Date(activity.startTime);
  const shifted = new Date(start.getTime() + (activity.tzOffsetMin ?? 0) * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function buildWeeks(
  activities: ActivityRow[],
  pmc: PmcDay[],
  from: Date,
  to: Date,
): WeekRow[] {
  const byDay = new Map<string, ActivityRow[]>();
  for (const a of activities) {
    const key = localDate(a);
    const list = byDay.get(key) ?? [];
    list.push(a);
    byDay.set(key, list);
  }

  const pmcByDay = new Map(pmc.map((d) => [d.date, d]));

  const weeks: WeekRow[] = [];
  const cursor = weekStart(from);
  const end = weekStart(to);

  while (cursor <= end) {
    const days: DayCell[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(cursor);
      day.setUTCDate(day.getUTCDate() + i);
      const key = iso(day);
      const list = byDay.get(key) ?? [];
      const countable = list.filter(countsTowardTotals);
      days.push({
        date: key,
        activities: list,
        load: countable.reduce((sum, a) => sum + (a.load ?? 0), 0),
        durationS: countable.reduce((sum, a) => sum + (a.durationS ?? 0), 0),
      });
    }

    // Model values are read from the last day of the week, where the trailing
    // seven-day windows they are built on cover exactly this week.
    const last = pmcByDay.get(days[6]!.date);
    const sessions = days.reduce((n, d) => n + d.activities.length, 0);

    weeks.push({
      start: iso(cursor),
      days,
      load: days.reduce((sum, d) => sum + d.load, 0),
      durationS: days.reduce((sum, d) => sum + d.durationS, 0),
      distanceM: days.reduce(
        (sum, d) =>
          sum + d.activities.filter(countsTowardTotals).reduce((s, a) => s + (a.distanceM ?? 0), 0),
        0,
      ),
      sessions,
      restDays: days.filter((d) => d.activities.length === 0).length,
      ctl: last?.ctl ?? null,
      acwr: last?.acwr ?? null,
      rampRate: last?.rampRate ?? null,
      monotony: last?.monotony ?? null,
      changeVsPrevious: null,
    });

    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  for (let i = 1; i < weeks.length; i++) {
    const previous = weeks[i - 1]!.load;
    weeks[i]!.changeVsPrevious = previous > 0 ? weeks[i]!.load / previous - 1 : null;
  }

  return weeks.reverse(); // newest first: the week you are in is the one you want
}
