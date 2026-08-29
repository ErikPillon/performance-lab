"""Estimate physiological thresholds from an athlete's own history.

Most people do not know their LTHR or threshold pace, and a load model is only
as good as the thresholds it is scaled against. These estimates come from
mean-maximal efforts already present in the training history, so the numbers are
grounded in what the athlete has actually done rather than in a formula applied
to their age.

Every estimate carries its provenance and every result says what it was derived
from, because these are starting points to be corrected, not measurements.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .gap import adjusted_speed
from .streams import mean_max, resample_1hz

ESTIMATOR_VERSION = "thresholds/1.0.0"

# Resting HR cannot be recovered from activity files — it is a morning
# measurement, and the lowest value inside a workout is a warm-up artefact, not
# a resting rate. This default is typical for a trained endurance athlete and is
# flagged so it gets corrected rather than trusted.
DEFAULT_REST_HR = 50

# An estimate drawn from too few efforts is worse than no estimate: it looks
# authoritative and silently rescales every load number derived from it.
MIN_ACTIVITIES = {"power": 3, "run_pace": 5, "hr": 3, "swim": 5}

# Lactate threshold usually sits at 85-92% of maximum heart rate. Outside that
# band the inputs are more likely wrong than the athlete unusual.
LTHR_FRACTION_RANGE = (0.80, 0.92)


def _best_over(samples: list[np.ndarray], window_s: int) -> float | None:
    best = [m for s in samples if (m := mean_max(s, window_s)) is not None]
    return max(best) if best else None


def estimate(activities: list[dict[str, Any]]) -> dict[str, Any]:
    """Estimate thresholds from parsed activities.

    Each item needs `sport`, `duration_s`, `distance_m`, `quality_flags`,
    `sub_sport` and a `frame` (the per-sample Polars frame).
    """
    hr_samples: list[np.ndarray] = []
    power_samples: list[np.ndarray] = []
    run_gap_samples: list[np.ndarray] = []
    swim_paces: list[float] = []

    for act in activities:
        frame = act.get("frame")
        flags = set(act.get("quality_flags") or [])
        sport = act.get("sport")

        if frame is not None and getattr(frame, "height", 0):
            grid = resample_1hz(frame, ["heart_rate", "power_w", "speed_mps", "altitude_m"])
            if (hr := grid.get("heart_rate")) is not None:
                hr_samples.append(hr)
            if (power := grid.get("power_w")) is not None:
                power_samples.append(power)
            # Treadmill distance is user-calibrated and its stream is not, so
            # pace from those files would corrupt a threshold-pace estimate.
            if (
                sport == "running"
                and (speed := grid.get("speed_mps")) is not None
                and "stream_distance_diverges" not in flags
                and act.get("sub_sport") != "treadmill"
            ):
                run_gap_samples.append(adjusted_speed(speed, grid.get("altitude_m")))

        if (
            sport == "swimming"
            and (dist := act.get("distance_m"))
            and (dur := act.get("duration_s"))
            and dist >= 400
            and "implausible_duration" not in flags
        ):
            swim_paces.append(dur / (dist / 100.0))

    sources: dict[str, str] = {}
    warnings: list[str] = []
    out: dict[str, Any] = {"estimator_version": ESTIMATOR_VERSION}
    enough = lambda kind, n: n >= MIN_ACTIVITIES[kind]  # noqa: E731

    # --- Maximum heart rate -------------------------------------------------
    # Best 5-second average rather than the single highest sample: a lone spike
    # is usually an electrical artefact from a slipping strap.
    if len(hr_samples) < MIN_ACTIVITIES["hr"]:
        warnings.append(
            f"only {len(hr_samples)} activities with heart rate; "
            "HR thresholds not estimated"
        )
    elif (peak := _best_over(hr_samples, 5)) is not None:
        out["max_hr"] = int(round(peak))
        sources["max_hr"] = "best 5s mean-max across all activities"

    # --- Lactate threshold heart rate --------------------------------------
    # Classically the highest heart rate sustainable for roughly an hour. Where
    # no hour-long hard effort exists, the standard 20-minute test correction
    # applies instead.
    if enough("hr", len(hr_samples)):
        if (hour := _best_over(hr_samples, 3600)) is not None:
            out["lthr"] = int(round(hour))
            sources["lthr"] = "best 60min mean-max HR"
        elif (twenty := _best_over(hr_samples, 1200)) is not None:
            out["lthr"] = int(round(twenty * 0.95))
            sources["lthr"] = "best 20min mean-max HR x 0.95"

    lthr, max_hr = out.get("lthr"), out.get("max_hr")
    if lthr and max_hr:
        fraction = lthr / max_hr
        lo, hi = LTHR_FRACTION_RANGE
        if not lo <= fraction <= hi:
            warnings.append(
                f"estimated LTHR is {fraction:.0%} of max HR ({lthr}/{max_hr}), outside the "
                f"usual {lo:.0%}-{hi:.0%} band. Either the best sustained effort was a hard "
                "race that overstates threshold, or true max HR is higher than anything "
                "recorded. Worth confirming with a field test."
            )

    out["rest_hr"] = DEFAULT_REST_HR
    sources["rest_hr"] = "DEFAULT - not derivable from activity files, please measure and correct"

    # --- Functional threshold power ----------------------------------------
    if not enough("power", len(power_samples)):
        if power_samples:
            warnings.append(
                f"only {len(power_samples)} "
                f"{'activity carries' if len(power_samples) == 1 else 'activities carry'} power; "
                f"FTP needs at least {MIN_ACTIVITIES['power']} and is not estimated"
            )
    elif (twenty_min_power := _best_over(power_samples, 1200)) is not None:
        out["ftp_watts"] = int(round(twenty_min_power * 0.95))
        sources["ftp_watts"] = "best 20min mean-max power x 0.95"

    # --- Threshold running pace --------------------------------------------
    # Best grade-adjusted 30-minute effort: long enough to be threshold-bound
    # rather than anaerobic, short enough that this athlete has actually run it.
    if not enough("run_pace", len(run_gap_samples)):
        if run_gap_samples:
            warnings.append(
                f"only {len(run_gap_samples)} runs with trustworthy pace; "
                "threshold pace not estimated"
            )
    elif (gap30 := _best_over(run_gap_samples, 1800)) is not None and gap30 > 0:
        out["threshold_pace_sec_per_km"] = round(1000.0 / gap30, 1)
        sources["threshold_pace_sec_per_km"] = "best 30min grade-adjusted running speed"

    # --- Critical swim speed ------------------------------------------------
    # Session pace includes rest between sets, so the fastest single session
    # understates true CSS less than the median overstates it. The 10th
    # percentile is a compromise that resists both a mismeasured session and a
    # long technique-drill swim.
    if enough("swim", len(swim_paces)):
        out["css_sec_per_100m"] = round(float(np.percentile(swim_paces, 10)), 1)
        sources["css_sec_per_100m"] = (
            f"10th percentile of {len(swim_paces)} session paces >=400m "
            "(includes rest, so conservative)"
        )

    out["sources"] = sources
    out["warnings"] = warnings
    out["sample_counts"] = {
        "hr_activities": len(hr_samples),
        "power_activities": len(power_samples),
        "run_pace_activities": len(run_gap_samples),
        "swim_sessions": len(swim_paces),
    }
    return out
