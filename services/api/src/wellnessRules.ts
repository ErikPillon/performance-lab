/**
 * Validation for hand-entered wellness readings.
 *
 * Deliberately free of imports, like the threshold rules: these are pure
 * predicates over numbers a person types before breakfast, and they are worth
 * testing without standing up a database.
 *
 * The bounds reject the impossible, not the merely unusual. A resting heart
 * rate of 28 is real for a well-trained endurance athlete and must be accepted;
 * 280 is a typo for 28 and must not be, because it would silently invert every
 * heart-rate-reserve calculation that later reads it.
 */

export interface WellnessInput {
  date?: string;
  restingHr?: number | null;
  hrvRmssdMs?: number | null;
  sleepHours?: number | null;
  sleepScore?: number | null;
  weightKg?: number | null;
  feel?: number | null;
  note?: string | null;
}

const RANGES: Record<string, [number, number]> = {
  restingHr: [25, 120],
  hrvRmssdMs: [1, 300],
  sleepHours: [0, 24],
  sleepScore: [0, 100],
  weightKg: [30, 250],
  feel: [1, 5],
};

const MEASUREMENTS = [
  'restingHr', 'hrvRmssdMs', 'sleepHours', 'sleepScore', 'weightKg', 'feel',
] as const;

export function validate(body: WellnessInput): string[] {
  const errors: string[] = [];

  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    errors.push('date must be YYYY-MM-DD');
  } else {
    // A reading dated in the future is a typo in the year or the month, and
    // it would sit at the end of every chart pulling the axis with it.
    const today = new Date();
    today.setUTCHours(23, 59, 59, 999);
    if (new Date(`${body.date}T00:00:00Z`) > today) errors.push('date is in the future');
  }

  for (const field of MEASUREMENTS) {
    const value = body[field];
    if (value == null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${field} must be a number`);
      continue;
    }
    const [lo, hi] = RANGES[field]!;
    if (value < lo || value > hi) errors.push(`${field} must be between ${lo} and ${hi}`);
  }

  if (body.note != null && body.note.length > 500) errors.push('note is too long');

  return errors;
}

/** Whether the entry carries any measurement at all. */
export function hasMeasurement(body: WellnessInput): boolean {
  return MEASUREMENTS.some((f) => body[f] != null) || !!body.note?.trim();
}

/**
 * Advisories: things worth saying out loud that are not errors.
 *
 * The system has been running on a hardcoded resting heart rate of 50, so the
 * first real measurement that disagrees with it is worth flagging rather than
 * absorbing silently.
 */
export function advisories(body: WellnessInput): string[] {
  const out: string[] = [];
  if (typeof body.restingHr === 'number') {
    if (body.restingHr < 35) {
      out.push('That is a very low resting heart rate — check it is a true morning reading.');
    }
    if (body.restingHr > 75) {
      out.push('A high morning reading can mean illness, alcohol, or accumulated fatigue.');
    }
  }
  if (typeof body.sleepHours === 'number' && body.sleepHours < 5) {
    out.push('Under five hours; treat any hard session today with suspicion.');
  }
  return out;
}
