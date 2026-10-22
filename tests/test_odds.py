import pytest

from ppopt.odds import american_to_implied, devig, DEVIG_METHODS


def test_american_to_implied_favourite():
    assert american_to_implied(-140) == pytest.approx(140 / 240)


def test_american_to_implied_underdog():
    assert american_to_implied(110) == pytest.approx(100 / 210)


def test_american_to_implied_even():
    assert american_to_implied(100) == pytest.approx(0.5)
    assert american_to_implied(-100) == pytest.approx(0.5)


@pytest.mark.parametrize("bad", [0, 50, -50, 99, -99])
def test_american_to_implied_rejects_invalid(bad):
    with pytest.raises(ValueError):
        american_to_implied(bad)


@pytest.mark.parametrize("method", DEVIG_METHODS)
def test_devig_sums_to_one(method):
    p_over, p_under = devig(-140, 110, method)
    assert p_over + p_under == pytest.approx(1.0)


@pytest.mark.parametrize("method", DEVIG_METHODS)
def test_devig_favourite_stays_favourite(method):
    p_over, p_under = devig(-140, 110, method)
    assert p_over > 0.5 > p_under


@pytest.mark.parametrize("method", DEVIG_METHODS)
def test_devig_symmetric_line_is_fifty_fifty(method):
    p_over, p_under = devig(-110, -110, method)
    assert p_over == pytest.approx(0.5)
    assert p_under == pytest.approx(0.5)


def test_multiplicative_value():
    q1, q2 = 140 / 240, 100 / 210
    p_over, _ = devig(-140, 110, "multiplicative")
    assert p_over == pytest.approx(q1 / (q1 + q2))


def test_additive_value():
    q1, q2 = 140 / 240, 100 / 210
    p_over, _ = devig(-140, 110, "additive")
    assert p_over == pytest.approx(q1 - (q1 + q2 - 1) / 2)


def test_power_value():
    q1, q2 = 140 / 240, 100 / 210
    p_over, p_under = devig(-140, 110, "power")
    k = __import__("math").log(p_over) / __import__("math").log(q1)
    assert q2 ** k == pytest.approx(p_under)


def test_methods_shade_longshot_differently():
    # Power and Shin remove more vig from the underdog than multiplicative does.
    mult = devig(-300, 240, "multiplicative")[0]
    power = devig(-300, 240, "power")[0]
    shin = devig(-300, 240, "shin")[0]
    assert power > mult
    assert shin > mult


def test_unknown_method():
    with pytest.raises(ValueError):
        devig(-110, -110, "magic")
