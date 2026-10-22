from pathlib import Path

import pytest

from ppopt.matching import Config
from ppopt.models import BookMarket, PPLine, PromoLeg
from ppopt.odds import devig
from ppopt.pricing import price_lines, price_promo, PromoError

ROOT = Path(__file__).resolve().parents[1]
GAME = frozenset({"CHI", "NE"})


@pytest.fixture(scope="module")
def cfg():
    return Config.load(ROOT)


def pp(player="Caleb Williams", stat="pass_yards", line=215.5, **kw):
    return PPLine(sport="NFL", teams=GAME, player=player, stat=stat, line=line, **kw)


def mkt(book="fanduel", player="Caleb Williams", stat="pass_yards", line=215.5, over=-140, under=110, teams=GAME):
    return BookMarket(book, "NFL", teams, player, stat, line, over, under)


def test_exact_match_prices_better_side(cfg):
    legs, unmatched = price_lines([pp()], [mkt()], cfg)
    assert unmatched == []
    [leg] = legs
    assert leg.side == "over"
    assert leg.prob == pytest.approx(devig(-140, 110)[0])
    assert leg.game_id == "NFL:CHI-NE"
    assert not leg.promo and not leg.modelled


def test_under_side_chosen_when_favoured(cfg):
    [leg], _ = price_lines([pp()], [mkt(over=120, under=-150)], cfg)
    assert leg.side == "under"
    assert leg.prob > 0.5


def test_averages_books_and_reports_disagreement(cfg):
    [leg], _ = price_lines([pp()], [mkt("fanduel", over=-140, under=110), mkt("draftkings", over=-120, under=-110)], cfg)
    fd, dk = devig(-140, 110)[0], devig(-120, -110)[0]
    assert leg.prob == pytest.approx((fd + dk) / 2)
    assert leg.disagreement == pytest.approx(fd - dk)


def test_player_names_normalized(cfg):
    legs, _ = price_lines([pp(player="Michael Pittman Jr.", stat="rec_yards", line=55.5)],
                          [mkt(player="Michael Pittman", stat="rec_yards", line=55.5)], cfg)
    assert len(legs) == 1


def test_devig_method_is_passed_through(cfg):
    [leg], _ = price_lines([pp()], [mkt(over=-300, under=240)], cfg, method="power")
    assert leg.prob == pytest.approx(devig(-300, 240, "power")[0])


@pytest.mark.parametrize(
    "line, markets, reason",
    [
        (pp(stat=None, raw_stat="Fantasy Score"), [mkt()], "unmapped stat"),
        (pp(), [mkt(player="Someone Else")], "no book market"),
        (pp(), [mkt(line=220.5)], "no exact line"),
        (pp(), [mkt(under=None)], "one-sided only"),
        (pp(), [mkt(teams=frozenset({"CHI", "GB"}))], "no book market"),
    ],
)
def test_unmatched_reasons(cfg, line, markets, reason):
    legs, unmatched = price_lines([line], markets, cfg)
    assert legs == []
    assert unmatched == [(line, reason)]


def test_over_only_line_keeps_over_even_when_under_favoured(cfg):
    [leg], _ = price_lines([pp(sides=("over",))], [mkt(over=120, under=-150)], cfg)
    assert leg.side == "over"
    assert leg.prob < 0.5


def test_one_sided_book_ignored_when_another_book_is_two_sided(cfg):
    [leg], _ = price_lines([pp()], [mkt("fanduel", under=None), mkt("draftkings", over=-120, under=-110)], cfg)
    assert set(leg.book_probs) == {"draftkings"}


@pytest.mark.parametrize(
    "line, odds_type, reason",
    [(215.5, "goblin", "not standard"), (215.5, "demon", "not standard"), (215.0, "standard", "whole-number line")],
)
def test_ineligible_lines(cfg, line, odds_type, reason):
    item = pp(line=line, odds_type=odds_type)
    legs, unmatched = price_lines([item], [mkt(line=line)], cfg)
    assert legs == [] and unmatched == [(item, reason)]


# --- promo legs -------------------------------------------------------------

def promo(line=215.5, side="over", player="Caleb Williams", stat="pass_yards", teams=GAME):
    return PromoLeg("NFL", teams, player, stat, line, side)


def test_promo_exact_line_not_modelled(cfg):
    leg = price_promo(promo(), [mkt()], cfg)
    assert leg.promo and not leg.modelled
    assert leg.promo_type == "manual"
    assert leg.prob == pytest.approx(devig(-140, 110)[0])


def test_promo_discounted_line_is_modelled_and_more_likely(cfg):
    leg = price_promo(promo(line=150.5), [mkt(over=-110, under=-110)], cfg)
    assert leg.promo and leg.modelled
    assert leg.prob > 0.8
    assert leg.side == "over"


def test_promo_uses_main_line_per_book(cfg):
    # Alt line far from 50/50 should be ignored in favour of the main line.
    main = mkt(line=215.5, over=-110, under=-110)
    alt = mkt(line=250.5, over=300, under=-450)
    with_alt = price_promo(promo(line=150.5), [alt, main], cfg)
    only_main = price_promo(promo(line=150.5), [main], cfg)
    assert with_alt.prob == pytest.approx(only_main.prob)


def test_promo_under_side(cfg):
    leg = price_promo(promo(line=280.5, side="under"), [mkt(over=-110, under=-110)], cfg)
    assert leg.side == "under" and leg.prob > 0.8


@pytest.mark.parametrize(
    "p, markets, match",
    [
        (promo(teams=frozenset({"CHI", "GB"})), [mkt()], "no book odds for game"),
        (promo(player="Nobody"), [mkt()], "Nobody"),
        (promo(), [mkt(under=None)], "two-sided"),
    ],
)
def test_promo_errors(cfg, p, markets, match):
    with pytest.raises(PromoError, match=match):
        price_promo(p, markets, cfg)
