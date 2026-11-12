"""Polite, cached JSON fetching via Scrapling."""

import hashlib
from collections import Counter
import json
import os
import random
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from ..progress import RunCancelled


def no_props_warning(book: str, sport: str, games: int) -> str:
    """A book lists games in the window but no player props for any of them (often: not posted yet)."""
    return f"{book} has no {sport} player props posted yet for {games} game{'s' if games != 1 else ''} in the window"


class FetchError(RuntimeError):
    """A request failed, was blocked, or did not return JSON."""


def scrapling_fetch(url: str, browser: bool = False) -> tuple[int, bytes]:
    """Fetch with Scrapling: TLS-impersonating HTTP, or a stealth browser when browser=True."""
    headers = {"Accept": "application/json"}
    if browser:
        from scrapling.fetchers import StealthyFetcher

        page = StealthyFetcher.fetch(url, headless=True, network_idle=True)
        body = page.body
        if body.lstrip()[:1] == b"<":
            # Browsers may wrap JSON in a <pre>; take its text.
            body = (page.css("pre::text").get() or "").encode()
        return page.status, body
    from scrapling.fetchers import Fetcher

    page = Fetcher.get(url, impersonate="chrome", headers=headers, timeout=30)
    return page.status, page.body


def parse_time(value: str) -> datetime:
    """ISO-8601 timestamp (any fractional precision, Z or offset) as aware UTC."""
    value = value.replace("Z", "+00:00")
    if "." in value:
        head, rest = value.split(".", 1)
        digits = rest[: len(rest) - len(rest.lstrip("0123456789"))]
        tz = rest[len(digits):]
        value = f"{head}.{digits[:6].ljust(6, '0')}{tz}"
    return datetime.fromisoformat(value).astimezone(timezone.utc)


def in_window(start: datetime, now: datetime, hours: float) -> bool:
    """True if `start` is in the future and no more than `hours` away."""
    return 0 <= (start - now).total_seconds() <= hours * 3600


class Http:
    def __init__(
        self,
        cache_dir: str | Path,
        ttl: float = 300,
        use_cache: bool = True,
        delay: tuple[float, float] = (1.0, 2.0),
        fetch=scrapling_fetch,
        sleep=time.sleep,
        progress=None,
        clock=time.monotonic,
    ):
        self.cache_dir = Path(cache_dir)
        self.ttl = ttl
        self.use_cache = use_cache
        self.delay = delay
        self.fetch = fetch
        self.sleep = sleep
        self.progress = progress  # ppopt.progress.Progress, ticked once per request
        self.clock = clock
        self._live_requests = 0
        self._hosts_fetched: set[str] = set()
        self._by_book: dict[str, Counter] = {}  # {book: Counter(live=..., cached=...)}, failed requests included
        self._lock = threading.Lock()  # books share this Http from their own threads
        self._stopped = threading.Event()
        self._timing: dict[str, dict] = {}  # {book: timing}, as each book finishes
        self._books: list[str] = []  # books in the order they were handed views

    @property
    def live_requests(self) -> int:
        """Requests made live so far (fetched, not answered from the odds cache)."""
        return self._live_requests

    def count_live(self):
        """Record a live request made without get_json: canned odds stand in for fetching the books."""
        with self._lock:
            self._live_requests += 1

    def stop(self):
        """End the run's fetching: every request from here on raises RunCancelled (one book broke)."""
        self._stopped.set()

    @property
    def timing(self) -> dict[str, dict]:
        """{book: {"requests", "cached", "failed", "seconds"}} for each book that has finished, in book order."""
        with self._lock:
            return {book: self._timing[book] for book in self._books if book in self._timing}

    def for_book(self, book: str) -> "BookHttp":
        """This Http as one book uses it: same odds cache, with the book's live requests and time recorded.
        Hand out views in book order: timing lists books in the order they were handed views."""
        with self._lock:
            if book not in self._books:
                self._books.append(book)
        return BookHttp(self, book)

    def _cache_path(self, url: str) -> Path:
        return self.cache_dir / (hashlib.sha256(url.encode()).hexdigest()[:32] + ".json")

    def get_json(self, url: str, browser: bool = False):
        return self._get_json(url, browser)[0]

    def _get_json(self, url: str, browser: bool, book: str = "") -> tuple[object, bool]:
        """The response, and whether it was fetched live."""
        if self._stopped.is_set():
            raise RunCancelled()
        path = self._cache_path(url)
        if self.use_cache and path.exists() and time.time() - path.stat().st_mtime < self.ttl:
            data = json.loads(path.read_text())
            with self._lock:
                self._by_book.setdefault(book, Counter())["cached"] += 1
            self._tick(book)
            return data, False

        host = urlsplit(url).netloc
        with self._lock:
            paused = host in self._hosts_fetched  # pacing is per sportsbook: hosts don't wait on each other
            self._hosts_fetched.add(host)
            self._live_requests += 1
            self._by_book.setdefault(book, Counter())["live"] += 1
        if paused:
            self.sleep(random.uniform(*self.delay))

        status, body = self.fetch(url, browser=browser)
        if status != 200:
            raise FetchError(f"HTTP {status} from {url}")
        try:
            data = json.loads(body)
        except ValueError as e:
            raise FetchError(f"non-JSON response from {url}") from e

        self.cache_dir.mkdir(parents=True, exist_ok=True)
        # Write aside, then rename: another run reading this response never sees half of it.
        tmp = path.with_name(f"{path.stem}.{os.getpid()}.{threading.get_ident()}.tmp")  # unique across runs
        try:
            tmp.write_bytes(body if isinstance(body, bytes) else body.encode())
            tmp.replace(path)
        finally:
            tmp.unlink(missing_ok=True)
        self._tick(book)
        return data, True

    def _tick(self, book: str):
        if self.progress is not None:
            self.progress.tick(book)


class BookHttp:
    """One book's view of the run's Http, used as a context manager around that book's fetching."""

    def __init__(self, http: Http, book: str):
        self.http, self.book = http, book
        self.progress = http.progress

    def get_json(self, url: str, browser: bool = False):
        return self.http._get_json(url, browser, self.book)[0]

    def __enter__(self):
        self.started = self.http.clock()
        return self

    def __exit__(self, exc_type, *exc):
        if self.progress is not None:
            self.progress.finish(self.book)
        with self.http._lock:
            counts = self.http._by_book.get(self.book, Counter())
            self.http._timing[self.book] = {
                "requests": counts["live"], "cached": counts["cached"], "failed": exc_type is not None,
                "seconds": self.http.clock() - self.started,
            }
        return False
