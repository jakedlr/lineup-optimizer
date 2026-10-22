"""getOdds: rank PrizePicks legs and slips by EV against devigged sportsbook odds."""

import argparse
import json
import re
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .matching import Config, game_id, parse_promo_leg
from .odds import DEVIG_METHODS
from .payouts import break_even, load_payouts
from .pricing import PromoError, price_lines, price_promo
from .slips import best_slips
from .sources import draftkings, fanduel, prizepicks
from .sources.http import FetchError, Http

ROOT = Path(__file__).resolve().parents[2]
SPORTS = ["NFL", "NBA", "NHL", "MLB"]
BOOK_ABBR = {"draftkings": "DK", "fanduel": "FD"}
STALE_MINUTES = 30


class UserError(Exception):
    """A problem the user can fix; printed without a traceback."""


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --- arguments ---------------------------------------------------------------

def _boost(value: str) -> float:
    x = float(value)
    if x <= 1:
        raise argparse.ArgumentTypeError("boost must be greater than 1 (e.g. 1.4)")
    return x


def _positive(value: str) -> float:
    x = float(value)
    if x <= 0:
        raise argparse.ArgumentTypeError("must be greater than 0")
    return x


def _ref_slip(value: str) -> tuple[str, int]:
    m = re.fullmatch(r"(power|flex)([2-6])", value.lower())
    if not m:
        raise argparse.ArgumentTypeError("use e.g. power2, flex6")
    return m[1], int(m[2])


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="getOdds",
        description="Rank PrizePicks legs and slips by expected value using devigged FanDuel/DraftKings odds.",
    )
    src = p.add_argument_group("data")
    src.add_argument("--sports", type=lambda s: [x.strip().upper() for x in s.split(",") if x.strip()],
                     default=SPORTS, help="comma-separated leagues (default: NFL,NBA,NHL,MLB)")
    src.add_argument("--hours", type=_positive, default=24, help="only games starting within this many hours (default: 24)")
    src.add_argument("--pp-file", type=Path, help="PrizePicks projections JSON saved from your browser")
    src.add_argument("--no-cache", action="store_true", help="ignore cached responses and fetch fresh odds")

    price = p.add_argument_group("pricing")
    price.add_argument("--devig", choices=DEVIG_METHODS, default="multiplicative", help="vig removal method (default: multiplicative)")
    price.add_argument("--stake", type=_positive, default=10.0, help="entry amount in dollars (default: 10)")
    price.add_argument("--payouts", type=Path, help="alternative payouts.json")

    promo = p.add_argument_group("promotions (only one kind per run)")
    excl = promo.add_mutually_exclusive_group()
    excl.add_argument("--bonus", action="store_true", help="free/bonus entry: stake is not returned (Power slips only)")
    excl.add_argument("--boost", type=_boost, help="lineup payout boost, e.g. 1.4")
    excl.add_argument("--promoLeg", "--promo-leg", dest="promo_legs", nargs=4, action="append", default=[],
                      metavar=("SPORT", "GAME", "PLAYER", "PICK"),
                      help='promo leg, e.g. NFL "CHI vs NE" "Caleb Williams" "Over 215.5 Pass Yards" (repeatable)')
    promo.add_argument("--no-promos", action="store_true", help="ignore promo lines found in the PrizePicks feed")

    out = p.add_argument_group("output")
    out.add_argument("--type", choices=["power", "flex"], help="only show this slip type")
    out.add_argument("--size", type=int, choices=range(2, 7), metavar="{2..6}", help="only show this slip size")
    out.add_argument("--ref-slip", type=_ref_slip, help="slip whose break-even sets each leg's edge, e.g. flex6 (default: lowest break-even)")
    out.add_argument("--top", type=int, default=25, help="number of legs to show (default: 25)")
    out.add_argument("--json", action="store_true", help="print machine-readable JSON")
    out.add_argument("-v", "--verbose", action="store_true", help="list PrizePicks lines that could not be priced")
    return p.parse_args(argv)


# --- core --------------------------------------------------------------------

def _leg_dict(leg, cfg: Config) -> dict:
    return {
        "sport": leg.sport,
        "game": leg.game_id,
        "player": leg.player,
        "side": leg.side,
        "line": leg.line,
        "stat": leg.stat,
        "stat_label": cfg.stat_label(leg.sport, leg.stat),
        "prob": leg.prob,
        "books": dict(leg.book_probs),
        "disagreement": leg.disagreement,
        "promo_type": leg.promo_type,
        "modelled": leg.modelled,
    }


