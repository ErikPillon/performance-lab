import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advisories, hasMeasurement, validate } from './wellnessRules.js';

const today = new Date().toISOString().slice(0, 10);

test('a complete plausible entry passes', () => {
  assert.deepEqual(
    validate({ date: today, restingHr: 48, hrvRmssdMs: 62, sleepHours: 7.5, weightKg: 71, feel: 4 }),
    [],
  );
});

test('an athlete resting heart rate is accepted, a typo for it is not', () => {
  // 28 is real for a well-trained endurance athlete and must be accepted.
  assert.deepEqual(validate({ date: today, restingHr: 28 }), []);
  // 280 is a fat-fingered 28 and would invert every HR-reserve calculation.
  assert.ok(validate({ date: today, restingHr: 280 }).some((e) => e.includes('restingHr')));
});

test('the date must be a real past date', () => {
  assert.ok(validate({ date: 'yesterday' }).some((e) => e.includes('YYYY-MM-DD')));
  assert.ok(validate({}).some((e) => e.includes('YYYY-MM-DD')));
  assert.ok(validate({ date: '2099-01-01' }).some((e) => e.includes('future')));
});

test("today's own date is not in the future", () => {
  // Guards an off-by-one against the timezone the server happens to run in.
  assert.deepEqual(validate({ date: today, restingHr: 50 }), []);
});

test('nulls are skipped, not range-checked', () => {
  assert.deepEqual(
    validate({ date: today, restingHr: null, hrvRmssdMs: null, weightKg: null }),
    [],
  );
});

test('a non-numeric measurement is rejected before the range check', () => {
  const errors = validate({ date: today, restingHr: 'fifty' as never });
  assert.equal(errors.length, 1);
  assert.ok(errors[0]!.includes('must be a number'));
});

test('an entry with nothing in it is recognised as empty', () => {
  assert.equal(hasMeasurement({ date: today }), false);
  assert.equal(hasMeasurement({ date: today, note: '   ' }), false);
  assert.equal(hasMeasurement({ date: today, weightKg: 71 }), true);
  assert.equal(hasMeasurement({ date: today, note: 'travelled' }), true);
});

test('a zero measurement still counts as entered', () => {
  // sleepScore 0 and feel are falsy-but-real; a truthiness check would drop them.
  assert.equal(hasMeasurement({ date: today, sleepScore: 0 }), true);
  assert.equal(hasMeasurement({ date: today, sleepHours: 0 }), true);
});

test('advisories flag the notable without blocking it', () => {
  assert.deepEqual(validate({ date: today, restingHr: 30 }), [], 'still valid');
  assert.ok(advisories({ restingHr: 30 }).some((a) => a.includes('very low')));
  assert.ok(advisories({ restingHr: 80 }).some((a) => a.includes('fatigue')));
  assert.ok(advisories({ sleepHours: 4 }).some((a) => a.includes('five hours')));
  assert.deepEqual(advisories({ restingHr: 48, sleepHours: 8 }), []);
});
