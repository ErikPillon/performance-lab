/** Display formatting. All stored values are SI; conversion happens here only. */

export function duration(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function hours(seconds: number | null | undefined, digits = 1): string {
  if (!seconds) return '0';
  return (seconds / 3600).toFixed(digits);
}

export function km(metres: number | null | undefined, digits = 1): string {
  if (!metres) return '—';
  return (metres / 1000).toFixed(digits);
}

/** Seconds per kilometre as m:ss. */
export function pace(secPerKm: number | null | undefined): string {
  if (!secPerKm || !Number.isFinite(secPerKm)) return '—';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function paceFrom(distanceM: number | null, durationS: number | null): string {
  if (!distanceM || !durationS || distanceM < 100) return '—';
  return pace(durationS / (distanceM / 1000));
}

/** Average speed in km/h — how cyclists read effort, where runners use pace. */
export function speedKmh(distanceM: number | null, durationS: number | null): string {
  if (!distanceM || !durationS || distanceM < 100) return '—';
  return (distanceM / 1000 / (durationS / 3600)).toFixed(1);
}

/** Swim pace, seconds per 100 m. */
export function swimPace(distanceM: number | null, durationS: number | null): string {
  if (!distanceM || !durationS || distanceM < 50) return '—';
  return pace(durationS / (distanceM / 100));
}

/**
 * The rate a given sport is normally read in, with its unit.
 * Returns null when the activity is flagged, since a pace derived from a
 * duration we already know is wrong is worse than showing nothing.
 */
export function rate(
  sport: string,
  distanceM: number | null,
  durationS: number | null,
  flags: string[] = [],
): { value: string; unit: string } {
  if (flags.includes('implausible_duration')) return { value: '—', unit: '' };
  if (sport === 'swimming') return { value: swimPace(distanceM, durationS), unit: '/100m' };
  if (sport === 'cycling') return { value: speedKmh(distanceM, durationS), unit: 'km/h' };
  return { value: paceFrom(distanceM, durationS), unit: '/km' };
}

export function num(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function date(iso: string | Date, opts: Intl.DateTimeFormatOptions = {}): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...opts });
}

export function dateTime(iso: string | Date, tzOffsetMin?: number | null): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  // The activity's own local time is what the athlete remembers, so shift by
  // the offset recorded on the file rather than showing the viewer's timezone.
  const shifted = tzOffsetMin ? new Date(d.getTime() + tzOffsetMin * 60_000) : d;
  const time = shifted.toISOString().slice(11, 16);
  return `${date(d, { year: 'numeric' })} · ${time}`;
}

export const SPORT_COLOR: Record<string, string> = {
  running: 'var(--run)',
  cycling: 'var(--bike)',
  swimming: 'var(--swim)',
};

export function sportColor(sport: string): string {
  return SPORT_COLOR[sport] ?? 'var(--other)';
}

/** How a load number was arrived at, in words a person can act on. */
export const LOAD_METHOD_LABEL: Record<string, string> = {
  hr_tss: 'heart rate',
  pace_tss: 'pace',
  power_tss: 'power',
  swim_tss: 'swim pace',
  duration_estimate: 'estimated from duration',
  excluded_implausible: 'excluded — implausible duration',
  none: 'not scored',
};

export function formLabel(tsb: number): { label: string; color: string } {
  if (tsb > 25) return { label: 'Transition', color: 'var(--faint)' };
  if (tsb > 5) return { label: 'Fresh', color: 'var(--good)' };
  if (tsb >= -10) return { label: 'Neutral', color: 'var(--muted)' };
  if (tsb >= -30) return { label: 'Productive', color: 'var(--accent)' };
  return { label: 'Overreaching', color: 'var(--bad)' };
}

/**
 * File size in the unit a human would use.
 *
 * A typical FIT file is 20 KB to 2 MB, so a fixed MB unit renders almost every
 * real upload as "0.0 MB".
 */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
