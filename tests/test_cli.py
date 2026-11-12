import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ppopt import cli
from ppopt.models import BookMarket

ROOT = Path(__file__).resolve().parents[1]
FIX = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 10, 22, 19, 0, tzinfo=timezone.utc)
CHI_NE = frozenset({"CHI", "NE"})
PHI_CLE = frozenset({"PHI", "CLE"})


def pp_payload():
    return json.loads((FIX / "pp_projections.json").read_text())


def markets():
    return [
        BookMarket("draftkings", "NFL", CHI_NE, "Drake Maye", "pass_yards", 249.5, -125, -105),
        BookMarket("fanduel", "NFL", CHI_NE, "Drake Maye", "pass_yards", 249.5, -120, -110),
        BookMarket("draftkings", "NFL", CHI_NE, "Caleb Williams", "pass_yards", 246.5, -111, -113),
        BookMarket("draftkings", "NFL", CHI_NE, "Caleb Williams", "pass_rush_yards", 266.5, -115, -105),
        BookMarket("draftkings", "NBA", PHI_CLE, "Joel Embiid", "pts_rebs_asts", 35.5, -130, 100),
        BookMarket("draftkings", "NBA", PHI_CLE, "Tyrese Maxey", "pts_rebs_asts", 32.5, -105, -115),
    ]


def run(argv):
    args = cli.parse_args(argv)
    return cli.run(args, ROOT, pp_payload(), markets(), NOW)


# --- argument parsing --------------------------------------------------------

def test_defaults():
    args = cli.parse_args([])
    assert args.sports == ["NFL", "NBA", "NHL", "MLB"]
    assert (args.hours, args.stake, args.devig) == (24, 10.0, "worst")
    assert not args.bonus and args.boost is None and args.promo_legs == []


@pytest.mark.parametrize("method", ["worst", "multiplicative", "additive", "power", "shin"])
def test_every_devig_method_is_selectable(method):
    assert cli.parse_args(["--devig", method]).devig == method


def test_sports_are_comma_separated_and_uppercased():
    assert cli.parse_args(["--sports", "nba,nfl"]).sports == ["NBA", "NFL"]


def test_promo_leg_is_repeatable_with_alias():
    args = cli.parse_args([
        "--promoLeg", "NFL", "CHI vs NE", "Caleb Williams", "Over 215.5 Pass Yards",
        "--promo-leg", "NBA", "PHI vs CLE", "Joel Embiid", "Over 30.5 Pts+Rebs+Asts",
    ])
    assert len(args.promo_legs) == 2


@pytest.mark.parametrize("argv", [
    ["--bonus", "--boost", "1.4"],
    ["--bonus", "--promoLeg", "NFL", "CHI vs NE", "X", "Over 1.5 Pass TDs"],
    ["--boost", "1.4", "--promoLeg", "NFL", "CHI vs NE", "X", "Over 1.5 Pass TDs"],
])
def test_promotions_are_mutually_exclusive(argv, capsys):
    with pytest.raises(SystemExit):
        cli.parse_args(argv)
    assert "not allowed with" in capsys.readouterr().err


@pytest.mark.parametrize("argv", [["--boost", "0.9"], ["--stake", "0"], ["--size", "7"], ["--ref-slip", "power9"]])
def test_rejects_bad_values(argv):
    with pytest.raises(SystemExit):
        cli.parse_args(argv)


# --- run ---------------------------------------------------------------------

def test_run_ranks_legs_by_probability():
    report = run([])
    probs = [l["prob"] for l in report["legs"]]
    assert probs == sorted(probs, reverse=True)
    assert {l["player"] for l in report["legs"]} >= {"Drake Maye", "Joel Embiid"}


def test_feed_promo_included_by_default():
    report = run([])
    taco = [l for l in report["legs"] if l["promo_type"] == "taco"]
    assert len(taco) == 1 and taco[0]["modelled"] and taco[0]["line"] == 215.5


@pytest.mark.parametrize("argv", [["--no-promos"], ["--bonus"], ["--boost", "1.4"]])
def test_feed_promos_disabled(argv):
    report = run(argv)
    assert not any(l["promo_type"] for l in report["legs"])
    assert any("promo" in w for w in report["warnings"]) or argv == ["--no-promos"]


