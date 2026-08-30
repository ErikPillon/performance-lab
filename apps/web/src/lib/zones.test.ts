import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, percentages, sumZones, toThreeZone } from './zones.js';

const H = 3600;
const dist = (z1: number, z2: number, z3: number, z4: number, z5: number) => ({
  z1_recovery: z1 * H, z2_aerobic: z2 * H, z3_tempo: z3 * H,
  z4_threshold: z4 * H, z5_vo2max: z5 * H,
});

test('the five zones collapse at the two thresholds', () => {
  const three = toThreeZone(dist(10, 5, 2, 1, 2));
  assert.equal(three.easy, 15 * H, 'Z1 and Z2 are below the first threshold');
  assert.equal(three.moderate, 3 * H, 'Z3 and Z4 sit between the thresholds');
  assert.equal(three.hard, 2 * H, 'Z5 is above LTHR');
  assert.equal(three.total, 20 * H);
});

test('missing zones count as zero rather than breaking the sum', () => {
  const three = toThreeZone({ z1_recovery: 10 * H });
  assert.equal(three.easy, 10 * H);
  assert.equal(three.moderate, 0);
  assert.equal(three.total, 10 * H);
});

test('easy > moderate > hard is pyramidal', () => {
  assert.equal(classify(toThreeZone(dist(70, 10, 8, 5, 2))), 'pyramidal');
});

test('easy > hard > moderate is polarised', () => {
  assert.equal(classify(toThreeZone(dist(70, 10, 2, 2, 12))), 'polarised');
});

test('a block that is not easy-dominated is a threshold block', () => {
  // Half the time in the grey zone between the two thresholds.
  assert.equal(classify(toThreeZone(dist(20, 15, 30, 25, 5))), 'threshold');
});

test('a nearly all-easy block stays pyramidal on one hard session', () => {
  // The real risk with an ordering rule: 95% easy and a single interval set
  // must not flip the label just because hard edged past a tiny moderate.
  const before = classify(toThreeZone(dist(90, 5, 3, 1, 0.5)));
  const after = classify(toThreeZone(dist(90, 5, 0.2, 0.2, 1)));
  assert.equal(before, 'pyramidal');
  assert.equal(after, 'polarised', 'hard genuinely exceeds moderate here');
  // But both remain easy-dominated, which is the thing that actually matters.
  assert.ok(percentages(toThreeZone(dist(90, 5, 0.2, 0.2, 1))).easy > 90);
});

test('too little training to describe is reported as such', () => {
  assert.equal(classify(toThreeZone(dist(1, 0.5, 0, 0, 0))), 'insufficient');
  assert.equal(classify(toThreeZone(dist(0, 0, 0, 0, 0))), 'insufficient');
});

test('percentages sum to 100 and survive an empty distribution', () => {
  const p = percentages(toThreeZone(dist(70, 10, 8, 5, 7)));
  assert.ok(Math.abs(p.easy + p.moderate + p.hard - 100) < 1e-9);
  assert.deepEqual(percentages({ easy: 0, moderate: 0, hard: 0, total: 0 }), {
    easy: 0, moderate: 0, hard: 0,
  });
});

test('sumZones adds periods without losing zones absent from some', () => {
  const total = sumZones([
    { zones: { z1_recovery: 100, z5_vo2max: 10 } },
    { zones: { z1_recovery: 50, z2_aerobic: 20 } },
  ]);
  assert.deepEqual(total, { z1_recovery: 150, z2_aerobic: 20, z5_vo2max: 10 });
});

test("this athlete's real distribution reads as pyramidal", () => {
  // 307h / 79h / 16h / 14h / 4h from the live corpus. Overwhelmingly easy with
  // very little above threshold — pyramidal, not polarised, and the page should
  // say so plainly.
  const three = toThreeZone(dist(307.3, 79.4, 16.5, 14.5, 4.1));
  assert.equal(classify(three), 'pyramidal');
  const p = percentages(three);
  assert.ok(p.easy > 90 && p.hard < 1.5, `got ${JSON.stringify(p)}`);
});
