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
    assert (args.hours, args.stake, args.devig) == (24, 10.0, "multiplicative")
    assert not args.bonus and args.boost is None and args.promo_legs == []


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


def test_main_reports_user_errors(capsys, monkeypatch, tmp_path):
    pp_file = tmp_path / "pp.json"
    pp_file.write_text(json.dumps(pp_payload()))
    monkeypatch.setattr(cli, "collect_markets", lambda *a, **k: (markets(), []))
    monkeypatch.setattr(cli, "utcnow", lambda: NOW)
    code = cli.main(["--pp-file", str(pp_file), "--promoLeg", "NFL", "CHI vs XYZ", "A", "Over 1.5 Pass TDs"], root=ROOT)
    assert code == 2
    assert "XYZ" in capsys.readouterr().err
