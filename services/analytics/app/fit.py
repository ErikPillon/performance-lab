"""FIT file decoding and normalisation.

Produces two things from a blob of FIT bytes:
  * a summary dict shaped like the `activity` table
  * a normalised per-sample Polars DataFrame ready to write as Parquet

Design notes:
  * SI units throughout (metres, seconds, m/s). Conversion is a display concern.
  * `enhanced_*` channels win over their legacy counterparts when both exist —
    across this corpus enhanced_speed appears in 157 files against speed in 45.
  * Unrecognised `unknown_NNN` channels are kept, not dropped. 190 of 252 files
    carry unknown_135/136; they are cheap to store columnar and may be decodable
    later. Throwing them away is irreversible.
  * A file with zero record messages is valid, not an error: it yields a summary
    with no stream.
"""

from __future__ import annotations

import datetime as dt
import io
import math
from typing import Any

import polars as pl
from fitparse import FitFile

from .sports import canonical_sport

PARSER_VERSION = "fit/1.0.0"

SEMICIRCLE_TO_DEG = 180.0 / (2**31)

# source channel -> canonical column, in preference order
_CHANNEL_ALIASES: list[tuple[tuple[str, ...], str]] = [
    (("enhanced_altitude", "altitude"), "altitude_m"),
    (("enhanced_speed", "speed"), "speed_mps"),
    (("enhanced_respiration_rate", "respiration_rate"), "respiration_rate"),
    (("heart_rate",), "heart_rate"),
    (("power",), "power_w"),
    (("cadence",), "cadence"),
    (("distance",), "distance_m"),
    (("temperature",), "temperature_c"),
    (("grade",), "grade_pct"),
    (("left_right_balance",), "left_right_balance"),
    (("vertical_oscillation",), "vertical_oscillation_mm"),
    (("stance_time",), "stance_time_ms"),
    (("step_length",), "step_length_mm"),
]


def _messages(fit: FitFile, name: str) -> list[dict[str, Any]]:
    return [{f.name: f.value for f in m} for m in fit.get_messages(name)]


def _utc(value: Any) -> dt.datetime | None:
    """Coerce a FIT timestamp to tz-aware UTC.

    fitparse yields naive datetimes that are already UTC by spec, but mixing
    them with aware ones raises on subtraction — so every timestamp is pinned
    here, at the boundary, rather than at each use site.
    """
    if not isinstance(value, dt.datetime):
        return None
    return value.replace(tzinfo=dt.timezone.utc) if value.tzinfo is None else value.astimezone(dt.timezone.utc)


def _finite(value: Any) -> float | None:
    """Coerce to a finite float, or None. FIT emits NaN and sentinel values freely."""
    if value is None or isinstance(value, (str, bytes, dt.datetime, dt.date)):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _as_int(value: Any, lo: int, hi: int) -> int | None:
    f = _finite(value)
    if f is None:
        return None
    i = int(round(f))
    return i if lo <= i <= hi else None


def _tz_offset_min(fit: FitFile, start_utc: dt.datetime | None) -> int | None:
    """Derive the local UTC offset from the FIT `activity` message.

    FIT stores both a UTC `timestamp` and a `local_timestamp` (the same instant
    expressed in device-local wall clock). Their difference is the offset.
    """
    for msg in _messages(fit, "activity"):
        utc, local = msg.get("timestamp"), msg.get("local_timestamp")
        # local_timestamp is wall-clock, not an instant: pin both to UTC so the
        # difference is the offset rather than zero.
        if isinstance(utc, dt.datetime) and isinstance(local, dt.datetime):
            utc_n = utc.replace(tzinfo=None)
            local_n = local.replace(tzinfo=None)
            offset = round((local_n - utc_n).total_seconds() / 60.0)
            if -14 * 60 <= offset <= 14 * 60:
                return int(offset)
    return None


