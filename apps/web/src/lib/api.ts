/** Typed client for the read API. Requests go through the Vite proxy at /api. */

const BASE = '/api';

/** Thrown for 401 so the app can show the sign-in screen rather than an error. */
export class NotSignedInError extends Error {
  constructor() {
    super('not signed in');
  }
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  // Session cookie travels with every request; same origin, so no CORS dance.
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 401) throw new NotSignedInError();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return (await res.json()) as T;
}

export type Scope = 'training' | 'wellness' | 'location';

export interface Athlete {
  id: string;
  displayName: string;
  sex: string;
  timezone: string;
  activities: number;
  relationship?: 'owner' | 'coach';
  scopes?: Scope[];
}

export interface Me {
  user: { userId: string; email: string; name: string } | null;
  athletes: { athleteId: string; scopes: Scope[]; relationship: 'owner' | 'coach' }[];
  signupOpen: boolean;
}

export interface Grant {
  id: string;
  status: 'pending' | 'active' | 'revoked';
  scopes: Scope[];
  note: string | null;
  inviteCode: string;
  createdAt: string;
  expiresAt: string | null;
  acceptedAt: string | null;
  coachName: string | null;
  coachEmail: string | null;
}

export interface PmcDay {
  date: string;
  load: number;
  ctl: number;
  atl: number;
  tsb: number;
  rampRate: number;
  weeklyLoad: number;
  monotony: number;
  acwr: number;
  activities: number;
  durationS: number;
}

export interface ActivityRow {
  id: string;
  startTime: string;
  tzOffsetMin: number | null;
  sport: string;
  subSport: string | null;
  durationS: number | null;
  movingS: number | null;
  distanceM: number | null;
  elevGainM: number | null;
  avgHr: number | null;
  maxHr: number | null;
  calories: number | null;
  qualityFlags: string[];
  hasStreams: boolean;
  load: number | null;
  loadMethod: string | null;
  trimp: number | null;
  intensityFactor: number | null;
  gapSecPerKm: number | null;
  decouplingPct: number | null;
  efficiencyFactor: number | null;
}

export interface Thresholds {
  effectiveFrom: string;
  /** Which dated entry each value was resolved from, keyed by snake_case field. */
  sources?: Record<string, string>;
  maxHr: number | null;
  restHr: number | null;
  lthr: number | null;
  ftpWatts: number | null;
  cssSecPer100m: number | null;
  thresholdPaceSecPerKm: number | null;
  note: string | null;
}

export interface Summary {
  athlete: Athlete;
  current: PmcDay | null;
  totals: {
    activities: number;
    excluded: number;
    durationS: number;
    distanceM: number;
    first: string | null;
    last: string | null;
  };
  thresholds: Thresholds | null;
  bySport: { sport: string; activities: number; durationS: number; distanceM: number; load: number }[];
}

export interface StreamPayload {
  key: string | null;
  sample_count: number;
  returned: number;
  channels: string[];
  series: Record<string, (number | null)[]>;
}

export interface ActivityDetail {
  activity: Omit<ActivityRow, 'load' | 'loadMethod' | 'gapSecPerKm'> & {
    channels: string[];
    device: string | null;
    rawSport: string | null;
  };
  /** The activity_load row; null until the load job has run. */
  load: Record<string, unknown> | null;
  thresholds: Thresholds | null;
}

export interface ThresholdRow extends Thresholds {
  id: string;
  athleteId: string;
  weightKg: number | null;
  createdAt: string;
}

export interface RecomputeStatus {
  job: {
    id: string;
    state: string;
    progress: { phase?: string; done?: number; total?: number; message?: string } | number;
    failedReason: string | null;
    finishedOn: number | null;
  } | null;
  currentVersion: string | null;
  versions: { version: string; n: number }[];
  staleRows: number;
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (payload as { errors?: string[]; error?: string });
    throw new Error(detail.errors?.join('; ') ?? detail.error ?? `${res.status} ${res.statusText}`);
  }
  return payload as T;
}

