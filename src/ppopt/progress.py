"""Run progress, counted in sportsbook requests: they're where a run spends its time.

Each book plans how many requests it will make per league. The engine starts from an estimate made from the
board before anything is fetched; a book replaces it with the exact count as soon as it has read that league's
event list. Plans are upper bounds in practice, so the percentage only moves forward.
"""

import threading
from collections import Counter
from typing import Callable

BOOK_NAMES = {"draftkings": "DraftKings", "fanduel": "FanDuel"}


class RunCancelled(Exception):
    """Nobody is waiting for this run any more (the browser went away); stop fetching."""


def raise_first_error(errors) -> None:
    """Raise the first real error among these (Nones ignored); RunCancelled only if nothing else went wrong.
    A bug outranks the stop it caused elsewhere in the run."""
    errors = [e for e in errors if e is not None]
    if errors:
        raise next((e for e in errors if not isinstance(e, RunCancelled)), errors[0])


class Progress:
    def __init__(self, emit: Callable[[dict], None]):
        self.emit = emit
        self.planned: dict[tuple[str, str], int] = {}
        self.done_by: Counter[str] = Counter()
        self.fetching: dict[str, str] = {}  # {book: league it's fetching}, in the order the books started
        self.label = ""
        self.cancelled = False
        self.on_cancel: list[Callable[[], None]] = []  # called once when the run is cancelled
        self.lock = threading.RLock()  # books fetch on their own threads

    @property
    def done(self) -> int:
        return sum(self.done_by.values())

    @property
    def total(self) -> int:
        return max(sum(self.planned.values()), self.done)

    def _emit(self):
        # Sent under the lock, so books ticking at once can't deliver their events out of order.
        with self.lock:
            self.emit({"done": self.done, "total": self.total, "step": self.label})

    def plan(self, book: str, sport: str, requests: int):
        with self.lock:
            self.planned[(book, sport)] = requests
            self._emit()

    def book(self, book: str, sport: str):
        """This book is now fetching this league."""
        with self.lock:
            self.fetching[book] = sport
            self._relabel()

    def finish(self, book: str):
        """This book has fetched everything it will."""
        with self.lock:
            self.fetching.pop(book, None)
            self._relabel()

    def _relabel(self):
        self.label = " · ".join(f"{BOOK_NAMES.get(b, b)} {sport}" for b, sport in self.fetching.items())

    def cancel(self):
        """Ask the run to stop. It does so at its next request (each costs 1-2 s, so promptly)."""
        self.cancelled = True
        for stop in self.on_cancel:
            stop()

    def tick(self, book: str = ""):
        """One request made (live or from the odds cache), by `book`."""
        if self.cancelled:
            raise RunCancelled()
        with self.lock:
            self.done_by[book] += 1
            self._emit()

    def close(self, book: str):
        """The book failed: whatever it hadn't fetched yet will never be fetched."""
        with self.lock:
            for key in [k for k in self.planned if k[0] == book]:
                del self.planned[key]
            self.planned[(book, "*")] = self.done_by[book]
            self._emit()

    def step(self, label: str):
        with self.lock:
            self.label = label
            self._emit()
