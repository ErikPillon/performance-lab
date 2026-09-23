"""Street coverage: how much of an area's network your tracks have run or ridden.

Every street is sampled every `SAMPLE_M` metres, and a sample is covered when
any of your tracks passes within `TOLERANCE_M` of it. A street's coverage is
the length its covered samples stand for. This is the approach CityStrides and
Wandrer take in spirit, and it is deliberately not map matching: a map matcher
has to decide which single street a track followed, and gets that wrong at
every junction and on every parallel footpath. Asking "was I near this piece of
street" has no such failure, at the price of occasionally crediting a street
that runs within 20 m of one you did take.

Tracks are cut into two-point segments before indexing. An index of whole
tracks would hand back every run that ever crossed the city for every query;
segments keep each candidate local, so the distance checks stay cheap.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

import numpy as np
import shapely
from shapely import STRtree
from shapely.ops import substring

from .geo import LocalProjection, encode_polyline
from .osm import Area, Way

COVERAGE_VERSION = 1

SAMPLE_M = 10.0
# GPS error plus half a street's width. Parallel streets closer than this are
# rare, and the alternative — missing streets that were genuinely run because
# the watch drifted — is the more common failure.
TOLERANCE_M = 20.0
# A street counts as done once this much of it is covered: the last metres of
# a dead end or a clipped junction should not keep a street "unfinished".
DONE_FRACTION = 0.9


@dataclass
class Track:
    id: str
    parts: list[np.ndarray]  # each (n, 2) lat/lon


@dataclass
class Network:
    """An area's streets, clipped and sampled, ready to test tracks against."""

    area: Area
    proj: LocalProjection
    pieces: list[tuple[Way, shapely.LineString]]  # projected, clipped to the area
    sample_xy: np.ndarray  # (n, 2)
    sample_piece: np.ndarray  # piece index per sample
    sample_at: np.ndarray  # distance along the piece, metres
    sample_len: np.ndarray  # metres each sample stands for
    sample_sub: np.ndarray  # sub-area index per sample, -1 when none
    subareas: list[Area]
    subareas_approx: bool


def build_network(area: Area, ways: list[Way], subareas: list[Area], approx: bool) -> Network:
    w, s, e, n = area.polygon.bounds
    proj = LocalProjection((s + n) / 2, (w + e) / 2)

    def project(geom):
        return shapely.transform(geom, lambda c: np.column_stack(proj.forward(c[:, 1], c[:, 0])))

    boundary = project(area.polygon)
    shapely.prepare(boundary)

    pieces: list[tuple[Way, shapely.LineString]] = []
    for way, coords in split_at_junctions(ways):
        x, y = proj.forward(coords[:, 0], coords[:, 1])
        line = shapely.linestrings(np.column_stack([x, y]))
        if not boundary.intersects(line):
            continue
        clipped = line if boundary.contains(line) else line.intersection(boundary)
        for part in getattr(clipped, "geoms", [clipped]):
            if isinstance(part, shapely.LineString) and part.length >= 1.0:
                pieces.append((way, part))

    # Sample each piece at the centre of equal intervals, so every sample
    # stands for the same share of its street and lengths add up exactly.
    counts = np.array([max(1, int(round(p.length / SAMPLE_M))) for _, p in pieces], dtype=int)
    lengths = np.array([p.length for _, p in pieces])
    sample_piece = np.repeat(np.arange(len(pieces)), counts)
    step = np.repeat(lengths / np.maximum(counts, 1), counts)
    offset = np.concatenate([np.arange(c) for c in counts]) if len(counts) else np.array([])
    sample_at = (offset + 0.5) * step
    geoms = np.array([p for _, p in pieces], dtype=object)[sample_piece] if len(pieces) else np.array([])
    points = shapely.line_interpolate_point(geoms, sample_at) if len(geoms) else np.array([])
    sample_xy = shapely.get_coordinates(points) if len(points) else np.zeros((0, 2))

    sample_sub = np.full(len(sample_xy), -1, dtype=int)
    if subareas and len(sample_xy):
        if approx:
            # Nearest named place, a Voronoi partition of the area.
            place_xy = np.column_stack(proj.forward(
                np.array([p.polygon.y for p in subareas]), np.array([p.polygon.x for p in subareas])
            ))
            # One place at a time keeps memory linear in the samples.
            best = np.full(len(sample_xy), np.inf)
            for i, (px, py) in enumerate(place_xy):
                d2 = (sample_xy[:, 0] - px) ** 2 + (sample_xy[:, 1] - py) ** 2
                closer = d2 < best
                best[closer] = d2[closer]
                sample_sub[closer] = i
        else:
            for i, sub in enumerate(subareas):
                inside = shapely.contains_xy(project(sub.polygon), sample_xy[:, 0], sample_xy[:, 1])
                sample_sub[inside & (sample_sub < 0)] = i

    return Network(area, proj, pieces, sample_xy, sample_piece, sample_at, step, sample_sub,
                   subareas, approx)


