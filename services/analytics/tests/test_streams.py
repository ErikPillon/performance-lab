import numpy as np
import polars as pl

from app.streams import MAX_INTERPOLATION_GAP_S, mean_max, normalised, resample_1hz, rolling_mean


def _frame(t, **channels):
    return pl.DataFrame({"t_s": [float(x) for x in t], **channels})


def test_resample_puts_irregular_samples_on_a_one_second_grid():
    """Garmin smart recording samples every ~7s; window metrics assume 1 Hz."""
    frame = _frame([0, 7, 14, 21], heart_rate=[100.0, 110.0, 120.0, 130.0])
    grid = resample_1hz(frame, ["heart_rate"])
    assert grid["heart_rate"].size == 22
    assert grid["heart_rate"][0] == 100.0
    assert abs(grid["heart_rate"][7] - 110.0) < 1e-9


def test_pauses_are_not_interpolated_across():
    """A stopped timer is absent data, not a straight line of steady effort."""
    gap = MAX_INTERPOLATION_GAP_S + 60
    frame = _frame([0, 10, 10 + gap], heart_rate=[140.0, 140.0, 140.0])
    grid = resample_1hz(frame, ["heart_rate"])
    assert np.isnan(grid["heart_rate"][10 + gap // 2]), "interpolated across a pause"
    assert not np.isnan(grid["heart_rate"][5])


def test_rolling_mean_refuses_windows_containing_gaps():
    series = np.concatenate([np.full(30, 100.0), np.full(10, np.nan), np.full(30, 100.0)])
    assert np.all(np.isnan(rolling_mean(series, 60)))
    assert not np.all(np.isnan(rolling_mean(np.full(120, 100.0), 60)))


def test_mean_max_finds_the_best_sustained_window():
    series = np.concatenate([np.full(60, 100.0), np.full(60, 200.0)])
    assert mean_max(series, 60) == 200.0
    assert mean_max(series, 120) == 150.0
    assert mean_max(series, 500) is None


def test_normalised_exceeds_the_mean_for_variable_effort():
    """The fourth-power weighting is what separates intervals from steady work."""
    variable = np.concatenate([np.full(60, 100.0), np.full(60, 200.0)])
    steady = np.full(120, 150.0)
    assert normalised(variable, 30) > float(variable.mean())
    assert abs(normalised(steady, 30) - 150.0) < 0.5
