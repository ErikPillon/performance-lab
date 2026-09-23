"""Analytics service: FIT decoding and training-load computation.

Kept in Python for two concrete reasons: the mature FIT decoders live here, and
the numeric work — mean-maximal curves, grade adjustment, impulse-response
modelling — belongs in numpy rather than in the orchestration layer. The ingest
worker calls this; the notebooks in /lab import the same modules, so exploratory
findings ship without a rewrite.

Every endpoint is stateless. Postgres is owned by the TypeScript side, which
keeps one service in charge of the schema contract.
"""

from __future__ import annotations

import datetime as dt
import gzip
import json
import logging
import re
from typing import Any

import numpy as np
import shapely

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import coverage as cov
from . import osm
from . import sectors as sec
from .curves import DURATIONS, critical_speed
from .downsample import bucket_min_max
from .predict import predict, predict_standard
from .strava import parse_strava
from .vdot import from_curve as vdot_from_curve
from .fit import PARSER_VERSION, dedupe_key, parse_fit
from .geo import decode_polyline, track_summary
from .load import CALC_VERSION, Thresholds, compute_load
from .pmc import CALC_VERSION as PMC_VERSION
from .pmc import build_series, form_label
from .storage import get_bytes, get_bytes_if_fresh, get_parquet, put_bytes, put_parquet
from .thresholds import ESTIMATOR_VERSION, estimate

log = logging.getLogger("analytics")
app = FastAPI(title="performance-lab analytics", version=PARSER_VERSION)


class ParseRequest(BaseModel):
    blob_key: str = Field(description="Object-storage key of the raw FIT bytes")
    activity_id: str = Field(description="UUID assigned by the worker; names the Parquet object")


class ParseResponse(BaseModel):
    summary: dict[str, Any]
    dedupe_key: str
    streams_key: str | None
    streams_bytes: int = 0


class ThresholdModel(BaseModel):
    max_hr: int | None = None
    rest_hr: int | None = None
    lthr: int | None = None
    ftp_watts: int | None = None
    css_sec_per_100m: float | None = None
    threshold_pace_sec_per_km: float | None = None
    sex: str = "unspecified"

    def to_domain(self) -> Thresholds:
        return Thresholds(**self.model_dump())


class LoadRequest(BaseModel):
    summary: dict[str, Any] = Field(description="Activity summary as stored on the activity row")
    streams_key: str | None = None
    thresholds: ThresholdModel
    preference: str = Field(
        default="consistency",
        description="consistency (heart-rate-first, uniform across sessions) or "
        "precision (best available model per session)",
    )


class PmcRequest(BaseModel):
    daily: dict[str, float] = Field(description="ISO date -> total training load for that day")
    start: str | None = None
    end: str | None = None


class EstimateRequest(BaseModel):
    activities: list[dict[str, Any]] = Field(
        description="Activity summaries, each optionally carrying a streams_key"
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "parser_version": PARSER_VERSION,
        "load_version": CALC_VERSION,
        "pmc_version": PMC_VERSION,
        "estimator_version": ESTIMATOR_VERSION,
    }


@app.post("/parse", response_model=ParseResponse)
def parse(req: ParseRequest) -> ParseResponse:
    try:
        data = get_bytes(req.blob_key)
    except Exception as exc:
        raise HTTPException(502, f"could not read blob {req.blob_key}: {exc}") from exc

    try:
        summary, df = parse_fit(data)
    except ValueError as exc:
        # A structurally valid file we cannot use: the worker marks it `skipped`
        # rather than retrying, since replaying will not change the outcome.
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        log.exception("parse failed for %s", req.blob_key)
        raise HTTPException(500, f"parse failed: {exc}") from exc

    streams_key, streams_bytes = None, 0
    if df.height > 0:
        streams_key = f"streams/{req.activity_id}.parquet"
        streams_bytes = put_parquet(streams_key, df)

    return ParseResponse(
        summary=summary,
        dedupe_key=dedupe_key(summary),
        streams_key=streams_key,
        streams_bytes=streams_bytes,
    )


class StravaParseRequest(BaseModel):
    activity: dict[str, Any] = Field(description="Strava's detailed activity object")
    streams: dict[str, Any] | None = Field(default=None, description="Strava's stream set")
    activity_id: str = Field(description="UUID assigned by the worker; names the Parquet object")