def split_at_junctions(ways: list[Way]) -> list[tuple[Way, np.ndarray]]:
    """Each way cut into edges that run from one junction to the next.

    An OSM way is a naming unit, not a topological one: a single residential
    street often runs through a dozen intersections. Two ways that meet share a
    node, and Overpass writes a shared node's coordinates identically in both,
    so a junction is any coordinate that appears more than once — no node ids
    needed. Coverage is indifferent to the split; anything that follows a route
    from street to street needs it.
    """
    keys = [np.round(w.coords, 7) for w in ways]
    counts: dict[tuple[float, float], int] = {}
    for k in keys:
        for pt in map(tuple, k):
            counts[pt] = counts.get(pt, 0) + 1

    edges: list[tuple[Way, np.ndarray]] = []
    for way, k in zip(ways, keys):
        cuts = [i for i in range(1, len(k) - 1) if counts[tuple(k[i])] > 1]
        start = 0
        for cut in [*cuts, len(k) - 1]:
            if cut > start:
                edges.append((way, way.coords[start:cut + 1]))
            start = cut
    return edges


def track_segments(tracks: Iterable[Track], proj: LocalProjection,
                   bounds_xy: tuple[float, float, float, float]) -> tuple[np.ndarray, np.ndarray]:
    """Two-point segments near the area, and which track each came from."""
    minx, miny, maxx, maxy = bounds_xy
    pad = TOLERANCE_M * 2
    segs: list[np.ndarray] = []
    owner: list[np.ndarray] = []
    for i, track in enumerate(tracks):
        for part in track.parts:
            if len(part) < 2:
                continue
            x, y = proj.forward(part[:, 0], part[:, 1])
            near = (x >= minx - pad) & (x <= maxx + pad) & (y >= miny - pad) & (y <= maxy + pad)
            keep = near[:-1] | near[1:]
            if not keep.any():
                continue
            a = np.column_stack([x[:-1], y[:-1]])[keep]
            b = np.column_stack([x[1:], y[1:]])[keep]
            segs.append(np.stack([a, b], axis=1))
            owner.append(np.full(len(a), i, dtype=int))
    if not segs:
        return np.zeros((0, 2, 2)), np.zeros(0, dtype=int)
    return np.concatenate(segs), np.concatenate(owner)


def match(network: Network, tracks: list[Track]) -> tuple[np.ndarray, np.ndarray]:
    """Pairs of (sample index, track index) within tolerance of each other."""
    if not len(network.sample_xy) or not tracks:
        return np.zeros(0, dtype=int), np.zeros(0, dtype=int)
    xs, ys = network.sample_xy[:, 0], network.sample_xy[:, 1]
    segs, owner = track_segments(tracks, network.proj, (xs.min(), ys.min(), xs.max(), ys.max()))
    if not len(segs):
        return np.zeros(0, dtype=int), np.zeros(0, dtype=int)
    tree = STRtree(shapely.linestrings(segs))
    samples, hits = tree.query(shapely.points(network.sample_xy), predicate="dwithin", distance=TOLERANCE_M)
    pairs = np.unique(np.column_stack([samples, owner[hits]]), axis=0)
    return pairs[:, 0], pairs[:, 1]