def test_same_game_legs_flagged_not_hidden():
    report = run(["--no-promos"])
    nfl = [l for l in report["legs"] if l["sport"] == "NFL"]
    assert len(nfl) >= 2
    assert [l["same_game"] for l in nfl] == [False] + [True] * (len(nfl) - 1)


def test_slips_one_leg_per_game():
    report = run([])
    for slip in report["slips"]:
        games = [l["game"] for l in slip["legs"]]
        assert len(games) == len(set(games))
        assert sum(bool(l["promo_type"]) for l in slip["legs"]) <= 1


def test_slips_sorted_and_filtered():
    report = run(["--type", "power"])
    assert report["slips"] and all(s["type"] == "power" for s in report["slips"])
    evs = [s["ev"] for s in report["slips"]]
    assert evs == sorted(evs, reverse=True)
    assert [s["size"] for s in run(["--size", "2"])["slips"]] == [2, 2]


def test_bonus_has_no_flex_slips():
    report = run(["--bonus"])
    assert all(s["type"] == "power" for s in report["slips"])


def test_ref_slip_and_edge():
    report = run(["--ref-slip", "power2"])
    assert report["ref_slip"]["type"] == "power" and report["ref_slip"]["size"] == 2
    leg = report["legs"][0]
    assert leg["edge"] == pytest.approx(leg["prob"] - report["ref_slip"]["break_even"])


def test_default_ref_slip_is_lowest_break_even():
    report = run([])
    from ppopt.payouts import break_even, load_payouts

    table = load_payouts(ROOT / "payouts.json")
    lowest = min(break_even(t, n) for by in table.values() for n, t in by.items())
    assert report["ref_slip"]["break_even"] == pytest.approx(lowest)


def test_manual_promo_leg_priced():
    report = run(["--promoLeg", "NBA", "PHI vs CLE", "Joel Embiid", "Over 30.5 Pts+Rebs+Asts"])
    manual = [l for l in report["legs"] if l["promo_type"] == "manual"]
    assert len(manual) == 1 and manual[0]["prob"] > 0.6


def test_manual_promo_leg_unpriceable_is_an_error():
    with pytest.raises(cli.UserError, match="Nobody"):
        run(["--promoLeg", "NFL", "CHI vs NE", "Nobody", "Over 200.5 Pass Yards"])


def test_unmatched_counts_reported():
    report = run([])
    assert sum(report["unmatched"].values()) > 0


def test_main_json_output(tmp_path, capsys, monkeypatch):
    pp_file = tmp_path / "pp.json"
    pp_file.write_text(json.dumps(pp_payload()))
    monkeypatch.setattr(cli, "collect_markets", lambda *a, **k: (markets(), []))
    monkeypatch.setattr(cli, "utcnow", lambda: NOW)
    assert cli.main(["--pp-file", str(pp_file), "--json"], root=ROOT) == 0
    out = json.loads(capsys.readouterr().out)
    assert {"legs", "slips", "ref_slip", "unmatched", "warnings"} <= set(out)


def test_main_table_output(tmp_path, capsys, monkeypatch):
    pp_file = tmp_path / "pp.json"
    pp_file.write_text(json.dumps(pp_payload()))
    monkeypatch.setattr(cli, "collect_markets", lambda *a, **k: (markets(), []))
    monkeypatch.setattr(cli, "utcnow", lambda: NOW)
    assert cli.main(["--pp-file", str(pp_file)], root=ROOT) == 0
    out = capsys.readouterr().out
    assert "Drake Maye" in out and "BEST SLIPS" in out and "taco" in out
    top_legs, best_slips = out.split("BEST SLIPS")
    assert "CHI vs NE" in top_legs and "CHI vs NE" in best_slips


def _row(sport, game, player, line, stat_label, prob, promo_type=""):
    return {
        "sport": sport, "game": game, "player": player, "side": "over", "line": line,
        "stat_label": stat_label, "prob": prob, "books": {"draftkings": prob}, "disagreement": 0.0,
        "promo_type": promo_type, "modelled": False, "edge": 0.05, "same_game": False,
    }


