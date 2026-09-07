import pytest

from app.predict import (
    MIN_ANCHOR_S,
    RIEGEL_MAX_RATIO,
    Reference,
    candidate_references,
    from_critical_speed,
    predict,
    predict_standard,
    riegel,
)


def curve_from_speed(speed_mps: float, durations=(60, 300, 600, 1200, 1800, 3600)) -> dict[int, float]:
    """A curve where speed decays gently with duration, as a real one does."""
    return {d: speed_mps * (600 / d) ** 0.06 for d in durations}


def test_short_efforts_are_refused_as_an_anchor():
    # Below five minutes the anaerobic reserve dominates and Riegel's exponent
    # stops describing the falloff.
    assert candidate_references({60: 6.5, 120: 5.9}) == []
    assert len(candidate_references({60: 6.5, 300: 5.4})) == 1
    assert MIN_ANCHOR_S == 300.0


def test_no_anchors_for_an_empty_or_zero_curve():
    assert candidate_references({}) == []
    assert candidate_references({1200: 0.0}) == []


def test_a_submaximal_long_run_does_not_anchor_the_prediction():
    """The bug that real data caught.

    The long end of a mean-maximal curve is not a maximal effort — it is
    whatever the athlete's best long *easy* run happened to be. Anchoring on the
    longest duration predicted a 5k at 4:58/km for an athlete whose critical
    speed was 4:10/km, because it extrapolated from a two-hour steady run.

    A submaximal anchor always yields a slower prediction than a maximal one at
    the same distance, so taking the fastest over all anchors picks the effort
    that was actually raced.
    """
    curve = {
        600: 4.6,    # a hard ten minutes
        1200: 4.45,  # a hard twenty
        3600: 4.2,   # a hard hour
        7200: 2.9,   # two hours of easy long run — much slower, not maximal
    }
    result = predict(5000.0, curve, None)
    assert result is not None
    # The two-hour anchor would have produced something far slower.
    from_easy_run = riegel(Reference(7200.0, 2.9 * 7200, 2.9), 5000.0)
    assert result["seconds"] < from_easy_run * 0.8
    assert result["reference"]["duration_s"] != 7200.0


def test_riegel_slows_down_over_distance():
    # Doubling the distance must take more than twice the time.
    ref = Reference(duration_s=1200.0, distance_m=4800.0, speed_mps=4.0)
    doubled = riegel(ref, 9600.0)
    assert doubled > 2400.0
    assert doubled == pytest.approx(2400.0 * 2 ** 0.06, rel=1e-9)


def test_riegel_returns_the_reference_itself_at_the_same_distance():
    ref = Reference(duration_s=1200.0, distance_m=4800.0, speed_mps=4.0)
    assert riegel(ref, 4800.0) == pytest.approx(1200.0)


def test_critical_speed_model_matches_its_own_algebra():
    # D = CS*t + D' rearranged. 5000 m at CS 4.0 with a 200 m reserve.
    assert from_critical_speed(5000.0, 4.0, 200.0) == pytest.approx((5000 - 200) / 4.0)


def test_critical_speed_refuses_a_sprint_inside_the_reserve():
    # The model has nothing to say about a distance shorter than D'.
    assert from_critical_speed(150.0, 4.0, 200.0) is None


def test_critical_speed_refuses_to_predict_a_marathon():
    # It assumes critical speed is sustainable indefinitely, which past about an
    # hour is badly optimistic. Better to say nothing than to say it confidently.
    assert from_critical_speed(42195.0, 4.0, 200.0) is None
    # A 10k at that speed is inside the horizon and is answered.
    assert from_critical_speed(10000.0, 4.0, 200.0) is not None


def test_predict_reports_both_models_and_a_spread():
    curve = curve_from_speed(4.0)
    critical = {"critical_speed_mps": 3.9, "d_prime_m": 180.0}
    result = predict(10000.0, curve, critical)
    assert result is not None
    assert set(result["estimates"]) == {"riegel", "critical_speed"}
    assert result["low_s"] <= result["seconds"] <= result["high_s"]
    # The spread is real disagreement between two models, so it is not zero here.
    assert result["high_s"] > result["low_s"]


def test_predict_works_without_a_critical_speed_fit():
    result = predict(10000.0, curve_from_speed(4.0), None)
    assert result is not None
    assert set(result["estimates"]) == {"riegel"}
    assert result["low_s"] == result["high_s"] == result["seconds"]


def test_predict_refuses_to_extrapolate_absurdly_far():
    # A curve topping out at ten minutes cannot speak to a marathon.
    curve = {600: 4.0}
    assert predict(42195.0, curve, None) is None
    # The same curve is fine for a distance close to what it measured.
    assert predict(3000.0, curve, None) is not None


def test_confidence_degrades_with_the_size_of_the_leap():
    curve = curve_from_speed(4.0)
    near = predict(10000.0, curve, None)
    far = predict(42195.0, curve, None)
    assert near is not None and far is not None
    assert near["extrapolation_ratio"] < far["extrapolation_ratio"]
    order = {"high": 0, "moderate": 1, "low": 2}
    assert order[far["confidence"]] >= order[near["confidence"]], (
        "a longer extrapolation cannot be more confident"
    )


def test_extrapolation_ratio_bounds_match_the_documented_limit():
    curve = {1200: 4.0}  # anchor distance 4800 m
    just_inside = predict(4800.0 * RIEGEL_MAX_RATIO, curve, None)
    just_outside = predict(4800.0 * (RIEGEL_MAX_RATIO + 0.1), curve, None)
    assert just_inside is not None
    assert just_outside is None


def test_a_faster_athlete_is_predicted_faster():
    slow = predict(10000.0, curve_from_speed(3.5), None)
    fast = predict(10000.0, curve_from_speed(4.5), None)
    assert slow is not None and fast is not None
    assert fast["seconds"] < slow["seconds"]


def test_standard_distances_come_back_ordered_and_monotonic():
    results = predict_standard(curve_from_speed(4.0), {"critical_speed_mps": 3.9, "d_prime_m": 180.0})
    assert [r["label"] for r in results] == [
        "1500 m", "5k", "10k", "half marathon", "marathon",
    ]
    times = [r["seconds"] for r in results]
    assert times == sorted(times), "a longer race cannot be predicted faster"


def test_standard_distances_skip_what_cannot_be_predicted():
    # A curve of one short effort supports the shortest distances only.
    results = predict_standard({600: 4.0}, None)
    labels = [r["label"] for r in results]
    assert "1500 m" in labels
    assert "marathon" not in labels


def test_no_curve_yields_no_predictions():
    assert predict_standard({}, None) == []
