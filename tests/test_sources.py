import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ppopt.matching import Config
from ppopt.sources import draftkings, fanduel, prizepicks
from ppopt.progress import RunCancelled
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

    def __call__(self, url):
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


@pytest.mark.parametrize("age, refetched", [(55, False), (65, True)])
def test_the_odds_cache_keeps_a_response_for_one_minute(tmp_path, age, refetched):
    import os

    fetch = FakeFetch({"u": (200, b'{"a": 1}')})
    Http(tmp_path, fetch=fetch, sleep=lambda s: None).get_json("u")
    for f in tmp_path.glob("*.json"):
        os.utime(f, (time.time() - age, time.time() - age))
    Http(tmp_path, fetch=fetch, sleep=lambda s: None).get_json("u")
    assert len(fetch.calls) == (2 if refetched else 1)


def test_http_expired_cache_refetches(tmp_path):
    fetch = FakeFetch({"u": (200, b'{"a": 1}')})
    Http(tmp_path, fetch=fetch, sleep=lambda s: None).get_json("u")
    Http(tmp_path, ttl=-1, fetch=fetch, sleep=lambda s: None).get_json("u")
    assert len(fetch.calls) == 2


def test_http_delays_between_live_requests(tmp_path):
    slept = []
    fetch = FakeFetch({"a": (200, b"{}"), "b": (200, b"{}")})
    http = Http(tmp_path, fetch=fetch, sleep=slept.append, delay=(1, 2), clock=FakeClock())
    http.get_json("a")
    http.get_json("b")
    assert len(slept) == 1 and 1 <= slept[0] <= 2


def test_the_slow_pace_pauses_after_a_long_request_too(tmp_path):
    clock, slept = FakeClock(), []
    http = Http(tmp_path, fetch=slow_fetch(clock, seconds=2), sleep=lambda t: (slept.append(t), clock.sleep(t)),
                clock=clock, delay=(1, 1))
    http.get_json("https://pp.example/a")
    http.get_json("https://pp.example/b")
    assert slept == [1]  # the pause follows the 2 s request; it isn't swallowed by it


def test_http_paces_each_host_on_its_own(tmp_path):
    slept, clock = [], FakeClock()
    http = Http(tmp_path, fetch=lambda url: (200, b"{}"), sleep=slept.append, delay=(1, 1), clock=clock)
    for url in ["https://dk.example/a", "https://fd.example/a", "https://dk.example/b", "https://fd.example/b"]:
        http.get_json(url)
    assert slept == [1, 1]  # before each host's second request; a host's first request never waits on another's


def test_http_counts_live_requests_not_cache_hits(tmp_path):
    fetch = FakeFetch({"a": (200, b"{}"), "b": (200, b"{}")})
    http = Http(tmp_path, fetch=fetch, sleep=lambda s: None)
    assert http.live_requests == 0
    http.get_json("a")
    http.get_json("a")  # cache hit
    assert http.live_requests == 1
    again = Http(tmp_path, fetch=fetch, sleep=lambda s: None)
    again.get_json("a")
    assert again.live_requests == 0
    again.get_json("b")
    assert again.live_requests == 1


def test_http_no_cache_counts_every_request_live(tmp_path):
    fetch = FakeFetch({"a": (200, b"{}")})
    Http(tmp_path, fetch=fetch, sleep=lambda s: None).get_json("a")
    http = Http(tmp_path, use_cache=False, fetch=fetch, sleep=lambda s: None)
    http.get_json("a")
    http.get_json("a")
    assert http.live_requests == 2


def test_http_live_requests_is_read_only(tmp_path):
    with pytest.raises(AttributeError):
        Http(tmp_path).live_requests = 5


def test_http_count_live_records_a_request_made_outside_get_json(tmp_path):
    http = Http(tmp_path)
    http.count_live()
    assert http.live_requests == 1


class FakeClock:
    """Time that moves only when a request takes time or the run pauses."""

    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def slow_fetch(clock, seconds=0.5):
    def fetch(url):
        clock.sleep(seconds)
        return 200, b"{}"
    return fetch


def test_http_times_each_book_and_counts_its_live_requests(tmp_path):
    clock = FakeClock()
    http = Http(tmp_path, fetch=slow_fetch(clock), sleep=clock.sleep, clock=clock, delay=(1, 1))
    with http.for_book("draftkings") as dk:
        dk.get_json("https://dk.example/a")
        dk.get_json("https://dk.example/b")
    # 0.5 for the first, a 1 s pause after it, 0.5 for the second.
    assert http.timing == {"draftkings": {"requests": 2, "cached": 0, "failed": False, "rate_limited": False,
                                           "seconds": 2.0}}


