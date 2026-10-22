import itertools

import pytest

from ppopt.models import Leg
from ppopt.slips import best_slip, best_slips

POWER = {2: {2: 3.0}, 3: {3: 6.0}, 4: {4: 10.0}}
TABLE = {"power": POWER, "flex": {3: {3: 3.0, 2: 1.0}}}


def leg(game, prob, player=None, promo=False):
    return Leg(
        sport="NBA",
        game_id=game,
        player=player or f"{game}-{prob}",
        stat="points",
        line=20.5,
        side="over",
        prob=prob,
        promo=promo,
    )


def test_one_leg_per_game():
    legs = [leg("A", 0.70), leg("A", 0.68), leg("B", 0.60), leg("C", 0.55)]
    slip = best_slip(legs, "power", POWER[3], stake=10)
    games = [l.game_id for l in slip.legs]
    assert len(set(games)) == len(games) == 3
    assert {l.prob for l in slip.legs} == {0.70, 0.60, 0.55}


def test_picks_best_leg_per_game():
    legs = [leg("A", 0.60), leg("A", 0.70), leg("B", 0.65)]
    slip = best_slip(legs, "power", POWER[2], stake=10)
    assert {l.prob for l in slip.legs} == {0.70, 0.65}


def test_not_enough_games_returns_none():
    legs = [leg("A", 0.7), leg("A", 0.6)]
    assert best_slip(legs, "power", POWER[2], stake=10) is None


def test_ev_is_computed():
    legs = [leg("A", 0.6), leg("B", 0.6)]
    slip = best_slip(legs, "power", POWER[2], stake=10)
    assert slip.ev == pytest.approx(10 * (0.36 * 3 - 1))


def test_at_most_one_promo_leg():
    legs = [leg("A", 0.9, promo=True), leg("B", 0.85, promo=True), leg("C", 0.55), leg("D", 0.52)]
    slip = best_slip(legs, "power", POWER[3], stake=10)
    assert sum(l.promo for l in slip.legs) == 1
    assert {l.prob for l in slip.legs} == {0.9, 0.55, 0.52}


def test_promo_slot_falls_back_to_non_promo_leg_in_same_game():
    # Promo B is used, so B's non-promo leg can't be; A's best non-promo leg is used instead.
    legs = [leg("A", 0.95, promo=True), leg("A", 0.60), leg("B", 0.90, promo=True), leg("C", 0.50)]
    slip = best_slip(legs, "power", POWER[3], stake=10)
    assert {l.prob for l in slip.legs} == {0.90, 0.60, 0.50}


def _brute_force(legs, tiers, size):
    from ppopt.payouts import slip_ev

    best = None
    for combo in itertools.combinations(legs, size):
        if len({l.game_id for l in combo}) < size or sum(l.promo for l in combo) > 1:
            continue
        ev = slip_ev([l.prob for l in combo], tiers, stake=10)[0]
        best = ev if best is None else max(best, ev)
    return best


@pytest.mark.parametrize("seed", range(20))
def test_matches_brute_force(seed):
    import random

    rng = random.Random(seed)
    legs = [
        leg(rng.choice("ABCDEF"), round(rng.uniform(0.4, 0.8), 3), player=str(i), promo=rng.random() < 0.2)
        for i in range(12)
    ]
    for size, tiers in POWER.items():
        slip = best_slip(legs, "power", tiers, stake=10)
        brute = _brute_force(legs, tiers, size)
        if brute is None:
            assert slip is None
        else:
            assert slip.ev == pytest.approx(brute)


def test_best_slips_sorted_by_ev_and_filters():
    legs = [leg(g, 0.6) for g in "ABCD"]
    slips = best_slips(legs, TABLE, stake=10)
    assert [s.ev for s in slips] == sorted((s.ev for s in slips), reverse=True)
    assert {(s.slip_type, s.size) for s in slips} == {("power", 2), ("power", 3), ("power", 4), ("flex", 3)}

    only = best_slips(legs, TABLE, stake=10, types=["power"], sizes=[3])
    assert [(s.slip_type, s.size) for s in only] == [("power", 3)]


def test_best_slips_bonus_skips_flex():
    legs = [leg(g, 0.6) for g in "ABCD"]
    slips = best_slips(legs, TABLE, stake=10, bonus=True)
    assert slips and all(s.slip_type == "power" for s in slips)
    assert best_slips(legs, TABLE, stake=10, bonus=True, types=["flex"]) == []


def test_best_slips_passes_promo_options():
    legs = [leg(g, 0.6) for g in "AB"]
    boosted = best_slips(legs, TABLE, stake=10, types=["power"], sizes=[2], boost=1.4)[0]
    assert boosted.ev == pytest.approx(10 * (0.36 * (1 + 1.4 * 2) - 1))
