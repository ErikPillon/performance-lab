import datetime as dt

from app.pmc import ATL_DAYS, CTL_DAYS, _decay, build_series, form_label


def _block(days, load, start=dt.date(2025, 1, 1)):
    return {(start + dt.timedelta(days=i)).isoformat(): load for i in range(days)}


def test_decay_constant_is_exponential_not_span_based():
    """Regression on the previous implementation.

    pandas `ewm(span=42)` gives alpha = 2/43 = 0.0465, roughly twice the decay
    of the impulse-response form TrainingPeaks and every PMC uses. The two
    produce visibly different fitness curves for identical training.
    """
    assert abs(_decay(CTL_DAYS) - 0.0235) < 0.001
    assert abs(_decay(ATL_DAYS) - 0.1331) < 0.001
    assert _decay(CTL_DAYS) < 2 / (CTL_DAYS + 1) / 1.5


def test_fatigue_responds_faster_than_fitness():
    series = build_series(_block(28, 100.0))
    assert series[27]["atl"] > series[27]["ctl"]


def test_sustained_training_builds_fitness_monotonically():
    series = build_series(_block(56, 100.0))
    ctl = [d["ctl"] for d in series[:56]]
    assert all(b >= a for a, b in zip(ctl, ctl[1:]))
    assert ctl[-1] > ctl[27] > ctl[6]


def test_rest_sheds_fatigue_faster_than_fitness_and_form_turns_positive():
    """The mechanism a taper relies on."""
    series = build_series(_block(56, 100.0), end=dt.date(2025, 1, 1) + dt.timedelta(days=75))
    peak = series[55]
    rested = series[70]
    assert peak["tsb"] < 0 and rested["tsb"] > 15
    assert rested["atl"] < peak["atl"] * 0.3
    assert rested["ctl"] > peak["ctl"] * 0.6, "fitness should decay far slower than fatigue"


def test_rest_days_are_present_in_the_series():
    """Days off are when fatigue decays; a series that skipped them misstates form."""
    sparse = {"2025-01-01": 100.0, "2025-01-15": 100.0}
    series = build_series(sparse)
    assert len(series) >= 15
    assert series[5]["load"] == 0.0


def test_form_is_computed_from_the_previous_day():
    """Today's session has not been absorbed yet; including it would make every
    hard day read as a form collapse."""
    series = build_series(_block(10, 200.0))
    assert series[0]["tsb"] == 0.0
    assert abs(series[5]["tsb"] - (series[4]["ctl"] - series[4]["atl"])) < 1e-9


def test_acwr_flags_a_sudden_spike_in_load():
    daily = _block(28, 50.0)
    spike_start = dt.date(2025, 1, 29)
    daily.update({(spike_start + dt.timedelta(days=i)).isoformat(): 300.0 for i in range(7)})
    series = build_series(daily)
    assert series[34]["acwr"] > 1.5, "a six-fold week should trip the risk ratio"


def test_monotony_is_high_when_every_day_is_identical():
    """Foster's monotony: undifferentiated training scores high regardless of volume."""
    flat = build_series(_block(28, 100.0))[27]["monotony"]
    varied = _block(28, 0.0)
    for i, date in enumerate(sorted(varied)):
        varied[date] = 200.0 if i % 2 == 0 else 0.0
    assert flat > build_series(varied)[27]["monotony"]


def test_form_labels_span_the_range():
    assert form_label(40) == "transition"
    assert form_label(10) == "fresh"
    assert form_label(0) == "neutral"
    assert form_label(-20) == "productive"
    assert form_label(-50) == "overreaching"


def test_empty_input_is_an_empty_series_not_a_crash():
    assert build_series({}) == []
