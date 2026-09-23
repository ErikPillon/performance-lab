"""Sectors: the stretches of street you keep coming back to, found for you.

A Strava segment is drawn by someone, once, and matched against everyone. This
works the other way round: it looks at where *your* routes actually repeat and
proposes those stretches, then times every pass along them from the original
streams. Nothing has to be drawn, and a new favourite loop shows up on its own.

Three steps.

1. **Traversals.** Each route is reduced to the sequence of street edges
   (junction to junction) it travelled along, in order and with a direction.
   An edge only counts when the route ran along a real share of it — crossing a
   street at a junction touches it for twenty metres and is not a visit.
2. **Mining.** The most-travelled directed edge seeds a sector, which grows
   forwards and backwards along whichever next edge the same activities most
   often continue onto, for as long as enough of them stay together. Edges a
   sector has claimed cannot seed another, so sectors do not overlap.
3. **Passes.** Each sector gets a gate at each end, perpendicular to the
   street. A pass is a crossing of the start gate followed by a crossing of
   the end gate, both in the sector's direction, with a path length close to
   the sector's own — so leaving the sector and rejoining it later is not a
   pass, and three laps of a loop are three. Crossing times are interpolated
   between samples, so a pass is timed to well under a second even on a watch
   that records every few.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import polars as pl
import shapely
from shapely import STRtree

from .coverage import TOLERANCE_M, Network, Track
from .gap import grade_factor
from .geo import LocalProjection, encode_polyline

SECTOR_VERSION = 1

MIN_SUPPORT = 4
MIN_LENGTH_M = 400.0
MAX_LENGTH_M = 5000.0
MAX_SECTORS = 12
# Growth continues while at least this share of the seed's activities agree on
# the next edge. Lower merges different habits into one sector; higher cuts a
# familiar route at every junction where one run turned off.
KEEP_SUPPORT = 0.6
# How much of an edge a route has to run along for it to count as a visit.
MIN_EDGE_SPAN = 0.5
# Where a route starts or ends, its edge must be all but complete to count.
FULL_EDGE = 0.9
# Edges shorter than this count as travelled whenever the route touched them.
SHORT_EDGE_M = 40.0
# Consecutive edges of a sector must actually meet.
JOIN_TOLERANCE_M = 25.0
# Travel back along an edge by more than this is a turnaround, not GPS noise.
REVERSAL_M = 25.0

GATE_HALF_WIDTH_M = 25.0
# Gates sit this far inside each end rather than on the junction itself. A
# route that turns onto the sector from a side street runs *parallel* to a
# gate drawn across the junction and never cleanly crosses it; twenty metres
# in, it is already travelling along the street.
GATE_INSET_M = 20.0
# A pass whose path is much longer than the sector left it and came back.
MAX_PATH_RATIO = 1.25
MIN_PATH_RATIO = 0.8


@dataclass
class Sector:
    edges: list[tuple[int, bool]]  # (piece index, forward)
    activities: set[str]
    line: shapely.LineString  # projected
    passes: list[dict[str, Any]] = field(default_factory=list)

    @property
    def length(self) -> float:
        return float(self.line.length)


# --------------------------------------------------------------------------
# 1. Traversals
# --------------------------------------------------------------------------


def _travel_order(network: Network, units: list[np.ndarray]) -> dict[int, np.ndarray]:
    """For each route part, the street samples it passed, in the order it passed them.

    Ordered by the route's own segments, which are in time order — not by
    projecting each sample onto the route. Projection gives a sample one
    position, so a street ridden out from home and back again collapses into a
    single pass, and the first and last minutes of a ride get stitched
    together. Here a sample near two stretches of the route appears twice.
    """
    xs, ys = network.sample_xy[:, 0], network.sample_xy[:, 1]
    minx, miny, maxx, maxy = xs.min(), ys.min(), xs.max(), ys.max()
    pad = TOLERANCE_M * 2
    segs, owner, order = [], [], []
    for u, part in enumerate(units):
        x, y = network.proj.forward(part[:, 0], part[:, 1])
        near = (x >= minx - pad) & (x <= maxx + pad) & (y >= miny - pad) & (y <= maxy + pad)
        keep = np.flatnonzero(near[:-1] | near[1:])
        if not len(keep):
            continue
        segs.append(np.stack([np.column_stack([x[keep], y[keep]]), np.column_stack([x[keep + 1], y[keep + 1]])], axis=1))
        owner.append(np.full(len(keep), u))
        order.append(keep)
    if not segs:
        return {}
    segs_a, owner_a, order_a = np.concatenate(segs), np.concatenate(owner), np.concatenate(order)
    tree = STRtree(shapely.linestrings(segs_a))
    samp, hit = tree.query(shapely.points(network.sample_xy), predicate="dwithin", distance=TOLERANCE_M)

    # Where along its segment each match falls, and how far off it is.
    a, b = segs_a[hit, 0], segs_a[hit, 1]
    ab = b - a
    pts = network.sample_xy[samp]
    t = np.clip(((pts - a) * ab).sum(axis=1) / np.maximum((ab**2).sum(axis=1), 1e-9), 0, 1)
    dist = np.hypot(*(pts - (a + ab * t[:, None])).T)
    unit, seg = owner_a[hit], order_a[hit]

    # A sample within reach of a dense route matches several consecutive
    # segments — one passing, not several. Group matches of the same sample by
    # the same route into runs of nearby segments, and keep the closest segment
    # of each run. A second run, far later in the route, is a genuine second
    # pass (out and back along the same street) and stays.
    idx = np.lexsort((seg, samp, unit))
    unit, samp, seg, t, dist = unit[idx], samp[idx], seg[idx], t[idx], dist[idx]
    new = np.r_[True, (unit[1:] != unit[:-1]) | (samp[1:] != samp[:-1]) | (seg[1:] - seg[:-1] > 2)]
    cluster = np.cumsum(new) - 1
    best = np.lexsort((dist, cluster))
    first = np.r_[True, cluster[best][1:] != cluster[best][:-1]]
    pick = best[first]
    unit, samp, seg, key, dist = unit[pick], samp[pick], seg[pick], seg[pick] + t[pick], dist[pick]

    # A road with a cycleway or footpath beside it: both lie within reach of
    # the same stretch of route, and following both makes a sequence that
    # zig-zags between them. For each route segment keep only the street it
    # was actually on — the one whose samples lie closest.
    piece = network.sample_piece[samp]
    order = np.lexsort((piece, seg, unit))
    unit, samp, seg, key, dist, piece = (arr[order] for arr in (unit, samp, seg, key, dist, piece))
    group_start = np.r_[True, (unit[1:] != unit[:-1]) | (seg[1:] != seg[:-1]) | (piece[1:] != piece[:-1])]
    gid = np.cumsum(group_start) - 1
    mean_dist = np.bincount(gid, weights=dist) / np.bincount(gid)
    bucket_start = np.r_[True, (unit[1:] != unit[:-1]) | (seg[1:] != seg[:-1])]
    bucket = np.cumsum(bucket_start) - 1
    group_bucket = bucket[group_start]
    best_group = np.full(bucket.max() + 1, -1)
    best_dist = np.full(bucket.max() + 1, np.inf)
    for g, (bk, d) in enumerate(zip(group_bucket, mean_dist)):
        if d < best_dist[bk]:
            best_dist[bk], best_group[bk] = d, g
    keep = best_group[bucket] == gid
    unit, samp, key = unit[keep], samp[keep], key[keep]

    out: dict[int, np.ndarray] = {}
    for u in np.unique(unit):
        mask = unit == u
        out[int(u)] = samp[mask][np.argsort(key[mask], kind="stable")]
    return out


def traversals(network: Network, tracks: list[Track]) -> dict[str, list[list[tuple[int, bool]]]]:
    """For each activity, the sequences of directed edges its parts travelled."""
    units: list[tuple[str, np.ndarray]] = [(t.id, part) for t in tracks for part in t.parts if len(part) >= 2]
    if not units or not len(network.sample_xy):
        return {}
    ordered = _travel_order(network, [p for _, p in units])

    out: dict[str, list[list[tuple[int, bool]]]] = defaultdict(list)
    piece_len = np.array([p.length for _, p in network.pieces])
    # Every sample on an edge stands for the same length; one per edge suffices.
    piece_step = np.zeros(len(piece_len))
    piece_step[network.sample_piece] = network.sample_len
    for u, seq_samples in ordered.items():
        activity = units[u][0]
        pieces = network.sample_piece[seq_samples]
        ats = network.sample_at[seq_samples]

        # Runs of consecutive samples on one edge: [edge, first at, last at,
        # samples, direction]. A run splits where travel along the edge turns
        # back — an out-and-back's turnaround — or the two legs would merge
        # into one visit that seems to go nowhere.
        runs: list[list] = []
        for piece, at in zip(pieces, ats):
            r = runs[-1] if runs and runs[-1][0] == piece else None
            if r is None:
                runs.append([int(piece), at, at, 1, 0])
                continue
            if r[4] == 0 and abs(at - r[1]) >= REVERSAL_M:
                r[4] = 1 if at > r[1] else -1
            if r[4] and (r[2] - at) * r[4] > REVERSAL_M:
                runs.append([int(piece), r[2], at, 1, -r[4]])
                continue
            if r[4] == 0 or (at - r[2]) * r[4] > 0:
                r[2] = at
            r[3] += 1

        # At every junction the crossing street's samples land between the
        # travelled street's, splitting one pass in two. Absorb a short run
        # that sits between two runs of the same edge and direction.
        merged: list[list] = []
        i = 0
        while i < len(runs):
            run = runs[i]
            nxt = runs[i + 1] if i + 1 < len(runs) else None
            if (merged and nxt and run[3] <= 4 and nxt[0] == merged[-1][0]
                    and nxt[4] * merged[-1][4] >= 0):
                i += 1
                continue
            if merged and merged[-1][0] == run[0] and run[4] * merged[-1][4] >= 0:
                merged[-1][2] = run[2]
                merged[-1][3] += run[3]
                merged[-1][4] = merged[-1][4] or run[4]
            else:
                merged.append(list(run))
            i += 1

        visits: list[tuple[tuple[int, bool], float]] = []  # (edge, share of it covered)
        for piece, first, last, n, _ in merged:
            share = (abs(last - first) + piece_step[piece]) / piece_len[piece]
            # A short connector between two junctions is passed in a couple of
            # samples; dropping it would break the chain it links.
            if share < MIN_EDGE_SPAN and piece_len[piece] >= SHORT_EDGE_M:
                continue
            edge = (piece, bool(last >= first))
            if visits and visits[-1][0] == edge:
                visits[-1] = (edge, max(visits[-1][1], share))
            else:
                visits.append((edge, share))
        # A route usually starts and ends *inside* an edge — at the front door.
        # Counting those partial edges builds sectors out of the home street
        # that no ride ever enters through a gate, so they can never be timed:
        # on the real corpus one such sector had 50 activities and no passes.
        while visits and visits[0][1] < FULL_EDGE:
            visits.pop(0)
        while visits and visits[-1][1] < FULL_EDGE:
            visits.pop()
        if visits:
            out[activity].append([edge for edge, _ in visits])
    return out


# --------------------------------------------------------------------------
# 2. Mining
# --------------------------------------------------------------------------


def _edge_length(network: Network, edge: tuple[int, bool]) -> float:
    return float(network.pieces[edge[0]][1].length)


def mine(network: Network, seqs: dict[str, list[list[tuple[int, bool]]]]) -> list[Sector]:
    # Every occurrence of every directed edge: (activity, sequence index, position).
    occurrences: dict[tuple[int, bool], list[tuple[str, int, int]]] = defaultdict(list)
    flat: list[tuple[str, list[tuple[int, bool]]]] = []
    for activity, lists in seqs.items():
        for seq in lists:
            k = len(flat)
            flat.append((activity, seq))
            for i, edge in enumerate(seq):
                occurrences[edge].append((activity, k, i))

    support = {e: len({a for a, _, _ in occ}) for e, occ in occurrences.items()}
    # Directed: the same street run the other way is a different effort — the
    # hill goes the other way — and deserves its own sector.
    used: set[tuple[int, bool]] = set()
    sectors: list[Sector] = []

    for seed in sorted(support, key=lambda e: (-support[e], -_edge_length(network, e))):
        if support[seed] < MIN_SUPPORT or seed in used:
            continue
        floor = max(MIN_SUPPORT, KEEP_SUPPORT * support[seed])
        # Occurrences carry (sequence, first index, last index) of the chain.
        occ = [(k, i, i) for _, k, i in occurrences[seed]]
        chain = [seed]
        length = _edge_length(network, seed)

        for direction in (1, -1):
            while length < MAX_LENGTH_M:
                nexts: dict[tuple[int, bool], list[tuple[int, int, int]]] = defaultdict(list)
                for k, first, last in occ:
                    seq = flat[k][1]
                    j = last + 1 if direction == 1 else first - 1
                    if 0 <= j < len(seq):
                        nexts[seq[j]].append((k, first if direction == 1 else j, j if direction == 1 else last))
                best = None
                for edge, cont in sorted(nexts.items(), key=lambda kv: -len({flat[k][0] for k, _, _ in kv[1]})):
                    if edge in used or any(edge[0] == c[0] for c in chain):
                        continue
                    joins = (_meets(network, chain[-1], edge) if direction == 1
                             else _meets(network, edge, chain[0]))
                    if not joins:
                        continue
                    if len({flat[k][0] for k, _, _ in cont}) >= floor:
                        best = (edge, cont)
                    break
                if best is None:
                    break
                edge, occ = best
                chain = [*chain, edge] if direction == 1 else [edge, *chain]
                length += _edge_length(network, edge)

        if length < MIN_LENGTH_M:
            continue
        activities = {flat[k][0] for k, _, _ in occ}
        if len(activities) < MIN_SUPPORT:
            continue
        sectors.append(Sector(chain, activities, _chain_line(network, chain)))
        used.update(chain)
        if len(sectors) >= MAX_SECTORS * 2:
            break

    sectors.sort(key=lambda s: -(len(s.activities) * s.length))
    return sectors[:MAX_SECTORS]


def _ends(network: Network, edge: tuple[int, bool]) -> tuple[np.ndarray, np.ndarray]:
    c = shapely.get_coordinates(network.pieces[edge[0]][1])
    return (c[0], c[-1]) if edge[1] else (c[-1], c[0])


def _meets(network: Network, a: tuple[int, bool], b: tuple[int, bool]) -> bool:
    """Whether edge `b` starts where edge `a` ends."""
    return float(np.hypot(*(_ends(network, a)[1] - _ends(network, b)[0]))) <= JOIN_TOLERANCE_M


def _chain_line(network: Network, chain: list[tuple[int, bool]]) -> shapely.LineString:
    coords: list[np.ndarray] = []
    for piece, forward in chain:
        c = shapely.get_coordinates(network.pieces[piece][1])
        c = c if forward else c[::-1]
        # Consecutive edges share their junction point; keep it once.
        coords.append(c[1:] if coords else c)
    return shapely.linestrings(np.vstack(coords))


# --------------------------------------------------------------------------
# 3. Passes
# --------------------------------------------------------------------------


def _gate(line: shapely.LineString, distance: float) -> tuple[np.ndarray, np.ndarray]:
    """A point `distance` metres along the line and the direction of travel there."""
    a = shapely.get_coordinates(shapely.line_interpolate_point(line, max(0.0, distance - 2.0)))[0]
    b = shapely.get_coordinates(shapely.line_interpolate_point(line, min(line.length, distance + 2.0)))[0]
    point = shapely.get_coordinates(shapely.line_interpolate_point(line, distance))[0]
    d = b - a
    return point, d / (np.linalg.norm(d) or 1.0)


def _crossings(xy: np.ndarray, t: np.ndarray, gate: tuple[np.ndarray, np.ndarray]) -> list[tuple[float, int]]:
    """Times at which the path crosses the gate in its direction, with the index before."""
    point, direction = gate
    rel = xy - point
    along = rel @ direction
    lateral = np.abs(rel @ np.array([-direction[1], direction[0]]))
    out = []
    idx = np.flatnonzero((along[:-1] < 0) & (along[1:] >= 0))
    for i in idx:
        frac = -along[i] / (along[i + 1] - along[i])
        side = lateral[i] + frac * (lateral[i + 1] - lateral[i])
        if side <= GATE_HALF_WIDTH_M:
            out.append((float(t[i] + frac * (t[i + 1] - t[i])), int(i)))
    return out


def passes(sector: Sector, frame: pl.DataFrame, proj: LocalProjection) -> list[dict[str, Any]]:
    """Every pass along the sector in one activity's stream."""
    need = {"t_s", "lat", "lon"}
    if not need <= set(frame.columns):
        return []
    df = frame.select([c for c in ("t_s", "lat", "lon", "heart_rate", "altitude_m") if c in frame.columns])
    df = df.drop_nulls(["t_s", "lat", "lon"])
    if df.height < 2:
        return []
    t = df["t_s"].to_numpy().astype(float)
    x, y = proj.forward(df["lat"].to_numpy(), df["lon"].to_numpy())
    xy = np.column_stack([x, y])
    step = np.r_[0.0, np.hypot(np.diff(x), np.diff(y))]
    dist = np.cumsum(step)
    hr = df["heart_rate"].to_numpy().astype(float) if "heart_rate" in df.columns else None
    alt = df["altitude_m"].to_numpy().astype(float) if "altitude_m" in df.columns else None

    inset = min(GATE_INSET_M, sector.length / 4)
    starts = _crossings(xy, t, _gate(sector.line, inset))
    ends = _crossings(xy, t, _gate(sector.line, sector.length - inset))
    timed = sector.length - 2 * inset
    out = []
    for t0, i0 in starts:
        later = [(t1, i1) for t1, i1 in ends if t1 > t0]
        if not later:
            continue
        t1, i1 = later[0]
        path = dist[i1] - dist[i0]
        if not (MIN_PATH_RATIO * timed <= path <= MAX_PATH_RATIO * timed):
            continue
        # A later start gate before this end means the pass restarted; the
        # later start is its own pass.
        if any(t0 < ts < t1 for ts, _ in starts):
            continue
        elapsed = t1 - t0
        if elapsed <= 0:
            continue
        window = slice(i0, i1 + 2)
        speed = timed / elapsed
        entry = {"start_s": round(t0, 1), "elapsed_s": round(elapsed, 1), "speed_mps": round(speed, 3)}
        if hr is not None:
            h = hr[window]
            h = h[np.isfinite(h) & (h > 0)]
            entry["avg_hr"] = round(float(h.mean()), 1) if len(h) else None
        if alt is not None:
            a = alt[window]
            ok = np.isfinite(a)
            if ok.sum() >= 2:
                climb = np.diff(a[ok])
                entry["gain_m"] = round(float(climb[climb > 0].sum()), 1)
                grade = (a[ok][-1] - a[ok][0]) / timed
                entry["gap_speed_mps"] = round(float(speed * grade_factor(np.array([grade]))[0]), 3)
        out.append(entry)
    return out


