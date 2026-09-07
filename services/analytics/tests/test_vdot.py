import pytest

from app.vdot import (
    MAX_DURATION_S,
    MIN_DURATION_S,
    equivalent_time,
    fraction_of_max,
    from_curve,
    oxygen_cost,
    vdot,
)


def test_matches_daniels_published_values():
    """Spot checks against the VDOT tables in *Daniels' Running Formula*.

    These are the anchor for everything else here: if the two equations were
    transcribed wrongly, every number downstream is wrong in the same direction
    and nothing else in the suite would notice.
    """
    # A 20:00 5k is VDOT ~50 in the tables.
    assert vdot(5000.0, 20 * 60) == pytest.approx(49.8, abs=0.3)
    # A 25:00 5k is ~38.
    assert vdot(5000.0, 25 * 60) == pytest.approx(38.3, abs=0.3)
    # A 3:00:00 marathon is ~54. This is why the window runs to four hours
    # rather than two — refusing the one race distance most people care about
    # would have been a strange place to stop.
    assert vdot(42195.0, 3 * 3600) == pytest.approx(53.5, abs=0.6)


def test_oxygen_cost_rises_with_speed():
    assert oxygen_cost(300) > oxygen_cost(200) > oxygen_cost(100)


def test_fraction_of_max_falls_with_duration():
    # You can hold a larger share of maximum for five minutes than for two hours.
    assert fraction_of_max(300) > fraction_of_max(1800) > fraction_of_max(7200)


def test_fraction_of_max_exceeds_one_for_short_efforts_by_design():
    # Not a transcription error. VDOT is a pseudo-VO2max that absorbs the
    # anaerobic contribution to short efforts, so the divisor is allowed to
    # represent more than aerobic capacity alone.
    assert fraction_of_max(180) > 1.0
    assert fraction_of_max(1200) < 1.0


def test_efforts_outside_the_modelled_window_are_refused():
    # Under three minutes the anaerobic contribution dominates; past four hours
    # fuelling and damage rather than oxygen uptake set the pace.
    assert vdot(1000.0, MIN_DURATION_S - 1) is None
    assert vdot(60000.0, MAX_DURATION_S + 1) is None
    assert vdot(5000.0, MIN_DURATION_S) is not None


def test_a_faster_run_over_the_same_distance_scores_higher():
    assert vdot(10000.0, 40 * 60) > vdot(10000.0, 50 * 60)


def test_from_curve_takes_the_best_effort_not_the_average():
    # A curve holds one genuinely maximal effort and many submaximal ones. Only
    # the best of them says anything about capacity.
    curve = {
        600: 4.6,    # hard ten minutes
        1200: 4.45,  # hard twenty
        3600: 4.2,   # hard hour
        7200: 2.9,   # two hours of easy running — must not drag the number down
    }
    result = from_curve(curve)
    assert result is not None
    best_individually = max(
        v for d, s in curve.items() if (v := vdot(s * d, float(d))) is not None
    )
    assert result["vdot"] == pytest.approx(best_individually, abs=0.05)
    assert result["from_duration_s"] != 7200.0


def test_from_curve_reports_which_effort_it_rests_on():
    # A VDOT anchored on three minutes deserves more scepticism than one
    # anchored on twenty, so the caller has to be able to tell.
    result = from_curve({600: 4.6, 1200: 4.45})
    assert result is not None
    assert result["from_duration_s"] in (600.0, 1200.0)


def test_from_curve_ignores_unusable_entries():
    assert from_curve({}) is None
    assert from_curve({600: 0.0}) is None
    # Every effort out of the window means no answer rather than a bad one.
    assert from_curve({60: 6.5}) is None


def test_equivalent_time_inverts_vdot():
    # Round trip: a VDOT turned into a 5k time and back must return itself.
    for target in (38.0, 45.0, 52.0, 60.0):
        seconds = equivalent_time(target, 5000.0)
        assert vdot(5000.0, seconds) == pytest.approx(target, abs=0.05)


def test_a_higher_vdot_predicts_a_faster_5k():
    assert equivalent_time(55.0, 5000.0) < equivalent_time(45.0, 5000.0)


def test_equivalent_5k_is_consistent_with_the_reported_vdot():
    result = from_curve({1200: 4.45, 3600: 4.2})
    assert result is not None
    round_tripped = vdot(5000.0, result["equivalent_5k_s"])
    assert round_tripped == pytest.approx(result["vdot"], abs=0.1)
