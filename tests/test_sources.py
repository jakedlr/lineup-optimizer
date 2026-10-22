import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ppopt.matching import Config
from ppopt.sources import draftkings, fanduel, prizepicks
from ppopt.sources.http import FetchError, Http, parse_time

ROOT = Path(__file__).resolve().parents[1]
FIX = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 10, 22, 19, 0, tzinfo=timezone.utc)  # 3pm ET on the sample day
GAME = frozenset({"CHI", "NE"})


def load(name):
    return json.loads((FIX / name).read_text())


@pytest.fixture(scope="module")
def cfg():
    return Config.load(ROOT)


@pytest.fixture(scope="module")
def books():
    return json.loads((ROOT / "books.json").read_text())


# --- http -------------------------------------------------------------------

class FakeFetch:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, url, browser=False):
        self.calls.append(url)
        return self.responses[url]


def test_http_caches_responses(tmp_path):
    fetch = FakeFetch({"u": (200, b'{"a": 1}')})
    http = Http(tmp_path, fetch=fetch, sleep=lambda s: None)
    assert http.get_json("u") == {"a": 1}
    assert Http(tmp_path, fetch=fetch, sleep=lambda s: None).get_json("u") == {"a": 1}
    assert fetch.calls == ["u"]


def test_http_no_cache_refetches(tmp_path):
    fetch = FakeFetch({"u": (200, b'{"a": 1}')})
    Http(tmp_path, fetch=fetch, sleep=lambda s: None).get_json("u")
    Http(tmp_path, use_cache=False, fetch=fetch, sleep=lambda s: None).get_json("u")
    assert fetch.calls == ["u", "u"]


def test_http_expired_cache_refetches(tmp_path):
    fetch = FakeFetch({"u": (200, b'{"a": 1}')})
    Http(tmp_path, fetch=fetch, sleep=lambda s: None).get_json("u")
    Http(tmp_path, ttl=-1, fetch=fetch, sleep=lambda s: None).get_json("u")
    assert len(fetch.calls) == 2


def test_http_delays_between_live_requests(tmp_path):
    slept = []
    fetch = FakeFetch({"a": (200, b"{}"), "b": (200, b"{}")})
    http = Http(tmp_path, fetch=fetch, sleep=slept.append, delay=(1, 2))
    http.get_json("a")
    http.get_json("b")
    assert len(slept) == 1 and 1 <= slept[0] <= 2


@pytest.mark.parametrize("resp", [(403, b'{"url": "captcha"}'), (200, b"<html>")])
def test_http_errors(tmp_path, resp):
    http = Http(tmp_path, fetch=FakeFetch({"u": resp}), sleep=lambda s: None)
    with pytest.raises(FetchError):
        http.get_json("u")


def test_parse_time_formats():
    assert parse_time("2026-10-23T00:15:00.0000000Z") == datetime(2026, 10, 23, 0, 15, tzinfo=timezone.utc)
    assert parse_time("2026-10-22T20:15:00.000-04:00") == datetime(2026, 10, 23, 0, 15, tzinfo=timezone.utc)


# --- prizepicks -------------------------------------------------------------

def test_prizepicks_parses_standard_lines(cfg):
    lines, promos = prizepicks.parse_projections(load("pp_projections.json"), cfg, ["NFL", "NBA"], NOW, 24)
    by = {(l.player, l.raw_stat): l for l in lines}
    maye = by[("Drake Maye", "Pass Yards")]
    assert maye.sport == "NFL" and maye.teams == GAME
    assert maye.stat == "pass_yards" and maye.line == 249.5
    assert maye.start_time == datetime(2026, 10, 23, 0, 15, tzinfo=timezone.utc)
    assert ("Joel Embiid", "Pts+Rebs+Asts") in by


def test_prizepicks_excludes_goblins_combos_and_other_sports(cfg):
    lines, _ = prizepicks.parse_projections(load("pp_projections.json"), cfg, ["NFL", "NBA"], NOW, 24)
    assert all(l.odds_type == "standard" for l in lines)
    assert not any("+" in l.player for l in lines)  # combos
    assert {l.sport for l in lines} == {"NFL", "NBA"}


def test_prizepicks_sport_filter(cfg):
    lines, promos = prizepicks.parse_projections(load("pp_projections.json"), cfg, ["NBA"], NOW, 24)
    assert {l.sport for l in lines} == {"NBA"} and promos == []


