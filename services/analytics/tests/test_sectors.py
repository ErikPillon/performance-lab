import numpy as np
import polars as pl
import pytest

from app.coverage import Track, build_network
from app.sectors import MIN_SUPPORT, mine, passes, sector_name, traversals
from tests.test_coverage import at, run_along, town


def habitual(n=6):
    """n runs of the same L: along East 1 from the west edge, then up North 2."""
    return [Track(f"habit{i}", [run_along((0, 500), (750, 500), (750, 1000), jitter=3, seed=i)]) for i in range(n)]


def one_offs():
    return [
        Track("other0", [run_along((250, 0), (250, 1000))]),
        Track("other1", [run_along((0, 750), (1000, 750))]),
    ]


def test_a_route_run_often_becomes_a_sector_and_one_offs_do_not():
    area, ways = town()
    net = build_network(area, ways, [], False)
    seqs = traversals(net, habitual() + one_offs())
    sectors = mine(net, seqs)

    assert len(sectors) == 1
    s = sectors[0]
    assert s.activities == {f"habit{i}" for i in range(6)}
    # 750 m east plus 500 m north.
    assert s.length == pytest.approx(1250, abs=15)
    assert sector_name(net, s) == "East 1 → North 2"


def test_crossing_a_street_is_not_travelling_along_it():
    area, ways = town()
    net = build_network(area, ways, [], False)
    seqs = traversals(net, [Track("a", [run_along((0, 500), (1000, 500))])])
    streets = {net.pieces[p][0].name for seq in seqs["a"] for p, _ in seq}
    assert streets == {"East 1"}


def test_direction_matters():
    area, ways = town()
    net = build_network(area, ways, [], False)
    there = [Track(f"t{i}", [run_along((0, 500), (1000, 500), seed=i)]) for i in range(MIN_SUPPORT)]
    back = [Track(f"b{i}", [run_along((1000, 500), (0, 500), seed=i)]) for i in range(MIN_SUPPORT)]
    sectors = mine(net, traversals(net, there + back))
    assert len(sectors) == 2
    assert {frozenset(s.activities) for s in sectors} == {
        frozenset(t.id for t in there), frozenset(t.id for t in back),
    }


def test_too_few_repeats_is_no_sector():
    area, ways = town()
    net = build_network(area, ways, [], False)
    assert mine(net, traversals(net, habitual(MIN_SUPPORT - 1))) == []


def stream(points_m, speed_mps=3.0, hr=150.0, dt=5.0, t0=0.0):
    """A stream following a polyline at a steady speed, a fix every `dt` seconds."""
    pts = np.array(points_m, dtype=float)
    seg = np.hypot(*np.diff(pts, axis=0).T)
    total = seg.sum()
    s = np.arange(0, total, speed_mps * dt)
    cum = np.r_[0, np.cumsum(seg)]
    x = np.interp(s, cum, pts[:, 0])
    y = np.interp(s, cum, pts[:, 1])
    lat, lon = zip(*(at(a, b) for a, b in zip(x, y)))
    return pl.DataFrame({
        "t_s": t0 + s / speed_mps,
        "lat": lat,
        "lon": lon,
        "heart_rate": np.full(len(s), hr),
        "altitude_m": np.full(len(s), 100.0),
    })


def test_a_pass_is_timed_between_the_gates_to_under_a_second():
    area, ways = town()
    net = build_network(area, ways, [], False)
    (s,) = mine(net, traversals(net, habitual()))
    # Sparse fixes (every 5 s) that never land exactly on a gate.
    frame = stream([(-100, 500), (750, 500), (750, 1100)], speed_mps=3.0, dt=5.0)
    (p,) = passes(s, frame, net.proj)
    # Timed between gates 20 m inside each end.
    assert p["elapsed_s"] == pytest.approx((s.length - 40) / 3.0, abs=1.0)
    assert p["avg_hr"] == pytest.approx(150)
    assert p["start_s"] == pytest.approx(120 / 3.0, abs=1.0)


def test_laps_are_separate_passes_and_a_detour_is_not_a_pass():
    area, ways = town()
    net = build_network(area, ways, [], False)
    (s,) = mine(net, traversals(net, habitual()))

    lap = [(-50, 500), (750, 500), (750, 1050)]
    two_laps = pl.concat([stream(lap), stream(lap, t0=2000)])
    assert len(passes(s, two_laps, net.proj)) == 2

    # Starts the sector, leaves it for a 2 km loop, rejoins for the finish.
    detour = stream([(-50, 500), (300, 500), (300, -800), (700, -800), (700, 500), (750, 500), (750, 1050)])
    assert passes(s, detour, net.proj) == []


def test_running_it_backwards_is_not_a_pass():
    area, ways = town()
    net = build_network(area, ways, [], False)
    (s,) = mine(net, traversals(net, habitual()))
    backwards = stream([(750, 1050), (750, 500), (-50, 500)])
    assert passes(s, backwards, net.proj) == []


def test_a_route_that_turns_onto_the_sector_at_its_first_junction_is_timed():
    # Half the runs come up North 0 from the south, half down it from the north;
    # all turn east onto East 1 at the junction. The shared stretch — and so the
    # sector — starts exactly at that junction, where every route arrives from a
    # side street running parallel to a gate drawn across it.
    area, ways = town()
    net = build_network(area, ways, [], False)
    runs = [
        Track(f"s{i}", [run_along((250, 0), (250, 500), (1000, 500), jitter=3, seed=i)]) for i in range(3)
    ] + [
        Track(f"n{i}", [run_along((250, 1000), (250, 500), (1000, 500), jitter=3, seed=10 + i)]) for i in range(3)
    ]
    (s,) = mine(net, traversals(net, runs))
    assert s.length == pytest.approx(750, abs=15)
    from_south = stream([(250, -50), (250, 500), (1000, 500)])
    from_north = stream([(250, 1050), (250, 500), (1000, 500)])
    assert len(passes(s, from_south, net.proj)) == 1
    assert len(passes(s, from_north, net.proj)) == 1


def test_an_out_and_back_is_two_passes_not_one_stitched_together():
    # Out along East 1 and back the same way, as a ride from the front door
    # does. Ordering samples by projection onto the route gave each one a
    # single position, merging the outbound and return legs.
    area, ways = town()
    net = build_network(area, ways, [], False)
    runs = [
        Track(f"r{i}", [run_along((0, 500), (1000, 500), (1000, 520), (0, 520), jitter=2, seed=i)])
        for i in range(MIN_SUPPORT)
    ]
    sectors = mine(net, traversals(net, runs))
    assert len(sectors) == 2
    east, west = sorted(sectors, key=lambda s: s.edges[0][1], reverse=True)
    frame = stream([(-20, 500), (1020, 500), (1020, 520), (-20, 520)])
    assert len(passes(east, frame, net.proj)) == 1
    assert len(passes(west, frame, net.proj)) == 1