def run(args: argparse.Namespace, root: Path, payload: dict, markets: list, now: datetime) -> dict:
    """Price everything and build the report. Raises UserError for fixable input problems."""
    cfg = Config.load(root)
    table = load_payouts(args.payouts or root / "payouts.json")
    warnings = []

    lines, feed_promos = prizepicks.parse_projections(payload, cfg, args.sports, now, args.hours)
    if feed_promos and (args.bonus or args.boost):
        warnings.append(f"ignored {len(feed_promos)} feed promo line(s): only one promotion is allowed per lineup")
        feed_promos = []
    elif args.no_promos:
        feed_promos = []

    try:
        manual = [parse_promo_leg(values, cfg) for values in args.promo_legs]
    except ValueError as e:
        raise UserError(f"--promoLeg: {e}") from e

    legs, unmatched = price_lines(lines, markets, cfg, args.devig)
    for promo in manual:
        try:
            legs.append(price_promo(promo, markets, cfg, args.devig))
        except PromoError as e:
            raise UserError(f"--promoLeg {promo.player}: {e}") from e
    for promo in feed_promos:
        try:
            legs.append(price_promo(promo, markets, cfg, args.devig))
        except PromoError as e:
            warnings.append(f"skipped {promo.promo_type} promo {promo.player}: {e}")

    legs.sort(key=lambda l: l.prob, reverse=True)

    # Edge reference: a cash entry (boost applied); bonus mode is Power-only.
    slip_types = ["power"] if args.bonus else list(table)
    if args.ref_slip:
        ref_type, ref_size = args.ref_slip
        if ref_size not in table.get(ref_type, {}):
            raise UserError(f"--ref-slip {ref_type}{ref_size} is not in the payout table")
    else:
        ref_type, ref_size = min(
            ((t, n) for t in slip_types for n in table[t]),
            key=lambda ts: break_even(table[ts[0]][ts[1]], ts[1], args.boost),
        )
    ref_be = break_even(table[ref_type][ref_size], ref_size, args.boost)

    seen_games, leg_rows = set(), []
    for leg in legs:
        row = _leg_dict(leg, cfg)
        row["edge"] = leg.prob - ref_be
        row["same_game"] = leg.game_id in seen_games
        seen_games.add(leg.game_id)
        leg_rows.append(row)

    slips = best_slips(
        legs, table, args.stake, bonus=args.bonus, boost=args.boost,
        types=[args.type] if args.type else None, sizes=[args.size] if args.size else None,
    )

    return {
        "settings": {
            "sports": args.sports, "hours": args.hours, "stake": args.stake, "devig": args.devig,
            "mode": "bonus" if args.bonus else f"boost {args.boost}x" if args.boost else "cash",
        },
        "ref_slip": {"type": ref_type, "size": ref_size, "break_even": ref_be},
        "legs": leg_rows,
        "slips": [
            {"type": s.slip_type, "size": s.size, "ev": s.ev, "ev_pct": s.ev_pct,
             "legs": [_leg_dict(l, cfg) for l in s.legs]}
            for s in slips
        ],
        "unmatched": dict(Counter(reason for _, reason in unmatched)),
        "unmatched_lines": [
            {"sport": l.sport, "player": l.player, "stat": l.raw_stat, "line": l.line, "reason": r}
            for l, r in unmatched
        ],
        "warnings": warnings,
    }


# --- I/O ---------------------------------------------------------------------

def collect_markets(http: Http, cfg: Config, books: dict, sports, now, hours, wanted_games) -> tuple[list, list[str]]:
    """Fetch every book; a failing book becomes a warning, not a crash."""
    markets, warnings = [], []
    for name, collect in (("draftkings", draftkings.collect), ("fanduel", fanduel.collect)):
        try:
            kwargs = {"wanted_games": wanted_games} if name == "fanduel" else {}
            markets += collect(http, cfg, books[name], sports, now, hours, **kwargs)
        except (FetchError, KeyError, ValueError) as e:
            warnings.append(f"{name} unavailable: {e}")
    return markets, warnings


def load_prizepicks(args, http: Http) -> tuple[dict, list[str]]:
    if args.pp_file:
        if not args.pp_file.exists():
            raise UserError(f"--pp-file {args.pp_file} not found")
        warnings = []
        age = (time.time() - args.pp_file.stat().st_mtime) / 60
        if age > STALE_MINUTES:
            warnings.append(f"{args.pp_file} is {age:.0f} minutes old; PrizePicks lines may have moved")
        return json.loads(args.pp_file.read_text()), warnings
    try:
        return prizepicks.fetch(http), []
    except FetchError as e:
        raise UserError(
            f"could not fetch PrizePicks ({e}); it blocks automated requests.\n"
            "Save the board from your logged-in browser and pass it with --pp-file:\n"
            f"  {prizepicks.URL}\n"
            "  -> Ctrl+S -> samples/projections.json, then: ./getOdds --pp-file samples/projections.json"
        ) from e


