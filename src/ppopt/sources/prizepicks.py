"""PrizePicks projections feed (JSON:API format)."""

from datetime import datetime

from ..matching import Config
from ..models import PPLine, PromoLeg
from .http import Http, in_window, parse_time

URL = "https://api.prizepicks.com/projections?per_page=1000&single_stat=true&game_mode=pickem"


def fetch(http: Http) -> dict:
    """Fetch the board. PrizePicks sits behind DataDome, so this uses a stealth browser."""
    return http.get_json(URL, browser=True)


def _teams(projection: dict, included: dict, cfg: Config, sport: str) -> frozenset[str] | None:
    game_ref = projection["relationships"].get("game", {}).get("data")
    game = included.get(("game", game_ref["id"])) if game_ref else None
    info = (game or {}).get("attributes", {}).get("metadata", {}).get("game_info", {}).get("teams")
    if not info:
        return None
    teams = {cfg.resolve_team(sport, info[side]["abbreviation"]) for side in ("home", "away")}
    return frozenset(teams) if None not in teams and len(teams) == 2 else None


def parse_projections(
    payload: dict, cfg: Config, sports: list[str], now: datetime, hours: float
) -> tuple[list[PPLine], list[PromoLeg]]:
    """Upcoming single-player projections in `sports`.

    Goblins, demons and multi-player combos are dropped. Promo projections (e.g.
    tacos) are returned as PromoLegs at their discounted line instead of as lines.
    """
    included = {(i["type"], i["id"]): i for i in payload.get("included", [])}
    leagues = {i["id"]: i["attributes"]["name"] for i in payload.get("included", []) if i["type"] == "league"}
    lines, promos = [], []

    for p in payload["data"]:
        a = p["attributes"]
        sport = leagues.get(p["relationships"]["league"]["data"]["id"])
        if sport not in sports or a.get("odds_type") != "standard" or a.get("event_type") == "combo":
            continue
        if a.get("in_game") or a.get("status") not in (None, "pre_game"):
            continue
        start = parse_time(a["start_time"])
        if not in_window(start, now, hours):
            continue
        teams = _teams(p, included, cfg, sport)
        if teams is None:
            continue
        player_ref = p["relationships"]["new_player"]["data"]
        player = included[("new_player", player_ref["id"])]["attributes"]["name"]
        stat = cfg.pp_stat(sport, a["stat_type"])
        sides = ("over",) if a.get("allowed_wager_types") == "over" else ("over", "under")

        promo_line = a.get("flash_sale_line_score")
        if a.get("is_promo") and promo_line is not None:
            if stat is None:
                continue
            side = "over" if promo_line < a["line_score"] else "under"
            if side in sides:
                promos.append(PromoLeg(sport, teams, player, stat, float(promo_line), side,
                                       promo_type=a.get("discount_name") or "promo"))
            continue

        lines.append(PPLine(
            sport=sport,
            teams=teams,
            player=player,
            stat=stat,
            line=float(a["line_score"]),
            odds_type=a["odds_type"],
            raw_stat=a["stat_type"],
            sides=sides,
            start_time=start,
        ))
    return lines, promos
