import { env } from './env.js';

export interface ParseSummary {
  sport: string;
  sub_sport: string | null;
  raw_sport: string | null;
  start_time: string;
  tz_offset_min: number | null;
  duration_s: number | null;
  moving_s: number | null;
  distance_m: number | null;
  elev_gain_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_power_w: number | null;
  max_power_w: number | null;
  avg_cadence: number | null;
  calories: number | null;
  device: string | null;
  sample_count: number;
  channels: string[];
  quality_flags: string[];
  parser_version: string;
}

export interface ParseResponse {
  summary: ParseSummary;
  dedupe_key: string;
  streams_key: string | null;
  streams_bytes: number;
}

/** Thrown for input the analytics service can never parse; retrying is pointless. */
export class UnparseableError extends Error {}

export async function parseBlob(blobKey: string, activityId: string): Promise<ParseResponse> {
  const res = await fetch(`${env.analyticsUrl}/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blob_key: blobKey, activity_id: activityId }),
    signal: AbortSignal.timeout(120_000),
  });

  if (res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new UnparseableError(body.detail ?? 'unparseable file');
  }
  if (!res.ok) {
    throw new Error(`analytics ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as ParseResponse;
}

export interface ThresholdSet {
  max_hr: number | null;
  rest_hr: number | null;
  lthr: number | null;
  ftp_watts: number | null;
  css_sec_per_100m: number | null;
  threshold_pace_sec_per_km: number | null;
  sex: string;
}

export interface LoadResult {
  load: number | null;
  load_method: string;
  trimp?: number | null;
  hr_tss?: number | null;
  pace_tss?: number | null;
  power_tss?: number | null;
  swim_tss?: number | null;
  intensity_factor?: number | null;
  np_w?: number | null;
  variability_index?: number | null;
  ngp_mps?: number | null;
  gap_sec_per_km?: number | null;
  swim_pace_sec_per_100m?: number | null;
  efficiency_factor?: number | null;
  decoupling_pct?: number | null;
  time_in_zones?: Record<string, number> | null;
  /** pace_tss / hr_tss where both exist; far from 1.0 means a threshold is off. */
  model_agreement?: number | null;
  calc_version: string;
}

export interface PmcDay {
  date: string;
  load: number;
  ctl: number;
  atl: number;
  tsb: number;
  ramp_rate: number;
  weekly_load: number;
  monotony: number;
  strain: number;
  acwr: number;
  calc_version: string;
}

async function post<T>(path: string, body: unknown, timeoutMs = 180_000): Promise<T> {
  const res = await fetch(`${env.analyticsUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`analytics ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export function computeLoad(
  summary: Record<string, unknown>,
  streamsKey: string | null,
  thresholds: ThresholdSet,
  preference: 'consistency' | 'precision' = 'consistency',
): Promise<LoadResult> {
  return post<LoadResult>('/load', {
    summary,
    streams_key: streamsKey,
    thresholds,
    preference,
  });
}

export function computePmc(
  daily: Record<string, number>,
  end?: string,
): Promise<{ series: PmcDay[]; latest: (PmcDay & { form: string }) | null }> {
  return post('/pmc', { daily, end });
}

export function estimateThresholds(
  activities: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  return post('/thresholds/estimate', { activities }, 300_000);
}
