import numpy as np
import polars as pl
import pytest

from app.geo import (
    LocalProjection, clean_fixes, decode_polyline, encode_polyline, simplify, track_summary,
)


def test_polyline_matches_the_reference_encoding():
    # The worked example from Google's format documentation.
    coords = np.array([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]])
    assert encode_polyline(coords) == "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
    np.testing.assert_allclose(decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@"), coords)


def test_polyline_round_trips_to_a_metre():
    rng = np.random.default_rng(1)
    coords = np.column_stack([45 + rng.random(200) * 0.01, 7 + rng.random(200) * 0.01])
    back = decode_polyline(encode_polyline(coords))
    assert np.abs(back - coords).max() < 1e-5  # ~1.1 m


def test_projection_measures_metres():
    proj = LocalProjection(45.0, 7.0)
    # One kilometre north and east of the origin.
    x, y = proj.forward(np.array([45.0 + 1000 / 110_574]), np.array([7.0 + 1000 / (111_320 * np.cos(np.radians(45)))]))
    assert x[0] == pytest.approx(1000, abs=0.5)
    assert y[0] == pytest.approx(1000, abs=0.5)
    lat, lon = proj.inverse(x, y)
    assert lat[0] == pytest.approx(45.0 + 1000 / 110_574)


def _line(n: int, lat0=45.0, lon0=7.0, step_m=5.0):
    """A straight run north, one fix per second."""
    lat = lat0 + np.arange(n) * step_m / 110_574
    lon = np.full(n, lon0)
    return lat, lon, np.arange(n, dtype=float)


def test_a_gap_splits_the_track_instead_of_drawing_across_it():
    lat, lon, t = _line(100)
    lat[50:] += 2000 / 110_574  # two kilometres further on after fix 50
    t[50:] += 600
    parts = clean_fixes(lat, lon, t)
    assert [len(p) for p in parts] == [50, 50]


def test_a_single_spike_is_dropped_not_split_around():
    lat, lon, t = _line(100)
    lon[40] += 400 / 78_700  # one fix 400 m sideways for a second
    parts = clean_fixes(lat, lon, t)
    assert len(parts) == 1
    assert len(parts[0]) == 99


def test_null_island_and_missing_fixes_are_ignored():
    lat, lon, t = _line(20)
    lat[:3] = 0.0
    lon[:3] = 0.0
    lat[10] = np.nan
    parts = clean_fixes(lat, lon, t)
    assert sum(len(p) for p in parts) == 16


def test_simplify_keeps_the_shape_and_drops_collinear_points():
    lat, lon, _ = _line(500)
    # An L: 500 fixes north, then 500 east.
    lat2 = np.full(500, lat[-1])
    lon2 = lon[-1] + np.arange(1, 501) * 5 / 78_700
    part = np.column_stack([np.r_[lat, lat2], np.r_[lon, lon2]])
    out = simplify(part)
    assert len(out) == 3
    np.testing.assert_allclose(out[0], part[0], atol=1e-7)
    np.testing.assert_allclose(out[-1], part[-1], atol=1e-7)


def test_no_gps_means_no_track():
    assert track_summary(pl.DataFrame({"t_s": [0.0, 1.0], "heart_rate": [100, 101]})) is None


def test_a_real_activity_simplifies_to_a_fraction_of_its_fixes(corpus):
    from app.fit import parse_fit

    for path in corpus:
        _, df = parse_fit(path.read_bytes())
        if "lat" in df.columns and df["lat"].drop_nulls().len() > 500:
            break
    else:
        pytest.skip("no GPS activity in the corpus")

    summary = track_summary(df)
    fixes = df["lat"].drop_nulls().len()
    assert summary is not None
    assert summary["points"] < fixes / 2
    south, west, north, east = summary["bbox"]
    assert south < north and west < east
    # Every simplified point lies within the original bounding box.
    for encoded in summary["parts"]:
        pts = decode_polyline(encoded)
        assert pts[:, 0].min() >= df["lat"].min() - 1e-5
        assert pts[:, 0].max() <= df["lat"].max() + 1e-5
