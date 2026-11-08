"""Polite, cached JSON fetching via Scrapling."""

import hashlib
import json
import random
import time
from datetime import datetime, timezone
from pathlib import Path


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
    ):
        self.cache_dir = Path(cache_dir)
        self.ttl = ttl
        self.use_cache = use_cache
        self.delay = delay
        self.fetch = fetch
        self.sleep = sleep
        self.progress = progress  # ppopt.progress.Progress, ticked once per request
        self._live_requests = 0

    @property
    def live_requests(self) -> int:
        """Requests made live so far (fetched, not answered from the odds cache)."""
        return self._live_requests

    def count_live(self):
        """Record a live request made without get_json: canned odds stand in for fetching the books."""
        self._live_requests += 1

    def _cache_path(self, url: str) -> Path:
        return self.cache_dir / (hashlib.sha256(url.encode()).hexdigest()[:32] + ".json")

    def get_json(self, url: str, browser: bool = False):
        path = self._cache_path(url)
        if self.use_cache and path.exists() and time.time() - path.stat().st_mtime < self.ttl:
            data = json.loads(path.read_text())
            self._tick()
            return data

        if self._live_requests:
            self.sleep(random.uniform(*self.delay))
        self._live_requests += 1

        status, body = self.fetch(url, browser=browser)
        if status != 200:
            raise FetchError(f"HTTP {status} from {url}")
        try:
            data = json.loads(body)
        except ValueError as e:
            raise FetchError(f"non-JSON response from {url}") from e

        self.cache_dir.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body if isinstance(body, bytes) else body.encode())
        self._tick()
        return data

    def _tick(self):
        if self.progress is not None:
            self.progress.tick()
