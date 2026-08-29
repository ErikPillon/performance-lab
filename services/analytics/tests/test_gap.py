import numpy as np

from app.gap import adjusted_speed, grade_factor


def _speedup(speed, altitude):
    return float(adjusted_speed(speed, altitude).mean() / speed.mean())


def test_grade_factor_matches_published_costs():
    """Minetti et al. (2002): running 5% uphill costs about 30% more energy."""
    assert grade_factor(np.array([0.0]))[0] == 1.0
    assert 1.28 < grade_factor(np.array([0.05]))[0] < 1.32
    assert 0.74 < grade_factor(np.array([-0.05]))[0] < 0.79
    assert grade_factor(np.array([0.10]))[0] > grade_factor(np.array([0.05]))[0]


def test_steady_gradients_adjust_by_the_expected_factor():
    n = 600
    speed = np.full(n, 3.0)
    assert abs(_speedup(speed, np.cumsum(np.full(n, 3.0 * 0.05))) - 1.30) < 0.05
    assert abs(_speedup(speed, np.cumsum(np.full(n, -3.0 * 0.05))) - 0.77) < 0.05
    assert abs(_speedup(speed, np.zeros(n)) - 1.0) < 0.01


def test_barometric_noise_on_flat_ground_does_not_inflate_pace():
    """Regression.

    Gradient was computed as vertical rate over instantaneous speed, so noise of
    a metre or two per sample produced huge slopes. Combined with fourth-power
    normalisation downstream it claimed 3:01/km for a 5:58/km hill run.
    """
    rng = np.random.default_rng(0)
    speed = np.full(600, 3.0)
    assert abs(_speedup(speed, rng.normal(0, 1.5, 600)) - 1.0) < 0.02


def test_slowing_to_a_crawl_on_a_climb_stays_bounded():
    """The failure mode the old divide-by-speed form hit hardest."""
    n = 600
    speed = np.concatenate([np.full(300, 3.0), np.full(300, 0.6)])
    altitude = np.cumsum(np.where(np.arange(n) < 300, 0.15, 0.03))
    factors = adjusted_speed(speed, altitude) / np.maximum(speed, 1e-9)
    assert factors.max() <= 2.0 + 1e-9, "grade adjustment escaped its cap"
