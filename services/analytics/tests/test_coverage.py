import numpy as np
import pytest
import shapely

from app.coverage import Track, build_network, coverage
from app.geo import decode_polyline
from app.osm import Area, Way

LAT0, LON0 = 45.0, 7.0
M_LAT = 1 / 110_574
M_LON = 1 / (111_320 * np.cos(np.radians(LAT0)))


def at(x_m: float, y_m: float) -> tuple[float, float]:
    """lat/lon of a point x metres east and y metres north of the origin."""
    return LAT0 + y_m * M_LAT, LON0 + x_m * M_LON


def street(id_, name, *pts):
    return Way(id_, name, "residential", np.array([at(*p) for p in pts]))


def town():
    """A 1 km square with a 3x3 street grid at 250/500/750 m."""
    (s, w), (n, e) = at(0, 0), at(1000, 1000)
    area = Area(1, "Gridville", 8, shapely.box(w, s, e, n))
    ways = []
    # A vertex at every crossing, as OSM has: crossing streets share a node.
    stops = (0, 250, 500, 750, 1000)
    for i, off in enumerate((250, 500, 750)):
        ways.append(street(10 + i, f"East {i}", *[(x, off) for x in stops]))
        ways.append(street(20 + i, f"North {i}", *[(off, y) for y in stops]))
    return area, ways


def run_along(*pts, jitter=0.0, seed=0):
    """A track following a polyline with a fix every 5 m."""
    rng = np.random.default_rng(seed)
    out = []
    for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
        n = int(np.hypot(x1 - x0, y1 - y0) / 5)
        for t in np.linspace(0, 1, n, endpoint=False):
            out.append(at(x0 + (x1 - x0) * t + rng.normal(0, jitter), y0 + (y1 - y0) * t + rng.normal(0, jitter)))
    out.append(at(*pts[-1]))
    return np.array(out)


def by_name(result):
    return {s["name"]: s for s in result["streets"]}


def test_a_street_run_end_to_end_is_done_and_its_crossings_are_only_touched():
    area, ways = town()
    net = build_network(area, ways, [], False)
    result = coverage(net, [Track("a", [run_along((0, 500), (1000, 500), jitter=4)])])

    streets = by_name(result)
    assert streets["East 1"]["covered_m"] == pytest.approx(1000, abs=20)
    # Each crossing street is only credited where the run passed within 20 m.
    for i in range(3):
        assert streets[f"North {i}"]["covered_m"] == pytest.approx(40, abs=20)
    assert result["totals"]["streets_done"] == 1
    assert result["totals"]["length_m"] == pytest.approx(6000, abs=10)
    assert result["activities"] == 1


def test_a_parallel_street_beyond_the_tolerance_is_not_credited():
    area, ways = town()
    net = build_network(area, ways, [], False)
    # 30 m north of East 1: close, but not that street.
    result = coverage(net, [Track("a", [run_along((0, 530), (1000, 530))])])
    assert by_name(result)["East 1"]["covered_m"] < 100


def test_streets_are_clipped_to_the_boundary():
    area, _ = town()
    long_way = street(99, "Through Road", (-2000, 100), (3000, 100))
    net = build_network(area, [long_way], [], False)
    result = coverage(net, [])
    assert result["totals"]["length_m"] == pytest.approx(1000, abs=10)


def test_tracks_elsewhere_change_nothing():
    area, ways = town()
    net = build_network(area, ways, [], False)
    far = run_along((5000, 5000), (6000, 5000))
    result = coverage(net, [Track("far", [far])])
    assert result["totals"]["covered_m"] == 0
    assert result["activities"] == 0


def test_the_map_shows_which_part_of_a_street_is_missing():
    area, ways = town()
    net = build_network(area, ways, [], False)
    # Half of East 1, west end only.
    result = coverage(net, [Track("a", [run_along((0, 500), (500, 500))])])
    covered = [decode_polyline(p) for p in result["runs"]["covered"]]
    east1 = [c for c in covered if abs(c[:, 0].mean() - at(0, 500)[0]) < 5 * M_LAT]
    assert east1, "the covered half of East 1 should be drawn"
    x_max = max(((c[:, 1] - LON0) / M_LON).max() for c in east1)
    assert 480 < x_max < 540


def test_named_places_split_the_town_when_no_boundaries_exist():
    area, ways = town()
    west = Area(5, "West End", 99, shapely.points(at(100, 500)[1], at(100, 500)[0]))
    east = Area(6, "East End", 99, shapely.points(at(800, 500)[1], at(800, 500)[0]))
    net = build_network(area, ways, [west, east], True)
    result = coverage(net, [Track("a", [run_along((0, 250), (1000, 250))])])
    subs = {s["name"]: s for s in result["subareas"]}
    assert set(subs) == {"West End", "East End"}
    # Split at x = 450: three 450 m stretches of the east-west streets, plus
    # the whole of the north-south street at x = 250.
    assert subs["West End"]["length_m"] == pytest.approx(3 * 450 + 1000, abs=30)
    assert subs["East End"]["length_m"] == pytest.approx(3 * 550 + 2000, abs=30)
    assert result["subareas_approx"] is True


def test_an_empty_network_is_not_an_error():
    area, _ = town()
    result = coverage(build_network(area, [], [], False), [Track("a", [run_along((0, 0), (10, 10))])])
    assert result["totals"] == {"length_m": 0, "covered_m": 0, "streets": 0, "streets_done": 0}


def test_streets_are_cut_at_every_junction():
    from app.coverage import split_at_junctions

    area, ways = town()
    edges = split_at_junctions(ways)
    # Each 1 km street crosses the three streets of the other direction, so it
    # becomes four edges: 250 m, 250 m, 250 m, 250 m.
    assert len(edges) == 6 * 4
    net = build_network(area, ways, [], False)
    assert len(net.pieces) == 24
    assert all(abs(p.length - 250) < 1 for _, p in net.pieces)
    # The cut changes nothing about coverage.
    assert coverage(net, [])["totals"]["length_m"] == pytest.approx(6000, abs=10)
