"""FanDuel sbapi.

A league page lists events; each event's prop tabs are fetched separately.
O/U player markets have exactly two runners, '<Player> Over' / '<Player> Under',
with the line in `handicap`.
"""

import re
from datetime import datetime

from ..matching import Config
from ..models import BookMarket
from .http import Http, in_window, parse_time

# Public app key FanDuel's own website sends with every odds request; not a personal credential.
API_KEY = "FhMFpcPWXMeyZxOx"
LEAGUE = "https://sbapi.{state}.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId={page}&_ak={key}&timezone=America/New_York"
EVENT = "https://sbapi.{state}.sportsbook.fanduel.com/api/event-page?_ak={key}&eventId={event}&tab={tab}"

_RUNNER = re.compile(r"^(.*) (Over|Under)$")


def market_key(market_type: str) -> str:
    """PLAYER_X_PASSING_YARDS_HIGH -> PLAYER_PASSING_YARDS (drop player letter and tier suffix)."""
    key = re.sub(r"^(PLAYER|PITCHER|BATTER)_[A-Z]_", r"\1_", market_type)
    return re.sub(r"_(HIGH|MEDIUM|LOW)$", "", key)


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
    wanted_games: set[frozenset[str]] | None = None,
) -> list[BookMarket]:
    """Markets for every event in the window, optionally only games PrizePicks lists."""
    markets = []
    for sport in sports:
        sport_conf = conf["sports"].get(sport)
        if not sport_conf:
            continue
        league = http.get_json(LEAGUE.format(state=conf["state"], page=sport_conf["page"], key=API_KEY))
        for event_id, teams in parse_events(league, cfg, sport, now, hours).items():
            if wanted_games is not None and teams not in wanted_games:
                continue
            for tab in sport_conf["tabs"]:
                url = EVENT.format(state=conf["state"], key=API_KEY, event=event_id, tab=tab)
                markets += parse_event_markets(http.get_json(url), sport, teams, sport_conf["markets"])
    return markets
