"""Join PrizePicks lines to sportsbook markets and price them."""

from collections import defaultdict

from .matching import Config, game_id
from .models import BookMarket, Leg, PPLine, PromoLeg
from .odds import devig
from .promo_model import reprice


class PromoError(ValueError):
    """A --promoLeg could not be priced."""


def _same_line(a: float, b: float) -> bool:
    return abs(a - b) < 1e-9


def _index(markets: list[BookMarket], cfg: Config) -> dict[tuple, list[BookMarket]]:
    idx = defaultdict(list)
    for m in markets:
        idx[(m.sport, m.teams, cfg.player_key(m.player), m.stat)].append(m)
    return idx


def _leg(sport, teams, player, stat, line, book_over: dict[str, float], side=None, sides=("over", "under"), **kw) -> Leg:
    p_over = sum(book_over.values()) / len(book_over)
    if side is None:
        best = "over" if p_over >= 0.5 else "under"
        side = best if best in sides else sides[0]
    flip = (lambda p: p) if side == "over" else (lambda p: 1 - p)
    return Leg(
        sport=sport,
        game_id=game_id(sport, teams),
        player=player,
        stat=stat,
        line=line,
        side=side,
        prob=flip(p_over),
        book_probs={b: flip(p) for b, p in book_over.items()},
        **kw,
    )


def price_lines(
    lines: list[PPLine], markets: list[BookMarket], cfg: Config, method: str = "multiplicative"
) -> tuple[list[Leg], list[tuple[PPLine, str]]]:
    """Price standard half-point PrizePicks lines against exact, two-sided book lines.

    Returns (legs, unmatched) where unmatched pairs each skipped line with a reason.
    Each priced line yields one leg on its more likely side.
    """
    idx = _index(markets, cfg)
    legs, unmatched = [], []
    for line in lines:
        if line.odds_type != "standard":
            unmatched.append((line, "not standard"))
            continue
        if line.line % 1 != 0.5:
            unmatched.append((line, "whole-number line"))
            continue
        if line.stat is None:
            unmatched.append((line, "unmapped stat"))
            continue
        candidates = idx.get((line.sport, line.teams, cfg.player_key(line.player), line.stat), [])
        if not candidates:
            unmatched.append((line, "no book market"))
            continue
        exact = [m for m in candidates if _same_line(m.line, line.line)]
        if not exact:
            unmatched.append((line, "no exact line"))
            continue
        two_sided = [m for m in exact if m.two_sided]
        if not two_sided:
            unmatched.append((line, "one-sided only"))
            continue
        book_over = {m.book: devig(m.over_odds, m.under_odds, method)[0] for m in two_sided}
        legs.append(_leg(line.sport, line.teams, line.player, line.stat, line.line, book_over, sides=line.sides))
    return legs, unmatched


def price_promo(
    promo: PromoLeg, markets: list[BookMarket], cfg: Config, method: str = "multiplicative"
) -> Leg:
    """Price a manually entered promo leg.

    Per book: use the exact line if offered, otherwise reprice from the book's main
    line (the two-sided line closest to 50/50) via the stat's distribution model.
    """
    if not any(m.sport == promo.sport and m.teams == promo.teams for m in markets):
        raise PromoError(f"no book odds for game {'/'.join(sorted(promo.teams))} ({promo.sport})")
    candidates = _index(markets, cfg).get((promo.sport, promo.teams, cfg.player_key(promo.player), promo.stat), [])
    if not candidates:
        raise PromoError(f"no book odds for {promo.player} {promo.stat}")
    two_sided = [m for m in candidates if m.two_sided]
    if not two_sided:
        raise PromoError(f"{promo.player} {promo.stat} has no two-sided book odds")

    by_book = defaultdict(list)
    for m in two_sided:
        by_book[m.book].append((m, devig(m.over_odds, m.under_odds, method)[0]))

    model, cv = cfg.stat_model(promo.sport, promo.stat)
    book_over, modelled = {}, False
    for book, priced in by_book.items():
        exact = [p for m, p in priced if _same_line(m.line, promo.line)]
        if exact:
            book_over[book] = exact[0]
            continue
        main, p_over = min(priced, key=lambda mp: abs(mp[1] - 0.5))
        book_over[book] = reprice(main.line, p_over, promo.line, "over", model, cv)
        modelled = True

    return _leg(
        promo.sport, promo.teams, promo.player, promo.stat, promo.line, book_over,
        side=promo.side, promo=True, modelled=modelled, promo_type=promo.promo_type,
    )