def _pct(x: float) -> str:
    return f"{x * 100:5.1f}%"


def _pick(row: dict) -> str:
    side = "Over" if row["side"] == "over" else "Under"
    return f"{side} {row['line']:g} {row['stat_label']}"


def format_report(report: dict, top: int, verbose: bool) -> str:
    s, ref = report["settings"], report["ref_slip"]
    out = [
        f"Stake ${s['stake']:g} | {s['mode']} | devig {s['devig']} | {','.join(s['sports'])} next {s['hours']:g}h",
        f"Edge vs {ref['type']}{ref['size']} break-even {_pct(ref['break_even']).strip()} per leg",
        "",
        f"TOP LEGS ({min(top, len(report['legs']))} of {len(report['legs'])})",
        f"{'#':>3}  {'Prob':>6}  {'Edge':>6}  {'Sport':<5}  {'Player':<24}  {'Pick':<34}  {'Books':<18}  Notes",
    ]
    for i, row in enumerate(report["legs"][:top], 1):
        books = " ".join(f"{BOOK_ABBR.get(b, b)} {p * 100:.1f}" for b, p in sorted(row["books"].items()))
        notes = []
        if row["promo_type"]:
            notes.append(row["promo_type"] + (" (modelled)" if row["modelled"] else ""))
        if row["same_game"]:
            notes.append("same game")
        if row["disagreement"] >= 0.03:
            notes.append(f"books differ {row['disagreement'] * 100:.1f}pts")
        out.append(f"{i:>3}  {_pct(row['prob'])}  {row['edge'] * 100:+5.1f}%  {row['sport']:<5}  "
                   f"{row['player'][:24]:<24}  {_pick(row)[:34]:<34}  {books:<18}  {', '.join(notes)}")

    out += ["", "BEST SLIPS (one leg per game)"]
    if not report["slips"]:
        out.append("  none: not enough distinct games")
    for slip in report["slips"]:
        out.append(f"  {slip['type'].title()} {slip['size']}: EV ${slip['ev']:+.2f} ({slip['ev_pct'] * 100:+.1f}%)")
        for leg in slip["legs"]:
            tag = f"  [{leg['promo_type']}]" if leg["promo_type"] else ""
            out.append(f"      {_pct(leg['prob'])}  {leg['player']} - {_pick(leg)}{tag}")

    if report["unmatched"]:
        counts = ", ".join(f"{n} {r}" for r, n in sorted(report["unmatched"].items(), key=lambda x: -x[1]))
        out += ["", f"Unpriced PrizePicks lines: {counts}" + ("" if verbose else " (-v to list)")]
        if verbose:
            for u in report["unmatched_lines"]:
                out.append(f"  {u['sport']:<4} {u['player']:<24} {u['stat']:<22} {u['line']:<7g} {u['reason']}")
    for w in report["warnings"]:
        out.append(f"warning: {w}")
    return "\n".join(out)


def main(argv: list[str] | None = None, root: Path = ROOT) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    now = utcnow()
    cfg = Config.load(root)
    http = Http(root / ".cache", use_cache=not args.no_cache)
    try:
        payload, warnings = load_prizepicks(args, http)
        lines, promos = prizepicks.parse_projections(payload, cfg, args.sports, now, args.hours)
        wanted = {l.teams for l in lines} | {p.teams for p in promos}
        try:
            wanted |= {parse_promo_leg(v, cfg).teams for v in args.promo_legs}
        except ValueError as e:
            raise UserError(f"--promoLeg: {e}") from e
        books = json.loads((root / "books.json").read_text())
        markets, book_warnings = collect_markets(http, cfg, books, args.sports, now, args.hours, wanted)
        if not markets:
            raise UserError("no sportsbook odds available: " + "; ".join(book_warnings or ["no markets in window"]))
        report = run(args, root, payload, markets, now)
    except UserError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    report["warnings"] = warnings + book_warnings + report["warnings"]

    print(json.dumps(report, indent=2) if args.json else format_report(report, args.top, args.verbose))
    return 0


if __name__ == "__main__":
    sys.exit(main())
