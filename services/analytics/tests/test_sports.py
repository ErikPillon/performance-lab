from app.sports import canonical_sport


def test_known_names_map_to_canonical():
    assert canonical_sport("running") == "running"
    assert canonical_sport("Cycling") == "cycling"
    assert canonical_sport("lap_swimming") == "other"  # sub_sport is not a sport
    assert canonical_sport("rowing") == "rowing"
    assert canonical_sport("training") == "strength"


def test_numeric_codes_resolve():
    assert canonical_sport(1) == "running"
    assert canonical_sport(15) == "rowing"
    assert canonical_sport("11") == "walking"


def test_unknown_never_raises_and_never_returns_none():
    # The regression this guards: the previous factory returned None for
    # anything outside run/bike/swim, silently dropping five real activities.
    for value in (None, 84, "84", "quidditch", 9999, object()):
        assert canonical_sport(value) == "other"
