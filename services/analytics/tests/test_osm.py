import gzip
import json

import pytest
import shapely

from app import osm


@pytest.fixture
def store(monkeypatch):
    """An in-memory object store and a scripted Overpass."""
    objects: dict[str, bytes] = {}
    monkeypatch.setattr(osm.storage, "get_bytes_if_fresh", lambda key, age: objects.get(key))
    monkeypatch.setattr(osm.storage, "put_bytes", lambda key, data, ct: objects.__setitem__(key, data))
    monkeypatch.setattr(osm.time, "sleep", lambda s: None)
    return objects


def script(monkeypatch, *responses):
    calls = []

    def fake_post(ql, timeout_s=120):
        calls.append(ql)
        return responses[min(len(calls), len(responses)) - 1]

    monkeypatch.setattr(osm, "_post", fake_post)
    return calls


OK = json.dumps({"elements": [{"type": "node", "id": 1}]}).encode()


def test_an_answer_is_cached_and_reused(store, monkeypatch):
    calls = script(monkeypatch, OK)
    assert osm.overpass("q")["elements"][0]["id"] == 1
    assert osm.overpass("q")["elements"][0]["id"] == 1
    assert len(calls) == 1
    (blob,) = store.values()
    assert json.loads(gzip.decompress(blob))["elements"]


def test_a_busy_server_is_retried_and_its_error_page_never_cached(store, monkeypatch):
    busy = b'<?xml version="1.0"?><html><p>Error: runtime error: ... too busy</p></html>'
    calls = script(monkeypatch, busy, OK)
    assert osm.overpass("q")["elements"]
    assert len(calls) == 2
    assert len(store) == 1


def test_partial_results_with_an_error_remark_are_not_cached(store, monkeypatch):
    partial = json.dumps({"elements": [], "remark": "runtime error: Query timed out"}).encode()
    calls = script(monkeypatch, partial, OK)
    assert osm.overpass("q")["elements"]
    assert len(calls) == 2


def test_giving_up_is_an_explicit_error(store, monkeypatch):
    script(monkeypatch, b"<html>busy</html>")
    with pytest.raises(osm.OverpassUnavailable):
        osm.overpass("q")
    assert store == {}


def _way(coords, role="outer"):
    return {"type": "way", "role": role, "geometry": [{"lat": la, "lon": lo} for la, lo in coords]}


def test_a_boundary_is_stitched_from_ways_in_any_order_and_direction():
    # A 1x1 square split into three ways, one reversed, listed out of order.
    rel = {"members": [
        _way([(1, 1), (1, 0)]),
        _way([(0, 0), (0, 1), (1, 1)]),
        _way([(0, 0), (1, 0)][::-1]),
    ]}
    poly = osm.relation_polygon(rel)
    assert poly is not None
    assert poly.area == pytest.approx(1.0)


def test_an_inner_ring_is_cut_out():
    rel = {"members": [
        _way([(0, 0), (0, 4), (4, 4), (4, 0), (0, 0)]),
        _way([(1, 1), (1, 2), (2, 2), (2, 1), (1, 1)], role="inner"),
    ]}
    assert osm.relation_polygon(rel).area == pytest.approx(15.0)


def test_a_relation_without_usable_members_has_no_polygon():
    assert osm.relation_polygon({"members": [{"type": "node", "role": "admin_centre"}]}) is None


@pytest.mark.parametrize("tags,keep", [
    ({"highway": "residential"}, True),
    ({"highway": "footway", "footway": "sidewalk"}, False),
    ({"highway": "footway", "footway": "crossing"}, False),
    ({"highway": "pedestrian", "area": "yes"}, False),
    ({"highway": "service"}, False),
    ({"highway": "motorway"}, False),
    ({"highway": "track", "access": "private"}, False),
    ({"highway": "track", "access": "private", "foot": "yes"}, True),
])
def test_only_streets_you_could_run_are_kept(tags, keep):
    assert osm._keep(tags) is keep


def test_tiles_cover_the_bbox_on_a_fixed_grid():
    tiles = osm.tiles_for((45.01, 7.01, 45.09, 7.04))
    assert tiles == [(pytest.approx(45.0), pytest.approx(7.0)), (pytest.approx(45.05), pytest.approx(7.0))]


def test_subareas_fall_back_to_named_places(store, monkeypatch):
    area = osm.Area(1, "Town", 8, shapely.box(7.0, 45.0, 7.1, 45.1))
    responses = iter([
        json.dumps({"elements": []}).encode(),  # no admin level 9/10
        json.dumps({"elements": [
            {"type": "node", "id": 5, "lat": 45.05, "lon": 7.02, "tags": {"place": "suburb", "name": "West"}},
            {"type": "node", "id": 6, "lat": 45.05, "lon": 7.08, "tags": {"place": "quarter", "name": "East"}},
            {"type": "node", "id": 7, "lat": 46.0, "lon": 8.0, "tags": {"place": "suburb", "name": "Elsewhere"}},
            {"type": "node", "id": 8, "lat": 45.05, "lon": 7.05, "tags": {"place": "suburb"}},
        ]}).encode(),
    ])
    monkeypatch.setattr(osm, "_post", lambda ql, timeout_s=120: next(responses))
    subs, approx = osm.subareas(area)
    assert approx is True
    assert [s.name for s in subs] == ["West", "East"]


def test_discovery_skips_a_cell_overpass_will_not_serve(store, monkeypatch):
    import numpy as np

    town = {"elements": [{
        "type": "relation", "id": 42, "tags": {"name": "Town", "admin_level": "8"},
        "members": [_way([(45.01, 7.01), (45.01, 7.05), (45.05, 7.05), (45.05, 7.01), (45.01, 7.01)])],
    }]}

    def fake_post(ql, timeout_s=120):
        # The cell holding 45.0/7.0 answers; the one holding 46.0/8.0 never does.
        return json.dumps(town).encode() if "45.0000,7.0000" in ql else b"<html>busy</html>"

    monkeypatch.setattr(osm, "_post", fake_post)
    areas = osm.discover_areas(np.array([45.02, 46.02]), np.array([7.02, 8.02]))
    assert [a.name for a in areas] == ["Town"]
