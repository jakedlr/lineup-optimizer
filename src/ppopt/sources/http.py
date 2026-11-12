"""Polite, cached JSON fetching via Scrapling."""

import hashlib
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
import os
import random
import threading
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit

from ..progress import RunCancelled, raise_first_error


def no_props_warning(book: str, sport: str, games: int) -> str:
    """A book lists games in the window but no player props for any of them (often: not posted yet)."""
    return f"{book} has no {sport} player props posted yet for {games} game{'s' if games != 1 else ''} in the window"


class FetchError(RuntimeError):
    """A request failed, was blocked, or did not return JSON."""


def scrapling_fetch(url: str, browser: bool = False) -> tuple[int, bytes, dict]:
    """Fetch with Scrapling: TLS-impersonating HTTP, or a stealth browser when browser=True.
    Returns status, body and response headers."""
    headers = {"Accept": "application/json"}
    if browser:
        from scrapling.fetchers import StealthyFetcher

        page = StealthyFetcher.fetch(url, headless=True, network_idle=True)
        body = page.body
        if body.lstrip()[:1] == b"<":
            # Browsers may wrap JSON in a <pre>; take its text.
            body = (page.css("pre::text").get() or "").encode()
        return page.status, body, dict(page.headers or {})
    from scrapling.fetchers import Fetcher

    page = Fetcher.get(url, impersonate="chrome", headers=headers, timeout=30)
    return page.status, page.body, dict(page.headers or {})


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


class Pacer:
    """How fast one sportsbook may be asked: at most `in_flight` requests at once, and a gap of `gap()` seconds
    between them, counted from the last request's start or, with `after_end`, from its end. Used as a context
    manager around each live request."""

    def __init__(self, in_flight: int, gap, clock, sleep, after_end: bool = False, check=lambda: None):
        self.in_flight, self.gap, self.clock, self.sleep, self.after_end = in_flight, gap, clock, sleep, after_end
        self.check = check  # raises if the run has stopped; called once a request has waited its turn
        self._cond = threading.Condition()
        self._active = 0
        self._next_start: float | None = None

    @classmethod
    def slow(cls, delay, clock, sleep, check=lambda: None) -> "Pacer":
        """One request at a time, pausing `delay` (a (low, high) range of seconds) after each: how every book was
        once asked."""
        return cls(1, lambda: random.uniform(*delay), clock, sleep, after_end=True, check=check)

    def __enter__(self):
        with self._cond:
            while self._active >= self.in_flight:
                self._cond.wait()
            self._active += 1
            now = self.clock()
            start = now if self._next_start is None else max(now, self._next_start)
            if not self.after_end:
                self._next_start = start + self.gap()
        try:
            if start > now:
                self.sleep(start - now)
            self.check()
        except BaseException:
            with self._cond:
                self._active -= 1
                self._cond.notify_all()
            raise
        return self

    def __exit__(self, *exc):
        with self._cond:
            self._active -= 1
            if self.after_end:  # never earlier than a hold already set
                self._next_start = max(self._next_start or 0.0, self.clock() + self.gap())
            self._cond.notify_all()
        return False

    def slow_down(self, delay, wait: float | None = None):
        """The book pushed back: no request starts until `wait` seconds (or one pause) from now, then one at a time,
        pausing `delay` seconds after each."""
        with self._cond:
            self.in_flight = 1
            self.gap = lambda: random.uniform(*delay)
            self.after_end = True
            hold = self.clock() + max(wait or 0.0, self.gap())
            self._next_start = max(self._next_start or hold, hold)


RATE_LIMITED = 429
REFUSED = 403  # blocked (bot protection, or a geo-block off a US connection); sometimes it passes
PUSHED_BACK = (RATE_LIMITED, REFUSED)
MAX_RETRY_AFTER = 10  # seconds; odds a minute old aren't worth waiting for


