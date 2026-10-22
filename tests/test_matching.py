from pathlib import Path

import pytest

from ppopt.matching import Config, normalize_name, parse_game, parse_pick, parse_promo_leg, game_id

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def cfg():
    return Config.load(ROOT)


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Caleb Williams", "caleb williams"),
        ("Luka Dončić", "luka doncic"),
        ("Michael Pittman Jr.", "michael pittman"),
        ("Marvin Harrison Jr", "marvin harrison"),
        ("Kenneth Walker III", "kenneth walker"),
        ("D'Andre Swift", "dandre swift"),
        ("Amon-Ra St. Brown", "amonra st brown"),
        ("  T.J.   Hockenson ", "tj hockenson"),
    ],
)
def test_normalize_name(raw, expected):
    assert normalize_name(raw) == expected


def test_player_key_applies_aliases():
    cfg = Config(teams={}, stats={}, aliases={"cam johnson": "cameron johnson"})
    assert cfg.player_key("Cam Johnson") == "cameron johnson"
    assert cfg.player_key("Cameron Johnson") == "cameron johnson"


@pytest.mark.parametrize(
    "text", ["CHI vs NE", "NE @ CHI", "chi - ne", "CHI vs. NE", "Chicago Bears vs New England Patriots", "Bears @ Patriots"]
)
def test_parse_game_variants(cfg, text):
    assert parse_game("NFL", text, cfg) == frozenset({"CHI", "NE"})


def test_resolve_team_by_nickname_suffix(cfg):
    assert cfg.resolve_team("NBA", "LA Clippers") == "LAC"
    assert cfg.resolve_team("NBA", "GS") == "GSW"
    assert cfg.resolve_team("NHL", "Utah Hockey Club") == "UTA"


def test_resolve_team_is_sport_specific(cfg):
    assert cfg.resolve_team("NFL", "Giants") == "NYG"
    assert cfg.resolve_team("MLB", "Giants") == "SF"


def test_parse_game_rejects_unknown_team(cfg):
    with pytest.raises(ValueError, match="XYZ"):
        parse_game("NFL", "CHI vs XYZ", cfg)


def test_parse_game_rejects_missing_separator(cfg):
    with pytest.raises(ValueError):
        parse_game("NFL", "CHI NE", cfg)


def test_game_id_is_order_insensitive():
    assert game_id("NFL", frozenset({"NE", "CHI"})) == game_id("NFL", frozenset({"CHI", "NE"})) == "NFL:CHI-NE"


def test_pp_stat_mapping(cfg):
    assert cfg.pp_stat("NBA", "Pts+Rebs+Asts") == "pts_rebs_asts"
    assert cfg.pp_stat("NBA", "Fantasy Score") is None
    assert cfg.pp_stat("NHL", "Points") == "points"


def test_stat_model(cfg):
    assert cfg.stat_model("NFL", "pass_yards") == ("normal", 0.25)
    assert cfg.stat_model("NBA", "rebounds") == ("poisson", None)


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Over 215.5 Pass Yards", ("over", 215.5, "pass_yards")),
        ("under 45.5 rush yards", ("under", 45.5, "rush_yards")),
        ("More 4.5 Receptions", ("over", 4.5, "receptions")),
        ("Less 0.5 Pass TDs", ("under", 0.5, "pass_tds")),
    ],
)
def test_parse_pick(cfg, text, expected):
    assert parse_pick("NFL", text, cfg) == expected


@pytest.mark.parametrize("text", ["Over Pass Yards", "Sideways 215.5 Pass Yards", "Over 215.5 Fantasy Score"])
def test_parse_pick_rejects_bad_input(cfg, text):
    with pytest.raises(ValueError):
        parse_pick("NFL", text, cfg)


def test_parse_pick_rejects_whole_number_line(cfg):
    with pytest.raises(ValueError, match="half-point"):
        parse_pick("NFL", "Over 215 Pass Yards", cfg)


def test_parse_promo_leg(cfg):
    promo = parse_promo_leg(["nfl", "CHI vs NE", "Caleb Williams", "Over 215.5 Pass Yards"], cfg)
    assert promo.sport == "NFL"
    assert promo.teams == frozenset({"CHI", "NE"})
    assert promo.player == "Caleb Williams"
    assert (promo.side, promo.line, promo.stat) == ("over", 215.5, "pass_yards")


def test_parse_promo_leg_rejects_unknown_sport(cfg):
    with pytest.raises(ValueError, match="sport"):
        parse_promo_leg(["CURLING", "A vs B", "X", "Over 1.5 Stones"], cfg)