def _build_frame(
    records: list[dict[str, Any]], start: dt.datetime | None
) -> tuple[pl.DataFrame, list[str]]:
    """Normalise raw record messages into a typed, canonically-named frame.

    Returns the frame plus any quality flags observed while building it.
    """
    if not records:
        return pl.DataFrame(), []

    present = {k for r in records for k in r}
    out: dict[str, list[Any]] = {}

    out["timestamp"] = [_utc(r.get("timestamp")) for r in records]
    anchor = start or next((t for t in out["timestamp"] if t), None)
    out["t_s"] = [
        int((t - anchor).total_seconds()) if (t and anchor) else None
        for t in out["timestamp"]
    ]

    # GPS arrives in semicircles; degrees are what every map library wants.
    if "position_lat" in present and "position_long" in present:
        out["lat"] = [
            (v * SEMICIRCLE_TO_DEG) if (v := _finite(r.get("position_lat"))) is not None else None
            for r in records
        ]
        out["lon"] = [
            (v * SEMICIRCLE_TO_DEG) if (v := _finite(r.get("position_long"))) is not None else None
            for r in records
        ]

    for sources, target in _CHANNEL_ALIASES:
        src = next((s for s in sources if s in present), None)
        if src is not None:
            out[target] = [_finite(r.get(src)) for r in records]

    # Anything else numeric — vendor extensions, undecoded developer fields —
    # rides along under its original name rather than being discarded.
    claimed = {s for sources, _ in _CHANNEL_ALIASES for s in sources}
    claimed |= {"timestamp", "position_lat", "position_long"}
    for name in sorted(present - claimed):
        col = [_finite(r.get(name)) for r in records]
        if any(v is not None for v in col):
            out[name] = col

    df = pl.DataFrame(out)
    # Drop all-null columns; a channel listed in one message but never populated
    # is noise, and it keeps `channels` honest about what is actually there.
    df = df.select([c for c in df.columns if df[c].null_count() < df.height])

    flags: list[str] = []
    # A device restarted mid-activity writes a second run of records whose
    # timestamps go backwards. Sorting gives charts a usable x-axis; the flag
    # records that this file is two segments stitched together, which matters
    # for anything reading gaps between samples.
    if "t_s" in df.columns and df.height > 1 and not df["t_s"].drop_nulls().is_sorted():
        flags.append("nonmonotonic_time")
        df = df.sort("timestamp", nulls_last=True)
    return df, flags


def _elevation_gain(df: pl.DataFrame, session_ascent: Any) -> float | None:
    """Prefer the device's own total_ascent; fall back to a smoothed integration.

    Raw barometric altitude is noisy enough that naive diff-and-sum inflates gain
    substantially, so the fallback smooths over a 15-sample window first.
    """
    ascent = _finite(session_ascent)
    if ascent is not None:
        return ascent
    if "altitude_m" not in df.columns or df.height < 30:
        return None
    alt = df["altitude_m"].drop_nulls()
    if alt.len() < 30:
        return None
    smoothed = alt.rolling_mean(window_size=15, min_samples=5).drop_nulls()
    delta = smoothed.diff().drop_nulls()
    gain = delta.filter(delta > 0).sum()
    return float(gain) if gain is not None else None


# Upper bound on plausible average speed in m/s, by sport. Generous on purpose:
# these catch data-entry errors, not strong performances.
_MAX_AVG_SPEED_MPS = {
    "swimming": 3.0, "walking": 4.0, "running": 8.0, "rowing": 8.0,
    "hiking": 4.0, "cycling": 20.0, "skiing": 30.0,
}


def quality_flags(summary: dict[str, Any]) -> list[str]:
    """Flag physically impossible summaries without discarding them.

    Hand-entered activities carry real errors — the corpus has a 750 m swim
    recorded as 50 hours, from minutes typed into an hours field. Dropping it
    loses a real session; trusting it hands a 50-hour swim to the load model.
    So the row is kept verbatim and marked, and load computation filters on
    these flags. The raw value stays visible and correctable.
    """
    flags: list[str] = []
    duration = summary.get("duration_s")
    distance = summary.get("distance_m")

    if duration is not None and duration > 24 * 3600:
        flags.append("implausible_duration")
    if distance is not None and distance > 1_000_000:
        flags.append("implausible_distance")
    if duration and distance and duration > 0:
        limit = _MAX_AVG_SPEED_MPS.get(summary.get("sport", ""), 40.0)
        if distance / duration > limit:
            flags.append("implausible_speed")
    if summary.get("sample_count") == 0:
        flags.append("no_stream")
    return flags


