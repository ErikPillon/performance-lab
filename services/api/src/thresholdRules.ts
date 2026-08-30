/**
 * Validation rules for hand-entered thresholds.
 *
 * Deliberately free of imports: these are pure predicates over user input that
 * rescales every derived number in the system, and keeping them independent of
 * the route module means they can be tested without opening a database or a
 * queue connection.
 */

export interface ThresholdInput {
  effectiveFrom?: string;
  maxHr?: number | null;
  restHr?: number | null;
  lthr?: number | null;
  ftpWatts?: number | null;
  cssSecPer100m?: number | null;
  thresholdPaceSecPerKm?: number | null;
  weightKg?: number | null;
  note?: string | null;
}

/**
 * Plausible ranges. Deliberately wide: the aim is to catch slips — 1780 for an
 * LTHR of 178 — not to police physiology.
 */
const RANGES: Record<string, [number, number]> = {
  maxHr: [100, 250],
  restHr: [25, 100],
  lthr: [80, 230],
  ftpWatts: [50, 600],
  cssSecPer100m: [40, 300],
  thresholdPaceSecPerKm: [120, 900],
  weightKg: [30, 200],
};

/** Blocking problems. An empty array means the input is safe to store. */
export function validate(body: ThresholdInput): string[] {
  const errors: string[] = [];

  for (const [field, [lo, hi]] of Object.entries(RANGES)) {
    const value = body[field as keyof ThresholdInput];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${field} must be a number`);
    } else if (value < lo || value > hi) {
      errors.push(`${field} must be between ${lo} and ${hi} (got ${value})`);
    }
  }

  // Relationships matter as much as ranges: an LTHR above max HR would make
  // heart-rate reserve negative and every TRIMP nonsense.
  if (typeof body.lthr === 'number' && typeof body.maxHr === 'number' && body.lthr >= body.maxHr) {
    errors.push('lthr must be below maxHr');
  }
  if (
    typeof body.restHr === 'number' &&
    typeof body.maxHr === 'number' &&
    body.restHr >= body.maxHr - 20
  ) {
    errors.push('restHr must be at least 20 bpm below maxHr');
  }
  if (body.effectiveFrom && Number.isNaN(new Date(body.effectiveFrom).getTime())) {
    errors.push('effectiveFrom must be a valid date');
  }
  return errors;
}

/** Non-blocking observations about values that are legal but unusual. */
export function advisories(body: ThresholdInput): string[] {
  const notes: string[] = [];
  if (typeof body.lthr === 'number' && typeof body.maxHr === 'number') {
    const fraction = body.lthr / body.maxHr;
    if (fraction > 0.92 || fraction < 0.8) {
      notes.push(
        `LTHR is ${Math.round(fraction * 100)}% of max HR, outside the usual 80-92% band. ` +
          'Worth confirming with a field test — every heart-rate-derived load number scales with it.',
      );
    }
  }
  return notes;
}
