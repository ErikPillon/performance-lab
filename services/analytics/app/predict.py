"""Race time prediction from an athlete's own duration curve.

Two independent models, deliberately reported side by side rather than blended
into one number:

* **Riegel** — `T2 = T1 * (D2/D1) ** 1.06`. An empirical fatigue law fitted to
  race results. It holds well from about 1500 m to the marathon and is the model
  most race predictors actually use.
* **Critical speed** — `T = (D - D') / CS` from the two-parameter model already
  fitted for the duration curve. Physiologically grounded, and honest only over
  the range it was fitted on: it assumes critical speed is sustainable
  indefinitely, so it becomes badly optimistic past roughly an hour.

Where they disagree is information, not a problem to average away. A wide spread
means the athlete's curve does not look like the population Riegel was fitted
to, which is worth seeing.

Nothing here predicts from a threshold or a lab value. Every number comes from
efforts the athlete has actually run.
"""

from __future__ import annotations

from dataclasses import dataclass

# Riegel's exponent. 1.06 is the classic value from race results across
# distances; higher means endurance falls off faster with distance. Well-trained
# runners sit slightly below it and beginners above, but fitting it per athlete
# needs race results this system does not have yet.
RIEGEL_EXPONENT = 1.06

# The critical-speed model is fitted over 2-20 minute efforts. Predicting a
# marathon from it is extrapolating twentyfold, and it says an athlete can hold
# critical speed forever, which nobody can. Past this it is not reported.
CS_MAX_PREDICT_S = 3600.0

# Riegel is an empirical law, not a licence to extrapolate without limit. Past
# roughly a fourfold jump from the reference effort the error grows quickly.
RIEGEL_MAX_RATIO = 4.0

# Below this the anaerobic reserve dominates and Riegel's exponent stops
# describing the falloff, so such efforts are never used as an anchor.
MIN_ANCHOR_S = 300.0

STANDARD_DISTANCES: dict[str, float] = {
    "1500 m": 1500.0,
    "5k": 5000.0,
    "10k": 10000.0,
    "half marathon": 21097.5,
    "marathon": 42195.0,
}


@dataclass(frozen=True)
class Reference:
    """The effort a prediction is extrapolated from."""

    duration_s: float
    distance_m: float
    speed_mps: float


def candidate_references(
    curve: dict[int, float], min_duration_s: float = MIN_ANCHOR_S
) -> list[Reference]:
    """Every effort in the curve long enough to extrapolate from.

    Below about five minutes the anaerobic reserve dominates and Riegel's
    exponent no longer describes the falloff, so those are excluded outright.
    """
    return [
        Reference(duration_s=float(d), distance_m=v * d, speed_mps=float(v))
        for d, v in sorted(curve.items())
        if d >= min_duration_s and v > 0
    ]


def best_reference(curve: dict[int, float], min_duration_s: float = MIN_ANCHOR_S) -> Reference | None:
    """The single anchor that yields the fastest prediction at its own distance.

    Kept for callers that want one anchor; `predict` searches all of them.
    """
    candidates = candidate_references(curve, min_duration_s)
    return candidates[0] if candidates else None


def riegel(reference: Reference, distance_m: float, exponent: float = RIEGEL_EXPONENT) -> float:
    """Predicted seconds for `distance_m`, extrapolated from one effort."""
    return reference.duration_s * (distance_m / reference.distance_m) ** exponent


def from_critical_speed(distance_m: float, critical_speed_mps: float, d_prime_m: float) -> float | None:
    """Predicted seconds from the two-parameter model, or None outside its range.

    `D = CS*t + D'` rearranges to `t = (D - D') / CS`. Returns None when the
    distance is inside the anaerobic reserve — the model has nothing to say
    about a sprint — or when the answer runs past the horizon the fit supports.
    """
    if critical_speed_mps <= 0 or distance_m <= d_prime_m:
        return None
    seconds = (distance_m - d_prime_m) / critical_speed_mps
    return seconds if seconds <= CS_MAX_PREDICT_S else None


def predict(
    distance_m: float,
    curve: dict[int, float],
    critical: dict[str, float] | None = None,
) -> dict[str, object] | None:
    """Predict a finish time for one distance.

    Returns both models where each is defensible, a range spanning them, and
    enough provenance for the caller to say where the number came from. Returns
    None when there is no effort long enough to extrapolate from at all.
    """
    # Riegel is evaluated from every usable anchor and the fastest result wins.
    #
    # This is the whole trick. A mean-maximal curve's long end is not a maximal
    # effort — it is whatever the athlete's best long *easy* run happened to be.
    # Anchoring on the longest duration, as this first did, predicted a 5k at
    # 4:58/km for an athlete whose critical speed is 4:10/km, because it was
    # extrapolating from a two-hour steady run. A submaximal anchor always
    # yields a slower prediction than a maximal one at the same distance, so
    # taking the minimum over anchors selects the effort that was actually raced.
    best: tuple[float, Reference] | None = None
    for candidate in candidate_references(curve):
        if distance_m / candidate.distance_m > RIEGEL_MAX_RATIO:
            continue
        seconds = riegel(candidate, distance_m)
        if best is None or seconds < best[0]:
            best = (seconds, candidate)

    if best is None:
        # Nothing close enough to extrapolate from. Fall back to the shortest
        # usable anchor only to report how far out of range the ask was.
        nearest = best_reference(curve)
        if nearest is None:
            return None
        reference = nearest
        ratio = distance_m / reference.distance_m
        estimates: dict[str, float] = {}
    else:
        reference = best[1]
        ratio = distance_m / reference.distance_m
        estimates = {"riegel": best[0]}

    if critical:
        cs = from_critical_speed(
            distance_m,
            float(critical.get("critical_speed_mps", 0.0)),
            float(critical.get("d_prime_m", 0.0)),
        )
        if cs is not None:
            estimates["critical_speed"] = cs

    if not estimates:
        return None

    values = sorted(estimates.values())
    return {
        "distance_m": distance_m,
        "estimates": {k: round(v, 1) for k, v in estimates.items()},
        # The spread between two independent models, not a statistical
        # confidence interval — it is honest about disagreement, not precision.
        "low_s": round(values[0], 1),
        "high_s": round(values[-1], 1),
        "seconds": round(sum(values) / len(values), 1),
        "reference": {
            "duration_s": reference.duration_s,
            "distance_m": round(reference.distance_m, 1),
            "speed_mps": round(reference.speed_mps, 4),
        },
        # How far past the anchoring effort this reaches. Above about 4 the
        # prediction is a guess wearing a number.
        "extrapolation_ratio": round(ratio, 2),
        "confidence": (
            "high" if ratio <= 1.5 else "moderate" if ratio <= 3 else "low"
        ),
    }


def predict_standard(
    curve: dict[int, float], critical: dict[str, float] | None = None
) -> list[dict[str, object]]:
    """Predictions for the usual race distances, skipping any that cannot be made."""
    out = []
    for label, distance in STANDARD_DISTANCES.items():
        result = predict(distance, curve, critical)
        if result is not None:
            out.append({"label": label, **result})
    return out
