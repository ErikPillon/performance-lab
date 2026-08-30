/** Typed client for the read API. Requests go through the Vite proxy at /api. */

const BASE = '/api';

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return (await res.json()) as T;
}

export interface Athlete {
  id: string;
  displayName: string;
  sex: string;
  timezone: string;
  activities: number;
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

export const api = {
  athletes: () => get<{ athletes: Athlete[] }>('/athletes'),
  summary: (id: string) => get<Summary>(`/athletes/${id}/summary`),
  pmc: (id: string, from?: string, to?: string) =>
    get<{ series: PmcDay[] }>(`/athletes/${id}/pmc`, { from, to }),
  activities: (id: string, params: { limit?: number; offset?: number; sport?: string } = {}) =>
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
  streams: (id: string, points = 1500) =>
    get<StreamPayload>(`/activities/${id}/streams`, { points }),
};
