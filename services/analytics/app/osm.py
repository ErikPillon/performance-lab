"""OpenStreetMap data, fetched from Overpass and kept.

Street coverage needs two things this project does not own: the street
network, and the boundaries of communes and neighbourhoods. Both come from
OpenStreetMap through the Overpass API.

Three rules shape this module:

* **Everything is cached in object storage**, gzipped, for months. Streets and
  municipal boundaries change slowly, the public Overpass servers are a shared
  resource run by volunteers, and a coverage refresh must not re-download a
  city because one run was added.
* **Streets are fetched as bounding-box tiles**, never as "everything inside
  this area". Overpass answers a tile in seconds; the same streets selected by
  area took three minutes for one French town in testing. Tiles are clipped to
  the boundary locally, and a tile is shared by every area that touches it.
* **Requests are serialised and retried politely.** A busy Overpass server
  answers with an HTML page and a 200, not an error code; that is detected and
  retried with growing pauses, and never cached.

Which areas are queried is visible to whoever runs the endpoint — the same
trade-off as the map tiles. `OVERPASS_URL` points it at a self-hosted instance.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import math
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import shapely
from shapely.geometry.base import BaseGeometry

from . import storage

log = logging.getLogger("analytics.osm")

# `or`, not a default argument: compose passes an unset variable as "".
OVERPASS_URL = os.getenv("OVERPASS_URL") or "https://overpass-api.de/api/interpreter"
USER_AGENT = "performance-lab/1.0 (self-hosted training analytics)"
CACHE_MAX_AGE_S = 90 * 24 * 3600
CACHE_PREFIX = "osm/v1"

# Street tiles: small enough that a dense city centre answers in seconds.
TILE_DEG = 0.05
# Discovery cells: one boundary query per cell a track passes through. Large,
# because the public servers ration requests rather than bytes: a quarter
# degree holds a few dozen communes, and a home region is a handful of cells.
CELL_DEG = 0.25

# What counts as a street someone could run or ride. Motorways and trunks are
# out; so are service roads (driveways, car-park aisles), which would bury the
# real network under thousands of dead ends nobody means to "complete".
HIGHWAYS = (
    "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
    "unclassified", "residential", "living_street", "pedestrian", "road",
    "track", "path", "footway", "cycleway", "bridleway", "steps",
)

# Sidewalks and crossings mapped as their own ways duplicate the street they
# run beside; counting them would make every street count twice.
EXCLUDED_FOOTWAY = {"sidewalk", "crossing", "traffic_island"}
PRIVATE_ACCESS = {"private", "no"}

_request_lock = threading.Lock()
# Patient on purpose: this runs in a background job, and the public servers
# shed load with 429s and 504s in the evening. Seven minutes of waiting beats
# a coverage refresh that fails because one tile was unlucky.
_BACKOFF_S = (0, 10, 30, 60, 120, 240)


class OverpassUnavailable(RuntimeError):
    """Every attempt failed; the caller should skip, not crash."""


def _post(ql: str, timeout_s: float = 120) -> bytes:
    body = urllib.parse.urlencode({"data": ql}).encode()
    req = urllib.request.Request(OVERPASS_URL, data=body, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout_s) as res:  # noqa: S310 — fixed https endpoint
        return res.read()


def overpass(ql: str) -> dict[str, Any]:
    """Run a query, answering from the cache when it is fresh."""
    key = f"{CACHE_PREFIX}/{hashlib.sha256(ql.encode()).hexdigest()}.json.gz"
    cached = storage.get_bytes_if_fresh(key, CACHE_MAX_AGE_S)
    if cached is not None:
        return json.loads(gzip.decompress(cached))

    with _request_lock:
        last_error = "no attempt made"
        for wait in _BACKOFF_S:
            if wait:
                log.warning("overpass: %s; retrying in %ss", last_error, wait)
                time.sleep(wait)
            started = time.monotonic()
            try:
                raw = _post(ql)
            except urllib.error.HTTPError as exc:
                last_error = f"HTTP {exc.code}"
                if exc.code in (400,):
                    raise ValueError(f"overpass rejected the query: {exc.read()[:300]!r}") from exc
                continue
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = str(exc)
                continue

            # A busy server answers 200 with an HTML error page.
            if not raw.lstrip().startswith(b"{"):
                last_error = "server busy (HTML error page)"
                continue
            data = json.loads(raw)
            # A timeout mid-query returns partial results with a remark; caching
            # those would make the gap permanent.
            remark = str(data.get("remark") or "")
            if "error" in remark.lower():
                last_error = remark[:200]
                continue

            storage.put_bytes(key, gzip.compress(raw), "application/gzip")
            log.info("overpass: %d elements, %d KB in %.1fs",
                     len(data.get("elements", [])), len(raw) // 1024, time.monotonic() - started)
            return data

    log.error("overpass: giving up: %s", last_error)
    raise OverpassUnavailable(f"overpass unavailable: {last_error}")


# --------------------------------------------------------------------------
# Areas
# --------------------------------------------------------------------------


@dataclass
class Area:
    id: int
    name: str
    level: int
    polygon: BaseGeometry  # lon/lat
    tags: dict[str, str] = field(default_factory=dict)

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        """south, west, north, east"""
        w, s, e, n = self.polygon.bounds
        return s, w, n, e


def _ring_lines(members: list[dict[str, Any]], roles: set[str]) -> list[BaseGeometry]:
    lines = []
    for m in members:
        if m.get("type") != "way" or m.get("role", "") not in roles:
            continue
        geom = m.get("geometry") or []
        coords = [(p["lon"], p["lat"]) for p in geom if p]
        if len(coords) >= 2:
            lines.append(shapely.linestrings(coords))
    return lines


def relation_polygon(rel: dict[str, Any]) -> BaseGeometry | None:
    """Assemble a boundary relation's member ways into a polygon.

    Boundaries arrive as dozens of ways, in no particular order and direction.
    Polygonizing the outer ways stitches them into rings; inner rings (an
    enclave, a lake) are cut out the same way.
    """
    members = rel.get("members") or []
    outer = _ring_lines(members, {"outer", ""})
    if not outer:
        return None
    outer_poly = shapely.union_all(shapely.polygonize(outer).geoms or [])
    inner = _ring_lines(members, {"inner"})
    if inner:
        holes = shapely.union_all(shapely.polygonize(inner).geoms or [])
        outer_poly = outer_poly.difference(holes)
    poly = shapely.make_valid(outer_poly)
    return None if poly.is_empty or poly.area == 0 else poly


def areas_from(data: dict[str, Any]) -> list[Area]:
    out = []
    for el in data.get("elements", []):
        if el.get("type") != "relation":
            continue
        tags = el.get("tags") or {}
        poly = relation_polygon(el)
        if poly is None:
            continue
        try:
            level = int(tags.get("admin_level", "0"))
        except ValueError:
            level = 0
        out.append(Area(id=int(el["id"]), name=tags.get("name", f"relation {el['id']}"),
                        level=level, polygon=poly, tags=tags))
    return out


def boundary(rel_id: int) -> Area | None:
    """One administrative area by relation id."""
    data = overpass(f"[out:json][timeout:60];rel({int(rel_id)});out geom qt;")
    return next((a for a in areas_from(data) if a.id == rel_id), None)


def _cells(lat: np.ndarray, lon: np.ndarray, size: float) -> list[tuple[float, float]]:
    keys = np.unique(np.column_stack([np.floor(lat / size), np.floor(lon / size)]), axis=0)
    return [(float(a) * size, float(b) * size) for a, b in keys]


def _bbox_clause(s: float, w: float, n: float, e: float) -> str:
    return f"{s:.4f},{w:.4f},{n:.4f},{e:.4f}"


def discover_areas(lat: np.ndarray, lon: np.ndarray, level: int = 8) -> list[Area]:
    """Every administrative area of `level` that the given points touch.

    One query per 0.1° cell the points pass through, cached, so a history
    concentrated around home costs a handful of requests and a new holiday
    region costs a few more.
    """
    seen: dict[int, Area] = {}
    for s, w in _cells(lat, lon, CELL_DEG):
        n, e = s + CELL_DEG, w + CELL_DEG
        ql = (
            f'[out:json][timeout:90];rel["boundary"="administrative"]["admin_level"="{level}"]'
            f"({_bbox_clause(s, w, n, e)});out geom qt;"
        )
        try:
            data = overpass(ql)
        except OverpassUnavailable:
            # A cell Overpass would not serve drops out of this run and is
            # asked again on the next one; nothing about it was cached. Unlike
            # a street tile, a missing cell cannot produce a wrong number —
            # only an area that appears a refresh later.
            log.warning("discovery: skipping cell %.1f,%.1f for now", s, w)
            continue
        for area in areas_from(data):
            seen.setdefault(area.id, area)
    return list(seen.values())


def subareas(area: Area) -> tuple[list[Area], bool]:
    """Neighbourhoods inside an area, and whether they are approximate.

    Administrative levels 9 and 10 where a city has mapped them. Many have not,
    and for those the named places (suburbs, quarters, neighbourhoods) are used
    instead: each street belongs to the nearest one, a Voronoi partition that
    follows how people actually name parts of town even where no official line
    exists.
    """
    s, w, n, e = area.bbox
    ql = (
        f'[out:json][timeout:90];rel["boundary"="administrative"]["admin_level"~"^(9|10)$"]'
        f"({_bbox_clause(s, w, n, e)});out geom qt;"
    )
    inside = []
    for sub in areas_from(overpass(ql)):
        if sub.level > area.level and area.polygon.contains(sub.polygon.representative_point()):
            inside.append(sub)
    if inside:
        # Prefer one consistent level: the finest that covers most of the area.
        by_level: dict[int, list[Area]] = {}
        for sub in inside:
            by_level.setdefault(sub.level, []).append(sub)
        best = max(by_level.values(), key=lambda subs: sum(x.polygon.area for x in subs))
        return best, False

    ql = (
        f'[out:json][timeout:90];node["place"~"^(suburb|quarter|neighbourhood)$"]'
        f"({_bbox_clause(s, w, n, e)});out tags qt;"
    )
    places = []
    for el in overpass(ql).get("elements", []):
        name = (el.get("tags") or {}).get("name")
        if not name:
            continue
        pt = shapely.points(el["lon"], el["lat"])
        if area.polygon.contains(pt):
            places.append(Area(id=int(el["id"]), name=name, level=99, polygon=pt, tags=el.get("tags") or {}))
    return places, True


# --------------------------------------------------------------------------
# Streets
# --------------------------------------------------------------------------


@dataclass
class Way:
    id: int
    name: str | None
    highway: str
    coords: np.ndarray  # (n, 2) lat/lon


def _keep(tags: dict[str, str]) -> bool:
    if tags.get("area") == "yes":
        return False
    if tags.get("footway") in EXCLUDED_FOOTWAY:
        return False
    if tags.get("access") in PRIVATE_ACCESS and tags.get("foot") not in ("yes", "designated"):
        return False
    return tags.get("highway") in HIGHWAYS


def tiles_for(bbox: tuple[float, float, float, float]) -> list[tuple[float, float]]:
    s, w, n, e = bbox
    lat0 = math.floor(s / TILE_DEG)
    lon0 = math.floor(w / TILE_DEG)
    lat1 = math.floor(n / TILE_DEG)
    lon1 = math.floor(e / TILE_DEG)
    return [(i * TILE_DEG, j * TILE_DEG) for i in range(lat0, lat1 + 1) for j in range(lon0, lon1 + 1)]


def streets_in(bbox: tuple[float, float, float, float], on_tile=None) -> list[Way]:
    """Every street in the tiles covering `bbox`, deduplicated by way id."""
    pattern = "|".join(HIGHWAYS)
    ways: dict[int, Way] = {}
    tiles = tiles_for(bbox)
    for i, (s, w) in enumerate(tiles):
        ql = (
            f"[out:json][timeout:90][bbox:{_bbox_clause(s, w, s + TILE_DEG, w + TILE_DEG)}];"
            f'way["highway"~"^({pattern})$"];out tags geom qt;'
        )
        for el in overpass(ql).get("elements", []):
            if el.get("type") != "way" or el["id"] in ways:
                continue
            tags = el.get("tags") or {}
            if not _keep(tags):
                continue
            geom = el.get("geometry") or []
            coords = np.array([(p["lat"], p["lon"]) for p in geom if p], dtype=float)
            if len(coords) >= 2:
                ways[el["id"]] = Way(el["id"], tags.get("name"), tags["highway"], coords)
        if on_tile:
            on_tile(i + 1, len(tiles))
    return list(ways.values())