def test_format_report_shows_sport_and_matchup():
    maye = _row("NFL", "NFL:CHI-NE", "Drake Maye", 249.5, "Pass Yards", 0.623, promo_type="taco")
    embiid = _row("NBA", "NBA:CLE-PHI", "Joel Embiid", 35.5, "Pts+Rebs+Asts", 0.581)
    report = {
        "settings": {"sports": ["NFL", "NBA"], "hours": 24, "stake": 10.0, "devig": "multiplicative", "mode": "cash"},
        "ref_slip": {"type": "power", "size": 2, "break_even": 0.573},
        "legs": [maye, embiid],
        "slips": [{"type": "power", "size": 2, "ev": 1.23, "ev_pct": 0.123, "legs": [maye, embiid]}],
        "unmatched": {}, "unmatched_lines": [], "warnings": [],
    }
    lines = cli.format_report(report, top=25, verbose=False).splitlines()

    header = next(l for l in lines if l.lstrip().startswith("#"))
    row = next(l for l in lines if l.lstrip().startswith("1 "))
    assert header.index("Sport") < header.index("Matchup") < header.index("Player")
    assert row.index("NFL") == header.index("Sport")
    assert row.index("CHI vs NE") == header.index("Matchup")
    assert row.index("Drake Maye") == header.index("Player")

    slip_legs = lines[lines.index("  Power 2: EV $+1.23 (+12.3%)") + 1:][:2]
    assert slip_legs == [
        "       62.3%  NFL   CHI vs NE   Drake Maye - Over 249.5 Pass Yards  [taco]",
        "       58.1%  NBA   CLE vs PHI  Joel Embiid - Over 35.5 Pts+Rebs+Asts",
    ]


def test_main_reports_user_errors(capsys, monkeypatch, tmp_path):
    pp_file = tmp_path / "pp.json"
    pp_file.write_text(json.dumps(pp_payload()))
    monkeypatch.setattr(cli, "collect_markets", lambda *a, **k: (markets(), []))
    monkeypatch.setattr(cli, "utcnow", lambda: NOW)
    code = cli.main(["--pp-file", str(pp_file), "--promoLeg", "NFL", "CHI vs XYZ", "A", "Over 1.5 Pass TDs"], root=ROOT)
    assert code == 2
    assert "XYZ" in capsys.readouterr().err


def test_legs_carry_a_matchup_label():
    report = run([])
    maye = next(l for l in report["legs"] if l["player"] == "Drake Maye")
    assert maye["matchup"] == "CHI vs NE"
    assert all("matchup" in l for s in report["slips"] for l in s["legs"])


def test_report_for_collects_markets_for_the_board_and_merges_warnings():
    seen = {}

    def collect(http, cfg, books, sports, now, hours, wanted):
        seen["wanted"] = wanted
        return markets(), ["fanduel unavailable: test"]

    args = cli.parse_args([])
    report = cli.report_for(args, ROOT, pp_payload(), http=None, now=NOW, collect=collect)
    assert seen["wanted"] == {("NFL", CHI_NE): {"pass_yards", "pass_rush_yards"}, ("NBA", PHI_CLE): {"pts_rebs_asts"}}
    assert "fanduel unavailable: test" in report["warnings"]
    assert report["legs"]


def test_report_for_without_any_odds_is_a_user_error():
    args = cli.parse_args([])
    with pytest.raises(cli.UserError, match="no sportsbook odds"):
        cli.report_for(args, ROOT, pp_payload(), http=None, now=NOW, collect=lambda *a: ([], ["x down"]))


def test_report_for_a_board_with_no_games_in_the_window_says_so_without_fetching():
    def collect(*a):
        raise AssertionError("should not fetch odds")

    args = cli.parse_args([])
    later = datetime(2026, 11, 2, 19, 0, tzinfo=timezone.utc)  # every fixture game has started
    with pytest.raises(cli.UserError, match="no PrizePicks games start in the next 24 hours"):
        cli.report_for(args, ROOT, pp_payload(), http=None, now=later, collect=collect)


# --- progress ----------------------------------------------------------------

from types import SimpleNamespace

from ppopt.progress import Progress


def test_report_for_estimates_requests_from_the_board_before_fetching():
    seen = []
    http = SimpleNamespace(progress=Progress(seen.append))
    snapshot = {}
    collect = lambda h, *a: (snapshot.update(seen[-1]), (markets(), []))[1]
    cli.report_for(cli.parse_args([]), ROOT, pp_payload(), http=http, now=NOW, collect=collect)

    # The board needs NFL pass yards + pass+rush yards (CHI-NE) and NBA pts+rebs+asts (CLE-PHI); one league page each.
    dk = (1 + 2) + (1 + 1) + 1 + 1  # a subcategory per needed stat
    fd = (1 + 1) + (1 + 1) + 1 + 1  # NFL passing-props (FD has no pass+rush), NBA player-combos
    assert snapshot == {"done": 0, "total": dk + fd, "step": "Fetching sportsbook odds"}
    assert seen[0] == snapshot  # the estimate goes out as one event, not one per league
    assert seen[-1]["step"] == "Pricing lines and building slips"


