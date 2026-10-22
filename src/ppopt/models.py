"""Shared data types."""

from dataclasses import dataclass, field
from datetime import datetime


@dataclass(frozen=True)
class Leg:
    """A priced PrizePicks pick."""

    sport: str
    game_id: str
    player: str
    stat: str
    line: float
    side: str  # "over" or "under"
    prob: float  # true win probability, averaged across books
    book_probs: dict[str, float] = field(default_factory=dict, compare=False, hash=False)
    promo: bool = False
    modelled: bool = False  # probability extrapolated to a non-matching (promo) line
    promo_type: str = ""  # e.g. "taco", "manual"

    @property
    def disagreement(self) -> float:
        """Spread between the most and least bullish book."""
        if len(self.book_probs) < 2:
            return 0.0
        return max(self.book_probs.values()) - min(self.book_probs.values())


@dataclass(frozen=True)
class PPLine:
    """A PrizePicks projection, as produced by the PrizePicks source."""

    sport: str
    teams: frozenset[str]
    player: str
    stat: str | None  # canonical stat, None if PrizePicks' stat_type is unmapped
    line: float
    odds_type: str = "standard"
    raw_stat: str = ""
    sides: tuple[str, ...] = ("over", "under")  # sides PrizePicks allows
    start_time: datetime | None = None
    promo_type: str = ""  # PrizePicks discount_name, e.g. "taco"
    promo_line: float | None = None  # discounted (flash sale) line


@dataclass(frozen=True)
class BookMarket:
    """One sportsbook player-prop line, as produced by a book adapter."""

    book: str
    sport: str
    teams: frozenset[str]
    player: str
    stat: str
    line: float
    over_odds: float | None
    under_odds: float | None

    @property
    def two_sided(self) -> bool:
        return self.over_odds is not None and self.under_odds is not None


@dataclass(frozen=True)
class PromoLeg:
    """A manually entered promo pick (--promoLeg)."""

    sport: str
    teams: frozenset[str]
    player: str
    stat: str
    line: float
    side: str
    promo_type: str = "manual"


@dataclass(frozen=True)
class Slip:
    slip_type: str
    legs: tuple[Leg, ...]
    ev: float  # dollars
    ev_pct: float  # fraction of stake

    @property
    def size(self) -> int:
        return len(self.legs)
