"""Name normalization, team/stat lookup and parsing of user-entered picks."""

import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from .models import PromoLeg

_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}
_GAME_SEPARATOR = re.compile(r"\s+vs?\.?\s+|\s*@\s*|\s*-\s*", re.IGNORECASE)
_PICK = re.compile(r"^\s*(over|under|more|less)\s+(\d+(?:\.\d+)?)\s+(.+?)\s*$", re.IGNORECASE)
_SIDES = {"over": "over", "more": "over", "under": "under", "less": "under"}


def _clean(text: str) -> str:
    """Lowercase, strip accents and punctuation, collapse whitespace."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    text = re.sub(r"[^a-z0-9\s]", "", text)
    return " ".join(text.split())


def normalize_name(name: str) -> str:
    """Player-name key: accents, punctuation and generational suffixes removed."""
    words = _clean(name).split()
    while len(words) > 1 and words[-1] in _SUFFIXES:
        words.pop()
    return " ".join(words)


def _load(path: Path) -> dict:
    return {k: v for k, v in json.loads(path.read_text()).items() if not k.startswith("_")}


@dataclass
class Config:
    teams: dict[str, dict[str, list[str]]]
    stats: dict[str, dict]
    aliases: dict[str, str]

    @classmethod
    def load(cls, root: str | Path) -> "Config":
        root = Path(root)
        return cls(
            teams=_load(root / "teams.json"),
            stats=_load(root / "stats.json"),
            aliases=_load(root / "aliases.json"),
        )

    def player_key(self, name: str) -> str:
        key = normalize_name(name)
        return self.aliases.get(key, key)

    def resolve_team(self, sport: str, text: str) -> str | None:
        """Canonical abbreviation for an abbreviation, full name or nickname."""
        needle = _clean(text)
        suffix_match = None
        for abbr, aliases in self.teams.get(sport, {}).items():
            names = [_clean(a) for a in [abbr, *aliases]]
            if needle in names:
                return abbr
            for name in names:
                # "LA Clippers" -> "clippers"; skip short abbreviations to avoid false hits.
                if len(name) > 4 and needle.endswith(" " + name):
                    if suffix_match is None or len(name) > suffix_match[1]:
                        suffix_match = (abbr, len(name))
        return suffix_match[0] if suffix_match else None

    def pp_stat(self, sport: str, pp_name: str) -> str | None:
        """Canonical stat for a PrizePicks stat_type, or None if unmapped."""
        mapping = self.stats.get(sport, {}).get("prizepicks", {})
        wanted = pp_name.strip().lower()
        for name, canonical in mapping.items():
            if name.lower() == wanted or canonical == wanted:
                return canonical
        return None

    def stat_label(self, sport: str, stat: str) -> str:
        """PrizePicks' display name for a canonical stat."""
        for name, canonical in self.stats.get(sport, {}).get("prizepicks", {}).items():
            if canonical == stat:
                return name
        return stat

    def stat_model(self, sport: str, stat: str) -> tuple[str, float | None]:
        spec = self.stats[sport]["models"][stat]
        return spec["model"], spec.get("cv")


def game_id(sport: str, teams: frozenset[str]) -> str:
    return f"{sport}:{'-'.join(sorted(teams))}"


def parse_game(sport: str, text: str, cfg: Config) -> frozenset[str]:
    """'CHI vs NE' / 'NE @ CHI' / 'Bears - Patriots' -> {'CHI', 'NE'}."""
    parts = [p for p in _GAME_SEPARATOR.split(text.strip()) if p]
    if len(parts) != 2:
        raise ValueError(f"can't read game {text!r}; use e.g. 'CHI vs NE'")
    teams = []
    for part in parts:
        abbr = cfg.resolve_team(sport, part)
        if abbr is None:
            raise ValueError(f"unknown {sport} team {part!r} in {text!r}")
        teams.append(abbr)
    if teams[0] == teams[1]:
        raise ValueError(f"game {text!r} lists the same team twice")
    return frozenset(teams)


def parse_pick(sport: str, text: str, cfg: Config) -> tuple[str, float, str]:
    """'Over 215.5 Pass Yards' -> ('over', 215.5, 'pass_yards')."""
    m = _PICK.match(text)
    if not m:
        raise ValueError(f"can't read pick {text!r}; use e.g. 'Over 215.5 Pass Yards'")
    side, line, stat_name = _SIDES[m[1].lower()], float(m[2]), m[3]
    if line % 1 != 0.5:
        raise ValueError(f"line {line} in {text!r} must be a half-point line (e.g. {int(line)}.5)")
    stat = cfg.pp_stat(sport, stat_name)
    if stat is None:
        raise ValueError(f"unknown {sport} stat {stat_name!r}; add it to stats.json")
    return side, line, stat


def parse_promo_leg(values: list[str], cfg: Config) -> PromoLeg:
    """Parse the four --promoLeg values: SPORT GAME PLAYER PICK."""
    sport_raw, game, player, pick = values
    sport = sport_raw.strip().upper()
    if sport not in cfg.stats:
        raise ValueError(f"unknown sport {sport_raw!r}; choose from {', '.join(cfg.stats)}")
    side, line, stat = parse_pick(sport, pick, cfg)
    return PromoLeg(
        sport=sport,
        teams=parse_game(sport, game, cfg),
        player=player.strip(),
        stat=stat,
        line=line,
        side=side,
    )