def test_a_failing_book_is_closed_out_of_the_progress(monkeypatch, tmp_path):
    from ppopt.sources.http import FetchError, Http

    p = Progress(lambda e: None)
    http = Http(tmp_path, progress=p)

    def broken(http, *a, **k):
        http.progress.book("draftkings", "NFL")
        http.progress.tick("draftkings")
        raise FetchError("HTTP 403")

    monkeypatch.setattr(cli.draftkings, "collect", broken)
    monkeypatch.setattr(cli.fanduel, "collect", lambda *a, **k: [])
    p.plan("draftkings", "NFL", 15)
    cli.collect_markets(http, None, {"draftkings": {}, "fanduel": {}}, ["NFL"], NOW, 24, set())
    assert p.planned == {("draftkings", "*"): 1}


def test_collect_markets_passes_on_book_warnings(monkeypatch, tmp_path):
    from ppopt.sources.http import Http

    def dk(http, cfg, conf, sports, now, hours, warnings, needs):
        warnings.append("DraftKings has no NHL player props posted yet for 2 games in the window")
        return []

    monkeypatch.setattr(cli.draftkings, "collect", dk)
    monkeypatch.setattr(cli.fanduel, "collect", lambda *a, **k: [])
    _, warnings = cli.collect_markets(Http(tmp_path), None, {"draftkings": {}, "fanduel": {}}, ["NHL"], NOW, 24, set())
    assert warnings == ["DraftKings has no NHL player props posted yet for 2 games in the window"]


# --- review fixes --------------------------------------------------------------

def test_no_games_in_window_message_fits_cli_and_app():
    later = datetime(2026, 11, 2, 19, 0, tzinfo=timezone.utc)
    with pytest.raises(cli.UserError) as e:
        cli.report_for(cli.parse_args(["--sports", "NHL"]), ROOT, pp_payload(), http=None, now=later,
                       collect=lambda *a: (_ for _ in ()).throw(AssertionError("no fetch")))
    msg = str(e.value)
    assert "no PrizePicks games start in the next 24 hours in NHL" in msg
    assert "more hours" in msg and "fresh board" in msg


@pytest.mark.parametrize("argv", [["--no-promos"], ["--bonus"], ["--boost", "1.4"]])
def test_games_with_only_dropped_feed_promos_are_not_fetched(argv):
    payload = pp_payload()
    # Keep only the taco promo projection: its game then has nothing but a feed promo.
    payload["data"] = [p for p in payload["data"] if p["attributes"].get("is_promo")]
    assert payload["data"]
    with pytest.raises(cli.UserError, match="no PrizePicks games"):
        cli.report_for(cli.parse_args(argv), ROOT, payload, http=None, now=NOW,
                       collect=lambda *a: (_ for _ in ()).throw(AssertionError("fetched a promo-only game")))


def test_report_for_parses_the_board_once(monkeypatch):
    calls = []
    real = cli.prizepicks.parse_projections
    monkeypatch.setattr(cli.prizepicks, "parse_projections", lambda *a, **k: calls.append(1) or real(*a, **k))
    cli.report_for(cli.parse_args([]), ROOT, pp_payload(), http=None, now=NOW, collect=lambda *a: (markets(), []))
    assert len(calls) == 1


def test_promo_leg_errors_name_the_leg_not_the_cli_flag():
    with pytest.raises(cli.UserError) as e:
        run(["--promoLeg", "NFL", "CHI vs NE", "Nobody", "Over 200.5 Pass Yards"])
    assert str(e.value).startswith("promo leg Nobody:")


# --- live requests -------------------------------------------------------------

def _fetching_collect(http, *a):
    http.get_json("https://book.test/odds")
    return markets(), []


def test_report_counts_live_sportsbook_requests_and_a_cached_rerun_counts_none(tmp_path):
    from ppopt.sources.http import Http

    fetch = lambda url, browser=False: (200, b"{}")
    args = cli.parse_args([])
    first = cli.report_for(args, ROOT, pp_payload(), Http(tmp_path, fetch=fetch), NOW, collect=_fetching_collect)
    second = cli.report_for(args, ROOT, pp_payload(), Http(tmp_path, fetch=fetch), NOW, collect=_fetching_collect)
    assert first["live_requests"] == 1
    assert second["live_requests"] == 0