def test_http_a_book_answered_from_the_odds_cache_made_no_live_requests(tmp_path):
    clock = FakeClock()
    Http(tmp_path, fetch=slow_fetch(clock), sleep=clock.sleep, clock=clock).get_json("https://dk.example/a")
    http = Http(tmp_path, fetch=slow_fetch(clock), sleep=clock.sleep, clock=clock)
    with http.for_book("draftkings") as dk:
        dk.get_json("https://dk.example/a")
    assert http.timing == {"draftkings": {"requests": 0, "cached": 1, "failed": False, "rate_limited": False,
                                           "seconds": 0.0}}


def test_http_records_a_book_that_failed(tmp_path):
    http = Http(tmp_path, fetch=lambda url: (403, b"{}"), sleep=lambda s: None)
    with pytest.raises(FetchError):
        with http.for_book("draftkings") as dk:
            dk.get_json("https://dk.example/a")
    assert http.timing["draftkings"]["failed"] is True


@pytest.mark.parametrize("resp", [(403, b'{"url": "captcha"}'), (200, b"<html>")])
def test_http_errors(tmp_path, resp):
    http = Http(tmp_path, fetch=FakeFetch({"u": resp}), sleep=lambda s: None)
    with pytest.raises(FetchError):
        http.get_json("u")


def test_parse_time_formats():
    assert parse_time("2026-10-23T00:15:00.0000000Z") == datetime(2026, 10, 23, 0, 15, tzinfo=timezone.utc)
    assert parse_time("2026-10-22T20:15:00.000-04:00") == datetime(2026, 10, 23, 0, 15, tzinfo=timezone.utc)


# --- prizepicks -------------------------------------------------------------

def test_http_without_the_cache_always_fetches_live_and_leaves_the_cache_alone(tmp_path):
    fetch = FakeFetch({"u": (200, b'{"a": 1}')})
    http = Http(tmp_path, fetch=fetch, sleep=lambda s: None)
    assert http.get_json("u", cache=False) == {"a": 1}
    assert http.get_json("u", cache=False) == {"a": 1}
    assert fetch.calls == ["u", "u"]
    assert list(tmp_path.iterdir()) == []


def test_http_without_the_cache_ignores_a_fresh_cached_answer(tmp_path):
    Http(tmp_path, fetch=FakeFetch({"u": (200, b'{"a": 1}')}), sleep=lambda s: None).get_json("u")
    fetch = FakeFetch({"u": (200, b'{"a": 2}')})
    assert Http(tmp_path, fetch=fetch, sleep=lambda s: None).get_json("u", cache=False) == {"a": 2}


def _board(body, status=200):
    fetch = FakeFetch({prizepicks.URL: (status, body)})
    return fetch, Http("/nonexistent-cache", fetch=fetch, sleep=lambda s: None)


def test_prizepicks_fetches_the_partner_feed():
    assert prizepicks.URL.startswith("https://partner-api.prizepicks.com/projections?")
    fetch, http = _board(json.dumps(load("pp_projections.json")).encode())
    assert prizepicks.fetch(http) == load("pp_projections.json")
    assert fetch.calls == [prizepicks.URL]


def test_prizepicks_fetch_bypasses_the_odds_cache():
    fetch, http = _board(b'{"data": [], "included": []}')
    prizepicks.fetch(http)
    prizepicks.fetch(http)
    assert fetch.calls == [prizepicks.URL, prizepicks.URL]


def test_prizepicks_keeps_the_app_feed_url_for_saving_by_hand():
    assert prizepicks.APP_URL == "https://api.prizepicks.com/projections?per_page=1000&single_stat=true&game_mode=pickem"


@pytest.mark.parametrize("body", [b'[]', b'{"errors": ["nope"]}', b'{"data": {}}', b'"data"', b'null'])
def test_prizepicks_fetch_rejects_anything_but_a_projections_feed(body):
    with pytest.raises(FetchError, match="not a PrizePicks projections feed"):
        prizepicks.fetch(_board(body)[1])


@pytest.mark.parametrize("status, body, reason", [
    (200, b"<html>blocked</html>", "non-JSON"),
    (403, b"{}", "HTTP 403"),
    (500, b"{}", "HTTP 500"),
])
def test_prizepicks_fetch_failures_are_fetch_errors(status, body, reason):
    with pytest.raises(FetchError, match=reason):
        prizepicks.fetch(_board(body, status)[1])