export interface CurvePoint {
  durationS: number;
  value: number;
  activityId: string;
  startTime: string;
}

export interface CurveResponse {
  sport: string;
  metric: string | null;
  points: CurvePoint[];
  critical: {
    critical_speed_mps: number;
    d_prime_m: number;
    r_squared: number;
    points: number;
  } | null;
  /** Empty for channels that do not measure distance, e.g. a heart-rate curve. */
  predictions: RacePrediction[];
  /** Running only — Daniels' equations are fitted to running economy. */
  vdot: { vdot: number; from_duration_s: number; equivalent_5k_s: number } | null;
  available: string[];
}

export interface TrendPointRow {
  activityId: string;
  startTime: string;
  efficiencyFactor: number | null;
  decouplingPct: number | null;
  avgHr: number | null;
  durationS: number | null;
  distanceM: number | null;
}

export interface TrendsResponse {
  sport: string;
  available: { sport: string; activities: number; withEf: number; withDecoupling: number }[];
  /**
   * Split by effort source as well as sport: efficiency factor is watts per
   * beat with a power meter and metres-per-second per beat without, which are
   * roughly sixty times apart and must never share a line.
   */
  groups: {
    effortSource: 'power' | 'speed';
    unit: string;
    points: TrendPointRow[];
  }[];
}

export interface UploadOutcome {
  filename: string;
  status: 'queued' | 'duplicate' | 'rejected';
  rawFileId?: string;
  sha256?: string;
  reason?: string;
}

/**
 * Upload one file, reporting progress as it goes.
 *
 * XMLHttpRequest rather than fetch: fetch still has no upload progress events,
 * and a 25 MB FIT file over a home connection is long enough that a progress
 * bar is the difference between "working" and "broken".
 *
 * One file per request, run with small concurrency by the caller. The endpoint
 * accepts many at once, but then progress is only known for the batch, and a
 * season of exports becomes one half-gigabyte request that fails whole.
 */