def test_no_cache_report_counts_every_request_live(tmp_path):
    from ppopt.sources.http import Http

    fetch = lambda url, browser=False: (200, b"{}")
    args = cli.parse_args(["--no-cache"])
    cli.report_for(args, ROOT, pp_payload(), Http(tmp_path, fetch=fetch), NOW, collect=_fetching_collect)
    http = Http(tmp_path, use_cache=not args.no_cache, fetch=fetch)
    assert cli.report_for(args, ROOT, pp_payload(), http, NOW, collect=_fetching_collect)["live_requests"] == 1


def test_live_requests_leave_out_the_prizepicks_fetch(tmp_path):
    from ppopt.sources.http import Http

    http = Http(tmp_path, fetch=lambda url, browser=False: (200, b"{}"), sleep=lambda s: None)
    http.get_json("https://prizepicks.test/projections")  # the board, fetched before pricing
    report = cli.report_for(cli.parse_args([]), ROOT, pp_payload(), http, NOW, collect=_fetching_collect)
    assert report["live_requests"] == 1


def test_main_json_output_carries_live_requests(tmp_path, capsys, monkeypatch):
    pp_file = tmp_path / "pp.json"
    pp_file.write_text(json.dumps(pp_payload()))
    monkeypatch.setattr(cli, "collect_markets", lambda *a, **k: (markets(), []))
    monkeypatch.setattr(cli, "utcnow", lambda: NOW)
    assert cli.main(["--pp-file", str(pp_file), "--json"], root=ROOT) == 0
    assert json.loads(capsys.readouterr().out)["live_requests"] == 0


# --- timing --------------------------------------------------------------------

class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def test_report_carries_how_long_the_run_took():
    clock = Clock()

    def collect(*a):
        clock.now += 3.0  # fetching the books
        return markets(), []

    report = cli.report_for(cli.parse_args([]), ROOT, pp_payload(), http=None, now=NOW, collect=collect, clock=clock)
    assert report["timing"] == {"seconds": 3.0, "books": {}, "summary": "Run took 3.0s"}


def test_each_book_is_timed_with_its_own_live_requests(monkeypatch, tmp_path):
    from ppopt.sources.http import Http

    def fetching(*urls):
        def collect(http, *a, **k):
            for url in urls:
                http.get_json(url)
            return []
        return collect

    monkeypatch.setattr(cli.draftkings, "collect", fetching("https://dk.example/a", "https://dk.example/b"))
    monkeypatch.setattr(cli.fanduel, "collect", fetching("https://fd.example/a"))
    http = Http(tmp_path, fetch=lambda url, browser=False: (200, b"{}"), sleep=lambda s: None)
    cli.collect_markets(http, None, {"draftkings": {}, "fanduel": {}}, ["NFL"], NOW, 24, set())
    assert {book: t["requests"] for book, t in http.timing.items()} == {"draftkings": 2, "fanduel": 1}


def test_format_report_ends_with_the_run_timing():
    report = {
        "settings": {"sports": ["NFL"], "hours": 24, "stake": 10.0, "devig": "worst", "mode": "cash"},
        "ref_slip": {"type": "power", "size": 2, "break_even": 0.573},
        "legs": [], "slips": [], "unmatched": {}, "unmatched_lines": [], "warnings": [],
        "timing": {"seconds": 1.0, "books": {}, "summary": "Run took 1.0s"},
    }
    assert cli.format_report(report, top=25, verbose=False).splitlines()[-1] == "Run took 1.0s"


def test_timing_names_each_books_live_requests_or_the_odds_cache():
    timing = {"seconds": 92.44, "books": {
        "draftkings": {"requests": 41, "cached": 0, "failed": False, "seconds": 40.08},
        "fanduel": {"requests": 0, "cached": 12, "failed": False, "seconds": 0.02}}}
    assert cli.format_timing(timing) == "Run took 92.4s: DraftKings 41 live requests in 40.1s, FanDuel from the odds cache"


def test_timing_says_request_for_a_single_live_request():
    timing = {"seconds": 2.0, "books": {"fanduel": {"requests": 1, "cached": 0, "failed": False, "seconds": 1.0}}}
    assert cli.format_timing(timing) == "Run took 2.0s: FanDuel 1 live request in 1.0s"


