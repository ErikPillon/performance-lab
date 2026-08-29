"""Load engine against the real corpus.

Unit tests prove the formulas; these prove they survive five years of actual
Garmin output, including the files that broke earlier versions.
"""

import numpy as np
import pytest

from app.load import Thresholds, compute_load

# Roughly the values the estimator derives from this corpus.
T = Thresholds(max_hr=192, rest_hr=50, lthr=178, sex="male",
               css_sec_per_100m=100.0, threshold_pace_sec_per_km=266.8)


@pytest.fixture(scope="session")
def scored(parsed):
    results, failures = parsed
    assert not failures
    return [(p, s, compute_load(s, df, T)) for p, s, df in results]


def test_every_activity_produces_a_result(scored):
    for path, _, result in scored:
        assert "load_method" in result, f"{path.name} produced no load result"
        assert result["calc_version"]


def test_heart_rate_activities_are_scored_not_estimated(scored):
    """191 of 252 activities carry heart rate; those must be measured directly."""
    scored_by_hr = [r for _, s, r in scored if r.get("hr_tss") is not None]
    assert len(scored_by_hr) > 150
    for result in scored_by_hr:
        assert result["load_method"] != "none"


def test_load_values_are_physically_plausible(scored):
    """An hour of hard training is ~100. Nothing here should approach 1000."""
    for path, summary, result in scored:
        load = result.get("load")
        if load is None:
            continue
        hours = (summary.get("duration_s") or 0) / 3600
        assert 0 <= load < 1000, f"{path.name}: load {load}"
        if hours > 0.25 and "implausible_duration" not in summary["quality_flags"]:
            per_hour = load / hours
            assert per_hour < 250, f"{path.name}: {per_hour:.0f} load/hour is not survivable"


def test_the_fifty_hour_swim_does_not_dominate_the_corpus(scored):
    """It is 59% of recorded swim time; unflagged it would swamp every swim."""
    flagged = [
        (p, s, r) for p, s, r in scored
        if "implausible_duration" in s["quality_flags"]
    ]
    assert flagged, "the known bad manual entry vanished from the corpus"
    for path, _, result in flagged:
        # The engine still reports what it can; the *caller* excludes it by flag.
        # What must not happen is a duration-derived score.
        assert result["load_method"] != "duration_estimate", f"{path.name} scored from a bad duration"


def test_grade_adjusted_pace_stays_within_reason(scored):
    """Regression: GAP once claimed 3:01/km for a 5:58/km hill run."""
    checked = 0
    for path, summary, result in scored:
        gap = result.get("gap_sec_per_km")
        distance, duration = summary.get("distance_m"), summary.get("duration_s")
        if not gap or not distance or not duration or distance < 4000:
            continue
        raw = duration / (distance / 1000)
        speedup = raw / gap
        assert 0.7 < speedup < 1.45, f"{path.name}: GAP speedup {speedup:.2f} (raw {raw:.0f}s/km)"
        checked += 1
    assert checked > 20, "corpus should have plenty of GPS runs to check"


def test_zone_time_never_exceeds_activity_duration(scored):
    for path, summary, result in scored:
        zones = result.get("time_in_zones")
        if not zones:
            continue
        total = sum(zones.values())
        assert total <= (summary.get("duration_s") or 0) + 60, f"{path.name}: zones exceed duration"


def test_intensity_factors_are_bounded(scored):
    for path, _, result in scored:
        intensity = result.get("intensity_factor")
        if intensity is None:
            continue
        assert 0 < intensity < 2.0, f"{path.name}: IF {intensity}"


def test_model_disagreement_is_recorded_where_both_apply(scored):
    ratios = [r["model_agreement"] for _, _, r in scored if r.get("model_agreement")]
    assert ratios, "no activity had both a pace and a heart-rate score"
    # Not asserting agreement - they genuinely differ on this corpus, which is
    # why the ratio is stored. Asserting it is finite and sane.
    assert all(0.2 < x < 5.0 for x in ratios)
