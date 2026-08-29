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

import logging
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .downsample import bucket_min_max
from .fit import PARSER_VERSION, dedupe_key, parse_fit
from .load import CALC_VERSION, Thresholds, compute_load
from .pmc import CALC_VERSION as PMC_VERSION
from .pmc import build_series, form_label
from .storage import get_bytes, get_parquet, put_parquet
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
        return compute_load(req.summary, frame, req.thresholds.to_domain(), req.preference)
    except Exception as exc:
        log.exception("load failed for %s", req.streams_key)
        raise HTTPException(500, f"load computation failed: {exc}") from exc


@app.post("/pmc")
def pmc(req: PmcRequest) -> dict[str, Any]:
    """Build the fitness/fatigue/form series from daily training load."""
    import datetime as dt

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
