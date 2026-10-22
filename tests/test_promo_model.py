import math

import pytest

from ppopt.promo_model import poisson_sf, normal_sf, fit_poisson, fit_normal, reprice


def test_poisson_sf_known_value():
    # P(X > 2.5 | lambda=3) = 1 - P(X <= 2)
    expected = 1 - math.exp(-3) * (1 + 3 + 4.5)
    assert poisson_sf(2.5, 3.0) == pytest.approx(expected)


def test_normal_sf_at_mean_is_half():
    assert normal_sf(100.0, 100.0, 20.0) == pytest.approx(0.5)


def test_fit_poisson_round_trip():
    lam = fit_poisson(6.5, 0.45)
    assert poisson_sf(6.5, lam) == pytest.approx(0.45, abs=1e-9)


def test_fit_normal_round_trip():
    mean = fit_normal(215.5, 0.52, cv=0.25)
    assert normal_sf(215.5, mean, 0.25 * mean) == pytest.approx(0.52, abs=1e-9)


@pytest.mark.parametrize("model", ["poisson", "normal"])
def test_reprice_same_line_is_identity(model):
    assert reprice(8.5, 0.55, 8.5, "over", model, cv=0.3) == pytest.approx(0.55, abs=1e-9)


@pytest.mark.parametrize("model", ["poisson", "normal"])
def test_reprice_discounted_over_is_more_likely(model):
    assert reprice(8.5, 0.5, 4.5, "over", model, cv=0.3) > 0.8


@pytest.mark.parametrize("model", ["poisson", "normal"])
def test_reprice_under_side(model):
    over = reprice(8.5, 0.5, 4.5, "over", model, cv=0.3)
    under = reprice(8.5, 0.5, 4.5, "under", model, cv=0.3)
    assert over + under == pytest.approx(1.0)


def test_reprice_normal_requires_cv():
    with pytest.raises(ValueError):
        reprice(200.5, 0.5, 150.5, "over", "normal")


def test_reprice_unknown_model():
    with pytest.raises(ValueError):
        reprice(8.5, 0.5, 4.5, "over", "gamma")