def test_a_manual_promo_legs_stat_is_fetched_too():
    seen = {}

    def collect(http, cfg, books, sports, now, hours, needs):
        seen["needs"] = needs
        return markets(), []

    args = cli.parse_args(["--promoLeg", "NFL", "CHI vs NE", "Caleb Williams", "Over 1.5 Pass TDs"])
    with pytest.raises(cli.UserError):  # no book prices pass TDs in markets(); the needs are what matter here
        cli.report_for(args, ROOT, pp_payload(), http=None, now=NOW, collect=collect)
    assert seen["needs"][("NFL", CHI_NE)] == {"pass_yards", "pass_rush_yards", "pass_tds"}


def test_collect_markets_gives_both_books_the_board_needs(monkeypatch, tmp_path):
    from ppopt.sources.http import Http

    seen = {}
    monkeypatch.setattr(cli.draftkings, "collect", lambda *a, needs, **k: seen.setdefault("draftkings", needs) and [])
    monkeypatch.setattr(cli.fanduel, "collect", lambda *a, needs, **k: seen.setdefault("fanduel", needs) and [])
    needs = {("NFL", CHI_NE): {"pass_yards"}}
    cli.collect_markets(Http(tmp_path), None, {"draftkings": {}, "fanduel": {}}, ["NFL"], NOW, 24, needs)
    assert seen == {"draftkings": needs, "fanduel": needs}


# --- books fetch in parallel ----------------------------------------------------

import threading


def test_both_books_fetch_at_the_same_time(monkeypatch, tmp_path):
    from ppopt.sources.http import Http

    started = {"draftkings": threading.Event(), "fanduel": threading.Event()}

    def book(name, other, market):
        def collect(*a, **k):
            started[name].set()
            assert started[other].wait(2), f"{other} didn't start while {name} was fetching"
            return [market]
        return collect

    dk, fd = markets()[0], markets()[1]
    monkeypatch.setattr(cli.draftkings, "collect", book("draftkings", "fanduel", dk))
    monkeypatch.setattr(cli.fanduel, "collect", book("fanduel", "draftkings", fd))
    got, _ = cli.collect_markets(Http(tmp_path), None, {"draftkings": {}, "fanduel": {}}, ["NFL"], NOW, 24, {})
    assert got == [dk, fd]


def test_a_cancelled_run_stops_every_book(monkeypatch, tmp_path):
    from ppopt.progress import RunCancelled
    from ppopt.sources.http import Http

    def cancelled(*a, **k):
        raise RunCancelled()

    monkeypatch.setattr(cli.draftkings, "collect", cancelled)
    monkeypatch.setattr(cli.fanduel, "collect", cancelled)
    with pytest.raises(RunCancelled):
        cli.collect_markets(Http(tmp_path), None, {"draftkings": {}, "fanduel": {}}, ["NFL"], NOW, 24, {})


def test_a_board_of_only_unmapped_stats_reports_them_unpriced_without_fetching():
    payload = pp_payload()
    for p in payload["data"]:
        p["attributes"]["stat_type"] = "Fantasy Score"  # no book prices it
    report = cli.report_for(cli.parse_args([]), ROOT, payload, http=None, now=NOW,
                            collect=lambda *a: (_ for _ in ()).throw(AssertionError("nothing to fetch")))
    assert report["legs"] == [] and report["unmatched"]


@pytest.mark.parametrize("book, words", [
    ({"requests": 0, "cached": 0, "failed": True, "seconds": 0.4}, "DraftKings unavailable"),
    ({"requests": 3, "cached": 0, "failed": True, "seconds": 5.1}, "DraftKings unavailable after 3 live requests"),
    ({"requests": 0, "cached": 0, "failed": False, "seconds": 0.0}, "DraftKings made no requests"),
])
def test_timing_does_not_call_a_failed_or_idle_book_cached(book, words):
    assert cli.format_timing({"seconds": 1.0, "books": {"draftkings": book}}) == f"Run took 1.0s: {words}"


