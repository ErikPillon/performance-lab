import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockProgress, daysUntil, nextRace, type Block } from './season.js';

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Daily rows with a fixed load per day, from `from` for `days` days. */
function daily(from: string, days: number, load: number) {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => ({ date: iso(start + i * DAY), load }));
}

// 2027-01-04 is a Monday.
const MONDAY = '2027-01-04';
const block: Block = {
  id: 'b1', name: 'Base 1', focus: 'base',
  startDate: MONDAY, endDate: '2027-01-31', targetWeeklyLoad: 350,
};

test('a block hitting its target scores 1.0', () => {
  const p = blockProgress(block, daily(MONDAY, 28, 50), new Date('2027-03-01'));
  assert.equal(p.weeks.length, 4);
  assert.ok(p.weeks.every((w) => w.state === 'complete'), 'all four weeks are whole and past');
  assert.ok(Math.abs(p.compliance! - 1) < 1e-9, `got ${p.compliance}`);
  assert.equal(p.status, 'done');
});

test('a partial first week is reported but not judged', () => {
  // Starting on a Wednesday: the opening week holds five days, not seven.
  const midweek: Block = { ...block, startDate: '2027-01-06', endDate: '2027-01-31' };
  const p = blockProgress(midweek, daily('2027-01-06', 26, 50), new Date('2027-03-01'));
  assert.equal(p.weeks[0]!.state, 'partial', 'a five-day week cannot be scored against a weekly target');
  assert.ok(p.weeks.slice(1, -1).every((w) => w.state === 'complete'));
  // Compliance sees only the whole weeks, so it is not dragged down by the stub.
  assert.ok(Math.abs(p.compliance! - 1) < 1e-9, `got ${p.compliance}`);
});

test('a week still in progress is not counted as a shortfall', () => {
  // Wednesday of the second week: three days of load against a weekly target.
  const p = blockProgress(block, daily(MONDAY, 10, 50), new Date('2027-01-13'));
  assert.equal(p.weeks[0]!.state, 'complete', 'the first week is over');
  assert.equal(p.weeks[1]!.state, 'partial', 'the current week is not');
  assert.ok(Math.abs(p.compliance! - 1) < 1e-9, 'only the finished week is judged');
  assert.equal(p.status, 'active');
});

test('missing training shows up as a ratio below one', () => {
  const p = blockProgress(block, daily(MONDAY, 28, 25), new Date('2027-03-01'));
  assert.ok(Math.abs(p.compliance! - 0.5) < 1e-9, `got ${p.compliance}`);
  assert.ok(p.weeks.every((w) => Math.abs(w.ratio! - 0.5) < 1e-9));
});

test('only load inside the block window is counted', () => {
  // Training either side of the block must neither flatter nor penalise it.
  // The block is 2027-01-04 to 2027-01-31 inclusive: 28 days.
  const wholeSeason = daily('2026-11-01', 200, 100);
  const p = blockProgress(block, wholeSeason, new Date('2027-06-01'));
  assert.equal(p.actualTotal, 28 * 100, 'exactly the 28 days inside the block');
  assert.equal(p.weeks.length, 4);
});

test('a block with no training in it scores zero rather than throwing', () => {
  const elsewhere = daily('2026-11-01', 30, 100); // ends well before the block
  const p = blockProgress(block, elsewhere, new Date('2027-06-01'));
  assert.equal(p.actualTotal, 0);
  assert.equal(p.compliance, 0);
});

test('a block with no target reports actuals and no score', () => {
  const p = blockProgress({ ...block, targetWeeklyLoad: null }, daily(MONDAY, 28, 50),
    new Date('2027-03-01'));
  assert.equal(p.compliance, null);
  assert.equal(p.plannedTotal, null);
  assert.equal(p.actualTotal, 28 * 50);
  assert.ok(p.weeks.every((w) => w.ratio === null));
});

test('a one-day block is legal and produces one week', () => {
  const oneDay: Block = { ...block, startDate: MONDAY, endDate: MONDAY };
  const p = blockProgress(oneDay, daily(MONDAY, 1, 40), new Date('2027-03-01'));
  assert.equal(p.weeks.length, 1);
  assert.equal(p.weeks[0]!.actual, 40);
  assert.equal(p.weeks[0]!.state, 'partial', 'one day is not a week');
});

test('status moves through upcoming, active and done', () => {
  assert.equal(blockProgress(block, [], new Date('2026-12-01')).status, 'upcoming');
  assert.equal(blockProgress(block, [], new Date('2027-01-15')).status, 'active');
  assert.equal(blockProgress(block, [], new Date('2027-06-01')).status, 'done');
});

test('the next race is the next A race, not merely the next race', () => {
  // The whole point of priorities: a C race is a training day, and counting
  // down to one buries the race the season is built around.
  const races = [
    { date: '2027-02-01', priority: 'C' },
    { date: '2027-04-18', priority: 'A' },
    { date: '2027-03-01', priority: 'B' },
  ];
  assert.equal(nextRace(races, new Date('2027-01-01'))!.date, '2027-04-18');
});

test('with no A race left, the next race of any priority is used', () => {
  const races = [{ date: '2027-02-01', priority: 'C' }, { date: '2027-03-01', priority: 'B' }];
  assert.equal(nextRace(races, new Date('2027-01-01'))!.date, '2027-02-01');
  assert.equal(nextRace(races, new Date('2027-06-01')), null, 'all in the past');
});

test('daysUntil counts from today and goes negative afterwards', () => {
  assert.equal(daysUntil('2027-01-11', new Date('2027-01-04')), 7);
  assert.equal(daysUntil('2027-01-04', new Date('2027-01-04')), 0, 'race day is zero');
  assert.equal(daysUntil('2027-01-01', new Date('2027-01-04')), -3);
});

test('a block that has not started reports future weeks, not failures', () => {
  // Reporting an upcoming block's weeks as 0% made a season that had not begun
  // look like one already lost.
  const p = blockProgress(block, [], new Date('2026-12-01'));
  assert.equal(p.status, 'upcoming');
  assert.ok(p.weeks.every((w) => w.state === 'future'), 'no week has started');
  assert.equal(p.compliance, null, 'nothing to score yet');
});

test('a block half run reports past, current and future weeks distinctly', () => {
  const p = blockProgress(block, daily(MONDAY, 10, 50), new Date('2027-01-13'));
  assert.deepEqual(p.weeks.map((w) => w.state), ['complete', 'partial', 'future', 'future']);
});
