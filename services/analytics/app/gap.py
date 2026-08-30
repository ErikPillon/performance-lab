"""Grade-adjusted pace.

Uses the Minetti et al. (2002) measurements of the metabolic cost of running on
gradients, which give the energy cost per metre as a function of slope. The
ratio of that cost to its level-ground value converts an observed speed into the
flat-equivalent speed that would have cost the same.

Without this, a hilly run and a flat run of identical pace look like identical
efforts, and any pace-derived training load is wrong on every hill.
"""

from __future__ import annotations

import numpy as np

# Cost of transport at zero gradient, J/kg/m.
_LEVEL_COST = 3.6

# Minetti's polynomial is fitted over roughly ±45% gradient; beyond that it
# diverges, and running becomes scrambling anyway. Clamped tighter than the
# published range because anything past 30% is hiking, not running.
_MAX_GRADE = 0.30

# Gradient is measured over this much horizontal travel rather than between
# consecutive samples. Per-sample slope is dominated by barometric noise, and
# dividing a vertical rate by an instantaneous speed explodes whenever the
# runner slows — exactly what happens on the climbs the adjustment is for.
_GRADE_BASELINE_M = 30.0

# A runner sustaining more than twice the energy cost of level ground is
# hiking. Capping keeps a single bad altitude sample from dominating a
# fourth-power-weighted average downstream.
_MAX_FACTOR = 2.0


def cost_of_running(grade: np.ndarray) -> np.ndarray:
    """Energy cost in J/kg/m at the given gradient (rise/run)."""
    i = np.clip(grade, -_MAX_GRADE, _MAX_GRADE)
    return 155.4 * i**5 - 30.4 * i**4 - 43.3 * i**3 + 46.3 * i**2 + 19.5 * i + _LEVEL_COST


def grade_factor(grade: np.ndarray) -> np.ndarray:
    """Multiplier converting observed speed to flat-equivalent speed."""
    return cost_of_running(grade) / _LEVEL_COST


def _smooth(values: np.ndarray, window: int) -> np.ndarray:
    kernel = np.ones(window) / window
    pad = window // 2
    padded = np.pad(np.nan_to_num(values, nan=0.0), (pad, pad), mode="edge")
    return np.convolve(padded, kernel, mode="valid")[: values.size]


def adjusted_speed(
    speed_mps: np.ndarray, altitude_m: np.ndarray | None, smooth_s: int = 30
) -> np.ndarray:
    """Flat-equivalent speed for a 1 Hz speed series.

    Gradient is taken over a fixed horizontal baseline: rise over the distance
    actually covered, not vertical rate over instantaneous speed. The naive form
    divides by a speed that approaches zero on steep ground, producing gradients
    of several hundred percent precisely where the adjustment matters most — on
    this corpus it claimed 3:01/km for a 5:58/km hill run.
    """
    if altitude_m is None or altitude_m.size != speed_mps.size or speed_mps.size < smooth_s:
        return speed_mps

    alt = _smooth(altitude_m, smooth_s)
    speed = np.nan_to_num(speed_mps, nan=0.0)

    # Cumulative horizontal distance, then the window of samples spanning
    # roughly _GRADE_BASELINE_M of it.
    distance = np.cumsum(speed)
    grade = np.zeros_like(speed)

    idx = np.arange(speed.size)
    back = np.searchsorted(distance, distance - _GRADE_BASELINE_M, side="left")
    span_m = distance - distance[back]
    span_alt = alt - alt[back]

    usable = (span_m >= _GRADE_BASELINE_M * 0.5) & (idx > back)
    grade[usable] = span_alt[usable] / span_m[usable]
    grade = np.nan_to_num(grade, nan=0.0, posinf=0.0, neginf=0.0)

    factor = np.clip(grade_factor(grade), 1.0 / _MAX_FACTOR, _MAX_FACTOR)
    return speed_mps * factor
