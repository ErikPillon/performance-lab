import { resolveThresholdsAt } from '@lab/db';
import type { ThresholdSet } from './analytics.js';

/**
 * Thresholds in effect for an athlete at an instant, shaped for the analytics
 * service. Resolution is per-field and effective-dated; see
 * `resolveThresholdsAt` in @lab/db for why.
 */
export async function resolveThresholds(athleteId: string, at: Date): Promise<ThresholdSet> {
  const resolved = await resolveThresholdsAt(athleteId, at);
  return {
    max_hr: resolved.max_hr,
    rest_hr: resolved.rest_hr,
    lthr: resolved.lthr,
    ftp_watts: resolved.ftp_watts,
    css_sec_per_100m: resolved.css_sec_per_100m,
    threshold_pace_sec_per_km: resolved.threshold_pace_sec_per_km,
    sex: resolved.sex,
  };
}
