"""DraftKings internal sportscontent API.

One league request lists events and subcategories; one request per O/U
subcategory then returns that stat's lines for every event in the league.
"""

from datetime import datetime

from ..matching import Config
from ..models import BookMarket
from .http import Http, in_window, parse_time

BASE = "https://sportsbook-nash.draftkings.com/api/sportscontent/dkus{state}/v1/leagues/{league}"


def _american(text: str) -> float:
    return float(text.replace("−", "-").replace("+", ""))


def subcategory_ids(league: dict, names: dict[str, str]) -> dict[str, tuple[int, int]]:
    """{canonical stat: (category id, subcategory id)} for configured subcategory names."""
    out = {}
    for sub in league.get("subcategories", []):
        stat = names.get(sub["name"])
        if stat:
            out[stat] = (sub["categoryId"], sub["id"])
    return out


def _event_teams(event: dict, cfg: Config, sport: str) -> frozenset[str] | None:
    parts = event["name"].split(" @ ")
    if len(parts) != 2:
        return None
    teams = {cfg.resolve_team(sport, part) for part in parts}
    return frozenset(teams) if None not in teams and len(teams) == 2 else None


def events_in_window(league: dict, cfg: Config, sport: str, now: datetime, hours: float) -> dict[str, frozenset[str]]:
    """{event id: teams} for games starting within the window."""
    out = {}
    for event in league.get("events", []):
        if not in_window(parse_time(event["startEventDate"]), now, hours):
            continue
        teams = _event_teams(event, cfg, sport)
        if teams:
            out[event["id"]] = teams
    return out


def parse_markets(payload: dict, sport: str, stat: str, events: dict[str, frozenset[str]]) -> list[BookMarket]:
    """O/U player markets from a subcategory response, limited to `events`."""
    sides: dict[str, dict] = {}
    for sel in payload.get("selections", []):
        outcome = sel.get("outcomeType")
        if outcome not in ("Over", "Under") or "points" not in sel or not sel.get("participants"):
            continue
        entry = sides.setdefault(sel["marketId"], {"player": sel["participants"][0]["name"], "line": sel["points"]})
        entry[outcome] = _american(sel["displayOdds"]["american"])

    out = []
    for market in payload.get("markets", []):
        teams = events.get(market["eventId"])
        entry = sides.get(market["id"])
        if not teams or not entry:
            continue
        out.append(BookMarket(
            book="draftkings",
            sport=sport,
            teams=teams,
            player=entry["player"],
            stat=stat,
            line=float(entry["line"]),
            over_odds=entry.get("Over"),
            under_odds=entry.get("Under"),
        ))
    return out


def collect(http: Http, cfg: Config, conf: dict, sports: list[str], now: datetime, hours: float) -> list[BookMarket]:
    markets = []
    for sport in sports:
        sport_conf = conf["sports"].get(sport)
        if not sport_conf:
            continue
        base = BASE.format(state=conf["state"], league=sport_conf["league"])
        league = http.get_json(base)
        events = events_in_window(league, cfg, sport, now, hours)
        if not events:
            continue
        for stat, (cat, sub) in subcategory_ids(league, sport_conf["subcategories"]).items():
            payload = http.get_json(f"{base}/categories/{cat}/subcategories/{sub}")
            markets += parse_markets(payload, sport, stat, events)
    return markets
