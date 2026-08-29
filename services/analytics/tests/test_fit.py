import datetime as dt

from app.fit import dedupe_key, quality_flags


def test_whole_corpus_parses(parsed):
    """Every file must yield a summary. A parser that drops inputs is data loss."""
    results, failures = parsed
    assert not failures, "files failed to parse:\n" + "\n".join(failures[:20])
    assert len(results) > 0


def test_no_activity_is_dropped_for_its_sport(parsed):
    """Regression: the previous factory returned None outside run/bike/swim,
    silently discarding rowing, walking, strength and unmapped numeric codes."""
    results, _ = parsed
    sports = {s["sport"] for _, s, _ in results}
    assert None not in sports
    assert sports - {"running", "cycling", "swimming"}, "minority sports were filtered out"
    for _, s, _ in results:
        assert s["sport"], "activity parsed without a sport"


def test_unmapped_sport_keeps_its_raw_value(parsed):
    results, _ = parsed
    for _, s, _ in results:
        if s["sport"] == "other" and s["raw_sport"] is not None:
            assert s["raw_sport"], "raw sport value was lost on fallback"


def test_zero_record_files_are_summaries_not_errors(parsed):
    results, _ = parsed
    empties = [(p, s) for p, s, df in results if df.height == 0]
    assert empties, "corpus should contain record-less files"
    for _, s in empties:
        assert s["sample_count"] == 0
        assert s["channels"] == []
        assert "no_stream" in s["quality_flags"]


def test_timestamps_are_utc_aware_and_ordered(parsed):
    results, _ = parsed
    for path, s, df in results:
        start = dt.datetime.fromisoformat(s["start_time"])
        assert start.tzinfo is not None, f"{path.name} start_time is naive"
        assert start.utcoffset() == dt.timedelta(0), "start_time must be UTC"
        if df.height > 1 and "t_s" in df.columns:
            assert df["t_s"].drop_nulls().is_sorted(), f"{path.name} samples out of order"



def test_gps_is_degrees_not_semicircles(parsed):
    """Semicircles are ~1e9; degrees are bounded. Catches a missed conversion."""
    results, _ = parsed
    checked = 0
    for path, _, df in results:
        if "lat" not in df.columns:
            continue
        lat, lon = df["lat"].drop_nulls(), df["lon"].drop_nulls()
        if lat.is_empty():
            continue
        assert -90 <= lat.min() <= lat.max() <= 90, f"{path.name} latitude out of range"
        assert -180 <= lon.min() <= lon.max() <= 180, f"{path.name} longitude out of range"
        checked += 1
    assert checked > 0, "corpus has no GPS activities to verify"


def test_stream_distance_agrees_with_session_total_or_is_flagged(parsed):
    """A units or accumulation error would show up as a divergence here.

    Treadmill runs legitimately diverge: the session total is user-calibrated
    after the fact while the stream keeps the watch's estimate. Those must be
    flagged, not silently accepted, because pace read straight off the stream
    is then wrong by up to 10%.
    """
    results, _ = parsed
    for path, s, df in results:
        total = s.get("distance_m")
        if not total or "distance_m" not in df.columns:
            continue
        peak = df["distance_m"].drop_nulls().max()
        if peak is None:
            continue
        if abs(peak - total) / total > 0.02:
            assert "stream_distance_diverges" in s["quality_flags"], (
                f"{path.name}: stream {peak} vs session {total}, unflagged"
            )


def test_treadmill_divergence_is_confined_to_indoor_runs(parsed):
    """If an outdoor GPS run diverged, that would be a real accumulation bug."""
    results, _ = parsed
    for path, s, df in results:
        if "stream_distance_diverges" not in s["quality_flags"]:
            continue
        assert "lat" not in df.columns, (
            f"{path.name}: GPS activity has diverging distance - not a calibration artefact"
        )


def test_out_of_order_samples_are_sorted_and_flagged(parsed):
    """A device restart mid-activity writes records whose timestamps go backwards."""
    results, _ = parsed
    flagged = [(p, s) for p, s, _ in results if "nonmonotonic_time" in s["quality_flags"]]
    for path, _, df in results:
        if df.height > 1 and "t_s" in df.columns:
            assert df["t_s"].drop_nulls().is_sorted(), f"{path.name} left unsorted"
    assert flagged, "corpus contains a restarted recording that should be flagged"


def test_summary_values_are_physically_plausible_or_flagged(parsed):
    results, _ = parsed
    for path, s, _ in results:
        if s["avg_hr"] is not None:
            assert 20 <= s["avg_hr"] <= 260, f"{path.name} avg_hr={s['avg_hr']}"
        if s["max_hr"] is not None and s["avg_hr"] is not None:
            assert s["max_hr"] >= s["avg_hr"], f"{path.name} max_hr below avg_hr"
        if s["tz_offset_min"] is not None:
            assert -14 * 60 <= s["tz_offset_min"] <= 14 * 60
        # Impossible values are permitted through, but must be flagged so load
        # computation can exclude them.
        if (s["duration_s"] or 0) > 24 * 3600:
            assert "implausible_duration" in s["quality_flags"], f"{path.name} unflagged"


def test_corpus_contains_the_known_bad_manual_entry(parsed):
    """A hand-entered 750 m swim recorded as 50 hours must survive, and be flagged."""
    results, _ = parsed
    flagged = [s for _, s, _ in results if "implausible_duration" in s["quality_flags"]]
    assert flagged, "the known 50-hour swim was dropped instead of flagged"
    for s in flagged:
        assert s["distance_m"], "flagged activity should retain its usable fields"


def test_quality_flags_catch_impossible_speed():
    fast = {"sport": "running", "duration_s": 600.0, "distance_m": 20_000.0, "sample_count": 1}
    assert "implausible_speed" in quality_flags(fast)
    sane = {"sport": "running", "duration_s": 600.0, "distance_m": 2_000.0, "sample_count": 1}
    assert quality_flags(sane) == []


def test_unknown_channels_are_preserved(parsed):
    """190 of 252 files carry undecoded vendor fields. Keeping them is deliberate."""
    results, _ = parsed
    seen = {c for _, s, _ in results for c in s["channels"] if c.startswith("unknown_")}
    assert seen, "undecoded vendor channels were dropped"


def test_dedupe_key_is_stable_and_distinguishing(parsed):
    results, _ = parsed
    keys: dict[str, list[str]] = {}
    for path, s, _ in results:
        key = dedupe_key(s)
        assert key == dedupe_key(s), "dedupe_key is not deterministic"
        keys.setdefault(key, []).append(path.name)
    collisions = {k: v for k, v in keys.items() if len(v) > 1}
    assert not collisions, f"distinct activities collided: {collisions}"
