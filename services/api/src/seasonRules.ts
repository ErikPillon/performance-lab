/**
 * Validation for races and training blocks.
 *
 * Free of imports, like the threshold and wellness rules: pure predicates over
 * what a person typed, testable without a database.
 *
 * The bounds reject the impossible, not the unusual. A 250 km ultra and a
 * 50 m swim are both real races; a block running from March to the following
 * December is a mistyped year.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface RaceInput {
  date?: string;
  name?: string;
  sport?: string;
  priority?: string;
  distanceM?: number | null;
  goalTimeS?: number | null;
  resultTimeS?: number | null;
  note?: string | null;
}

export interface BlockInput {
  name?: string;
  focus?: string;
  startDate?: string;
  endDate?: string;
  targetWeeklyLoad?: number | null;
  raceId?: string | null;
  note?: string | null;
}

export const PRIORITIES = ['A', 'B', 'C'] as const;
export const FOCUSES = [
  'base', 'build', 'peak', 'taper', 'race', 'recovery', 'offseason', 'other',
] as const;

function positive(value: unknown, name: string, max: number, errors: string[]) {
  if (value == null) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${name} must be a number`);
  } else if (value <= 0 || value > max) {
    errors.push(`${name} must be between 0 and ${max}`);
  }
}

export function validateRace(body: RaceInput): string[] {
  const errors: string[] = [];

  if (!body.date || !DATE.test(body.date)) errors.push('date must be YYYY-MM-DD');
  // A race in the future is the normal case here — this is a planning tool —
  // so unlike a wellness reading there is no upper bound on the date.

  if (!body.name?.trim()) errors.push('name is required');
  else if (body.name.length > 120) errors.push('name is too long');

  if (body.priority && !PRIORITIES.includes(body.priority as never)) {
    errors.push(`priority must be one of ${PRIORITIES.join(', ')}`);
  }

  // 500 km covers the longest ultras anyone enters on purpose.
  positive(body.distanceM, 'distanceM', 500_000, errors);
  // 60 hours: longer than any single-stage race, short enough to catch a
  // milliseconds-for-seconds mix-up.
  positive(body.goalTimeS, 'goalTimeS', 216_000, errors);
  positive(body.resultTimeS, 'resultTimeS', 216_000, errors);

  if (body.note != null && body.note.length > 500) errors.push('note is too long');
  return errors;
}

export function validateBlock(body: BlockInput): string[] {
  const errors: string[] = [];

  if (!body.name?.trim()) errors.push('name is required');
  else if (body.name.length > 120) errors.push('name is too long');

  if (body.focus && !FOCUSES.includes(body.focus as never)) {
    errors.push(`focus must be one of ${FOCUSES.join(', ')}`);
  }

  const startOk = !!body.startDate && DATE.test(body.startDate);
  const endOk = !!body.endDate && DATE.test(body.endDate);
  if (!startOk) errors.push('startDate must be YYYY-MM-DD');
  if (!endOk) errors.push('endDate must be YYYY-MM-DD');

  if (startOk && endOk) {
    const start = Date.parse(`${body.startDate}T00:00:00Z`);
    const end = Date.parse(`${body.endDate}T00:00:00Z`);
    // Inclusive, so a single-day block is start === end and legal.
    if (end < start) errors.push('endDate is before startDate');
    // Two years is not a training block, it is a mistyped year.
    else if (end - start > 730 * 86_400_000) errors.push('a block cannot span more than two years');
  }

  // 2000 is far above any human weekly TSS; the cap is there to catch a
  // per-season total typed into a per-week field.
  positive(body.targetWeeklyLoad, 'targetWeeklyLoad', 2_000, errors);

  if (body.note != null && body.note.length > 500) errors.push('note is too long');
  return errors;
}

/**
 * Advisories: worth saying, not worth blocking.
 *
 * A taper longer than three weeks and an A race with no block pointing at it
 * are both legal and both usually mistakes.
 */
export function blockAdvisories(body: BlockInput): string[] {
  const out: string[] = [];
  if (body.focus === 'taper' && body.startDate && body.endDate) {
    const days =
      (Date.parse(`${body.endDate}T00:00:00Z`) - Date.parse(`${body.startDate}T00:00:00Z`)) /
      86_400_000;
    if (days > 21) out.push('A taper longer than three weeks usually costs more fitness than it recovers.');
  }
  if (body.focus === 'build' && typeof body.targetWeeklyLoad === 'number' && body.targetWeeklyLoad > 900) {
    out.push('That is a very high weekly target — check it is per week and not per block.');
  }
  return out;
}
