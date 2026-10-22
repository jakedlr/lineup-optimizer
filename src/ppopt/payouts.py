"""Payout tables, promo adjustments and slip EV.

A tier table maps number of hits -> payout multiplier on the stake,
e.g. a 6-pick Flex is {6: 25.0, 5: 2.0, 4: 0.4}.
"""

import json
from pathlib import Path

SLIP_TYPES = ("power", "flex")


def load_payouts(path: str | Path) -> dict[str, dict[int, dict[int, float]]]:
    """Load payouts.json as {slip type: {size: {hits: multiplier}}}."""
    raw = json.loads(Path(path).read_text())
    return {
        slip_type: {
            int(size): {int(hits): float(m) for hits, m in tiers.items()}
            for size, tiers in sizes.items()
        }
        for slip_type, sizes in raw.items()
        if slip_type in SLIP_TYPES
    }


def boost_tiers(tiers: dict[int, float], boost: float) -> dict[int, float]:
    """Apply a lineup boost: tiers paying more than 1x become 1 + boost * (m - 1)."""
    return {hits: 1 + boost * (m - 1) if m > 1 else m for hits, m in tiers.items()}


def hit_distribution(probs: list[float]) -> list[float]:
    """P(exactly k legs hit) for k = 0..n (Poisson-binomial)."""
    dist = [1.0]
    for p in probs:
        nxt = [0.0] * (len(dist) + 1)
        for k, pk in enumerate(dist):
            nxt[k] += pk * (1 - p)
            nxt[k + 1] += pk * p
        dist = nxt
    return dist


def expected_return(probs: list[float], tiers: dict[int, float]) -> float:
    """Expected payout multiple of the stake."""
    dist = hit_distribution(probs)
    return sum(dist[hits] * m for hits, m in tiers.items() if hits < len(dist))


def slip_ev(
    probs: list[float],
    tiers: dict[int, float],
    stake: float,
    bonus: bool = False,
    boost: float | None = None,
) -> tuple[float, float]:
    """(EV in dollars, EV as a fraction of stake) for one slip.

    bonus: free entry, stake not returned, so each tier is worth max(m - 1, 0).
    boost: lineup boost applied to tiers above 1x.
    """
    if bonus and boost is not None:
        raise ValueError("promotions are mutually exclusive: bonus and boost cannot combine")
    if boost is not None:
        tiers = boost_tiers(tiers, boost)
    if bonus:
        pct = expected_return(probs, {h: max(m - 1, 0.0) for h, m in tiers.items()})
    else:
        pct = expected_return(probs, tiers) - 1
    return stake * pct, pct


def break_even(tiers: dict[int, float], size: int, boost: float | None = None) -> float:
    """Per-leg probability at which a cash entry of equal legs has zero EV."""
    lo, hi = 0.0, 1.0
    for _ in range(100):
        mid = (lo + hi) / 2
        if slip_ev([mid] * size, tiers, stake=1, boost=boost)[1] < 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2
