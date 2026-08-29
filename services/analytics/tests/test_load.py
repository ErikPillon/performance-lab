import numpy as np
import polars as pl
import pytest

from app.load import (
    Thresholds,
    banister_trimp,
    compute_load,
    decoupling,
    hr_tss,
    swim_metrics,
    time_in_zones,
    trimp_at_threshold_per_hour,
)

T = Thresholds(max_hr=193, rest_hr=50, lthr=172, sex="male", css_sec_per_100m=100.0,
               threshold_pace_sec_per_km=270.0, ftp_watts=250)


def _steady(hr, minutes):
    return np.full(minutes * 60, float(hr))


def test_one_hour_at_threshold_scores_exactly_one_hundred():
    """The anchor of the whole scale: 100 = one hour at lactate threshold."""
    assert abs(hr_tss(banister_trimp(_steady(172, 60), T), T) - 100.0) < 0.5


def test_load_scales_with_duration_at_fixed_intensity():
    half = hr_tss(banister_trimp(_steady(172, 30), T), T)
    full = hr_tss(banister_trimp(_steady(172, 60), T), T)
    assert abs(full - 2 * half) < 0.5


def test_load_rises_faster_than_linearly_with_intensity():
    """Banister's exponential term: an hour hard is worth more than two easy."""
    easy = hr_tss(banister_trimp(_steady(120, 60), T), T)
    hard = hr_tss(banister_trimp(_steady(180, 60), T), T)
    assert hard > 3 * easy


def test_intervals_outscore_steady_work_at_identical_mean_heart_rate():
    """The reason load is integrated per sample rather than taken from avg_hr.

    The previous implementation used duration x (avg_hr/100), which cannot tell
    these two sessions apart at all.
    """
    steady = _steady(150, 60)
    intervals = np.concatenate(
        [np.full(300, 180.0) if i % 2 == 0 else np.full(300, 120.0) for i in range(12)]
    )
    assert abs(intervals.mean() - steady.mean()) < 1.0, "test setup: means must match"
    assert banister_trimp(intervals, T) > banister_trimp(steady, T) * 1.15


def test_trimp_needs_a_usable_heart_rate_reserve():
    assert banister_trimp(_steady(150, 30), Thresholds()) is None
    assert trimp_at_threshold_per_hour(Thresholds(max_hr=190)) is None
    # A nonsensically narrow reserve is rejected rather than producing infinities.
    assert banister_trimp(_steady(150, 30), Thresholds(max_hr=100, rest_hr=95, lthr=98)) is None


def test_time_in_zones_accounts_for_every_sample():
    hr = np.concatenate([_steady(110, 10), _steady(150, 10), _steady(180, 10)])
    zones = time_in_zones(hr, T)
    assert sum(zones.values()) == hr.size
    assert zones["z1_recovery"] == 600
    assert zones["z5_vo2max"] == 600


def test_decoupling_detects_cardiac_drift():
    """Same output, rising heart rate through the second half = positive drift."""
    effort = np.full(3600, 3.0)
    drifting = np.concatenate([np.full(1800, 140.0), np.full(1800, 154.0)])
    assert decoupling(effort, drifting) > 5.0
    assert abs(decoupling(effort, np.full(3600, 140.0))) < 0.01
    assert decoupling(np.full(600, 3.0), np.full(600, 140.0)) is None  # too short to judge


def test_swim_load_uses_a_cubic_intensity_term():
    faster = swim_metrics(2000, 2000 * 1.0, T)   # 100 s/100m == CSS
    assert abs(faster["intensity_factor"] - 1.0) < 0.01
    slower = swim_metrics(2000, 2000 * 1.25, T)
    assert slower["swim_tss"] < faster["swim_tss"]


def test_compute_load_survives_an_activity_with_no_streams():
    result = compute_load(
        {"sport": "running", "duration_s": 1800, "quality_flags": [], "sample_count": 0}, None, T
    )
    assert result["load"] is None
    assert result["load_method"] == "none"


def test_compute_load_without_thresholds_declines_rather_than_guessing():
    frame = pl.DataFrame({"t_s": [float(i) for i in range(600)],
                          "heart_rate": [150.0] * 600})
    result = compute_load(
        {"sport": "cycling", "duration_s": 600, "quality_flags": [], "sample_count": 600},
        frame,
        Thresholds(),
    )
    assert result["load_method"] == "none"


def test_treadmill_runs_fall_through_to_heart_rate():
    """Treadmill distance is user-calibrated but the stream is not, so pace off
    that stream is wrong by up to 10%. Better to use HR than to be confidently
    wrong."""
    frame = pl.DataFrame({
        "t_s": [float(i) for i in range(1800)],
        "heart_rate": [150.0] * 1800,
        "speed_mps": [3.0] * 1800,
    })
    summary = {
        "sport": "running", "sub_sport": "treadmill", "duration_s": 1800,
        "quality_flags": ["stream_distance_diverges"], "sample_count": 1800,
    }
    result = compute_load(summary, frame, T)
    assert result.get("pace_tss") is None
    assert result["load_method"] == "hr_tss"


def test_preference_switches_which_model_wins_without_losing_the_others():
    frame = pl.DataFrame({
        "t_s": [float(i) for i in range(1800)],
        "heart_rate": [150.0] * 1800,
        "speed_mps": [3.5] * 1800,
        "altitude_m": [100.0] * 1800,
    })
    summary = {"sport": "running", "sub_sport": "generic", "duration_s": 1800,
               "quality_flags": [], "sample_count": 1800}

    consistency = compute_load(summary, frame, T, "consistency")
    precision = compute_load(summary, frame, T, "precision")

    assert consistency["load_method"] == "hr_tss"
    assert precision["load_method"] == "pace_tss"
    # Both models are computed either way, so switching is a recompute.
    for result in (consistency, precision):
        assert result["hr_tss"] is not None and result["pace_tss"] is not None
    assert consistency["model_agreement"] == pytest.approx(
        consistency["pace_tss"] / consistency["hr_tss"], rel=1e-3
    )