def summarise(network: Network, covered: np.ndarray) -> dict[str, Any]:
    """Totals, per street, per neighbourhood, and the drawable runs."""
    length = network.sample_len
    total = float(length.sum())
    covered_m = float(length[covered].sum())

    # Streets are counted by name: one street is usually several OSM ways.
    piece_names = np.array([way.name or "" for way, _ in network.pieces], dtype=object)
    names = piece_names[network.sample_piece] if len(piece_names) else np.array([], dtype=object)
    streets = []
    if len(names):
        unique, inverse = np.unique(names, return_inverse=True)
        total_by = np.bincount(inverse, weights=length, minlength=len(unique))
        covered_by = np.bincount(inverse, weights=length * covered, minlength=len(unique))
        streets = sorted(
            ({"name": str(n), "length_m": round(t), "covered_m": round(c)}
             for n, t, c in zip(unique, total_by, covered_by) if n),
            key=lambda s: -s["length_m"],
        )
    done = sum(1 for s in streets if s["length_m"] and s["covered_m"] / s["length_m"] >= DONE_FRACTION)

    subs = []
    for i, sub in enumerate(network.subareas):
        mask = network.sample_sub == i
        if not mask.any():
            continue
        subs.append({
            "id": sub.id,
            "name": sub.name,
            "length_m": round(float(length[mask].sum())),
            "covered_m": round(float(length[mask & covered].sum())),
        })
    subs.sort(key=lambda s: -s["covered_m"] / max(s["length_m"], 1))

    return {
        "totals": {
            "length_m": round(total),
            "covered_m": round(covered_m),
            "streets": len(streets),
            "streets_done": done,
        },
        "streets": streets,
        "subareas": subs,
        "subareas_approx": network.subareas_approx,
        "runs": runs(network, covered),
    }


def runs(network: Network, covered: np.ndarray) -> dict[str, list[str]]:
    """Covered and uncovered stretches, as encoded polylines.

    A street half-run is drawn half in each colour, rather than tinted by its
    percentage — the map should show which end is missing.
    """
    out: dict[str, list[str]] = {"covered": [], "uncovered": []}
    if not len(network.sample_piece):
        return out
    # Boundaries where the piece or the covered state changes.
    change = np.r_[True, (np.diff(network.sample_piece) != 0) | (np.diff(covered.astype(int)) != 0)]
    starts = np.flatnonzero(change)
    ends = np.r_[starts[1:], len(covered)]
    for a, b in zip(starts, ends):
        piece = network.sample_piece[a]
        line = network.pieces[piece][1]
        half = network.sample_len[a] / 2
        start = max(0.0, network.sample_at[a] - half)
        end = min(line.length, network.sample_at[b - 1] + half)
        seg = substring(line, start, end)
        coords = shapely.get_coordinates(seg)
        if len(coords) < 2:
            continue
        lat, lon = network.proj.inverse(coords[:, 0], coords[:, 1])
        out["covered" if covered[a] else "uncovered"].append(encode_polyline(np.column_stack([lat, lon])))
    return out


def outline(area: Area, tolerance_deg: float = 0.00005) -> list[str]:
    """The boundary as encoded polylines, one per ring, simplified to ~5 m."""
    simple = shapely.simplify(area.polygon, tolerance_deg)
    rings = []
    for poly in getattr(simple, "geoms", [simple]):
        if not isinstance(poly, shapely.Polygon):
            continue
        for ring in [poly.exterior, *poly.interiors]:
            c = shapely.get_coordinates(ring)
            rings.append(encode_polyline(np.column_stack([c[:, 1], c[:, 0]])))
    return rings


def coverage(network: Network, tracks: list[Track]) -> dict[str, Any]:
    samples, owners = match(network, tracks)
    covered = np.zeros(len(network.sample_xy), dtype=bool)
    covered[samples] = True
    result = summarise(network, covered)
    # Activities that actually touched a street here, not every one passed in.
    result["activities"] = int(len(np.unique(owners)))
    return result
