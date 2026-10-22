"""Best-slip construction: one leg per game, at most one promo leg.

Slip EV is symmetric and non-decreasing in every leg probability, so the best
N-leg slip is the top N of the per-game best legs. Promo legs are handled by
also trying each promo leg alongside the best non-promo legs from other games.
"""

from .models import Leg, Slip
from .payouts import slip_ev


def _best_per_game(legs: list[Leg], exclude_game: str | None = None) -> list[Leg]:
    best: dict[str, Leg] = {}
    for leg in legs:
        if leg.game_id == exclude_game:
            continue
        if leg.game_id not in best or leg.prob > best[leg.game_id].prob:
            best[leg.game_id] = leg
    return sorted(best.values(), key=lambda l: l.prob, reverse=True)


def best_slip(
    legs: list[Leg],
    slip_type: str,
    tiers: dict[int, float],
    stake: float,
    bonus: bool = False,
    boost: float | None = None,
) -> Slip | None:
    """Highest-EV slip of the size implied by `tiers`, or None if too few games."""
    size = max(tiers)
    regular = [l for l in legs if not l.promo]

    candidates = [_best_per_game(regular)[:size]]
    for promo in (l for l in legs if l.promo):
        candidates.append([promo] + _best_per_game(regular, exclude_game=promo.game_id)[: size - 1])

    best = None
    for chosen in candidates:
        if len(chosen) < size:
            continue
        ev, pct = slip_ev([l.prob for l in chosen], tiers, stake, bonus=bonus, boost=boost)
        if best is None or ev > best.ev:
            best = Slip(slip_type, tuple(chosen), ev, pct)
    return best


def best_slips(
    legs: list[Leg],
    table: dict[str, dict[int, dict[int, float]]],
    stake: float,
    bonus: bool = False,
    boost: float | None = None,
    types: list[str] | None = None,
    sizes: list[int] | None = None,
) -> list[Slip]:
    """Best slip for every type/size in the payout table, sorted by EV.

    Bonus entries are Power-only: PrizePicks pays bonus Flex lineups on a
    different (undocumented, player-unfavourable) structure.
    """
    slips = []
    for slip_type, by_size in table.items():
        if types and slip_type not in types:
            continue
        if bonus and slip_type == "flex":
            continue
        for size, tiers in by_size.items():
            if sizes and size not in sizes:
                continue
            slip = best_slip(legs, slip_type, tiers, stake, bonus=bonus, boost=boost)
            if slip:
                slips.append(slip)
    return sorted(slips, key=lambda s: s.ev, reverse=True)
