import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coalesceThresholds } from './queries.js';

/** Annotated explicitly: an all-null literal infers `null` for every field. */
type Values = {
  maxHr: number | null;
  restHr: number | null;
  lthr: number | null;
  ftpWatts: number | null;
  cssSecPer100m: number | null;
  thresholdPaceSecPerKm: number | null;
  weightKg: number | null;
};

const empty: Values = {
  maxHr: null,
  restHr: null,
  lthr: null,
  ftpWatts: null,
  cssSecPer100m: null,
  thresholdPaceSecPerKm: null,
  weightKg: null,
};

const row = (effectiveFrom: string, values: Partial<Values>) => ({
  effectiveFrom,
  ...empty,
  ...values,
});

test('the newest value wins for each field', () => {
  const resolved = coalesceThresholds([
    row('2025-01-01', { lthr: 172 }),
    row('2020-10-10', { lthr: 178, maxHr: 192 }),
  ]);
  assert.equal(resolved.lthr, 172);
  assert.equal(resolved.max_hr, 192);
});

test('a newer entry does not erase fields it leaves empty', () => {
  // The regression this exists for. Entering an FTP test used to blank
  // threshold pace and CSS, which silently dropped pace-derived scoring from
  // 193 activities.
  const resolved = coalesceThresholds([
    row('2025-01-01', { maxHr: 193, lthr: 172, restHr: 48 }),
    row('2020-10-10', { thresholdPaceSecPerKm: 266.8, cssSecPer100m: 100 }),
  ]);
  assert.equal(resolved.threshold_pace_sec_per_km, 266.8);
  assert.equal(resolved.css_sec_per_100m, 100);
  assert.equal(resolved.lthr, 172);
});

test('each value reports which dated entry it came from', () => {
  const resolved = coalesceThresholds([
    row('2025-01-01', { lthr: 172 }),
    row('2020-10-10', { cssSecPer100m: 100 }),
  ]);
  assert.equal(resolved.sources.lthr, '2025-01-01');
  assert.equal(resolved.sources.css_sec_per_100m, '2020-10-10');
  assert.equal(resolved.sources.ftp_watts, undefined);
});

test('zero is a real value and is not treated as absent', () => {
  const resolved = coalesceThresholds([row('2025-01-01', { ftpWatts: 0 })]);
  assert.equal(resolved.ftp_watts, 0);
  assert.equal(resolved.sources.ftp_watts, '2025-01-01');
});

test('no entries resolves to all nulls rather than throwing', () => {
  const resolved = coalesceThresholds([]);
  assert.equal(resolved.lthr, null);
  assert.equal(resolved.max_hr, null);
  assert.deepEqual(resolved.sources, {});
  assert.equal(resolved.sex, 'unspecified');
});

test('sex is carried through for the Banister weighting', () => {
  assert.equal(coalesceThresholds([], 'female').sex, 'female');
});
