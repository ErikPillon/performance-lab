import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareEnds, median, rollingMedian, withGapBreaks, type TrendPoint } from './trends.js';

const DAY = 86_400_000;
const at = (day: number, y: number | null): TrendPoint => ({ x: day * DAY, y });

test('median handles both parities and does not mutate its input', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  const input = [3, 1, 2];
  median(input);
  assert.deepEqual(input, [3, 1, 2], 'sorting must not leak back to the caller');
});

test('rollingMedian smooths a noisy series around its true level', () => {
  // Scatter around a level of 10. Deliberately not a two-value alternation:
  // over an odd window that has no middle to find and a median filter just
  // returns whichever value is in the majority, so it would oscillate rather
  // than smooth — a property of median filters, not a bug in this one.
  const pattern = [8, 12, 9, 11, 10];
  const points = Array.from({ length: 40 }, (_, i) => at(i, pattern[i % pattern.length]!));
  const smoothed = rollingMedian(points, { halfWindowDays: 7, minPoints: 3 });
  const middle = smoothed.slice(10, 30);
  assert.ok(middle.every((v) => v != null && v >= 9.5 && v <= 10.5), `got ${middle.join(',')}`);
});

test('a single outlier does not move the median', () => {
  const points = [...Array.from({ length: 20 }, (_, i) => at(i, 10)), at(20, 1000)];
  const smoothed = rollingMedian(points, { halfWindowDays: 10, minPoints: 3 });
  assert.equal(smoothed[5], 10, 'a mean would have been dragged upward');
});

test('a gap in training breaks the line rather than bridging it', () => {
  // Three sessions, then nothing for a year, then one more.
  const points = [at(0, 10), at(1, 10), at(2, 10), at(400, 20)];
  const smoothed = rollingMedian(points, { halfWindowDays: 21, minPoints: 3 });
  assert.equal(smoothed[3], null, 'the isolated point has too little around it');
  assert.equal(smoothed[0], 10);
});

test('the window is calendar time, not a count of activities', () => {
  // Two clusters 100 days apart. A 9-point window would merge them; a 21-day
  // window must not.
  const points = [
    ...Array.from({ length: 5 }, (_, i) => at(i, 10)),
    ...Array.from({ length: 5 }, (_, i) => at(100 + i, 30)),
  ];
  const smoothed = rollingMedian(points, { halfWindowDays: 21, minPoints: 3 });
  assert.equal(smoothed[0], 10);
  assert.equal(smoothed[9], 30, 'the later cluster must not be pulled toward the earlier one');
});

test('nulls are skipped, not treated as zero', () => {
  const points = [at(0, 10), at(1, null), at(2, 10), at(3, 10), at(4, null)];
  const smoothed = rollingMedian(points, { halfWindowDays: 7, minPoints: 3 });
  assert.equal(smoothed[0], 10, 'a null counted as 0 would have halved this');
});

test('rollingMedian tolerates unsorted input', () => {
  const points = [at(3, 10), at(0, 10), at(2, 10), at(1, 10)];
  const smoothed = rollingMedian(points, { halfWindowDays: 7, minPoints: 3 });
  assert.deepEqual(smoothed, [10, 10, 10, 10]);
});

test('compareEnds reports the change between first and last months', () => {
  const points = [
    ...Array.from({ length: 5 }, (_, i) => at(i, 0.017)),
    ...Array.from({ length: 5 }, (_, i) => at(300 + i, 0.020)),
  ];
  const result = compareEnds(points, { spanDays: 60, minPoints: 3 });
  assert.ok(result);
  assert.ok(Math.abs(result.first - 0.017) < 1e-9);
  assert.ok(Math.abs(result.last - 0.020) < 1e-9);
  assert.ok(Math.abs(result.changePct - 17.647) < 0.01, `got ${result.changePct}`);
});

test('compareEnds refuses when the series is too short to say anything', () => {
  assert.equal(compareEnds([at(0, 10), at(1, 11)]), null, 'too few points');
  // Enough points, but all inside one span: "first" and "last" would overlap.
  const bunched = Array.from({ length: 10 }, (_, i) => at(i, 10));
  assert.equal(compareEnds(bunched, { spanDays: 60 }), null, 'not enough calendar spread');
});

test('compareEnds survives a negative baseline without flipping sign', () => {
  // Decoupling can be negative — heart rate drifting down through a session.
  const points = [
    ...Array.from({ length: 5 }, (_, i) => at(i, -4)),
    ...Array.from({ length: 5 }, (_, i) => at(300 + i, -2)),
  ];
  const result = compareEnds(points, { spanDays: 60 });
  assert.ok(result);
  assert.ok(result.changePct > 0, 'from -4 to -2 is an increase; got ' + result.changePct);
});

test('withGapBreaks breaks the line across a layoff', () => {
  // Two dense clusters 100 days apart. Both have enough neighbours for a
  // median, so nothing is null and the chart would otherwise join them.
  const points = [
    ...Array.from({ length: 5 }, (_, i) => at(i, 10)),
    ...Array.from({ length: 5 }, (_, i) => at(100 + i, 20)),
  ];
  const broken = withGapBreaks(points, { maxGapDays: 42 });
  assert.equal(broken.length, points.length + 1, 'exactly one break inserted');
  const nulls = broken.filter((p) => p.y == null);
  assert.equal(nulls.length, 1);
  assert.ok(nulls[0]!.x > at(4, 0).x && nulls[0]!.x < at(100, 0).x, 'break sits inside the gap');
});

test('withGapBreaks leaves a continuous series alone', () => {
  const points = Array.from({ length: 10 }, (_, i) => at(i * 5, 10));
  assert.deepEqual(withGapBreaks(points, { maxGapDays: 42 }), points);
});

test('withGapBreaks handles an empty series and a single point', () => {
  assert.deepEqual(withGapBreaks([]), []);
  assert.deepEqual(withGapBreaks([at(0, 10)]), [at(0, 10)]);
});