def test_the_live_fetch_is_plain_http():
    import inspect
    from ppopt.sources import http as http_module

    assert list(inspect.signature(http_module.scrapling_fetch).parameters) == ["url"]
    assert "StealthyFetcher" not in inspect.getsource(http_module)


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
    mapping = books["fanduel"]["sports"]["NFL"]["tabs"]["passing-props"]
    markets = fanduel.parse_event_markets(load("fd_event_passing.json"), "NFL", GAME, mapping)
    caleb = next(m for m in markets if m.player == "Caleb Williams" and m.stat == "pass_yards")
    assert (caleb.book, caleb.line, caleb.over_odds, caleb.under_odds) == ("fanduel", 243.5, -113, -113)
    tds = next(m for m in markets if m.player == "Caleb Williams" and m.stat == "pass_tds")
    assert (tds.line, tds.over_odds, tds.under_odds) == (1.5, -156, 120)
    # Alt "X+" ladders are one-sided and never become markets.
    assert all(m.two_sided for m in markets)
    assert len({(m.player, m.stat) for m in markets}) == len(markets)


# --- pacing: several requests in flight per book ------------------------------

import threading
import time


class Network:
    """A fake network that notes when each request starts and how many are in flight at once."""

    def __init__(self, seconds=0.05, status=None):
        self.seconds, self.status = seconds, status or (lambda url, n: (200, {}))
        self.lock, self.in_flight, self.peak, self.starts = threading.Lock(), 0, 0, []

    def __call__(self, url):
        with self.lock:
            self.in_flight += 1
            self.peak = max(self.peak, self.in_flight)
            self.starts.append((time.monotonic(), url))
            n = sum(u == url for _, u in self.starts)
        time.sleep(self.seconds)
        with self.lock:
            self.in_flight -= 1
        status, headers = self.status(url, n)
        return status, json.dumps({"url": url}).encode(), headers


URLS = [f"https://dk.example/{i}" for i in range(9)]


def test_a_paced_book_keeps_at_most_in_flight_requests_going_and_answers_in_order(tmp_path):
    net = Network()
    http = Http(tmp_path, fetch=net)
    with http.for_book("draftkings", pacing={"in_flight": 3, "min_gap": 0}) as dk:
        got = dk.get_many(URLS)
    assert got == [{"url": u} for u in URLS]
    assert net.peak == 3


def test_a_paced_book_starts_requests_at_least_min_gap_apart(tmp_path):
    net = Network(seconds=0.01)
    http = Http(tmp_path, fetch=net)
    with http.for_book("draftkings", pacing={"in_flight": 3, "min_gap": 0.05}) as dk:
        dk.get_many(URLS[:5])
    starts = sorted(t for t, _ in net.starts)
    assert min(b - a for a, b in zip(starts, starts[1:])) >= 0.045


def test_a_book_without_pacing_keeps_one_request_at_a_time_1_to_2_s_apart(tmp_path):
    clock, net = FakeClock(), Network(seconds=0)
    slept = []
    http = Http(tmp_path, fetch=net, sleep=lambda t: (slept.append(t), clock.sleep(t)), clock=clock)
    with http.for_book("draftkings") as dk:
        dk.get_many(URLS[:4])
    assert net.peak == 1 and len(slept) == 3 and all(0.9 <= s <= 2 for s in slept)


def test_a_cancelled_run_stops_the_rest_of_a_batch(tmp_path):
    from ppopt.progress import Progress, RunCancelled

    progress = Progress(lambda e: None)

    def cancel_on_first(url, n):
        progress.cancel()  # the browser went away while the first requests were in flight
        return 200, {}

    net = Network(status=cancel_on_first)
    http = Http(tmp_path, fetch=net, progress=progress)
    with pytest.raises(RunCancelled):
        with http.for_book("draftkings", pacing={"in_flight": 3, "min_gap": 0}) as dk:
            dk.get_many(URLS)
    assert len(net.starts) <= 3


# --- a book that pushes back is rate-limited ------------------------------------

def limits_first(url_to_limit, status=429, retry_after=None, times=1):
    """A book that pushes back on one URL's first `times` requests."""
    def respond(url, n):
        if url == url_to_limit and n <= times:
            return status, {"Retry-After": retry_after} if retry_after is not None else {}
        return 200, {}
    return respond


@pytest.mark.parametrize("asked, delay", [("0.3", (0.01, 0.01)), (None, (0.3, 0.3))])
def test_a_book_that_pushes_back_holds_every_request_until_the_wait_is_over(tmp_path, asked, delay):
    net = Network(seconds=0.02, status=limits_first(URLS[0], retry_after=asked))
    http = Http(tmp_path, fetch=net, delay=delay)
    with http.for_book("draftkings", pacing={"in_flight": 3, "min_gap": 0}) as dk:
        got = dk.get_many(URLS)
    assert got == [{"url": u} for u in URLS]
    assert http.timing["draftkings"]["rate_limited"] is True
    refused = min(t for t, u in net.starts if u == URLS[0]) + 0.02
    # Requests already admitted as the refusal landed are under way; nothing else may go out during the wait.
    later = sorted(t for t, _ in net.starts if t > refused + 0.015)
    assert later and later[0] >= refused + 0.3 - 0.02
    # Then one at a time, pausing after each: a start comes a request (0.02 s) plus a pause after the last.
    assert all(b - a >= 0.02 + delay[0] - 0.005 for a, b in zip(later, later[1:]))


