import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeks, countsTowardTotals, localDate, weekStart } from './weeks.js';
import type { ActivityRow, PmcDay } from './api.js';

function activity(partial: Partial<ActivityRow> & { startTime: string }): ActivityRow {
  return {
    id: partial.startTime,
    tzOffsetMin: 0,
    sport: 'running',
    subSport: null,
    durationS: 3600,
    movingS: 3600,
    distanceM: 10000,
    elevGainM: null,
    avgHr: null,
    maxHr: null,
    calories: null,
    qualityFlags: [],
    hasStreams: true,
    load: 50,
    loadMethod: 'hr_tss',
    trimp: null,
    intensityFactor: null,
    gapSecPerKm: null,
    decouplingPct: null,
    efficiencyFactor: null,
    ...partial,
  };
}

const noPmc: PmcDay[] = [];

test('weeks start on Monday', () => {
  // 2025-09-24 is a Wednesday.
  assert.equal(weekStart(new Date('2025-09-24T12:00:00Z')).toISOString().slice(0, 10), '2025-09-22');
  // A Monday is its own week start.
  assert.equal(weekStart(new Date('2025-09-22T00:00:00Z')).toISOString().slice(0, 10), '2025-09-22');
  // A Sunday belongs to the week that began six days earlier, not the next one.
  assert.equal(weekStart(new Date('2025-09-28T23:00:00Z')).toISOString().slice(0, 10), '2025-09-22');
});

test('an activity lands on its local calendar day', () => {
  // 23:30 UTC at +02:00 is half past one the following morning, locally.
  assert.equal(
    localDate(activity({ startTime: '2025-06-10T23:30:00Z', tzOffsetMin: 120 })),
    '2025-06-11',
  );
  // Daytime sessions are unaffected, which is every activity in this dataset.
  assert.equal(
    localDate(activity({ startTime: '2025-06-10T16:00:00Z', tzOffsetMin: 120 })),
    '2025-06-10',
  );
});

test('sessions are placed in the right day column', () => {
  const weeks = buildWeeks(
    [activity({ startTime: '2025-09-24T09:00:00Z' })],
    noPmc,
    new Date('2025-09-22T00:00:00Z'),
    new Date('2025-09-28T00:00:00Z'),
  );
  assert.equal(weeks.length, 1);
  const days = weeks[0]!.days;
  assert.equal(days[2]!.activities.length, 1, 'Wednesday is the third column');
  assert.equal(days.filter((d) => d.activities.length > 0).length, 1);
});

test('a flagged duration is shown but never summed', () => {
  // The regression this exists for: a 750 m swim hand-entered as 50 hours turned
  // one week into 53 hours of training.
  const bad = activity({
    startTime: '2025-09-24T09:00:00Z',
    durationS: 180_000,
    distanceM: 750,
    load: null,
    qualityFlags: ['implausible_duration'],
  });
  assert.equal(countsTowardTotals(bad), false);

  const weeks = buildWeeks(
    [bad, activity({ startTime: '2025-09-25T09:00:00Z' })],
    noPmc,
    new Date('2025-09-22T00:00:00Z'),
    new Date('2025-09-28T00:00:00Z'),
  );
  const week = weeks[0]!;
  assert.equal(week.sessions, 2, 'both sessions still appear');
  assert.equal(week.durationS, 3600, 'only the sound one counts toward hours');
  assert.equal(week.distanceM, 10000);
  assert.equal(week.load, 50);
});

test('rest days are counted', () => {
  const weeks = buildWeeks(
    [activity({ startTime: '2025-09-24T09:00:00Z' }), activity({ startTime: '2025-09-27T09:00:00Z' })],
    noPmc,
    new Date('2025-09-22T00:00:00Z'),
    new Date('2025-09-28T00:00:00Z'),
  );
  assert.equal(weeks[0]!.restDays, 5);
});

test('week-on-week change is relative to the previous week', () => {
  const weeks = buildWeeks(
    [
      activity({ startTime: '2025-09-16T09:00:00Z', load: 100 }),
      activity({ startTime: '2025-09-23T09:00:00Z', load: 150 }),
    ],
    noPmc,
    new Date('2025-09-15T00:00:00Z'),
    new Date('2025-09-28T00:00:00Z'),
  );
  // Newest first, so the most recent week is index 0.
  const recent = weeks.find((w) => w.start === '2025-09-22')!;
  assert.ok(Math.abs(recent.changeVsPrevious! - 0.5) < 1e-9);
  const first = weeks.find((w) => w.start === '2025-09-15')!;
  assert.equal(first.changeVsPrevious, null, 'nothing to compare the first week against');
});

test('weeks come back newest first', () => {
  const weeks = buildWeeks([], noPmc, new Date('2025-09-01T00:00:00Z'), new Date('2025-09-28T00:00:00Z'));
  const starts = weeks.map((w) => w.start);
  assert.deepEqual([...starts].sort().reverse(), starts);
});

test('empty weeks are still rendered so gaps in training are visible', () => {
  const weeks = buildWeeks([], noPmc, new Date('2025-09-01T00:00:00Z'), new Date('2025-09-28T00:00:00Z'));
  assert.ok(weeks.length >= 4);
  assert.ok(weeks.every((w) => w.sessions === 0 && w.days.length === 7));
});

test('model values are read from the last day of the week', () => {
  const pmc: PmcDay[] = [
    { date: '2025-09-28', load: 0, ctl: 40, atl: 30, tsb: 10, rampRate: 2, weeklyLoad: 300, monotony: 1.2, acwr: 1.6, activities: 0, durationS: 0 },
  ];
  const weeks = buildWeeks([], pmc, new Date('2025-09-22T00:00:00Z'), new Date('2025-09-28T00:00:00Z'));
  assert.equal(weeks[0]!.ctl, 40);
  assert.equal(weeks[0]!.acwr, 1.6);
});
