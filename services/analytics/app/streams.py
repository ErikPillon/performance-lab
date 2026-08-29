"""Stream resampling and mean-maximal analysis.

Garmin "smart recording" samples irregularly — roughly every 7 s on this corpus,
but it varies within a single activity. Every window-based metric (normalised
power, mean-max curves, decoupling) assumes a uniform time base, so streams are
resampled to 1 Hz before any of them run. Skipping this silently biases every
rolling window toward whatever the local sample density happened to be.
"""

from __future__ import annotations

import numpy as np
import polars as pl

# Gaps longer than this are pauses, not missing samples: interpolating across a
# stopped-timer break would invent training that did not happen.
MAX_INTERPOLATION_GAP_S = 30


def resample_1hz(df: pl.DataFrame, channels: list[str]) -> dict[str, np.ndarray]:
    """Resample the given channels onto a uniform 1 Hz grid.

    Returns a dict of channel -> float array with NaN wherever the source had a
    gap longer than MAX_INTERPOLATION_GAP_S. The grid runs from t=0 to the last
    sample, so array index is elapsed seconds.
    """
    if df.height == 0 or "t_s" not in df.columns:
        return {}

    t = df["t_s"].to_numpy().astype(float)
    valid = ~np.isnan(t)
    t = t[valid]
    if t.size < 2:
        return {}

    grid = np.arange(0, int(t[-1]) + 1, dtype=float)
    out: dict[str, np.ndarray] = {}

    for name in channels:
        if name not in df.columns:
            continue
        raw = df[name].to_numpy().astype(float)[valid]
        present = ~np.isnan(raw)
        if present.sum() < 2:
            continue

        series = np.interp(grid, t[present], raw[present])

        # Blank out stretches the source never covered. np.interp happily draws
        # a straight line across a 20-minute pause; that would read as steady
        # effort rather than a stop.
        src = t[present]
        idx = np.searchsorted(src, grid)
        idx = np.clip(idx, 1, len(src) - 1)
        gap = src[idx] - src[idx - 1]
        series[gap > MAX_INTERPOLATION_GAP_S] = np.nan
        series[(grid < src[0]) | (grid > src[-1])] = np.nan

        out[name] = series

    return out


def rolling_mean(series: np.ndarray, window_s: int) -> np.ndarray:
    """Centred-free trailing rolling mean over a 1 Hz series, NaN-aware.

    Windows containing any gap yield NaN rather than a mean over partial data,
    which keeps a paused segment from inflating a 20-minute best.
    """
    if series.size < window_s:
        return np.array([])
    filled = np.nan_to_num(series, nan=0.0)
    ok = (~np.isnan(series)).astype(float)

    csum = np.concatenate(([0.0], np.cumsum(filled)))
    ccount = np.concatenate(([0.0], np.cumsum(ok)))

    total = csum[window_s:] - csum[:-window_s]
    count = ccount[window_s:] - ccount[:-window_s]

    with np.errstate(invalid="ignore", divide="ignore"):
        means = total / count
    means[count < window_s] = np.nan
    return means


def mean_max(series: np.ndarray, window_s: int) -> float | None:
    """Best sustained average over any window of `window_s` seconds.

    This is the primitive behind both threshold estimation and the
    power/pace-duration curve.
    """
    means = rolling_mean(series, window_s)
    if means.size == 0 or np.all(np.isnan(means)):
        return None
    return float(np.nanmax(means))


def normalised(series: np.ndarray, window_s: int = 30) -> float | None:
    """Normalised power/pace: fourth root of the mean of 30 s rolling means^4.

    Weights hard surges far above their share of clock time, which is what makes
    an interval session and a steady ride of the same average score differently.
    """
    rolled = rolling_mean(series, window_s)
    if rolled.size == 0:
        return None
    valid = rolled[~np.isnan(rolled)]
    if valid.size == 0:
        return None
    return float(np.mean(np.power(valid, 4)) ** 0.25)
