"""Performance Management Chart: fitness, fatigue, form and risk flags.

Impulse-response model. Daily training load feeds two exponentially-weighted
averages with different time constants — a slow one standing for adaptation
(fitness) and a fast one for fatigue — and their difference is form.
"""

from __future__ import annotations

import datetime as dt
import math
from typing import Any

import numpy as np

CALC_VERSION = "pmc/1.0.0"

CTL_DAYS = 42
ATL_DAYS = 7

# Foster monotony is mean/SD, which diverges as training becomes perfectly
# uniform. Real weeks never reach that, but synthetic and heavily-rounded data
# do, so the ratio is capped rather than allowed to run to infinity. Anything
# above 2.0 is already the "high risk" end of the published range.
MONOTONY_CAP = 10.0


def _decay(days: int) -> float:
    """Smoothing factor for an exponential decay with the given time constant.

    Deliberately `1 - exp(-1/N)` rather than the `2/(N+1)` a span-based EWMA
    would give. For a 42-day constant those are 0.0236 and 0.0465 — the
    span form decays about twice as fast, so it produces a visibly different
    (and lower) fitness curve for the same training.
    """
    return 1.0 - math.exp(-1.0 / days)


def _ewma(loads: np.ndarray, days: int, seed: float = 0.0) -> np.ndarray:
    alpha = _decay(days)
    out = np.empty(loads.size, dtype=float)
    prev = seed
    for i, value in enumerate(loads):
        prev = prev + (value - prev) * alpha
        out[i] = prev
    return out


def _rolling_sum(values: np.ndarray, window: int) -> np.ndarray:
    padded = np.concatenate((np.zeros(window), values))
    csum = np.cumsum(padded)
    return csum[window:] - csum[:-window]


def build_series(
    daily: dict[str, float],
    start: dt.date | None = None,
    end: dt.date | None = None,
) -> list[dict[str, Any]]:
    """Build a continuous daily PMC series from {ISO date: load}.

    Rest days matter as much as training days — they are when fatigue decays —
    so the series is filled to every calendar day rather than only days with
    activities.
    """
    if not daily and not (start and end):
        return []

    dates = sorted(dt.date.fromisoformat(d) for d in daily)
    first = start or dates[0]
    last = end or max(dates[-1], dt.date.today())
    span = (last - first).days + 1
    if span <= 0:
        return []

    grid = [first + dt.timedelta(days=i) for i in range(span)]
    loads = np.array([daily.get(d.isoformat(), 0.0) for d in grid], dtype=float)

    ctl = _ewma(loads, CTL_DAYS)
    atl = _ewma(loads, ATL_DAYS)

    # Form is yesterday's fitness minus yesterday's fatigue: today's session has
    # not been absorbed yet, and including it would make every hard day look
    # like a form collapse.
    tsb = np.concatenate(([0.0], ctl[:-1] - atl[:-1]))

    # Ramp rate: how fast fitness is being built, in CTL points per week.
    ramp = np.concatenate((np.zeros(7), ctl[7:] - ctl[:-7]))

    weekly = _rolling_sum(loads, 7)

    # Foster monotony: weekly mean over weekly standard deviation. High values
    # mean every day looks the same, which is associated with poor adaptation
    # regardless of how much work is being done.
    monotony = np.zeros(span)
    strain = np.zeros(span)
    for i in range(span):
        window = loads[max(0, i - 6) : i + 1]
        if window.size < 7:
            continue
        mean = float(np.mean(window))
        if mean <= 0:
            continue  # a week with no training has no monotony to speak of
        sd = float(np.std(window))
        # Guarding on `sd > 0` and leaving zero otherwise reports the *least*
        # varied week as the least monotonous, which is exactly backwards.
        monotony[i] = MONOTONY_CAP if sd < 1e-6 else min(mean / sd, MONOTONY_CAP)
        strain[i] = weekly[i] * monotony[i]

    # Acute:chronic workload ratio. Above ~1.5 is the commonly cited danger
    # zone for injury risk; below ~0.8 suggests detraining.
    chronic = _rolling_sum(loads, 28) / 4.0
    with np.errstate(invalid="ignore", divide="ignore"):
        acwr = np.where(chronic > 0, weekly / chronic, 0.0)

    return [
        {
            "date": grid[i].isoformat(),
            "load": round(float(loads[i]), 1),
            "ctl": round(float(ctl[i]), 2),
            "atl": round(float(atl[i]), 2),
            "tsb": round(float(tsb[i]), 2),
            "ramp_rate": round(float(ramp[i]), 2),
            "weekly_load": round(float(weekly[i]), 1),
            "monotony": round(float(monotony[i]), 2),
            "strain": round(float(strain[i]), 1),
            "acwr": round(float(acwr[i]), 2),
            "calc_version": CALC_VERSION,
        }
        for i in range(span)
    ]


def form_label(tsb: float) -> str:
    """Plain-language reading of training stress balance."""
    if tsb > 25:
        return "transition"       # detraining if held
    if tsb > 5:
        return "fresh"            # tapered, race-ready
    if tsb >= -10:
        return "neutral"
    if tsb >= -30:
        return "productive"       # the zone most training happens in
    return "overreaching"