def test_prizepicks_time_window(cfg):
    lines, _ = prizepicks.parse_projections(load("pp_projections.json"), cfg, ["NFL", "NBA"], NOW, 5)
    assert {l.sport for l in lines} == {"NBA"}  # NBA 7pm ET is 4h away, NFL 8:15pm ET is 5.25h


def test_prizepicks_taco_promo_becomes_promo_leg(cfg):
    lines, promos = prizepicks.parse_projections(load("pp_projections.json"), cfg, ["NFL"], NOW, 24)
    [taco] = promos
    assert (taco.player, taco.stat, taco.line, taco.side, taco.promo_type) == (
        "Caleb Williams", "pass_yards", 215.5, "over", "taco")
    assert taco.teams == GAME
    assert not any(l.player == "Caleb Williams" and l.stat == "pass_yards" for l in lines)


def test_prizepicks_over_only_sides(cfg):
    payload = load("pp_projections.json")
    for p in payload["data"]:
        if p["id"] == "15900665":
            p["attributes"]["allowed_wager_types"] = "over"
    lines, _ = prizepicks.parse_projections(payload, cfg, ["NFL"], NOW, 24)
    maye = next(l for l in lines if l.player == "Drake Maye" and l.raw_stat == "Pass Yards")
    assert maye.sides == ("over",)


# --- draftkings -------------------------------------------------------------

def test_draftkings_subcategory_lookup(books):
    ids = draftkings.subcategory_ids(load("dk_league_nfl.json"), books["draftkings"]["sports"]["NFL"]["subcategories"])
    assert ids["pass_yards"] == (1000, 9524)
    assert ids["rec_yards"] == (1342, 14114)


def test_draftkings_events_in_window(cfg):
    events = draftkings.events_in_window(load("dk_league_nfl.json"), cfg, "NFL", NOW, 24)
    assert events == {"34118033": GAME}


def test_draftkings_parse_markets(cfg):
    markets = draftkings.parse_markets(load("dk_subcat_pass_yards.json"), "NFL", "pass_yards", {"34118033": GAME})
    caleb = next(m for m in markets if m.player == "Caleb Williams")
    assert (caleb.book, caleb.sport, caleb.teams, caleb.stat) == ("draftkings", "NFL", GAME, "pass_yards")
    assert (caleb.line, caleb.over_odds, caleb.under_odds) == (246.5, -111, -113)


def test_draftkings_skips_events_outside_window():
    assert draftkings.parse_markets(load("dk_subcat_pass_yards.json"), "NFL", "pass_yards", {}) == []


# --- fanduel ----------------------------------------------------------------

def test_fanduel_events_skip_futures_and_window(cfg):
    events = fanduel.parse_events(load("fd_league_nfl.json"), cfg, "NFL", NOW, 24)
    assert events == {"36190129": GAME}


def test_fanduel_events_strip_pitchers(cfg):
    events = fanduel.parse_events(load("fd_league_mlb.json"), cfg, "MLB", NOW, 48)
    assert list(events.values()) == [frozenset({"TB", "MIL"})]


def test_fanduel_market_key():
    assert fanduel.market_key("PLAYER_X_PASSING_YARDS_HIGH") == "PLAYER_PASSING_YARDS"
    assert fanduel.market_key("PLAYER_C_TOTAL_POINTS_+_REB_+_AST") == "PLAYER_TOTAL_POINTS_+_REB_+_AST"
    assert fanduel.market_key("PITCHER_D_TOTAL_STRIKEOUTS") == "PITCHER_TOTAL_STRIKEOUTS"
    assert fanduel.market_key("PLAYER_TOTAL_SHOTS") == "PLAYER_TOTAL_SHOTS"


def test_fanduel_parse_event_markets(books):
    mapping = books["fanduel"]["sports"]["NFL"]["markets"]
    markets = fanduel.parse_event_markets(load("fd_event_passing.json"), "NFL", GAME, mapping)
    caleb = next(m for m in markets if m.player == "Caleb Williams" and m.stat == "pass_yards")
    assert (caleb.book, caleb.line, caleb.over_odds, caleb.under_odds) == ("fanduel", 243.5, -113, -113)
    tds = next(m for m in markets if m.player == "Caleb Williams" and m.stat == "pass_tds")
    assert (tds.line, tds.over_odds, tds.under_odds) == (1.5, -156, 120)
    # Alt "X+" ladders are one-sided and never become markets.
    assert all(m.two_sided for m in markets)
    assert len({(m.player, m.stat) for m in markets}) == len(markets)
