"""Turn a Strava activity into the same shape the FIT parser produces.

The point is reuse. `parse_fit` returns `(summary, frame)`, and every stage
after it — load, curves, zones, the fitness model — consumes that pair and
nothing else. Producing the same pair from Strava means none of that has to
learn a second source.

**Strava is a mirror, not a source of truth.** Its API cannot return the
original file: third-party applications get a summary and derived streams, and
`velocity_smooth` in particular is Strava's smoothing rather than the device's
own measurement. Where a FIT exists for the same session it is canonical, and
the dedupe key collapses the two.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import polars as pl

from .sports import canonical_sport

PARSER_VERSION = "strava/1.0.0"

# Strava stream key -> the canonical column the rest of the pipeline expects.
# `latlng` is handled separately: it arrives as pairs, not scalars.
_STREAM_COLUMNS = {
    "time": "t_s",
    "distance": "distance_m",
    "altitude": "altitude_m",
    "velocity_smooth": "speed_mps",
    "heartrate": "heart_rate",
    "cadence": "cadence",
    "watts": "power_w",
    "temp": "temperature_c",
    "grade_smooth": "grade_pct",
}

# Strava's activity types onto the same canonical enum the FIT parser uses.
# Only the ones that differ in spelling need an entry; the rest fall through to
# canonical_sport, which already understands "running" and friends.
_SPORT_ALIASES = {
    "run": "running",
    "trailrun": "running",
    "virtualrun": "running",
    "ride": "cycling",
    "virtualride": "cycling",
    "gravelride": "cycling",
    "mountainbikeride": "cycling",
    "ebikeride": "cycling",
    "swim": "swimming",
    "walk": "walking",
    "hike": "hiking",
    "rowing": "rowing",
    "virtualrow": "rowing",
    "weighttraining": "strength",
    "workout": "strength",
    "nordicski": "skiing",
    "alpineski": "skiing",
    "backcountryski": "skiing",
    "snowboard": "skiing",
}


def strava_sport(activity_type: str | None) -> str:
    """Canonical sport for a Strava `sport_type` or `type`."""
    if not activity_type:
        return "other"
    key = activity_type.strip().lower()
    if key in _SPORT_ALIASES:
        return _SPORT_ALIASES[key]
    return canonical_sport(key)


def _frame(streams: dict[str, Any]) -> pl.DataFrame:
    """Build the sample frame from Strava's stream payload.

    Strava returns each stream as `{"data": [...]}` and guarantees they are the
    same length as one another, but not that any given one is present.
    """
    columns: dict[str, list[Any]] = {}
    lengths: set[int] = set()

    for key, column in _STREAM_COLUMNS.items():
        data = (streams.get(key) or {}).get("data")
        if isinstance(data, list) and data:
            columns[column] = list(data)
            lengths.add(len(data))

    latlng = (streams.get("latlng") or {}).get("data")
    if isinstance(latlng, list) and latlng:
        # Pairs, and occasionally a null where the GPS dropped out.
        columns["lat"] = [p[0] if isinstance(p, (list, tuple)) and len(p) == 2 else None for p in latlng]
        columns["lon"] = [p[1] if isinstance(p, (list, tuple)) and len(p) == 2 else None for p in latlng]
        lengths.add(len(latlng))

    if not columns:
        return pl.DataFrame()

    # Ragged streams should not silently truncate one channel against another;
    # everything is cut to the shortest so a row means one instant in time.
    n = min(lengths)
    return pl.DataFrame({k: v[:n] for k, v in columns.items()})


def parse_strava(activity: dict[str, Any], streams: dict[str, Any] | None = None):
    """`(summary, frame)`, matching what `parse_fit` returns.

    `activity` is Strava's detailed activity object; `streams` its stream set,
    which may be absent — a manually entered activity has none, and a summary
    with no samples is still worth importing.
    """
    df = _frame(streams or {})

    start_raw = activity.get("start_date")
    if not start_raw:
        raise ValueError("strava activity has no start_date")
    start = datetime.fromisoformat(str(start_raw).replace("Z", "+00:00"))
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)

    # Strava gives the offset in seconds; the rest of the system stores minutes.
    offset_s = activity.get("utc_offset")
    tz_offset_min = int(offset_s / 60) if isinstance(offset_s, (int, float)) else None

    # A timestamp column, because downstream resampling works from one and
    # Strava only gives elapsed seconds.
    if "t_s" in df.columns and df.height:
        df = df.with_columns(
            pl.Series("timestamp", [start + timedelta(seconds=float(t)) for t in df["t_s"]])
        )

    duration_s = _num(activity.get("elapsed_time"))
    moving_s = _num(activity.get("moving_time"))

    summary = {
        "sport": strava_sport(activity.get("sport_type") or activity.get("type")),
        "sub_sport": None,
        "raw_sport": str(activity.get("sport_type") or activity.get("type") or "") or None,
        "start_time": start.isoformat(),
        "tz_offset_min": tz_offset_min,
        "duration_s": duration_s,
        "moving_s": moving_s,
        "distance_m": _num(activity.get("distance")),
        "elev_gain_m": _num(activity.get("total_elevation_gain")),
        "avg_hr": _as_int(activity.get("average_heartrate"), 20, 260),
        "max_hr": _as_int(activity.get("max_heartrate"), 20, 260),
        "avg_power_w": _as_int(activity.get("average_watts"), 0, 3000),
        "max_power_w": _as_int(activity.get("max_watts"), 0, 3000),
        "avg_cadence": _num(activity.get("average_cadence")),
        "calories": _as_int(activity.get("calories"), 0, 30000),
        "device": activity.get("device_name"),
        "sample_count": df.height,
        "channels": [c for c in df.columns if c not in ("timestamp", "t_s")],
        "parser_version": PARSER_VERSION,
    }

    flags: list[str] = []
    if not df.height:
        flags.append("no_stream")
    # Strava reports power for rides without a meter by estimating it from
    # speed, weight and gradient. Treating that as measured would put invented
    # watts into the load model, so it is flagged for downstream to ignore.
    if activity.get("device_watts") is False and summary["avg_power_w"]:
        flags.append("estimated_power")
    if activity.get("manual"):
        flags.append("manual_entry")
    if activity.get("trainer"):
        flags.append("indoor")

    summary["quality_flags"] = sorted(set(flags))
    return summary, df


def _num(value: Any) -> float | None:
    if isinstance(value, (int, float)) and value == value:  # not NaN
        return float(value)
    return None


def _as_int(value: Any, lo: int, hi: int) -> int | None:
    """An integer within a plausible band, or None.

    The same clamping the FIT parser applies: a heart rate of 0 or 900 is a
    sensor fault, and letting it through would rescale every derived number
    that reads it.
    """
    n = _num(value)
    if n is None:
        return None
    i = int(round(n))
    return i if lo <= i <= hi else None
