"""FanDuel sbapi.

A league page lists events; each event's prop tabs are fetched separately.
O/U player markets have exactly two runners, '<Player> Over' / '<Player> Under',
with the line in `handicap`.
"""

import re
from datetime import datetime

from ..matching import Config
from ..models import BookMarket
from .http import Http, in_window, no_props_warning, parse_time

# Public app key FanDuel's own website sends with every odds request; not a personal credential.
API_KEY = "FhMFpcPWXMeyZxOx"
LEAGUE = "https://sbapi.{state}.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId={page}&_ak={key}&timezone=America/New_York"
EVENT = "https://sbapi.{state}.sportsbook.fanduel.com/api/event-page?_ak={key}&eventId={event}&tab={tab}"

_RUNNER = re.compile(r"^(.*) (Over|Under)$")


def market_key(market_type: str) -> str:
    """PLAYER_X_PASSING_YARDS_HIGH -> PLAYER_PASSING_YARDS (drop player letter and tier suffix)."""
    key = re.sub(r"^(PLAYER|PITCHER|BATTER)_[A-Z]_", r"\1_", market_type)
    return re.sub(r"_(HIGH|MEDIUM|LOW)$", "", key)


def needed_tabs(sport_conf: dict, stats: set[str]) -> dict[str, dict[str, str]]:
    """{tab: {market key: stat}} for the tabs holding any of one game's needed stats."""
    return {tab: markets for tab, markets in sport_conf["tabs"].items() if stats & set(markets.values())}


def parse_events(league: dict, cfg: Config, sport: str, now: datetime, hours: float) -> dict[str, frozenset[str]]:
    """{event id: teams} for games in the window. Futures/specials have no ' @ '."""
    out = {}
    for event in league.get("attachments", {}).get("events", {}).values():
        parts = event["name"].split(" @ ")
        if len(parts) != 2 or not in_window(parse_time(event["openDate"]), now, hours):
            continue
        # MLB names carry probable pitchers: "Tampa Bay Rays (N Martinez)".
        teams = {cfg.resolve_team(sport, re.sub(r"\s*\(.*?\)", "", part)) for part in parts}
        if None not in teams and len(teams) == 2:
            out[str(event["eventId"])] = frozenset(teams)
    return out


def parse_event_markets(payload: dict, sport: str, teams: frozenset[str], mapping: dict[str, str]) -> list[BookMarket]:
    out = {}
    for market in payload.get("attachments", {}).get("markets", {}).values():
        stat = mapping.get(market_key(market["marketType"]))
        runners = market.get("runners", [])
        if not stat or len(runners) != 2:
            continue
        entry = {}
        for r in runners:
            m = _RUNNER.match(r["runnerName"])
            if not m or r.get("runnerStatus", "ACTIVE") != "ACTIVE":
                break
            entry["player"], entry["line"] = m[1], float(r["handicap"])
            entry[m[2]] = float(r["winRunnerOdds"]["americanDisplayOdds"]["americanOddsInt"])
        if "Over" not in entry or "Under" not in entry:
            continue
        key = (entry["player"], stat)
        out[key] = BookMarket(
            book="fanduel",
            sport=sport,
            teams=teams,
            player=entry["player"],
            stat=stat,
            line=entry["line"],
            over_odds=entry["Over"],
            under_odds=entry["Under"],
        )
    return list(out.values())


def collect(
    http: Http,
    cfg: Config,
    conf: dict,
    sports: list[str],
    now: datetime,
    hours: float,
    warnings: list[str] | None = None,
    *,
    needs: dict[tuple[str, frozenset[str]], set[str]],
) -> list[BookMarket]:
    """Markets for the games the board needs, fetching only the tabs holding each game's stats.
    `needs` is {(sport, teams): stats}."""
    markets = []
    for sport in sports:
        sport_conf = conf["sports"].get(sport)
        if not sport_conf:
            continue
        progress = getattr(http, "progress", None)
        if progress:
            progress.book("fanduel", sport)
        league = http.get_json(LEAGUE.format(state=conf["state"], page=sport_conf["page"], key=API_KEY))
        events = {
            event_id: teams for event_id, teams in parse_events(league, cfg, sport, now, hours).items()
            if (sport, teams) in needs
        }
        fetches = [
            (event_id, teams, tab, markets_in_tab)
            for event_id, teams in events.items()
            for tab, markets_in_tab in needed_tabs(sport_conf, needs[(sport, teams)]).items()
        ]
        if progress:
            progress.plan("fanduel", sport, 1 + len(fetches))
        found = []
        for event_id, teams, tab, markets_in_tab in fetches:
            url = EVENT.format(state=conf["state"], key=API_KEY, event=event_id, tab=tab)
            found += parse_event_markets(http.get_json(url), sport, teams, markets_in_tab)
        if fetches and not found and warnings is not None:  # nothing to fetch isn't "not posted"
            warnings.append(no_props_warning("FanDuel", sport, len(events)))
        markets += found
    return markets
