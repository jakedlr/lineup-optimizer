"""Reprice a book line's true probability at a different (promo) line.

Fit a distribution so that P(stat > book_line) equals the devigged over
probability, then read P(stat > promo_line) off the fitted distribution.

- poisson: low-count stats; solves lambda.
- normal: large stats; solves the mean with sigma = cv * mean (cv is a
  per-stat modelling assumption).
"""

import math

MODELS = ("poisson", "normal")


def poisson_sf(line: float, lam: float) -> float:
    """P(X > line) for X ~ Poisson(lam)."""
    term = math.exp(-lam)
    cdf = 0.0
    for k in range(int(math.floor(line)) + 1):
        if k:
            term *= lam / k
        cdf += term
    return max(0.0, 1.0 - cdf)


def normal_sf(line: float, mean: float, sd: float) -> float:
    """P(X > line) for X ~ Normal(mean, sd)."""
    return 0.5 * math.erfc((line - mean) / (sd * math.sqrt(2)))


def _solve_increasing(f, target: float, lo: float, hi: float) -> float:
    for _ in range(200):
        mid = (lo + hi) / 2
        if f(mid) < target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def fit_poisson(line: float, p_over: float) -> float:
    return _solve_increasing(lambda lam: poisson_sf(line, lam), p_over, 1e-9, 10 * line + 50)


def fit_normal(line: float, p_over: float, cv: float) -> float:
    return _solve_increasing(lambda m: normal_sf(line, m, cv * m), p_over, 1e-9, 10 * line + 50)


def reprice(
    book_line: float,
    book_p_over: float,
    promo_line: float,
    side: str,
    model: str,
    cv: float | None = None,
) -> float:
    """True probability of `side` at `promo_line`, extrapolated from the book line."""
    if model == "poisson":
        p_over = poisson_sf(promo_line, fit_poisson(book_line, book_p_over))
    elif model == "normal":
        if cv is None:
            raise ValueError("normal model needs a coefficient of variation (cv)")
        mean = fit_normal(book_line, book_p_over, cv)
        p_over = normal_sf(promo_line, mean, cv * mean)
    else:
        raise ValueError(f"unknown model {model!r}; choose from {MODELS}")
    return p_over if side == "over" else 1 - p_over
