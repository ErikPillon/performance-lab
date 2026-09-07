import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockAdvisories, validateBlock, validateRace } from './seasonRules.js';

test('a plausible race passes', () => {
  assert.deepEqual(
    validateRace({ date: '2027-04-18', name: 'Rotterdam Marathon', priority: 'A',
      distanceM: 42195, goalTimeS: 10_800 }),
    [],
  );
});

test('a race in the future is the normal case, not an error', () => {
  // Unlike a wellness reading — this is a planning tool.
  assert.deepEqual(validateRace({ date: '2030-01-01', name: 'someday' }), []);
});

test('a race needs a name and a real date', () => {
  assert.ok(validateRace({ date: '2027-04-18' }).some((e) => e.includes('name')));
  assert.ok(validateRace({ name: 'x', date: 'April' }).some((e) => e.includes('YYYY-MM-DD')));
  assert.ok(validateRace({ name: '   ', date: '2027-04-18' }).some((e) => e.includes('name')));
});

test('the long tail of real race distances is accepted', () => {
  // A 50 m pool swim and a 250 km ultra are both real races.
  assert.deepEqual(validateRace({ date: '2027-01-01', name: 'sprint', distanceM: 50 }), []);
  assert.deepEqual(validateRace({ date: '2027-01-01', name: 'ultra', distanceM: 250_000 }), []);
  assert.ok(validateRace({ date: '2027-01-01', name: 'x', distanceM: 900_000 }).length > 0);
});

test('a goal time in milliseconds is caught', () => {
  // 3:00:00 typed as milliseconds is 10,800,000 — well past the 60-hour cap.
  assert.ok(
    validateRace({ date: '2027-01-01', name: 'x', goalTimeS: 10_800_000 })
      .some((e) => e.includes('goalTimeS')),
  );
});

test('a block runs forwards, and a single day is legal', () => {
  assert.deepEqual(
    validateBlock({ name: 'Base 1', focus: 'base', startDate: '2027-01-01', endDate: '2027-02-28' }),
    [],
  );
  assert.deepEqual(
    validateBlock({ name: 'Race day', focus: 'race', startDate: '2027-04-18', endDate: '2027-04-18' }),
    [],
    'an inclusive range makes a one-day block valid',
  );
  assert.ok(
    validateBlock({ name: 'x', startDate: '2027-03-01', endDate: '2027-02-01' })
      .some((e) => e.includes('before')),
  );
});

test('a mistyped year is caught as an impossible span', () => {
  assert.ok(
    validateBlock({ name: 'Base', startDate: '2027-03-01', endDate: '2030-03-01' })
      .some((e) => e.includes('two years')),
  );
});

test('an unknown focus or priority is rejected', () => {
  assert.ok(validateBlock({ name: 'x', focus: 'sharpening', startDate: '2027-01-01', endDate: '2027-01-08' })
    .some((e) => e.includes('focus')));
  assert.ok(validateRace({ date: '2027-01-01', name: 'x', priority: 'S' })
    .some((e) => e.includes('priority')));
});

test('a season total typed into the weekly field is caught', () => {
  assert.ok(
    validateBlock({ name: 'Build', startDate: '2027-01-01', endDate: '2027-02-01', targetWeeklyLoad: 12_000 })
      .some((e) => e.includes('targetWeeklyLoad')),
  );
});

test('advisories warn without blocking', () => {
  const long = { name: 'Taper', focus: 'taper', startDate: '2027-03-01', endDate: '2027-04-10' };
  assert.deepEqual(validateBlock(long), [], 'still valid');
  assert.ok(blockAdvisories(long).some((a) => a.includes('three weeks')));
  assert.deepEqual(blockAdvisories({ name: 'Base', focus: 'base' }), []);
});
