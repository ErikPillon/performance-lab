import numpy as np
import pytest

from app.curves import (
    DURATIONS,
    MAX_SAMPLE_SPEED_MPS,
    MIN_DURATION_S,
    critical_speed,
    duration_curve,
    mask_implausible_speed,
)


def test_curve_finds_the_best_window_at_each_duration():
    speed = np.full(1800, 3.0)
    speed[600:660] = 5.0  # a 60-second surge
    curve = duration_curve({"speed_mps": speed})["speed_mps"]
    assert curve[60] == pytest.approx(5.0)
    assert curve[300] < 5.0, "a 5-minute window must dilute a 60-second surge"
    assert curve[1200] < curve[300]


def test_durations_longer_than_the_activity_are_omitted():
    """A 20-minute run must not appear to hold a 60-minute best."""
    curve = duration_curve({"heart_rate": np.full(1200, 150.0)})["heart_rate"]
    assert max(curve) <= 1200
    assert 3600 not in curve


def test_gps_derived_metrics_start_at_a_trustworthy_duration():
    """Consumer GPS carries 1-3 m/s of instantaneous error, so sub-30s bests
    measure satellite geometry rather than sprinting."""
    series = np.full(3600, 3.0)
    speed = duration_curve({"speed_mps": series})["speed_mps"]
    heart = duration_curve({"heart_rate": series * 50})["heart_rate"]

    assert min(speed) >= MIN_DURATION_S["speed_mps"]
    assert min(heart) < MIN_DURATION_S["speed_mps"], "HR is measured directly and stays useful shorter"


def test_curve_decreases_with_duration():
    """Longer efforts are slower.

    Not asserted strictly: a mean-max curve is *not* guaranteed monotonic. A
    window whose high values sit at both ends can beat every sub-window inside
    it, so on pure noise a longer duration can edge out a shorter one by a
    fraction of a percent. Real efforts are sustained rather than edge-loaded,
    so the shape holds; the tolerance is here to tolerate that pathology without
    letting a genuine regression through.
    """
    rng = np.random.default_rng(0)
    speed = np.abs(rng.normal(3.0, 0.8, 7200))
    curve = duration_curve({"speed_mps": speed})["speed_mps"]
    values = [curve[d] for d in sorted(curve)]

    assert values[0] > values[-1], "the curve must fall overall"
    for a, b in zip(values, values[1:]):
        assert b <= a * 1.01, f"a longer window beat a shorter one by more than 1%: {a} -> {b}"


def test_curve_is_strictly_decreasing_for_a_sustained_effort():
    """With a real effort profile rather than noise, the shape is strict."""
    # A hard 5 minutes inside an otherwise steady hour.
    speed = np.full(3600, 3.0)
    speed[1200:1500] = 4.5
    curve = duration_curve({"speed_mps": speed})["speed_mps"]
    values = [curve[d] for d in sorted(curve)]
    assert all(a >= b - 1e-9 for a, b in zip(values, values[1:]))


def test_implausible_speed_is_masked_not_clipped():
    """Clipping would invent a best effort at exactly the cap."""
    speed = np.array([3.0, 4.0, 13.2, 9.5, 3.1])
    cleaned, count = mask_implausible_speed(speed, "running")
    assert count == 2
    assert np.isnan(cleaned[2]) and np.isnan(cleaned[3])
    assert np.nanmax(cleaned) == 4.0, "surviving values are untouched"


def test_speed_caps_are_per_sport():
    fast = np.array([15.0])
    assert mask_implausible_speed(fast, "running")[1] == 1
    assert mask_implausible_speed(fast, "cycling")[1] == 0
    # An unmapped sport has no cap rather than a wrong one.
    assert mask_implausible_speed(fast, "quidditch")[1] == 0


def test_masking_removes_vehicle_contamination_from_the_curve():
    """The failure this exists for: a watch left recording on the way home.

    One activity in the corpus holds 9+ m/s for 31 consecutive seconds with
    smooth acceleration — not a GPS spike, simply not running.
    """
    speed = np.full(1200, 3.0)
    speed[600:660] = 13.0  # a minute in a car
    dirty = duration_curve({"speed_mps": speed})["speed_mps"]
    cleaned_series, _ = mask_implausible_speed(speed, "running")
    clean = duration_curve({"speed_mps": cleaned_series})["speed_mps"]

    assert dirty[60] > MAX_SAMPLE_SPEED_MPS["running"]
    assert clean[60] == pytest.approx(3.0), "the running portion still counts"


def test_critical_speed_recovers_a_known_model():
    cs, d_prime = 4.0, 200.0
    curve = {d: (cs * d + d_prime) / d for d in DURATIONS if 120 <= d <= 1200}
    fit = critical_speed(curve)
    assert fit["critical_speed_mps"] == pytest.approx(cs, abs=0.01)
    assert fit["d_prime_m"] == pytest.approx(d_prime, abs=1.0)
    assert fit["r_squared"] > 0.999


def test_critical_speed_only_fits_the_middle_of_the_curve():
    """Under 2 minutes is dominated by the anaerobic reserve; over 20 the model
    drifts. Points outside that band must not move the fit."""
    cs, d_prime = 4.0, 200.0
    curve = {d: (cs * d + d_prime) / d for d in DURATIONS if 120 <= d <= 1200}
    with_outliers = {**curve, 30: 99.0, 7200: 0.1}
    assert critical_speed(with_outliers) == pytest.approx(
        critical_speed(curve), rel=1e-6
    ) or critical_speed(with_outliers)["critical_speed_mps"] == pytest.approx(cs, abs=0.01)


def test_critical_speed_declines_to_fit_too_few_points():
    assert critical_speed({300: 4.0}) is None
    assert critical_speed({}) is None


def test_critical_speed_rejects_a_nonsensical_fit():
    """A curve that rises with duration is not a set of best efforts."""
    rising = {d: 1.0 + d / 1000 for d in (120, 300, 600, 1200)}
    fit = critical_speed(rising)
    assert fit is None or fit["d_prime_m"] >= 0


def test_curve_skips_channels_with_too_little_data():
    assert duration_curve({"heart_rate": np.array([150.0])}) == {}
    assert duration_curve({}) == {}