@app.post("/parse/strava", response_model=ParseResponse)
def parse_strava_activity(req: StravaParseRequest) -> ParseResponse:
    """Convert a Strava activity into the same pair `/parse` returns.

    The same response shape on purpose: everything after this point — load,
    curves, zones, the fitness model — consumes `(summary, frame)` and should
    not learn that a second source exists.
    """
    try:
        summary, df = parse_strava(req.activity, req.streams)
    except ValueError as exc:
        # Structurally unusable rather than transiently broken; retrying will
        # not change the outcome, so the worker marks it skipped.
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        log.exception("strava parse failed for activity %s", req.activity.get("id"))
        raise HTTPException(500, f"strava parse failed: {exc}") from exc

    streams_key, streams_bytes = None, 0
    if df.height > 0:
        streams_key = f"streams/{req.activity_id}.parquet"
        streams_bytes = put_parquet(streams_key, df)

    return ParseResponse(
        summary=summary,
        # The same key a FIT of this session would produce, which is what lets
        # the two collapse onto one activity rather than double-counting.
        dedupe_key=dedupe_key(summary),
        streams_key=streams_key,
        streams_bytes=streams_bytes,
    )


@app.post("/load")
def load(req: LoadRequest) -> dict[str, Any]:
    """Compute every available load metric for one activity."""
    frame = None
    if req.streams_key:
        try:
            frame = get_parquet(req.streams_key)
        except Exception as exc:
            raise HTTPException(502, f"could not read streams {req.streams_key}: {exc}") from exc
    try:
        result = compute_load(req.summary, frame, req.thresholds.to_domain(), req.preference)
    except Exception as exc:
        log.exception("load failed for %s", req.streams_key)
        raise HTTPException(500, f"load computation failed: {exc}") from exc

    # The simplified route rides along, since the stream is already in memory.
    # A failure here must not cost the activity its load.
    try:
        result["track"] = track_summary(frame) if frame is not None else None
    except Exception:
        log.exception("track simplification failed for %s", req.streams_key)
        result["track"] = None
    return result


@app.post("/pmc")
def pmc(req: PmcRequest) -> dict[str, Any]:
    """Build the fitness/fatigue/form series from daily training load."""
    try:
        start = dt.date.fromisoformat(req.start) if req.start else None
        end = dt.date.fromisoformat(req.end) if req.end else None
    except ValueError as exc:
        raise HTTPException(422, f"bad date: {exc}") from exc

    series = build_series(req.daily, start=start, end=end)
    latest = series[-1] if series else None
    return {
        "series": series,
        "latest": {**latest, "form": form_label(latest["tsb"])} if latest else None,
    }


@app.get("/streams")
def streams(key: str, points: int = 1500, channels: str | None = None) -> dict[str, Any]:
    """Return a downsampled activity stream, shaped for charting.

    Columns come back as parallel arrays rather than row objects: a 1,500-point
    six-channel response is roughly a third the size that way, and it is the
    shape charting libraries want anyway.
    """
    try:
        df = get_parquet(key)
    except Exception as exc:
        raise HTTPException(404, f"no stream at {key}: {exc}") from exc

    if channels:
        wanted = [c.strip() for c in channels.split(",") if c.strip() in df.columns]
        keep = ["t_s", *[c for c in wanted if c != "t_s"]]
        df = df.select([c for c in keep if c in df.columns])

    # `timestamp` is redundant once t_s exists and serialises poorly.
    if "timestamp" in df.columns:
        df = df.drop("timestamp")

    full_height = df.height
    df = bucket_min_max(df, max(50, min(points, 20_000)))

    return {
        "key": key,
        "sample_count": full_height,
        "returned": df.height,
        "channels": [c for c in df.columns if c != "t_s"],
        "series": {c: df[c].to_list() for c in df.columns},
    }


class CriticalRequest(BaseModel):
    curve: dict[str, float] = Field(description="duration in seconds -> best sustained average")


