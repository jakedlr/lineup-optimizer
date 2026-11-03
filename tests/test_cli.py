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
    assert CHI_NE in seen["wanted"]
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

    books = json.loads((ROOT / "books.json").read_text())
    games = {"NFL": 1, "NBA": 1, "NHL": 0, "MLB": 0}  # games on the fixture board
    dk = sum(1 + (len(books["draftkings"]["sports"][s]["subcategories"]) if n else 0) for s, n in games.items())
    fd = sum(1 + n * len(books["fanduel"]["sports"][s]["tabs"]) for s, n in games.items())
    assert snapshot == {"done": 0, "total": dk + fd, "step": "Fetching sportsbook odds"}
    assert seen[0] == snapshot  # the estimate goes out as one event, not one per league
    assert seen[-1]["step"] == "Pricing lines and building slips"


def test_a_failing_book_is_closed_out_of_the_progress(monkeypatch):
    from ppopt.sources.http import FetchError

    p = Progress(lambda e: None)
    http = SimpleNamespace(progress=p)

    def broken(http, *a, **k):
        http.progress.book("draftkings", "NFL")
        http.progress.tick()
        raise FetchError("HTTP 403")

    monkeypatch.setattr(cli.draftkings, "collect", broken)
    monkeypatch.setattr(cli.fanduel, "collect", lambda *a, **k: [])
    p.plan("draftkings", "NFL", 15)
    cli.collect_markets(http, None, {"draftkings": {}, "fanduel": {}}, ["NFL"], NOW, 24, set())
    assert p.planned == {("draftkings", "*"): 1}


def test_collect_markets_passes_on_book_warnings(monkeypatch):
    def dk(http, cfg, conf, sports, now, hours, warnings):
        warnings.append("DraftKings has no NHL player props posted yet for 2 games in the window")
        return []

    monkeypatch.setattr(cli.draftkings, "collect", dk)
    monkeypatch.setattr(cli.fanduel, "collect", lambda *a, **k: [])
    _, warnings = cli.collect_markets(None, None, {"draftkings": {}, "fanduel": {}}, ["NHL"], NOW, 24, set())
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
