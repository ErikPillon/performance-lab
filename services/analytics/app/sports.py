"""Mapping from FIT sport values to our canonical sport enum.

The FIT profile defines ~90 sport codes and vendors add more, so this is a
best-effort map with a deliberate `other` fallback. The original value is always
preserved on the activity row: an activity is never dropped for its sport.
(The previous implementation returned None for anything outside run/bike/swim,
which silently discarded rowing, walking and unmapped numeric codes.)
"""

CANONICAL = {
    "running": "running",
    "cycling": "cycling",
    "swimming": "swimming",
    "rowing": "rowing",
    "walking": "walking",
    "hiking": "hiking",
    "transition": "transition",
    "multisport": "multisport",
    "training": "strength",
    "fitness_equipment": "strength",
    "cross_country_skiing": "skiing",
    "alpine_skiing": "skiing",
    "snowboarding": "skiing",
    "backcountry_skiing": "skiing",
}

# Numeric fallbacks for codes fitparse cannot resolve to a name.
BY_CODE = {
    1: "running", 2: "cycling", 3: "transition", 4: "strength", 5: "swimming",
    10: "strength", 11: "walking", 12: "skiing", 13: "skiing", 14: "skiing",
    15: "rowing", 17: "hiking", 18: "multisport",
}


def canonical_sport(raw) -> str:
    """Map a FIT sport value (name or numeric code) onto the canonical enum."""
    if raw is None:
        return "other"
    if isinstance(raw, str):
        key = raw.strip().lower()
        if key in CANONICAL:
            return CANONICAL[key]
        if key.isdigit():
            return BY_CODE.get(int(key), "other")
        return "other"
    if isinstance(raw, int):
        return BY_CODE.get(raw, "other")
    return "other"
