import pytest

from app.strava import PARSER_VERSION, parse_strava, strava_sport


def activity(**overrides):
    base = {
        "id": 123456,
        "type": "Run",
        "sport_type": "Run",
        "start_date": "2027-03-15T07:30:00Z",
        "utc_offset": 7200,
        "elapsed_time": 3720,
        "moving_time": 3600,
        "distance": 12000.0,
        "total_elevation_gain": 85.0,
        "average_heartrate": 148.0,
        "max_heartrate": 171.0,
        "average_cadence": 88.0,
        "calories": 780,
        "device_name": "Garmin Forerunner 965",
    }
    base.update(overrides)
    return base


def streams(n=5, **extra):
    base = {
        "time": {"data": list(range(n))},
        "distance": {"data": [i * 3.3 for i in range(n)]},
        "heartrate": {"data": [140 + i for i in range(n)]},
        "altitude": {"data": [10.0 + i for i in range(n)]},
        "velocity_smooth": {"data": [3.3] * n},
        "latlng": {"data": [[52.0 + i * 1e-4, 4.5 + i * 1e-4] for i in range(n)]},
    }
    base.update(extra)
    return base


def test_produces_the_shape_the_rest_of_the_pipeline_expects():
    summary, df = parse_strava(activity(), streams())
    # The same keys parse_fit emits — downstream consumes this pair and nothing
    # else, so a missing key here breaks load, curves and zones at once.
    for key in (
        "sport", "start_time", "tz_offset_min", "duration_s", "moving_s",
        "distance_m", "avg_hr", "max_hr", "sample_count", "channels",
        "parser_version", "quality_flags",
    ):
        assert key in summary, f"missing {key}"
    assert summary["parser_version"] == PARSER_VERSION
    assert summary["sport"] == "running"
    assert summary["sample_count"] == 5


def test_streams_map_onto_canonical_column_names():
    _, df = parse_strava(activity(), streams())
    # These names are what load.py and curves.py read; Strava's own spelling
    # must not leak past this module.
    assert {"t_s", "distance_m", "heart_rate", "altitude_m", "speed_mps", "lat", "lon"} <= set(df.columns)
    assert "velocity_smooth" not in df.columns
    assert "heartrate" not in df.columns


def test_latlng_pairs_are_split_and_gaps_survive():
    s = streams(3)
    s["latlng"]["data"][1] = None  # a GPS dropout
    _, df = parse_strava(activity(), s)
    assert df["lat"].to_list() == [pytest.approx(52.0), None, pytest.approx(52.0002)]


def test_a_timestamp_column_is_derived_from_elapsed_seconds():
    # Strava gives elapsed seconds; downstream resampling needs an instant.
    _, df = parse_strava(activity(), streams(3))
    assert "timestamp" in df.columns
    stamps = df["timestamp"].to_list()
    assert (stamps[1] - stamps[0]).total_seconds() == 1.0


def test_ragged_streams_are_cut_to_the_shortest():
    # A row must mean one instant. Letting channels run to different lengths
    # would silently pair sample 400 of one with sample 300 of another.
    s = streams(5)
    s["heartrate"]["data"] = s["heartrate"]["data"][:3]
    _, df = parse_strava(activity(), s)
    assert df.height == 3


def test_an_activity_with_no_streams_is_still_imported():
    # A manually entered activity has no samples but is real training.
    summary, df = parse_strava(activity(manual=True), None)
    assert df.height == 0
    assert summary["sample_count"] == 0
    assert "no_stream" in summary["quality_flags"]
    assert "manual_entry" in summary["quality_flags"]
    assert summary["distance_m"] == 12000.0


def test_estimated_power_is_flagged_not_silently_trusted():
    # Strava invents watts for rides with no meter, from speed, weight and
    # gradient. Treating that as measured puts fictional watts into the load
    # model.
    summary, _ = parse_strava(
        activity(type="Ride", sport_type="Ride", average_watts=210, device_watts=False),
        streams(),
    )
    assert "estimated_power" in summary["quality_flags"]

    measured, _ = parse_strava(
        activity(type="Ride", sport_type="Ride", average_watts=210, device_watts=True),
        streams(),
    )
    assert "estimated_power" not in measured["quality_flags"]


def test_the_utc_offset_is_converted_to_minutes():
    # Strava reports seconds; everything here stores minutes, and the daily
    # rollup buckets on it.
    summary, _ = parse_strava(activity(utc_offset=7200), streams())
    assert summary["tz_offset_min"] == 120
    summary, _ = parse_strava(activity(utc_offset=-18000), streams())
    assert summary["tz_offset_min"] == -300
    summary, _ = parse_strava(activity(utc_offset=None), streams())
    assert summary["tz_offset_min"] is None


def test_implausible_sensor_values_are_dropped_like_the_fit_parser_does():
    summary, _ = parse_strava(activity(average_heartrate=0, max_heartrate=900), streams())
    assert summary["avg_hr"] is None
    assert summary["max_hr"] is None


def test_sport_types_map_onto_the_canonical_enum():
    assert strava_sport("Run") == "running"
    assert strava_sport("TrailRun") == "running"
    assert strava_sport("VirtualRide") == "cycling"
    assert strava_sport("GravelRide") == "cycling"
    assert strava_sport("Swim") == "swimming"
    assert strava_sport("WeightTraining") == "strength"
    assert strava_sport("AlpineSki") == "skiing"
    # Anything unrecognised lands in `other` rather than being dropped.
    assert strava_sport("Kitesurf") == "other"
    assert strava_sport(None) == "other"


def test_a_naive_start_date_is_treated_as_utc():
    summary, _ = parse_strava(activity(start_date="2027-03-15T07:30:00"), streams())
    assert summary["start_time"].startswith("2027-03-15T07:30:00")
    assert "+00:00" in summary["start_time"]


def test_an_activity_without_a_start_date_is_refused():
    with pytest.raises(ValueError):
        parse_strava(activity(start_date=None), streams())


def test_a_strava_mirror_dedupes_against_the_fit_of_the_same_session():
    """The claim the whole mirror design rests on.

    Strava cannot return the original file, so the same session can arrive
    twice — once as an uploaded FIT and once from Strava. If the two did not
    collapse onto one activity, every synced session would be counted twice and
    the fitness model would be wrong by roughly a factor of two.
    """
    from app.fit import dedupe_key

    strava_summary, _ = parse_strava(
        activity(start_date="2027-03-15T07:30:12Z", elapsed_time=3720), streams()
    )
    # What the FIT parser would emit for the same session: same instant, same
    # duration, arrived by a different road.
    fit_summary = {
        "start_time": "2027-03-15T07:30:12+00:00",
        "duration_s": 3720.0,
        "sport": "running",
    }
    assert dedupe_key(strava_summary) == dedupe_key(fit_summary)


def test_sessions_a_minute_apart_do_not_collapse():
    # The guard on the guard: if the key were too coarse, two genuinely
    # different sessions would be merged and one would silently vanish.
    from app.fit import dedupe_key

    a, _ = parse_strava(activity(start_date="2027-03-15T07:30:00Z"), streams())
    b, _ = parse_strava(activity(start_date="2027-03-15T09:00:00Z"), streams())
    assert dedupe_key(a) != dedupe_key(b)
