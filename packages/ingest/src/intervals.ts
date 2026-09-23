import { RateLimited } from './rateLimit.js';

/**
 * intervals.icu, used as a bridge to the watch's original file.
 *
 * It is an approved partner of Garmin, Polar, Suunto, Coros and Wahoo, so the
 * athlete's own watch sync lands there within minutes, and its API hands back
 * the file exactly as the device wrote it. That makes it the one free route to
 * the *original* FIT for an individual: Garmin's program is business-only and
 * paused, and Strava's API returns derived streams under a seven-day retention
 * limit. Everything downloaded here goes through the same `ingestBytes` as a
 * browser upload, so it dedupes against files already imported by hand.
 *
 * Authentication is the athlete's personal API key (intervals.icu → Settings →
 * Developer Settings). OAuth exists, but an OAuth app needs intervals.icu to
 * approve it and its webhooks need a public callback; the key needs neither.
 */

const API = 'https://intervals.icu/api/v1';

/**
 * intervals.icu sits behind Cloudflare, which is known to challenge generic
 * client user agents. Saying what this is avoids that and is polite besides.
 */
const USER_AGENT = 'performance-lab/1.0 (self-hosted training analytics)';

/** Only what the planner needs; the full activity object is large. */
const LIST_FIELDS = 'id,start_date,start_date_local,type,file_type,source';

/** The key was rejected: revoked, mistyped, or regenerated since. */
export class IntervalsAuthError extends Error {
  readonly needsReauth = true;
  constructor(status: number) {
    super(`intervals.icu rejected the API key (${status}) — it may have been regenerated`);
  }
}

export interface IntervalsActivity {
  id: string;
  start_date?: string | null;
  start_date_local?: string | null;
  type?: string | null;
  /** `fit`, `gpx`, `tcx` — absent for a manually entered activity. */
  file_type?: string | null;
  /** Where intervals.icu got it: `GARMIN_CONNECT`, `STRAVA`, `UPLOAD`, … */
  source?: string | null;
}

async function call(apiKey: string, path: string, params?: Record<string, string>): Promise<Response> {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: {
      // Basic auth with the literal username API_KEY; bearer is for OAuth tokens.
      authorization: `Basic ${Buffer.from(`API_KEY:${apiKey}`).toString('base64')}`,
      'user-agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (res.status === 429) {
    const seconds = Number(res.headers.get('retry-after'));
    throw new RateLimited(
      'intervals.icu',
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 15 * 60_000,
    );
  }
  if (res.status === 401 || res.status === 403) throw new IntervalsAuthError(res.status);
  if (!res.ok) throw new Error(`intervals.icu ${path} returned ${res.status}`);
  return res;
}

/** Whose key this is. Doubles as the check that a pasted key works at all. */
export async function intervalsAthlete(apiKey: string): Promise<{ id: string; name: string | null }> {
  // Athlete id 0 means "whoever the key belongs to".
  const body = (await (await call(apiKey, '/athlete/0')).json()) as { id: string; name?: string };
  return { id: String(body.id), name: body.name ?? null };
}

/** Every activity started on or after `oldest`'s date, in no promised order. */
export async function listIntervalsActivities(
  apiKey: string,
  oldest: Date,
  now = new Date(),
): Promise<IntervalsActivity[]> {
  // `newest` is inclusive by date; tomorrow keeps a session that started late
  // this evening in another timezone from waiting a day.
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const res = await call(apiKey, '/athlete/0/activities', {
    oldest: isoDate(oldest),
    newest: isoDate(tomorrow),
    fields: LIST_FIELDS,
  });
  return (await res.json()) as IntervalsActivity[];
}

/**
 * The file for one activity. `original` is exactly what the device recorded;
 * `generated` is intervals.icu's FIT rendering, used only when the original is
 * a GPX or TCX this pipeline cannot decode. Both arrive gzipped, which
 * `ingestBytes` unwraps.
 */
export async function downloadIntervalsFile(
  apiKey: string,
  id: string,
  kind: 'original' | 'generated',
): Promise<Buffer> {
  const path = kind === 'original' ? `/activity/${id}/file` : `/activity/${id}/fit-file`;
  return Buffer.from(await (await call(apiKey, path)).arrayBuffer());
}

export interface ImportPlan {
  toImport: { id: string; startedAt: Date; kind: 'original' | 'generated' }[];
  /** Listed but not fetchable: manual entries, and anything that came from Strava. */
  skipped: number;
}

/**
 * Which listed activities to fetch, oldest first.
 *
 * Strictly after the cursor, because the list is requested by date and the
 * cursor's own day comes back every time. Oldest first so the cursor can
 * advance per activity and an interrupted run resumes rather than restarts.
 *
 * Strava-sourced activities are skipped: intervals.icu does not pass Strava
 * data on through its API, and Strava's own terms forbid keeping it. Manual
 * entries have no file to fetch.
 */
export function planImports(list: IntervalsActivity[], after: Date | null): ImportPlan {
  const toImport: ImportPlan['toImport'] = [];
  let skipped = 0;

  for (const a of list) {
    const startedAt = new Date(a.start_date ?? a.start_date_local ?? NaN);
    if (Number.isNaN(startedAt.getTime())) { skipped++; continue; }
    if (after && startedAt <= after) continue;
    if (a.source === 'STRAVA' || !a.file_type) { skipped++; continue; }
    toImport.push({
      id: String(a.id),
      startedAt,
      kind: a.file_type.toLowerCase() === 'fit' ? 'original' : 'generated',
    });
  }

  toImport.sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime());
  return { toImport, skipped };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
