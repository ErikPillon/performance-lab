"""Mean-maximal (duration) curves.

The best average a channel sustained over every window length — the chart that
answers "what is my best 5-minute effort, and is it better than last year's".
It is also the input to critical-power and critical-speed modelling.

Curves are computed **per activity** and aggregated across activities later,
rather than scanned on demand. A single request covering five years would
otherwise read every Parquet file in the store: ~35 s here and growing linearly.
Per-activity curves are a few dozen rows each, so a date-ranged curve becomes a
MAX aggregate over an indexed table.
"""

from __future__ import annotations

import numpy as np

from .streams import mean_max

# A logarithmic ladder: dense where efforts are anaerobic and change quickly,
# sparse out in the endurance range where a few extra minutes matters less.
# Anything longer than an activity is simply absent from its curve.
DURATIONS = (
    1, 2, 5, 10, 15, 20, 30, 45,
    60, 90, 120, 180, 300, 420, 600, 900,
    1200, 1800, 2400, 3600, 5400, 7200, 10800, 14400,
)

# Instantaneous speed beyond which a sample cannot be the sport it claims.
#
# Set above any plausible effort for a recreational athlete but well below
# vehicle speeds, because the failure mode these catch is not sensor noise: it
# is a watch left recording on the ride or drive home. One activity in this
# corpus holds 9+ m/s for 31 consecutive seconds — smooth acceleration, no
# spikes, simply not running.
#
# Samples above the cap are excluded rather than clipped. Clipping would invent
# a best effort at exactly the cap; excluding says the sample tells us nothing.
MAX_SAMPLE_SPEED_MPS = {
    "running": 8.0,     # 2:05/km, faster than any age-group sprint
    "cycling": 22.0,    # 79 km/h, a steep descent
    "swimming": 2.5,
    "rowing": 7.0,
    "walking": 3.0,
    "hiking": 3.0,
}


def mask_implausible_speed(
    speed: np.ndarray, sport: str
) -> tuple[np.ndarray, int]:
    """Blank speed samples too fast to be this sport. Returns (masked, count)."""
    cap = MAX_SAMPLE_SPEED_MPS.get(sport)
    if cap is None:
        return speed, 0
    over = np.asarray(speed > cap)
    if not over.any():
        return speed, 0
    cleaned = speed.copy()
    cleaned[over] = np.nan
    return cleaned, int(over.sum())


# Channels worth a curve. Speed is stored in m/s and inverted to pace for
# display; grade-adjusted speed is the more meaningful one for hilly running.
CURVE_METRICS = ("power_w", "speed_mps", "gap_mps", "heart_rate")

# Shortest window each channel can be trusted over.
#
# Consumer GPS carries 1-3 m/s of instantaneous speed error, so a "best 1
# second pace" is a measure of satellite geometry, not of sprinting — on this
# corpus every sub-30s best landed exactly on the plausibility cap, which is
# what noise pinned against a ceiling looks like. Power and heart rate are
# measured directly and stay meaningful much shorter.
MIN_DURATION_S = {
    "speed_mps": 30,
    "gap_mps": 30,
    "heart_rate": 5,
    "power_w": 1,
}


def duration_curve(series: dict[str, np.ndarray], max_duration: int | None = None) -> dict[str, dict[int, float]]:
    """Best sustained average per duration, for each channel present.

    `series` holds 1 Hz arrays keyed by channel name. Durations longer than the
    activity are omitted rather than reported as a partial-window average, which
    would make a 20-minute run appear to hold a 60-minute best.
    """
    out: dict[str, dict[int, float]] = {}

    for metric in CURVE_METRICS:
        values = series.get(metric)
        if values is None or values.size < DURATIONS[0]:
            continue

        limit = min(values.size, max_duration or values.size)
        floor = MIN_DURATION_S.get(metric, 1)
        points: dict[int, float] = {}
        for duration in DURATIONS:
            if duration < floor:
                continue
            if duration > limit:
                break
            best = mean_max(values, duration)
            if best is not None and np.isfinite(best) and best > 0:
                points[duration] = round(float(best), 3)

        if points:
            out[metric] = points

    return out


def critical_speed(curve: dict[int, float]) -> dict[str, float] | None:
    """Two-parameter critical-speed fit over the 2–20 minute range.

    Distance covered in time t is modelled as `D = CS * t + D'`, so a linear fit
    of distance against time gives critical speed as the slope and the finite
    anaerobic reserve as the intercept. Restricted to 2–20 minutes because
    shorter efforts are dominated by that reserve and longer ones drift below
    the model's assumptions.

    The same algebra gives critical power from a power curve — the model does
    not care which channel it is fed.
    """
    usable = {d: v for d, v in curve.items() if 120 <= d <= 1200}
    if len(usable) < 3:
        return None

    times = np.array(sorted(usable), dtype=float)
    distances = np.array([usable[int(t)] * t for t in times], dtype=float)

    slope, intercept = np.polyfit(times, distances, 1)
    if slope <= 0 or intercept < 0:
        return None  # a fit this shape means the inputs are not efforts

    predicted = slope * times + intercept
    ss_res = float(np.sum((distances - predicted) ** 2))
    ss_tot = float(np.sum((distances - distances.mean()) ** 2))
    r_squared = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0

    return {
        "critical_speed_mps": round(float(slope), 4),
        "d_prime_m": round(float(intercept), 1),
        "r_squared": round(r_squared, 4),
        "points": len(usable),
    }
