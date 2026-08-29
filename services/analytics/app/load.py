"""Per-activity training load.

Several load models exist because no single one covers every session. Each is
computed where its inputs allow, and `load` selects between them by a documented
per-sport preference. `load_method` records which one won, so a chart can always
say how a number was arrived at.

Everything here is a pure function of a stream plus thresholds: no I/O, no
database. That is what lets `lab/` import it and lets the whole history be
recomputed from raw bytes when a model changes.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from .gap import adjusted_speed
from .streams import mean_max, normalised, resample_1hz, rolling_mean

CALC_VERSION = "load/1.0.0"

# Friel's HR zones as fractions of lactate threshold HR.
HR_ZONE_EDGES = (0.81, 0.89, 0.93, 0.99)
ZONE_NAMES = ("z1_recovery", "z2_aerobic", "z3_tempo", "z4_threshold", "z5_vo2max")


@dataclass(frozen=True)
class Thresholds:
    """Physiological thresholds in effect at a given moment.

    These are effective-dated in the database; the caller is responsible for
    passing the row that applies at the activity's start time, not the latest.
    """

    max_hr: int | None = None
    rest_hr: int | None = None
    lthr: int | None = None
    ftp_watts: int | None = None
    css_sec_per_100m: float | None = None
    threshold_pace_sec_per_km: float | None = None
    sex: str = "unspecified"

    @property
    def hr_reserve(self) -> int | None:
        if self.max_hr is None or self.rest_hr is None:
            return None
        span = self.max_hr - self.rest_hr
        return span if span > 20 else None


def _banister_weight(hr_reserve_frac: np.ndarray, sex: str) -> np.ndarray:
    """Banister's exponential intensity weighting.

    The exponent is what makes TRIMP non-linear in intensity: a minute at
    threshold counts several times a minute of easy running, which is why load
    must be integrated per sample rather than derived from an average heart
    rate. An interval session and a steady run can share a mean HR and differ
    in load by a wide margin.
    """
    if sex == "female":
        return 0.86 * np.exp(1.67 * hr_reserve_frac)
    return 0.64 * np.exp(1.92 * hr_reserve_frac)


def banister_trimp(hr_1hz: np.ndarray, t: Thresholds) -> float | None:
    """Banister TRIMP integrated over heart-rate reserve, per second."""
    reserve = t.hr_reserve
    if reserve is None or t.rest_hr is None:
        return None
    hr = hr_1hz[~np.isnan(hr_1hz)]
    if hr.size == 0:
        return None

    frac = np.clip((hr - t.rest_hr) / reserve, 0.0, 1.5)
    minutes = 1.0 / 60.0
    return float(np.sum(minutes * frac * _banister_weight(frac, t.sex)))


def trimp_at_threshold_per_hour(t: Thresholds) -> float | None:
    """TRIMP accrued by one hour held exactly at lactate threshold.

    This is the reference that converts TRIMP onto the TSS scale, where 100 is
    an hour at threshold. Deriving it from the athlete's own thresholds keeps
    hrTSS comparable with power- and pace-derived TSS for the same athlete.
    """
    reserve = t.hr_reserve
    if reserve is None or t.lthr is None or t.rest_hr is None:
        return None
    frac = np.array([(t.lthr - t.rest_hr) / reserve])
    per_min = float((frac * _banister_weight(frac, t.sex)).item())
    return per_min * 60.0 if per_min > 0 else None


def hr_tss(trimp: float | None, t: Thresholds) -> float | None:
    ref = trimp_at_threshold_per_hour(t)
    if trimp is None or ref is None or ref <= 0:
        return None
    return round(trimp / ref * 100.0, 1)


def _tss_from_if(duration_s: float, intensity: float, exponent: int) -> float:
    """TSS on the canonical scale: 100 = one hour at threshold."""
    return round((duration_s / 3600.0) * (intensity**exponent) * 100.0, 1)


def power_metrics(power_1hz: np.ndarray, t: Thresholds, duration_s: float) -> dict[str, Any]:
    """Normalised power, intensity factor, variability index and power TSS.

    Untested against real data: this corpus has essentially no power meter
    files. The model is standard and the code path is exercised by synthetic
    tests, but treat the first real numbers with suspicion.
    """
    out: dict[str, Any] = {}
    valid = power_1hz[~np.isnan(power_1hz)]
    if valid.size < 60:
        return out

    np_w = normalised(power_1hz, 30)
    if np_w is None:
        return out
    out["np_w"] = round(np_w, 1)
    avg = float(np.mean(valid))
    if avg > 0:
        out["variability_index"] = round(np_w / avg, 3)

    if t.ftp_watts:
        intensity = np_w / t.ftp_watts
        out["intensity_factor"] = round(intensity, 3)
        out["power_tss"] = _tss_from_if(duration_s, intensity, 2)
    return out


def pace_metrics(
    speed_1hz: np.ndarray, altitude_1hz: np.ndarray | None, t: Thresholds, duration_s: float
) -> dict[str, Any]:
    """Normalised graded pace and run TSS.

    Speed is grade-adjusted first, so a hilly run scores by effort rather than
    by the pace the terrain allowed.
    """
    out: dict[str, Any] = {}
    if speed_1hz.size < 60:
        return out

    gap = adjusted_speed(speed_1hz, altitude_1hz)
    ngp = normalised(gap, 30)
    if ngp is None or ngp <= 0:
        return out

    out["ngp_mps"] = round(ngp, 3)
    out["gap_sec_per_km"] = round(1000.0 / ngp, 1)

    if t.threshold_pace_sec_per_km:
        threshold_speed = 1000.0 / t.threshold_pace_sec_per_km
        intensity = ngp / threshold_speed
        out["intensity_factor"] = round(intensity, 3)
        out["pace_tss"] = _tss_from_if(duration_s, intensity, 2)
    return out


def swim_metrics(distance_m: float | None, duration_s: float | None, t: Thresholds) -> dict[str, Any]:
    """Swim TSS from average pace against critical swim speed.

    Cubed rather than squared: swimming resistance is dominated by hydrodynamic
    drag, so the cost of going faster rises more steeply than in running or
    cycling. Session pace includes rest between sets, which makes this a
    conservative estimate for interval sessions.
    """
    out: dict[str, Any] = {}
    if not distance_m or not duration_s or duration_s <= 0 or not t.css_sec_per_100m:
        return out

    pace = duration_s / (distance_m / 100.0)
    out["swim_pace_sec_per_100m"] = round(pace, 1)
    intensity = t.css_sec_per_100m / pace
    out["intensity_factor"] = round(intensity, 3)
    out["swim_tss"] = _tss_from_if(duration_s, intensity, 3)
    return out


def time_in_zones(hr_1hz: np.ndarray, t: Thresholds) -> dict[str, int] | None:
    """Seconds spent in each heart-rate zone, as fractions of threshold HR."""
    if not t.lthr:
        return None
    hr = hr_1hz[~np.isnan(hr_1hz)]
    if hr.size == 0:
        return None
    edges = [t.lthr * e for e in HR_ZONE_EDGES]
    idx = np.digitize(hr, edges)
    return {name: int(np.sum(idx == i)) for i, name in enumerate(ZONE_NAMES)}


def decoupling(effort_1hz: np.ndarray, hr_1hz: np.ndarray) -> float | None:
    """Aerobic decoupling: drift in effort-per-heartbeat, first half vs second.

    A durability signal. A ride held at steady output whose heart rate climbs
    through the second half is running out of aerobic endurance; under about 5%
    is generally read as well-supported for the duration.
    """
    n = min(effort_1hz.size, hr_1hz.size)
    if n < 1200:  # under 20 minutes the two halves are too noisy to compare
        return None

    half = n // 2
    ratios = []
    for lo, hi in ((0, half), (half, n)):
        eff = effort_1hz[lo:hi]
        hr = hr_1hz[lo:hi]
        ok = ~np.isnan(eff) & ~np.isnan(hr) & (hr > 0)
        if ok.sum() < 300:
            return None
        ratios.append(float(np.mean(eff[ok]) / np.mean(hr[ok])))

    if ratios[0] == 0:
        return None
    return round((ratios[0] - ratios[1]) / ratios[0] * 100.0, 2)


# Which model to trust per sport, best first.
# Which model to trust per sport, best first.
#
# The default is heart-rate-first across every sport, which is a consistency
# choice rather than a precision one. Pace and power are better models of a
# single session, but switching model between sessions puts steps in the
# fitness curve that no training explains: on this corpus pace scores 1.38x
# heart rate for the *same* runs, so a winter of treadmill work — scored by HR
# because treadmill distance is user-calibrated — would read as a fitness
# collapse that never happened.
#
# Once thresholds are confirmed by field test and a power meter is in use,
# PRECISION_PREFERENCE below is the better setting: it takes the best available
# model per activity, the way TrainingPeaks does.
CONSISTENCY_PREFERENCE = {
    "cycling": ("hr_tss", "power_tss"),
    "running": ("hr_tss", "pace_tss"),
    # Swim pace includes rest between sets and the cubic intensity term
    # amplifies that: a 45-minute swim here scored 4.3 by pace against 32.7 by
    # heart rate. Pace becomes the better choice once lap data separates work
    # from rest.
    "swimming": ("hr_tss", "swim_tss"),
    "rowing": ("hr_tss", "power_tss"),
}

PRECISION_PREFERENCE = {
    "cycling": ("power_tss", "hr_tss"),
    "running": ("power_tss", "pace_tss", "hr_tss"),
    "swimming": ("swim_tss", "hr_tss"),
    "rowing": ("power_tss", "hr_tss"),
}

PREFERENCE_SETS = {
    "consistency": CONSISTENCY_PREFERENCE,
    "precision": PRECISION_PREFERENCE,
}

METHOD_PREFERENCE = CONSISTENCY_PREFERENCE
DEFAULT_PREFERENCE = ("hr_tss",)


def compute_load(
    summary: dict[str, Any],
    df,
    thresholds: Thresholds,
    preference: str = "consistency",
) -> dict[str, Any]:
    """Compute every available load metric for one activity.

    `preference` selects between the consistency-first and precision-first
    method orderings. Every model that could be computed is returned regardless
    of which one wins, so switching the setting is a recompute, not a re-ingest.
    """
    preferences = PREFERENCE_SETS.get(preference, CONSISTENCY_PREFERENCE)
    duration_s = summary.get("moving_s") or summary.get("duration_s") or 0.0
    sport = summary.get("sport", "other")
    flags = set(summary.get("quality_flags") or [])

    result: dict[str, Any] = {"calc_version": CALC_VERSION}

    wanted = ["heart_rate", "power_w", "speed_mps", "altitude_m", "distance_m"]
    grid = resample_1hz(df, wanted) if df is not None and getattr(df, "height", 0) else {}
    hr = grid.get("heart_rate")
    power = grid.get("power_w")
    speed = grid.get("speed_mps")
    altitude = grid.get("altitude_m")

    if hr is not None:
        trimp = banister_trimp(hr, thresholds)
        result["trimp"] = round(trimp, 1) if trimp is not None else None
        result["hr_tss"] = hr_tss(trimp, thresholds)
        result["avg_hr_computed"] = round(float(np.nanmean(hr)), 1)
        zones = time_in_zones(hr, thresholds)
        if zones:
            result["time_in_zones"] = zones

    if power is not None:
        result.update(power_metrics(power, thresholds, duration_s))

    # Treadmill distance is user-calibrated after the fact and the stream is not
    # rewritten to match, so grade-adjusted pace off that stream is wrong by up
    # to 10%. Better to fall through to heart rate than to publish a confident
    # wrong number.
    pace_is_trustworthy = (
        speed is not None
        and sport == "running"
        and "stream_distance_diverges" not in flags
        and summary.get("sub_sport") != "treadmill"
    )
    if pace_is_trustworthy:
        result.update(pace_metrics(speed, altitude, thresholds, duration_s))

    if sport == "swimming":
        result.update(swim_metrics(summary.get("distance_m"), duration_s, thresholds))

    # Efficiency factor and decoupling both need a steady effort signal paired
    # with heart rate. Grade-adjusted speed stands in for power when there is no
    # meter, which is the case for this entire corpus.
    effort = power if power is not None else (speed if pace_is_trustworthy else None)
    if effort is not None and hr is not None:
        result["decoupling_pct"] = decoupling(effort, hr)
        mean_hr = float(np.nanmean(hr))
        mean_effort = float(np.nanmean(effort))
        if mean_hr > 0:
            result["efficiency_factor"] = round(mean_effort / mean_hr, 4)

    # Disagreement between two independently-anchored models is a threshold
    # problem, not a rounding one. Surfacing it makes a bad LTHR or threshold
    # pace visible instead of silently rescaling the fitness curve.
    if result.get("pace_tss") and result.get("hr_tss"):
        result["model_agreement"] = round(result["pace_tss"] / result["hr_tss"], 3)

    for method in preferences.get(sport, DEFAULT_PREFERENCE):
        value = result.get(method)
        if value is not None:
            result["load"] = value
            result["load_method"] = method
            break
    else:
        # No direct model applies. The caller fills this from the athlete's own
        # historical load rate for the sport; leaving it null would silently
        # erase the session from the fitness curve.
        result["load"] = None
        result["load_method"] = "none"

    return result