def test_a_stopped_run_cuts_a_back_off_wait_short(tmp_path):
    from ppopt.progress import RunCancelled

    net = Network(seconds=0, status=limits_first(URLS[0], retry_after="5"))
    http = Http(tmp_path, fetch=net)
    threading.Timer(0.1, http.stop).start()  # the other book broke while this one waited
    began = time.monotonic()
    with pytest.raises(RunCancelled):
        with http.for_book("draftkings", pacing={"in_flight": 1, "min_gap": 0}) as dk:
            dk.get_many(URLS[:1])
    assert time.monotonic() - began < 1 and len(net.starts) == 1


def run_book(tmp_path, respond, urls=URLS[:1]):
    net = Network(seconds=0, status=respond)
    http = Http(tmp_path, fetch=net, delay=(0, 0), sleep=lambda t: None)
    with http.for_book("draftkings", pacing={"in_flight": 3, "min_gap": 0}) as dk:
        dk.get_many(urls)
    return http, net


def test_a_book_that_rate_limits_twice_fails_naming_the_rate_limit(tmp_path):
    with pytest.raises(FetchError, match="^rate-limited: HTTP 429 .* again after backing off"):
        run_book(tmp_path, limits_first(URLS[0], status=429, times=2))


def test_a_book_that_refuses_twice_is_blocked_not_rate_limited(tmp_path):
    with pytest.raises(FetchError, match=r"^refused: HTTP 403 from \S+ \(blocked, or off a US connection\)$"):
        run_book(tmp_path, limits_first(URLS[0], status=403, times=2))


def test_a_book_that_refused_once_then_answered_was_not_rate_limited(tmp_path):
    http, net = run_book(tmp_path, limits_first(URLS[0], status=403))
    assert len(net.starts) == 2 and http.timing["draftkings"]["rate_limited"] is False


def test_a_retry_that_fails_otherwise_says_how(tmp_path):
    def respond(url, n):
        return (429, {}) if n == 1 else (500, {})

    with pytest.raises(FetchError, match="^HTTP 500 from"):
        run_book(tmp_path, respond)


def test_a_book_asking_for_a_long_wait_fails_at_once(tmp_path):
    net, slept = Network(seconds=0, status=limits_first(URLS[0], retry_after="60")), []
    http = Http(tmp_path, fetch=net, delay=(0, 0), sleep=slept.append)
    with pytest.raises(FetchError, match="rate-limited: HTTP 429 .* asked to wait 60s"):
        with http.for_book("draftkings", pacing={"in_flight": 3, "min_gap": 0}) as dk:
            dk.get_many(URLS[:1])
    assert len(net.starts) == 1 and 60 not in slept


def test_a_request_made_by_no_book_is_not_retried(tmp_path):
    net = Network(seconds=0, status=limits_first("https://pp.example/board", status=403))
    with pytest.raises(FetchError, match="^HTTP 403"):
        Http(tmp_path, fetch=net, sleep=lambda t: None).get_json("https://pp.example/board")
    assert len(net.starts) == 1


def test_a_slowed_book_stays_slowed_when_handed_a_view_again(tmp_path):
    net = Network(seconds=0.02, status=limits_first(URLS[0]))
    http = Http(tmp_path, fetch=net, delay=(0, 0))
    pacing = {"in_flight": 3, "min_gap": 0}
    with http.for_book("draftkings", pacing) as dk:
        dk.get_many(URLS[:1])  # pushed back, so now one at a time
    net.peak = 0
    with http.for_book("draftkings", pacing) as dk:
        dk.get_many(URLS[1:])
    assert net.peak == 1


def test_a_network_error_fetching_the_board_is_a_fetch_failure(tmp_path):
    def fetch(url):
        raise ConnectionResetError("connection reset by peer")

    with pytest.raises(FetchError, match="connection reset by peer"):
        prizepicks.fetch(Http(tmp_path, fetch=fetch, sleep=lambda s: None))


def test_a_cancelled_run_is_not_a_board_fetch_failure(tmp_path):
    http = Http(tmp_path, fetch=lambda url: (200, b'{"data": []}'), sleep=lambda s: None)
    http.stop()
    with pytest.raises(RunCancelled):
        prizepicks.fetch(http)