@app.post("/curve/critical")
def curve_critical(req: CriticalRequest) -> dict[str, Any]:
    """Fit the two-parameter critical-speed (or critical-power) model.

    Kept here rather than reimplemented in the API so there is one definition of
    the model. `D = CS * t + D'`, fitted over 2-20 minutes.
    """
    curve = {int(k): float(v) for k, v in req.curve.items()}
    fit = critical_speed(curve)
    # Predictions travel with the fit rather than behind a second endpoint: the
    # caller already has the curve in hand, and one of the two models is built
    # from this very fit.
    return {
        "fit": fit,
        "durations": list(DURATIONS),
        "predictions": predict_standard(curve, fit),
        "vdot": vdot_from_curve(curve),
    }


class PredictRequest(BaseModel):
    curve: dict[str, float] = Field(description="duration in seconds -> best sustained average")
    distances_m: list[float] = Field(description="race distances to predict, in metres")


@app.post("/curve/predict")
def curve_predict(req: PredictRequest) -> dict[str, Any]:
    """Predict finish times for specific distances — an athlete's planned races.

    Two models side by side rather than one blended number. Where they disagree
    is information: it means this athlete's curve does not look like the
    population Riegel was fitted to.
    """
    curve = {int(k): float(v) for k, v in req.curve.items()}
    fit = critical_speed(curve)
    return {
        "fit": fit,
        "predictions": [
            p for d in req.distances_m if (p := predict(d, curve, fit)) is not None
        ],
    }


@app.post("/thresholds/estimate")
def thresholds_estimate(req: EstimateRequest) -> dict[str, Any]:
    """Derive starting thresholds from an athlete's own mean-maximal efforts."""
    enriched = []
    for act in req.activities:
        item = dict(act)
        key = item.pop("streams_key", None)
        if key:
            try:
                item["frame"] = get_parquet(key)
            except Exception:
                log.warning("skipping unreadable stream %s", key)
        enriched.append(item)
    return estimate(enriched)


# --------------------------------------------------------------------------
# Street coverage
# --------------------------------------------------------------------------

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
GROUPS = ("foot", "bike", "all")


class TrackIn(BaseModel):
    id: str
    parts: list[str] = Field(description="Encoded polylines, one per continuous stretch")


class DiscoverRequest(BaseModel):
    tracks: list[TrackIn]
    level: int = 8
    min_share: float = Field(default=0.005, description="Ignore areas holding less of your GPS than this")
    max_areas: int = 25


class AreaRequest(BaseModel):
    athlete_id: str
    osm_id: int
    groups: dict[str, list[str]] = Field(description="group -> ids of the tracks that belong to it")
    tracks: list[TrackIn]
    streams: dict[str, str] = Field(
        default_factory=dict, description="track id -> streams key, for timing sector passes"
    )
    starts: dict[str, str] = Field(
        default_factory=dict, description="track id -> ISO start time of the activity"
    )


# Sectors are per sport: a running sector and a cycling one are different
# efforts on the same street, and "all" would mix them.
SECTOR_GROUPS = ("foot", "bike")


def _sectors(network: cov.Network, tracks: list[cov.Track], req: AreaRequest,
             frames: dict[str, Any]) -> list[dict[str, Any]]:
    """The most-run stretches in this area, each with every pass timed."""
    found = sec.mine(network, sec.traversals(network, tracks))
    out = []
    for sector in found:
        timed = []
        for activity_id in sorted(sector.activities):
            key = req.streams.get(activity_id)
            if not key:
                continue
            if activity_id not in frames:
                try:
                    frames[activity_id] = get_parquet(key)
                except Exception:
                    log.warning("sector passes: no stream at %s", key)
                    frames[activity_id] = None
            frame = frames[activity_id]
            if frame is None:
                continue
            start = req.starts.get(activity_id)
            for p in sec.passes(sector, frame, network.proj):
                at = None
                if start:
                    at = (dt.datetime.fromisoformat(start.replace("Z", "+00:00"))
                          + dt.timedelta(seconds=p["start_s"])).isoformat()
                timed.append({"activity_id": activity_id, "at": at, **p})
        # Mined from where routes went, timed from when they crossed the gates.
        # A sector most routes only touch mid-way is not worth a row.
        if len(timed) < sec.MIN_SUPPORT:
            continue
        timed.sort(key=lambda p: p["at"] or "")
        elapsed = np.array([p["elapsed_s"] for p in timed])
        out.append({
            **sec.describe(network, sector),
            "passes": timed,
            "best_s": float(elapsed.min()),
            "median_s": float(np.median(elapsed)),
            "last_s": float(timed[-1]["elapsed_s"]),
        })
    return out


