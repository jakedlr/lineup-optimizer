from pathlib import Path

import pytest

from ppopt.payouts import (
    load_payouts,
    boost_tiers,
    hit_distribution,
    expected_return,
    slip_ev,
    break_even,
)

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def table():
    return load_payouts(ROOT / "payouts.json")


def test_load_payouts_uses_int_keys(table):
    assert table["power"][3] == {3: 6.0}
    assert table["flex"][6] == {6: 25.0, 5: 2.0, 4: 0.4}
    assert table["flex"][2] == {2: 2.0, 1: 0.5}


def test_load_payouts_ignores_comment_keys(table):
    assert set(table) == {"power", "flex"}


def test_boost_matches_user_example():
    # 3-leg power 6x with a 1.4x boost pays 6 + 0.4 * 5 = 8x.
    assert boost_tiers({3: 6.0}, 1.4) == {3: pytest.approx(8.0)}


def test_boost_leaves_tiers_at_or_below_one_unchanged():
    assert boost_tiers({6: 25.0, 5: 2.0, 4: 0.4}, 1.4) == {
        6: pytest.approx(34.6),
        5: pytest.approx(2.4),
        4: 0.4,
    }
    assert boost_tiers({3: 3.0, 2: 1.0}, 2.0)[2] == 1.0


def test_hit_distribution_sums_to_one():
    dist = hit_distribution([0.6, 0.55, 0.7])
    assert sum(dist) == pytest.approx(1.0)
    assert len(dist) == 4


def test_hit_distribution_values():
    dist = hit_distribution([0.5, 0.5])
    assert dist == pytest.approx([0.25, 0.5, 0.25])


def test_expected_return_power():
    # P(all 3 hit) * 6
    assert expected_return([0.6, 0.6, 0.6], {3: 6.0}) == pytest.approx(0.216 * 6)


def test_slip_ev_cash_entry():
    ev, pct = slip_ev([0.6, 0.6, 0.6], {3: 6.0}, stake=10)
    assert ev == pytest.approx(10 * (0.216 * 6 - 1))
    assert pct == pytest.approx(0.216 * 6 - 1)


def test_slip_ev_bonus_entry_pays_profit_only():
    ev, pct = slip_ev([0.6, 0.6, 0.6], {3: 6.0}, stake=10, bonus=True)
    assert ev == pytest.approx(10 * 0.216 * 5)
    assert pct == pytest.approx(0.216 * 5)


def test_slip_ev_bonus_ignores_tiers_below_stake():
    # Flex 5: 3/5 at 0.4x returns nothing on a free entry.
    probs = [0.5] * 5
    tiers = {5: 10.0, 4: 2.0, 3: 0.4}
    ev, _ = slip_ev(probs, tiers, stake=1, bonus=True)
    assert ev == pytest.approx((1 / 32) * 9 + (5 / 32) * 1)


def test_slip_ev_boost():
    ev, _ = slip_ev([0.6, 0.6, 0.6], {3: 6.0}, stake=10, boost=1.4)
    assert ev == pytest.approx(10 * (0.216 * 8 - 1))


def test_bonus_and_boost_are_exclusive():
    with pytest.raises(ValueError):
        slip_ev([0.6, 0.6], {2: 3.0}, stake=10, bonus=True, boost=1.4)


def test_break_even_power_two():
    # 3x two-pick: p^2 * 3 = 1
    assert break_even({2: 3.0}, 2) == pytest.approx(3 ** -0.5)


def test_break_even_with_boost_is_lower():
    assert break_even({3: 6.0}, 3, boost=1.4) < break_even({3: 6.0}, 3)


def test_break_even_flex_six(table):
    p = break_even(table["flex"][6], 6)
    ev, _ = slip_ev([p] * 6, table["flex"][6], stake=1)
    assert ev == pytest.approx(0.0, abs=1e-9)
    assert 0.5 < p < 0.6
