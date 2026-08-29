import numpy as np
import polars as pl

from app.thresholds import DEFAULT_REST_HR, MIN_ACTIVITIES, estimate


def _activity(sport="running", minutes=60, hr=None, distance_m=None, **extra):
    frame = None
    if hr is not None:
        n = minutes * 60
        frame = pl.DataFrame({"t_s": [float(i) for i in range(n)], "heart_rate": [float(hr)] * n})
    return {
        "sport": sport,
        "duration_s": minutes * 60,
        "distance_m": distance_m,
        "quality_flags": [],
        "frame": frame,
        **extra,
    }


def test_max_and_threshold_hr_come_from_sustained_efforts():
    acts = [_activity(hr=hr, minutes=70) for hr in (150, 160, 170)]
    result = estimate(acts)
    assert result["max_hr"] == 170
    assert result["lthr"] == 170
    assert result["rest_hr"] == DEFAULT_REST_HR
    assert "measure and correct" in result["sources"]["rest_hr"]


def test_a_single_power_file_does_not_become_an_ftp():
    """Regression.

    One activity in this corpus carries a power channel and it produced a
    109 W FTP - implausible, and it would have rescaled every cycling load
    number computed against it.
    """
    n = 1800
    powered = _activity(sport="cycling", minutes=30)
    powered["frame"] = pl.DataFrame(
        {"t_s": [float(i) for i in range(n)], "power_w": [115.0] * n}
    )
    result = estimate([powered])
    assert "ftp_watts" not in result
    assert any("FTP needs at least" in w for w in result["warnings"])
    assert MIN_ACTIVITIES["power"] > 1


def test_implausible_threshold_fraction_is_flagged():
    """LTHR at 93% of max means an input is wrong, not that the athlete is unusual."""
    acts = [_activity(hr=185, minutes=70) for _ in range(3)]
    for a in acts:
        a["frame"] = pl.concat([
            a["frame"],
            pl.DataFrame({"t_s": [float(x) for x in range(4200, 4210)],
                          "heart_rate": [196.0] * 10}),
        ])
    result = estimate(acts)
    assert any("outside the usual" in w for w in result["warnings"])


def test_swim_css_needs_several_sessions():
    few = [_activity(sport="swimming", minutes=30, distance_m=1500) for _ in range(2)]
    assert "css_sec_per_100m" not in estimate(few)
    many = [_activity(sport="swimming", minutes=30, distance_m=1500) for _ in range(6)]
    assert estimate(many)["css_sec_per_100m"] > 0


def test_implausible_swims_are_excluded_from_css():
    """The 50-hour swim must not become the athlete's critical swim speed."""
    good = [_activity(sport="swimming", minutes=30, distance_m=1500) for _ in range(6)]
    bad = _activity(sport="swimming", minutes=3000, distance_m=750)
    bad["quality_flags"] = ["implausible_duration"]
    assert estimate(good + [bad])["css_sec_per_100m"] == estimate(good)["css_sec_per_100m"]


def test_no_data_produces_warnings_rather_than_invented_numbers():
    result = estimate([])
    assert "max_hr" not in result
    assert "lthr" not in result
    assert result["warnings"]