def test_timing_lists_books_in_book_order_whichever_finishes_first(monkeypatch, tmp_path):
    import time

    from ppopt.sources.http import Http

    http = Http(tmp_path)

    def dk(*a, **k):
        deadline = time.monotonic() + 2
        while "fanduel" not in http.timing:  # finish only after FanDuel has
            assert time.monotonic() < deadline, "FanDuel never finished"
            time.sleep(0.01)
        return []

    monkeypatch.setattr(cli.draftkings, "collect", dk)
    monkeypatch.setattr(cli.fanduel, "collect", lambda *a, **k: [])
    cli.collect_markets(http, None, {"draftkings": {}, "fanduel": {}}, ["NFL"], NOW, 24, {})
    assert list(http.timing) == ["draftkings", "fanduel"]


def test_a_book_that_breaks_stops_the_other_at_its_next_request(monkeypatch, tmp_path):
    import time

    from ppopt.sources.http import Http

    def broken(*a, **k):
        raise TypeError("a bug in the DraftKings parser")

    def busy(http, *a, **k):
        for i in range(1000):
            http.get_json(f"https://fd.example/{i}")
        return []

    def fetch(url, browser=False):
        time.sleep(0.001)
        return 200, b"{}"

    monkeypatch.setattr(cli.draftkings, "collect", broken)
    monkeypatch.setattr(cli.fanduel, "collect", busy)
    http = Http(tmp_path, fetch=fetch, sleep=lambda s: None)
    with pytest.raises(TypeError):
        cli.collect_markets(http, None, {"draftkings": {}, "fanduel": {}}, ["NFL"], NOW, 24, {})
    assert http.live_requests < 1000


def test_the_breaking_books_error_surfaces_not_the_stop_it_caused(monkeypatch, tmp_path):
    from ppopt.sources.http import Http

    def busy(http, *a, **k):
        for i in range(1000):
            http.get_json(f"https://dk.example/{i}")
        return []

    def broken(*a, **k):
        raise TypeError("a bug in the FanDuel parser")

    def fetch(url, browser=False):
        import time
        time.sleep(0.001)
        return 200, b"{}"

    monkeypatch.setattr(cli.draftkings, "collect", busy)
    monkeypatch.setattr(cli.fanduel, "collect", broken)
    with pytest.raises(TypeError):
        cli.collect_markets(Http(tmp_path, fetch=fetch, sleep=lambda s: None), None,
                            {"draftkings": {}, "fanduel": {}}, ["NFL"], NOW, 24, {})


# --- each book is paced as books.json says ------------------------------------------

class InFlight:
    """A fake network counting the most requests in flight at once; `limit` URLs get one 429 first."""

    def __init__(self, limit=()):
        self.lock, self.now, self.peak, self.limit, self.seen = threading.Lock(), 0, 0, set(limit), set()

    def __call__(self, url, browser=False):
        import time
        with self.lock:
            self.now += 1
            self.peak = max(self.peak, self.now)
            first = url not in self.seen
            self.seen.add(url)
        time.sleep(0.03)
        with self.lock:
            self.now -= 1
        return (429 if url in self.limit and first else 200), b"{}", {}


def batch(*urls):
    def collect(http, *a, **k):
        http.get_many(list(urls))
        return []
    return collect


def test_each_book_is_paced_by_its_own_books_json_entry(monkeypatch, tmp_path):
    from ppopt.sources.http import Http

    dk_net = InFlight()
    monkeypatch.setattr(cli.draftkings, "collect", batch(*[f"https://dk.example/{i}" for i in range(6)]))
    monkeypatch.setattr(cli.fanduel, "collect", lambda *a, **k: [])
    books = {"draftkings": {"pacing": {"in_flight": 2, "min_gap": 0}}, "fanduel": {}}
    cli.collect_markets(Http(tmp_path, fetch=dk_net), None, books, ["NFL"], NOW, 24, {})
    assert dk_net.peak == 2


def test_a_book_that_was_rate_limited_but_recovered_says_so(monkeypatch, tmp_path):
    from ppopt.sources.http import Http

    net = InFlight(limit={"https://dk.example/0"})
    monkeypatch.setattr(cli.draftkings, "collect", batch("https://dk.example/0", "https://dk.example/1"))
    monkeypatch.setattr(cli.fanduel, "collect", lambda *a, **k: [])
    books = {"draftkings": {"pacing": {"in_flight": 3, "min_gap": 0}}, "fanduel": {}}
    http = Http(tmp_path, fetch=net, delay=(0, 0))
    _, warnings = cli.collect_markets(http, None, books, ["NFL"], NOW, 24, {})
    assert warnings == ["DraftKings rate-limited the run, so it finished one request at a time; "
                        "lower its pacing in books.json"]