def parse_fit(data: bytes) -> tuple[dict[str, Any], pl.DataFrame]:
    """Decode FIT bytes into (summary, per-sample frame).

    Raises ValueError if the file carries no session message at all.
    """
    fit = FitFile(io.BytesIO(data))
    sessions = _messages(fit, "session")
    if not sessions:
        raise ValueError("no session message in FIT file")

    # Multisport files hold one session per leg. Aggregate onto the first, which
    # keeps a brick session as a single activity rather than fragments.
    head = sessions[0]
    multisport = len(sessions) > 1

    records = _messages(fit, "record")
    start = _utc(head.get("start_time")) or _utc(head.get("timestamp"))
    if start is None:
        start = next((ts for r in records if (ts := _utc(r.get("timestamp")))), None)
    if start is None:
        raise ValueError("no usable start time in FIT file")

    df, frame_flags = _build_frame(records, start)

    def agg(field: str) -> float | None:
        return sum(v for s in sessions if (v := _finite(s.get(field))) is not None) or None

    raw_sport = head.get("sport")
    duration_s = agg("total_elapsed_time")
    moving_s = agg("total_timer_time")

    device = None
    for info in _messages(fit, "file_id"):
        parts = [str(info.get(k)) for k in ("manufacturer", "garmin_product", "product") if info.get(k)]
        if parts:
            device = " ".join(dict.fromkeys(parts))
            break

    summary = {
        "sport": "multisport" if multisport else canonical_sport(raw_sport),
        "sub_sport": str(head["sub_sport"]) if head.get("sub_sport") else None,
        "raw_sport": str(raw_sport) if raw_sport is not None else None,
        "start_time": start.isoformat(),
        "tz_offset_min": _tz_offset_min(fit, start),
        "duration_s": duration_s,
        "moving_s": moving_s,
        "distance_m": agg("total_distance"),
        "elev_gain_m": _elevation_gain(df, head.get("total_ascent")),
        "avg_hr": _as_int(head.get("avg_heart_rate"), 20, 260),
        "max_hr": _as_int(head.get("max_heart_rate"), 20, 260),
        "avg_power_w": _as_int(head.get("avg_power"), 0, 3000),
        "max_power_w": _as_int(head.get("max_power"), 0, 3000),
        "avg_cadence": _finite(head.get("avg_cadence")),
        "calories": _as_int(agg("total_calories"), 0, 30000),
        "device": device,
        "sample_count": df.height,
        "channels": [c for c in df.columns if c not in ("timestamp", "t_s")],
        "parser_version": PARSER_VERSION,
    }
    flags = quality_flags(summary) + frame_flags
    # Treadmill distance is user-calibrated after the run: Garmin rewrites the
    # session total but leaves the per-record stream at the watch's
    # accelerometer estimate, which diverges by up to 10%. The session value is
    # the authoritative one, so pace derived from the stream must be rescaled
    # onto it rather than used raw.
    total = summary.get("distance_m")
    if total and "distance_m" in df.columns:
        peak = df["distance_m"].drop_nulls().max()
        if peak is not None and abs(peak - total) / total > 0.02:
            flags.append("stream_distance_diverges")
    summary["quality_flags"] = sorted(set(flags))
    return summary, df


def dedupe_key(summary: dict[str, Any]) -> str:
    """Stable identity for a session across sources.

    Start time truncated to the minute plus whole-minute duration: the same
    session pulled from a Garmin FIT and from the Strava API lands on one key,
    so training load is counted once. Sport is included so a transition and the
    leg that follows it stay distinct.
    """
    start = dt.datetime.fromisoformat(summary["start_time"]).astimezone(dt.timezone.utc)
    minutes = int(round((summary.get("duration_s") or 0) / 60.0))
    return f"{summary['sport']}:{start.strftime('%Y%m%dT%H%M')}:{minutes}"