# --------------------------------------------------------------------------


def sector_key(sector: Sector, proj: LocalProjection) -> str:
    """Stable across recomputes as long as the ends and the length stay put."""
    c = shapely.get_coordinates(sector.line)
    lat, lon = proj.inverse(c[[0, -1], 0], c[[0, -1], 1])
    raw = f"{lat[0]:.4f},{lon[0]:.4f}>{lat[1]:.4f},{lon[1]:.4f}:{round(sector.length, -1):.0f}"
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def sector_name(network: Network, sector: Sector) -> str:
    """The streets it follows, in order, without repeats."""
    names: list[str] = []
    for piece, _ in sector.edges:
        name = network.pieces[piece][0].name
        if name and (not names or names[-1] != name):
            names.append(name)
    if not names:
        return "Unnamed paths"
    return names[0] if len(names) == 1 else f"{names[0]} → {names[-1]}" + (
        f" (via {len(names) - 2} more)" if len(names) > 2 else ""
    )


def describe(network: Network, sector: Sector) -> dict[str, Any]:
    c = shapely.get_coordinates(sector.line)
    lat, lon = network.proj.inverse(c[:, 0], c[:, 1])
    return {
        "key": sector_key(sector, network.proj),
        "name": sector_name(network, sector),
        "length_m": round(sector.length),
        "activities": len(sector.activities),
        "polyline": encode_polyline(np.column_stack([lat, lon])),
    }