export function uploadFile(
  athleteId: string,
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/athletes/${athleteId}/files`);
    // The session cookie is what authorises this; same origin, but XHR needs
    // telling explicitly.
    xhr.withCredentials = true;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    });

    xhr.addEventListener('load', () => {
      if (xhr.status === 401) return reject(new NotSignedInError());
      let body: { accepted?: UploadOutcome[]; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        return reject(new Error(`${xhr.status} ${xhr.statusText}`));
      }
      if (xhr.status >= 400) return reject(new Error(body.error ?? `${xhr.status}`));
      const outcome = body.accepted?.[0];
      // A 202 with nothing in it would otherwise show as a silent success.
      if (!outcome) return reject(new Error('server accepted nothing'));
      resolve(outcome);
    });

    xhr.addEventListener('error', () => reject(new Error('network error during upload')));
    xhr.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    xhr.send(form);
  });
}

export interface ZoneTrendResponse {
  bucket: 'week' | 'month';
  periods: { start: string; zones: Record<string, number> }[];
}

export interface WellnessEntry {
  date: string;
  restingHr: number | null;
  hrvRmssdMs: number | null;
  sleepHours: number | null;
  sleepScore: number | null;
  weightKg: number | null;
  feel: number | null;
  note: string | null;
  source: string;
  recordedAt: string;
}

export interface WellnessResponse {
  entries: WellnessEntry[];
  coverage: {
    days: number;
    withRestingHr: number;
    withHrv: number;
    withWeight: number;
    withSleep: number;
  } | null;
}

/** What the athlete's resting heart rate actually measures, for the threshold. */
export interface RestingHrSuggestion {
  days: number;
  samples: number;
  /** Null until there are enough mornings to mean anything. */
  suggestion: number | null;
  median: number | null;
  low: number | null;
  first: string | null;
  last: string | null;
}

export interface RaceRow {
  id: string;
  date: string;
  name: string;
  sport: string;
  priority: 'A' | 'B' | 'C';
  distanceM: number | null;
  goalTimeS: number | null;
  resultTimeS: number | null;
  activityId: string | null;
  note: string | null;
}

export interface BlockRow {
  id: string;
  name: string;
  focus: string;
  startDate: string;
  endDate: string;
  targetWeeklyLoad: number | null;
  raceId: string | null;
  note: string | null;
}

export interface RacePrediction {
  label?: string;
  distance_m: number;
  /** One entry per model that had something defensible to say. */
  estimates: Record<string, number>;
  seconds: number;
  low_s: number;
  high_s: number;
  reference: { duration_s: number; distance_m: number; speed_mps: number };
  /** How far past the effort it is extrapolated from. Above ~4 it is refused. */
  extrapolation_ratio: number;
  confidence: 'high' | 'moderate' | 'low';
}

export interface ConnectionRow {
  provider: 'strava';
  status: 'active' | 'needs_reauth' | 'error' | 'disconnected';
  syncedThrough: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  importedCount: number;
  scope: string | null;
  createdAt: string;
}

export interface ConnectionsResponse {
  connections: ConnectionRow[];
  /** Whether the server has credentials at all; without them the UI hides it. */
  providers: { strava: { configured: boolean } };
  canManage: boolean;
}

export interface SubscriptionStatus {
  configured: boolean;
  subscription: { id: number; callback_url: string } | null;
  callbackUrl?: string;
  /** Whether Strava could plausibly reach the callback from the internet. */
  reachable?: boolean;
}

export const api = {
  me: () => get<Me>('/me'),
  athletes: () => get<{ athletes: Athlete[] }>('/athletes'),
  grants: (id: string) => get<{ grants: Grant[] }>(`/athletes/${id}/grants`),
  createGrant: (id: string, body: { scopes: Scope[]; note?: string; expiresInDays?: number }) =>
    send<{ grant: Grant }>(`/athletes/${id}/grants`, 'POST', body),
  revokeGrant: (id: string, grantId: string) =>
    send<{ revoked: number }>(`/athletes/${id}/grants/${grantId}`, 'DELETE'),
  acceptInvite: (code: string) =>
    send<{ grant: Grant; athlete: string | null }>('/grants/accept', 'POST', { code }),
  coaching: () =>
    get<{ coaching: { athleteId: string; displayName: string; scopes: Scope[]; since: string }[] }>(
      '/coaching',
    ),
  summary: (id: string) => get<Summary>(`/athletes/${id}/summary`),
  pmc: (id: string, from?: string, to?: string) =>
    get<{ series: PmcDay[] }>(`/athletes/${id}/pmc`, { from, to }),
  activities: (
    id: string,
    params: { limit?: number; offset?: number; sport?: string; from?: string; to?: string } = {},
  ) =>
    get<{ activities: ActivityRow[]; total: number; limit: number; offset: number }>(
      `/athletes/${id}/activities`,
      params,
    ),
  zones: (id: string, from?: string, to?: string) =>
    get<{ zones: { zone: string; seconds: number }[] }>(`/athletes/${id}/zones`, { from, to }),
  activity: (id: string) => get<ActivityDetail>(`/activities/${id}`),
  thresholds: (id: string) => get<{ thresholds: ThresholdRow[] }>(`/athletes/${id}/thresholds`),
  saveThresholds: (id: string, body: Record<string, unknown>) =>
    send<{ threshold: ThresholdRow; advisories: string[]; recomputeRequired: boolean }>(
      `/athletes/${id}/thresholds`,
      'POST',
      body,
    ),
  deleteThreshold: (id: string, effectiveFrom: string) =>
    send<{ deleted: number }>(`/athletes/${id}/thresholds/${effectiveFrom}`, 'DELETE'),
  recompute: (id: string, body: { estimateThresholds?: boolean } = {}) =>
    send<{ jobId: string }>(`/athletes/${id}/recompute`, 'POST', body),
  recomputeStatus: (id: string) => get<RecomputeStatus>(`/athletes/${id}/recompute`),
  curve: (id: string, params: { sport?: string; metric?: string; from?: string; to?: string } = {}) =>
    get<CurveResponse>(`/athletes/${id}/curve`, params),
  curveSports: (id: string) =>
    get<{ sports: { sport: string; activities: number }[] }>(`/athletes/${id}/curve/sports`),
  streams: (id: string, points = 1500) =>
    get<StreamPayload>(`/activities/${id}/streams`, { points }),
  trends: (id: string, params: { sport?: string; from?: string; to?: string } = {}) =>
    get<TrendsResponse>(`/athletes/${id}/trends`, params),
  zonesTrend: (
    id: string,
    params: { bucket?: 'week' | 'month'; sport?: string; from?: string; to?: string } = {},
  ) => get<ZoneTrendResponse>(`/athletes/${id}/zones/trend`, params),
  wellness: (id: string, params: { from?: string; to?: string; limit?: number } = {}) =>
    get<WellnessResponse>(`/athletes/${id}/wellness`, params),
  saveWellness: (id: string, body: Record<string, unknown>) =>
    send<{ entry: WellnessEntry; advisories: string[] }>(`/athletes/${id}/wellness`, 'POST', body),
  deleteWellness: (id: string, date: string) =>
    send<{ deleted: number }>(`/athletes/${id}/wellness/${date}`, 'DELETE'),
  restingHrSuggestion: (id: string, days = 60) =>
    get<RestingHrSuggestion>(`/athletes/${id}/wellness/resting-hr`, { days }),
  season: (id: string, params: { from?: string; to?: string } = {}) =>
    get<{ races: RaceRow[]; blocks: BlockRow[] }>(`/athletes/${id}/season`, params),
  saveRace: (id: string, body: Record<string, unknown>, raceId?: string) =>
    send<{ race: RaceRow }>(
      raceId ? `/athletes/${id}/races/${raceId}` : `/athletes/${id}/races`,
      raceId ? 'PATCH' : 'POST',
      body,
    ),
  deleteRace: (id: string, raceId: string) =>
    send<{ deleted: number }>(`/athletes/${id}/races/${raceId}`, 'DELETE'),
  saveBlock: (id: string, body: Record<string, unknown>, blockId?: string) =>
    send<{ block: BlockRow; advisories: string[] }>(
      blockId ? `/athletes/${id}/blocks/${blockId}` : `/athletes/${id}/blocks`,
      blockId ? 'PATCH' : 'POST',
      body,
    ),
  deleteBlock: (id: string, blockId: string) =>
    send<{ deleted: number }>(`/athletes/${id}/blocks/${blockId}`, 'DELETE'),
  racePredictions: (id: string) =>
    get<{ predictions: Record<string, RacePrediction> }>(`/athletes/${id}/races/predictions`),
  connections: (id: string) => get<ConnectionsResponse>(`/athletes/${id}/connections`),
  connectStrava: (id: string) =>
    send<{ url: string }>(`/athletes/${id}/connections/strava`, 'POST'),
  disconnectStrava: (id: string) =>
    send<{ disconnected: number }>(`/athletes/${id}/connections/strava`, 'DELETE'),
  syncStrava: (id: string) =>
    send<{ jobId: string; alreadyRunning: boolean }>(
      `/athletes/${id}/connections/strava/sync`, 'POST',
    ),
  stravaSubscription: (id: string) =>
    get<SubscriptionStatus>(`/athletes/${id}/connections/strava/subscription`),
  createStravaSubscription: (id: string) =>
    send<{ subscription: { id: number } }>(
      `/athletes/${id}/connections/strava/subscription`, 'POST',
    ),
  deleteStravaSubscription: (id: string, subscriptionId: number) =>
    send<{ deleted: boolean }>(
      `/athletes/${id}/connections/strava/subscription/${subscriptionId}`, 'DELETE',
    ),
};
