import json
from datetime import datetime, timezone
from pathlib import Path

from ppopt.matching import Config
from ppopt.progress import Progress
from ppopt.sources import draftkings, fanduel
from ppopt.sources.http import Http

ROOT = Path(__file__).resolve().parents[1]
FIX = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 10, 22, 19, 0, tzinfo=timezone.utc)
GAME = frozenset({"CHI", "NE"})


def events():
    seen = []
    return seen, Progress(seen.append)


def test_progress_counts_requests_against_the_plan():
    seen, p = events()
    p.plan("draftkings", "NFL", 3)
    p.plan("fanduel", "NFL", 2)
    p.book("draftkings", "NFL")
    p.tick()
    assert seen[-1] == {"done": 1, "total": 5, "step": "DraftKings NFL"}


def test_the_step_names_every_book_still_fetching():
    seen, p = events()
    p.book("draftkings", "NHL")
    p.book("fanduel", "NBA")
    p.tick("draftkings")
    assert seen[-1]["step"] == "DraftKings NHL · FanDuel NBA"
    p.book("draftkings", "NBA")
    p.tick("fanduel")
    assert seen[-1]["step"] == "DraftKings NBA · FanDuel NBA"
    p.finish("draftkings")
    p.tick("fanduel")
    assert seen[-1]["step"] == "FanDuel NBA"


def test_ticks_count_toward_the_book_that_made_the_request():
    seen, p = events()
    p.plan("draftkings", "NFL", 10)
    p.plan("fanduel", "NFL", 10)
    p.book("draftkings", "NFL")
    p.book("fanduel", "NFL")
    p.tick("draftkings")
    p.tick("fanduel")
    p.tick("fanduel")
    p.close("fanduel")  # fanduel failed after its 2 requests: its plan shrinks to those
    assert seen[-1]["total"] == 10 + 2


def test_a_revised_plan_replaces_the_estimate():
    seen, p = events()
    p.plan("fanduel", "NBA", 13)
    p.plan("fanduel", "NBA", 7)
    assert seen[-1]["total"] == 7


def test_total_never_falls_below_done():
    seen, p = events()
    p.plan("draftkings", "NFL", 1)
    p.tick()
    p.tick()
    assert seen[-1]["done"] == 2 and seen[-1]["total"] == 2


def test_a_failed_book_drops_its_unfinished_requests():
    seen, p = events()
    p.plan("draftkings", "NFL", 10)
    p.plan("fanduel", "NFL", 4)
    p.book("draftkings", "NFL")
    p.tick("draftkings")
    p.close("draftkings")
    assert seen[-1]["total"] == 1 + 4 and seen[-1]["done"] == 1


def test_finishing_reports_the_final_step():
    seen, p = events()
    p.plan("draftkings", "NFL", 2)
    p.step("Pricing lines and building slips")
    assert seen[-1]["step"] == "Pricing lines and building slips"


def test_http_ticks_progress_on_live_and_cached_requests(tmp_path):
    seen, p = events()
    fetch = lambda url, browser=False: (200, b'{"a": 1}')
    Http(tmp_path, fetch=fetch, sleep=lambda s: None, progress=p).get_json("u")
    Http(tmp_path, fetch=fetch, sleep=lambda s: None, progress=p).get_json("u")  # cache hit
    assert [e["done"] for e in seen] == [1, 2]


# --- each collector's plan matches the requests it actually makes -------------------

class FakeHttp:
    def __init__(self, routes, progress):
        self.routes, self.progress, self.calls = routes, progress, []

    def get_json(self, url, browser=False):
        self.calls.append(url)
        self.progress.tick()
        for needle, name in self.routes:
            if needle in url:
                return json.loads((FIX / name).read_text())
        raise AssertionError(url)


def books():
    return json.loads((ROOT / "books.json").read_text())


def every_stat(book, sport="NFL"):
    """Board needs for one game that wants every stat the book prices in `sport`."""
    conf = books()[book]["sports"][sport]
    if book == "draftkings":
        return {(sport, GAME): set(conf["subcategories"].values())}
    return {(sport, GAME): {stat for tab in conf["tabs"].values() for stat in tab.values()}}


def test_draftkings_plans_exactly_the_requests_it_makes():
    seen, p = events()
    http = FakeHttp([("/subcategories/", "dk_subcat_pass_yards.json"), ("/leagues/", "dk_league_nfl.json")], p)
    draftkings.collect(http, Config.load(ROOT), books()["draftkings"], ["NFL"], NOW, 24,
                       needs=every_stat("draftkings"))
    assert len(http.calls) > 1
    assert p.planned[("draftkings", "NFL")] == len(http.calls)


