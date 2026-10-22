"""American odds conversion and vig removal for two-way markets."""

import math

DEVIG_METHODS = ("multiplicative", "additive", "power", "shin")


def american_to_implied(odds: float) -> float:
    """Implied probability of American odds, vig included."""
    if -100 < odds < 100:
        raise ValueError(f"invalid American odds: {odds}")
    if odds < 0:
        return -odds / (-odds + 100)
    return 100 / (odds + 100)


def _bisect(f, lo: float, hi: float, iters: int = 200) -> float:
    """Root of a function that is decreasing on [lo, hi]."""
    for _ in range(iters):
        mid = (lo + hi) / 2
        if f(mid) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def devig(over_odds: float, under_odds: float, method: str = "multiplicative") -> tuple[float, float]:
    """True (over, under) probabilities from two-sided American odds."""
    q = (american_to_implied(over_odds), american_to_implied(under_odds))
    total = sum(q)

    if method == "multiplicative":
        p = tuple(qi / total for qi in q)
    elif method == "additive":
        p = tuple(qi - (total - 1) / 2 for qi in q)
    elif method == "power":
        k = _bisect(lambda k: sum(qi**k for qi in q) - 1, 1e-9, 100.0)
        p = tuple(qi**k for qi in q)
    elif method == "shin":

        def shin_probs(z):
            return tuple(
                (math.sqrt(z * z + 4 * (1 - z) * qi * qi / total) - z) / (2 * (1 - z)) for qi in q
            )

        z = _bisect(lambda z: sum(shin_probs(z)) - 1, 0.0, 0.999)
        p = shin_probs(z)
    else:
        raise ValueError(f"unknown devig method {method!r}; choose from {DEVIG_METHODS}")

    # Normalise away bisection residue so the pair sums to exactly 1.
    s = p[0] + p[1]
    return p[0] / s, p[1] / s
