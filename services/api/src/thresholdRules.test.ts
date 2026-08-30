import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advisories, validate } from './thresholdRules.js';

test('sane thresholds pass', () => {
  assert.deepEqual(
    validate({ maxHr: 193, lthr: 172, restHr: 48, ftpWatts: 250, thresholdPaceSecPerKm: 267 }),
    [],
  );
});

test('a slipped decimal is rejected', () => {
  // 1780 for 178 is the realistic typo, and it would rescale every
  // heart-rate-derived number in the system.
  const errors = validate({ maxHr: 193, lthr: 1780 });
  assert.ok(errors.some((e) => e.includes('between 80 and 230')));
});

test('threshold HR above max HR is rejected', () => {
  // Would make heart-rate reserve negative and every TRIMP nonsense.
  assert.ok(validate({ maxHr: 190, lthr: 195 }).some((e) => e.includes('below maxHr')));
});

test('resting HR too close to max HR is rejected', () => {
  assert.ok(validate({ maxHr: 190, restHr: 175 }).some((e) => e.includes('20 bpm below')));
});

test('omitted fields are not validated', () => {
  assert.deepEqual(validate({ lthr: 172 }), []);
  assert.deepEqual(validate({}), []);
});

test('nulls clear a field rather than failing validation', () => {
  assert.deepEqual(validate({ lthr: null, ftpWatts: null }), []);
});

test('a non-numeric value is rejected rather than coerced', () => {
  assert.ok(validate({ lthr: 'high' as unknown as number }).some((e) => e.includes('must be a number')));
});

test('an invalid effective date is rejected', () => {
  assert.ok(validate({ effectiveFrom: 'last tuesday' }).some((e) => e.includes('valid date')));
});

test('an LTHR outside the usual band is advised on but still allowed', () => {
  const body = { maxHr: 192, lthr: 178 }; // 93%
  assert.deepEqual(validate(body), [], 'should not block');
  assert.ok(advisories(body).some((a) => a.includes('93%')));
});

test('an LTHR inside the usual band draws no advisory', () => {
  assert.deepEqual(advisories({ maxHr: 193, lthr: 168 }), []);
});