def test_fanduel_plans_exactly_the_requests_it_makes():
    seen, p = events()
    http = FakeHttp([("event-page", "fd_event_passing.json"), ("content-managed-page", "fd_league_nfl.json")], p)
    fanduel.collect(http, Config.load(ROOT), books()["fanduel"], ["NFL"], NOW, 24, needs=every_stat("fanduel"))
    assert len(http.calls) > 1
    assert p.planned[("fanduel", "NFL")] == len(http.calls)


# --- a book with games in the window but no props posted says so ---------------------

class Fixtures(FakeHttp):
    def __init__(self, routes, overrides=None):
        super().__init__(routes, Progress(lambda e: None))
        self.overrides = overrides or {}

    def get_json(self, url, browser=False):
        data = super().get_json(url, browser)
        for needle, change in self.overrides.items():
            if needle in url:
                return change(data)
        return data


DK_ROUTES = [("/subcategories/", "dk_subcat_pass_yards.json"), ("/leagues/", "dk_league_nfl.json")]
FD_ROUTES = [("event-page", "fd_event_passing.json"), ("content-managed-page", "fd_league_nfl.json")]


def test_draftkings_quiet_when_props_are_posted():
    warnings = []
    markets = draftkings.collect(Fixtures(DK_ROUTES), Config.load(ROOT), books()["draftkings"], ["NFL"], NOW, 24,
                                 warnings=warnings, needs=every_stat("draftkings"))
    assert markets and warnings == []


def test_draftkings_warns_when_games_have_no_props_posted():
    warnings = []
    no_props = {"/leagues/": lambda d: {**d, "subcategories": []}}
    draftkings.collect(Fixtures(DK_ROUTES, no_props), Config.load(ROOT), books()["draftkings"], ["NFL"], NOW, 24,
                       warnings=warnings, needs=every_stat("draftkings"))
    assert warnings == ["DraftKings has no NFL player props posted yet for 1 game in the window"]


def test_fanduel_warns_when_games_have_no_props_posted():
    warnings = []
    no_props = {"event-page": lambda d: {"attachments": {}}}
    fanduel.collect(Fixtures(FD_ROUTES, no_props), Config.load(ROOT), books()["fanduel"], ["NFL"], NOW, 24,
                    needs=every_stat("fanduel"), warnings=warnings)
    assert warnings == ["FanDuel has no NFL player props posted yet for 1 game in the window"]


def test_fanduel_quiet_when_props_are_posted():
    warnings = []
    markets = fanduel.collect(Fixtures(FD_ROUTES), Config.load(ROOT), books()["fanduel"], ["NFL"], NOW, 24,
                              needs=every_stat("fanduel"), warnings=warnings)
    assert markets and warnings == []


def test_a_cancelled_run_stops_at_its_next_request():
    import pytest

    from ppopt.progress import RunCancelled

    p = Progress(lambda e: None)
    p.tick()
    p.cancel()
    with pytest.raises(RunCancelled):
        p.tick()


# --- a run fetches only what the board can use --------------------------------------

def test_draftkings_requests_only_subcategories_for_stats_on_the_board():
    http = Fixtures(DK_ROUTES)
    draftkings.collect(http, Config.load(ROOT), books()["draftkings"], ["NFL"], NOW, 24,
                       needs={("NFL", GAME): {"rec_yards", "receptions"}})
    assert http.calls[1:] == [
        "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1/leagues/88808/categories/1342/subcategories/14114",
        "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1/leagues/88808/categories/1342/subcategories/14115",
    ]


def test_fanduel_requests_only_the_tabs_holding_each_games_stats():
    http = Fixtures(FD_ROUTES)
    fanduel.collect(http, Config.load(ROOT), books()["fanduel"], ["NFL"], NOW, 24,
                    needs={("NFL", GAME): {"rec_yards", "rush_rec_yards"}})
    assert [url.split("&tab=")[1] for url in http.calls[1:]] == ["receiving-props"]


def test_fanduel_skips_games_the_board_does_not_need():
    http = Fixtures(FD_ROUTES)
    fanduel.collect(http, Config.load(ROOT), books()["fanduel"], ["NFL"], NOW, 24,
                    needs={("NFL", frozenset({"KC", "BUF"})): {"rec_yards"}})
    assert len(http.calls) == 1  # the league page only


def test_draftkings_skips_and_does_not_warn_about_games_the_board_does_not_need():
    http, warnings = Fixtures(DK_ROUTES, {"/leagues/": lambda d: {**d, "subcategories": []}}), []
    draftkings.collect(http, Config.load(ROOT), books()["draftkings"], ["NFL"], NOW, 24, warnings=warnings,
                       needs={("NFL", frozenset({"KC", "BUF"})): {"rec_yards"}})
    assert len(http.calls) == 1 and warnings == []