def _decode(tracks: list[TrackIn]) -> list[cov.Track]:
    return [cov.Track(t.id, [decode_polyline(p) for p in t.parts if p]) for t in tracks]


def _detail_key(athlete_id: str, group: str, osm_id: int) -> str:
    if not _UUID.match(athlete_id) or group not in GROUPS:
        raise HTTPException(422, "bad athlete id or group")
    return f"coverage/v{cov.COVERAGE_VERSION}/{athlete_id}/{group}/{int(osm_id)}.json.gz"


@app.post("/coverage/discover")
def coverage_discover(req: DiscoverRequest) -> dict[str, Any]:
    """The communes your tracks spend the most time in, largest share first.

    Ranked by the share of your GPS points inside each boundary, exactly rather
    than by bounding box: a big rural commune whose box happens to overlap the
    city would otherwise outrank the city itself.
    """
    tracks = _decode(req.tracks)
    pts = [p for t in tracks for p in t.parts]
    if not pts:
        return {"areas": [], "points": 0}
    allpts = np.vstack(pts)
    lat, lon = allpts[:, 0], allpts[:, 1]
    try:
        areas = osm.discover_areas(lat, lon, req.level)
    except osm.OverpassUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc

    ranked = []
    for area in areas:
        inside = int(shapely.contains_xy(area.polygon, lon, lat).sum())
        share = inside / len(lat)
        if share >= req.min_share:
            ranked.append({"id": area.id, "name": area.name, "level": area.level,
                           "bbox": list(area.bbox), "points": inside, "share": round(share, 4)})
    ranked.sort(key=lambda a: -a["points"])
    return {"areas": ranked[: req.max_areas], "points": int(len(lat))}


@app.post("/coverage/area")
def coverage_area(req: AreaRequest) -> dict[str, Any]:
    """Compute coverage of one area for each sport group, and keep the detail.

    The street network is built once and tested against each group's tracks.
    The full result — every run of covered and uncovered street — is written
    to object storage for the map; only the totals come back.
    """
    for group in req.groups:
        _detail_key(req.athlete_id, group, req.osm_id)
    try:
        area = osm.boundary(req.osm_id)
        if area is None:
            raise HTTPException(404, f"no boundary for relation {req.osm_id}")
        subs, approx = osm.subareas(area)
        ways = osm.streets_in(area.bbox)
    except osm.OverpassUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc

    network = cov.build_network(area, ways, subs, approx)
    tracks = {t.id: t for t in _decode(req.tracks)}
    computed_at = dt.datetime.now(dt.timezone.utc).isoformat()
    results: dict[str, Any] = {}
    frames: dict[str, Any] = {}
    for group, ids in req.groups.items():
        group_tracks = [tracks[i] for i in ids if i in tracks]
        result = cov.coverage(network, group_tracks)
        result["sectors"] = _sectors(network, group_tracks, req, frames) if group in SECTOR_GROUPS else []
        detail = {
            "area": {"id": area.id, "name": area.name, "level": area.level,
                     "bbox": list(area.bbox), "outline": cov.outline(area)},
            "group": group,
            "computed_at": computed_at,
            "version": cov.COVERAGE_VERSION,
            "sample_m": cov.SAMPLE_M,
            "tolerance_m": cov.TOLERANCE_M,
            "done_fraction": cov.DONE_FRACTION,
            "sector_version": sec.SECTOR_VERSION,
            **result,
        }
        put_bytes(_detail_key(req.athlete_id, group, req.osm_id),
                  gzip.compress(json.dumps(detail, separators=(",", ":")).encode()), "application/gzip")
        results[group] = {
            **result["totals"],
            "subareas": len(result["subareas"]),
            "activities": result["activities"],
            "sectors": len(result["sectors"]),
        }
    return {"area": {"id": area.id, "name": area.name, "level": area.level, "bbox": list(area.bbox)},
            "results": results, "computed_at": computed_at}


@app.get("/coverage/detail")
def coverage_detail(athlete_id: str, group: str, osm_id: int) -> dict[str, Any]:
    blob = get_bytes_if_fresh(_detail_key(athlete_id, group, osm_id), float("inf"))
    if blob is None:
        raise HTTPException(404, "not computed yet")
    return json.loads(gzip.decompress(blob))
