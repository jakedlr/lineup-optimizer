"""Run progress, counted in sportsbook requests: they're where a run spends its time.

Each book plans how many requests it will make per league. The engine starts from an estimate made from the
board before anything is fetched; a book replaces it with the exact count as soon as it has read that league's
event list. Plans are upper bounds in practice, so the percentage only moves forward.
"""

from collections import Counter
from typing import Callable

BOOK_NAMES = {"draftkings": "DraftKings", "fanduel": "FanDuel"}


class RunCancelled(Exception):
    """Nobody is waiting for this run any more (the browser went away); stop fetching."""


class Progress:
    def __init__(self, emit: Callable[[dict], None]):
        self.emit = emit
        self.planned: dict[tuple[str, str], int] = {}
        self.done_by: Counter[str] = Counter()
        self.current: str | None = None
        self.label = ""
        self.cancelled = False

    @property
    def done(self) -> int:
        return sum(self.done_by.values())

    @property
    def total(self) -> int:
        return max(sum(self.planned.values()), self.done)

    def _emit(self):
        self.emit({"done": self.done, "total": self.total, "step": self.label})

    def plan(self, book: str, sport: str, requests: int):
        self.planned[(book, sport)] = requests
        self._emit()

    def book(self, book: str, sport: str):
        """Requests from here on belong to this book, fetching this league."""
        self.current = book
        self.label = f"{BOOK_NAMES.get(book, book)} {sport}"

    def cancel(self):
        """Ask the run to stop. It does so at its next request (each costs 1-2 s, so promptly)."""
        self.cancelled = True

    def tick(self):
        if self.cancelled:
            raise RunCancelled()
        self.done_by[self.current or ""] += 1
        self._emit()

    def close(self, book: str):
        """The book failed: whatever it hadn't fetched yet will never be fetched."""
        for key in [k for k in self.planned if k[0] == book]:
            del self.planned[key]
        self.planned[(book, "*")] = self.done_by[book]
        self._emit()

    def step(self, label: str):
        self.label = label
        self._emit()