def retry_after(headers: dict) -> float | None:
    """Seconds a Retry-After header asks for (a number or an HTTP date), or None."""
    value = next((v for k, v in headers.items() if k.lower() == "retry-after"), None)
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        return max(0.0, (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds())
    except (TypeError, ValueError):
        return None


class Http:
    def __init__(
        self,
        cache_dir: str | Path,
        ttl: float = 60,  # seconds an odds-cache answer is reused; lines move fast
        use_cache: bool = True,
        delay: tuple[float, float] = (1.0, 2.0),
        fetch=scrapling_fetch,
        sleep=None,
        progress=None,
        clock=time.monotonic,
    ):
        self.cache_dir = Path(cache_dir)
        self.ttl = ttl
        self.use_cache = use_cache
        self.delay = delay
        self.fetch = fetch
        self._stopped = threading.Event()
        # Waits end early when the run stops, so a cancelled run never sits out a pause it no longer needs.
        self.sleep = sleep or self._stopped.wait
        self.progress = progress  # ppopt.progress.Progress, ticked once per request
        if progress is not None:
            progress.on_cancel.append(self.stop)
        self.clock = clock
        self._live_requests = 0
        self._rate_limited: set[str] = set()  # books that pushed back during this run
        self._pacers: dict[str, Pacer] = {}  # {book, or host for requests made by no book: its pacer}
        self._by_book: dict[str, Counter] = {}  # {book: Counter(live=..., cached=...)}, failed requests included
        self._lock = threading.Lock()  # books share this Http from their own threads
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
        """End the run's fetching: every request from here on raises RunCancelled (cancelled, or one book broke)."""
        self._stopped.set()

    def _check(self):
        if self._stopped.is_set():
            raise RunCancelled()

    @property
    def timing(self) -> dict[str, dict]:
        """{book: {"requests", "cached", "failed", "rate_limited", "seconds"}} for each book that has finished, in
        book order. `requests` counts live requests (retries included), `cached` answers from the odds cache."""
        with self._lock:
            return {book: self._timing[book] for book in self._books if book in self._timing}

    def for_book(self, book: str, pacing: dict | None = None) -> "BookHttp":
        """This Http as one book uses it: same odds cache, paced by `pacing` ({"in_flight", "min_gap"}; without it,
        one request at a time with a 1-2 s pause after each), with the book's live requests and time recorded.
        Raises ValueError for pacing it can't use. A book keeps its first pacer for the run, slowed or not.
        Hand out views in book order: timing lists books in the order they were handed views."""
        if pacing is not None:
            in_flight, min_gap = pacing.get("in_flight"), pacing.get("min_gap")
            if not (type(in_flight) is int and in_flight >= 1
                    and type(min_gap) in (int, float) and min_gap >= 0):
                raise ValueError("its pacing in books.json needs a whole in_flight of 1 or more "
                                 "and a min_gap of 0 or more seconds")
        with self._lock:
            if book not in self._books:
                self._books.append(book)
        self._pacer(book, pacing)
        return BookHttp(self, book)

    def _pacer(self, key: str, pacing: dict | None = None) -> Pacer:
        """The pacer for a book (or, for requests made by no book, a host), made on first use."""
        with self._lock:
            if key not in self._pacers:
                if pacing:
                    gap = float(pacing["min_gap"])
                    self._pacers[key] = Pacer(pacing["in_flight"], lambda: gap, self.clock, self.sleep,
                                              check=self._check)
                else:
                    self._pacers[key] = Pacer.slow(self.delay, self.clock, self.sleep, self._check)
            return self._pacers[key]

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

        with self._lock:
            self._live_requests += 1
            self._by_book.setdefault(book, Counter())["live"] += 1
        # Each book is paced on its own; a request made by no book is paced with others to its host.
        pacer = self._pacer(book or urlsplit(url).netloc)
        with pacer:
            status, body, *rest = self.fetch(url, browser=browser)
        if status in PUSHED_BACK and book:
            status, body = self._back_off(url, browser, book, pacer, status, rest[0] if rest else {})
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

    def _back_off(self, url, browser, book, pacer, status, headers) -> tuple[int, bytes]:
        """The book pushed back: hold all its requests for the wait it asked for (or one pause), slow it to one
        request at a time, then retry this request once, in turn like any other. Only a 429 is a rate limit."""
        if status == RATE_LIMITED:
            with self._lock:
                self._rate_limited.add(book)
        wait = retry_after(headers) if status == RATE_LIMITED else None
        if wait is not None and wait > MAX_RETRY_AFTER:
            pacer.slow_down(self.delay)
            raise FetchError(f"rate-limited: HTTP {status} from {url}, asked to wait {wait:g}s")
        pacer.slow_down(self.delay, wait)
        with pacer:
            with self._lock:
                self._live_requests += 1
                self._by_book[book]["live"] += 1
            retry, body, *_ = self.fetch(url, browser=browser)
        if retry == RATE_LIMITED:
            raise FetchError(f"rate-limited: HTTP {retry} from {url}, again after backing off")
        if retry == REFUSED:
            raise FetchError(f"refused: HTTP {retry} from {url} (blocked, or off a US connection)")
        return retry, body  # anything else is judged like a first answer

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

    def get_many(self, urls: list[str]) -> list:
        """Every URL's response, in order, fetched as fast as the book's pacing allows. The first failure stops
        requests not yet started and is raised once the ones in flight have landed."""
        if not urls:
            return []
        abort = threading.Event()

        def one(url):
            if abort.is_set():
                raise RunCancelled()
            try:
                return self.get_json(url)
            except BaseException:
                abort.set()
                raise

        with ThreadPoolExecutor(max_workers=self.http._pacer(self.book).in_flight) as pool:
            futures = [pool.submit(one, url) for url in urls]
        raise_first_error([f.exception() for f in futures])
        return [f.result() for f in futures]

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
                "rate_limited": self.book in self.http._rate_limited,
                "seconds": self.http.clock() - self.started,
            }
        return False
