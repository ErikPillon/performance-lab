"""VO2max estimated from running performance, via Daniels and Gilbert.

Two equations, both from *Daniels' Running Formula*:

* oxygen cost of running at a velocity, `VO2 = -4.60 + 0.182258*v + 0.000104*v^2`
  with `v` in metres per minute;
* the fraction of maximum an athlete can hold for a given duration,
  `%max = 0.8 + 0.1894393*e^(-0.012778*t) + 0.2989558*e^(-0.1932605*t)`
  with `t` in minutes.

Dividing one by the other gives VDOT — a pseudo-VO2max in ml/kg/min.

**It is a transformation of running performance, not a measurement.** Nothing
here observes oxygen uptake; a VDOT of 52 means "you run like someone whose
measured VO2max is around 52", which is a different claim and a weaker one. It
moves with heat, terrain, sleep and pacing. Reported because the trend over
months is informative and because it is the number every other platform quotes,
not because the absolute value is precise.
"""

from __future__ import annotations

import math

# The window the two equations were fitted over: roughly 1500 m to the marathon.
# Outside it the answer would be arithmetic rather than physiology — a 400 m
# sprint is almost entirely anaerobic, and past four hours pace is set by
# fuelling and damage rather than by oxygen uptake.
#
# Four hours rather than two so that a marathon is inside the window. Daniels'
# tables run to marathon times, and refusing the one race distance most people
# care about would have been a strange place to stop.
MIN_DURATION_S = 180.0
MAX_DURATION_S = 14400.0


def oxygen_cost(velocity_m_per_min: float) -> float:
    """Oxygen cost, ml/kg/min, of running at a velocity."""
    v = velocity_m_per_min
    return -4.60 + 0.182258 * v + 0.000104 * v * v


def fraction_of_max(duration_s: float) -> float:
    """Fraction of VO2max sustainable for a duration.

    Exceeds 1.0 below about seven minutes, and that is the model rather than a
    transcription error: VDOT is a *pseudo*-VO2max that absorbs the anaerobic
    contribution to short efforts, so the ratio it divides by is allowed to
    represent more than aerobic capacity alone.
    """
    t = duration_s / 60.0
    return 0.8 + 0.1894393 * math.exp(-0.012778 * t) + 0.2989558 * math.exp(-0.1932605 * t)


def vdot(distance_m: float, duration_s: float) -> float | None:
    """VDOT for one performance, or None when the effort is out of range."""
    if duration_s < MIN_DURATION_S or duration_s > MAX_DURATION_S or distance_m <= 0:
        return None
    velocity = distance_m / (duration_s / 60.0)
    cost = oxygen_cost(velocity)
    fraction = fraction_of_max(duration_s)
    if fraction <= 0 or cost <= 0:
        return None
    return cost / fraction


def from_curve(curve: dict[int, float]) -> dict[str, float] | None:
    """Best VDOT across every usable effort in a mean-maximal curve.

    The maximum, not the average: a curve holds one genuinely maximal effort
    and a great many submaximal ones, and only the best of them says anything
    about capacity. Which duration produced it is returned too — it is the
    effort the number rests on, and a VDOT anchored on a three-minute effort
    deserves more scepticism than one anchored on twenty.
    """
    best: tuple[float, int] | None = None
    for duration, speed in curve.items():
        if speed <= 0:
            continue
        value = vdot(speed * duration, float(duration))
        if value is not None and (best is None or value > best[0]):
            best = (value, duration)
    if best is None:
        return None
    return {
        "vdot": round(best[0], 1),
        "from_duration_s": float(best[1]),
        # The equivalent 5k, because a VDOT means nothing to most people and a
        # 5k time means something to every runner.
        "equivalent_5k_s": round(equivalent_time(best[0], 5000.0), 1),
    }


def equivalent_time(target_vdot: float, distance_m: float) -> float:
    """The time that a given VDOT predicts for a distance.

    Inverted numerically: the forward relation has duration on both sides —
    inside the velocity and inside the fractional-utilisation term — so there is
    no closed form. A bisection over a wide bracket converges in well under a
    millisecond and cannot diverge, which a Newton step on this curve can.
    """
    lo, hi = MIN_DURATION_S, MAX_DURATION_S
    for _ in range(200):
        mid = (lo + hi) / 2
        estimate = vdot(distance_m, mid)
        if estimate is None:
            # Outside the model's window; push the bracket inward.
            lo = mid
            continue
        # A longer time means a lower VDOT, so the search runs downhill.
        if estimate > target_vdot:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2
