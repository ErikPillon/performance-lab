"""Track geometry: cleaning, simplification, and a compact wire format.

A route for the map does not need every sample. At 1 Hz a 40-minute run is
2,400 points, most of them collinear; simplified to a few metres of tolerance
it keeps its shape in a few hundred. Across a whole history that is the
difference between a heatmap that loads and one that does not.

Distances are computed in a local equirectangular projection around the data.
At city scale — the only scale these computations run at — its error is well
under a metre per kilometre, and it keeps every geometric operation in plain
metres without pulling in a projection library.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import polars as pl
import shapely

TRACK_VERSION = 1

# Douglas-Peucker tolerance. Below GPS noise, so nothing real is lost.
SIMPLIFY_TOLERANCE_M = 3.0

# A jump longer than this between consecutive fixes is a gap — the watch lost
# signal, or the timer ran through a train ride — not a path. Joining it would
# draw a straight line through buildings.
MAX_STEP_M = 250.0

# Faster than any human-powered sport by a wide margin; a fix implying more is
# a GPS spike.
MAX_SPEED_MPS = 40.0

EARTH_M_PER_DEG_LAT = 110_574.0
EARTH_M_PER_DEG_LON_EQ = 111_320.0


@dataclass(frozen=True)
class LocalProjection:
    """Metres east/north of an origin; accurate at city scale."""

    lat0: float
    lon0: float

    @classmethod
    def around(cls, lat: np.ndarray, lon: np.ndarray) -> LocalProjection:
        return cls(float(np.nanmean(lat)), float(np.nanmean(lon)))

    @property
    def _kx(self) -> float:
        return EARTH_M_PER_DEG_LON_EQ * math.cos(math.radians(self.lat0))

    def forward(self, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return (np.asarray(lon) - self.lon0) * self._kx, (np.asarray(lat) - self.lat0) * EARTH_M_PER_DEG_LAT

    def inverse(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return np.asarray(y) / EARTH_M_PER_DEG_LAT + self.lat0, np.asarray(x) / self._kx + self.lon0


def clean_fixes(lat: np.ndarray, lon: np.ndarray, t: np.ndarray | None) -> list[np.ndarray]:
    """Valid fixes, split into parts at gaps and with spikes removed.

    Returns a list of (n, 2) lat/lon arrays, each a continuous stretch of
    movement with at least two points.
    """
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    ok = np.isfinite(lat) & np.isfinite(lon) & (np.abs(lat) <= 90) & (np.abs(lon) <= 180)
    # (0, 0) is what some devices write before the first fix.
    ok &= ~((np.abs(lat) < 1e-6) & (np.abs(lon) < 1e-6))
    if t is not None:
        t = np.asarray(t, dtype=float)
        ok &= np.isfinite(t)
    lat, lon = lat[ok], lon[ok]
    t = t[ok] if t is not None else None
    if lat.size < 2:
        return []

    proj = LocalProjection.around(lat, lon)
    x, y = proj.forward(lat, lon)

    parts: list[np.ndarray] = []
    current: list[int] = [0]
    for i in range(1, lat.size):
        j = current[-1]
        step = math.hypot(x[i] - x[j], y[i] - y[j])
        if t is not None:
            dt = t[i] - t[j]
            # A single fix that leaps away and back is a spike: drop it rather
            # than splitting the track around it.
            if dt > 0 and step / dt > MAX_SPEED_MPS and step < MAX_STEP_M * 4:
                continue
        if step > MAX_STEP_M:
            if len(current) >= 2:
                parts.append(np.column_stack([lat[current], lon[current]]))
            current = [i]
        else:
            current.append(i)
    if len(current) >= 2:
        parts.append(np.column_stack([lat[current], lon[current]]))
    return parts


def simplify(part: np.ndarray, tolerance_m: float = SIMPLIFY_TOLERANCE_M) -> np.ndarray:
    """Douglas-Peucker in metres, returned as lat/lon."""
    proj = LocalProjection.around(part[:, 0], part[:, 1])
    x, y = proj.forward(part[:, 0], part[:, 1])
    line = shapely.simplify(shapely.linestrings(np.column_stack([x, y])), tolerance_m)
    coords = shapely.get_coordinates(line)
    lat, lon = proj.inverse(coords[:, 0], coords[:, 1])
    return np.column_stack([lat, lon])


def track_summary(df: pl.DataFrame) -> dict[str, Any] | None:
    """The simplified route of one activity, or None when it has no GPS."""
    if df is None or "lat" not in df.columns or "lon" not in df.columns:
        return None
    t = df["t_s"].to_numpy() if "t_s" in df.columns else None
    parts = clean_fixes(df["lat"].to_numpy(), df["lon"].to_numpy(), t)
    if not parts:
        return None

    simplified = [simplify(p) for p in parts]
    everything = np.vstack(simplified)
    return {
        "parts": [encode_polyline(p) for p in simplified],
        "bbox": [
            round(float(everything[:, 0].min()), 6),
            round(float(everything[:, 1].min()), 6),
            round(float(everything[:, 0].max()), 6),
            round(float(everything[:, 1].max()), 6),
        ],
        "points": int(everything.shape[0]),
        "version": TRACK_VERSION,
    }


def encode_polyline(coords: np.ndarray, precision: int = 5) -> str:
    """Google's encoded-polyline format: ~1 m resolution at precision 5.

    Chosen because it is compact (about 4 bytes a point against ~20 for JSON
    pairs) and every map library, including the dashboard's, can decode it
    in a few lines.
    """
    factor = 10**precision
    out: list[str] = []
    prev_lat = prev_lon = 0
    for lat, lon in coords:
        ilat = int(round(lat * factor))
        ilon = int(round(lon * factor))
        for delta in (ilat - prev_lat, ilon - prev_lon):
            v = ~(delta << 1) if delta < 0 else delta << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        prev_lat, prev_lon = ilat, ilon
    return "".join(out)


def decode_polyline(encoded: str, precision: int = 5) -> np.ndarray:
    """The inverse of `encode_polyline`, as an (n, 2) lat/lon array."""
    factor = 10**precision
    coords: list[tuple[float, float]] = []
    index = lat = lon = 0
    length = len(encoded)
    while index < length:
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += delta
            else:
                lon += delta
        coords.append((lat / factor, lon / factor))
    return np.array(coords, dtype=float).reshape(-1, 2)
