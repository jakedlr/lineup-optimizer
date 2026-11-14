"""HTTP front door to the ppopt engine. Serves the JSON API under /api and the built SPA everywhere else.

Paths come from the environment so the same code runs from a checkout and from the Docker image:
  PPOPT_ROOT      folder holding the engine's config JSON (payouts.json, books.json, ...)
  PPOPT_DATA      writable folder for the saved board and the odds cache
  PPOPT_WEB_DIST  built SPA
  PPOPT_ODDS_FILE optional JSON list of book markets used instead of live FanDuel/DraftKings
                  (offline runs and the e2e suite)
  PPOPT_BOARD_FILE optional projections JSON read instead of PrizePicks' partner feed, at each fetch
                  (the e2e suite: a missing or broken file is a failed fetch)
"""

import json
import os
import queue
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

from typing import Annotated, Literal

from fastapi import Body, FastAPI, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import cli
from .matching import Config, config_file, game_id, matchup_label
from .models import BookMarket
from .pricing import PRICING_METHODS
from .payouts import load_payouts
from .progress import Progress, RunCancelled
from .sources import prizepicks
from .sources.http import REUSE_SECONDS, FetchError, Http

REPO = Path(__file__).resolve().parents[2]
DEFAULT_STATIC = REPO / "web" / "dist"
BOARD = "board.json"
BOARD_META = "board.meta.json"


def board_from_file(path: Path):
    """A board fetcher that reads a projections file instead of the partner feed, fresh at each fetch."""

    def fetch(progress=None) -> bytes:
        try:
            return Path(path).read_bytes()
        except OSError as e:
            raise FetchError(f"no board file at {path} ({e.strerror or e})") from e

    return fetch


def ago(minutes: float) -> str:
    """How long ago, in the page's words (web/src/format.ts `ago`): "just now", "45 min ago", "2 h ago", "3 d ago"."""
    m = max(0, int(minutes // 1))
    if m < 1:
        return "just now"
    if m < 60:
        return f"{m} min ago"
    hours = m // 60
    return f"{hours} h ago" if hours < 24 else f"{hours // 24} d ago"


def markets_from_file(path: Path):
    """A market collector that reads canned book markets instead of fetching them."""
    rows = json.loads(Path(path).read_text())
    markets = [BookMarket(**{**r, "teams": frozenset(r["teams"])}) for r in rows]

    def collect(http, cfg, books, sports, now, hours, needs):
        if http is not None:
            http.count_live()  # canned odds stand in for the books, so a run on them is always fresh
        return [m for m in markets if m.sport in sports], []

    return collect


class PromoLegIn(BaseModel):
    """A promo pick chosen from the board, at its discounted line (the web form of --promoLeg)."""

    model_config = ConfigDict(extra="forbid")

    sport: Literal[tuple(cli.SPORTS)]
    matchup: str = Field(min_length=1)
    player: str = Field(min_length=1)
    stat_label: str = Field(min_length=1)
    side: Literal["over", "under"]
    line: float

    def cli_values(self) -> list[str]:
        return [self.sport, self.matchup, self.player, f"{self.side.title()} {self.line:g} {self.stat_label}"]


class RunSettings(BaseModel):
    """What the web app may change about a run. Anything left out takes the CLI default."""

    model_config = ConfigDict(extra="forbid")

    sports: list[Literal[tuple(cli.SPORTS)]] | None = Field(None, min_length=1)
    stake: float | None = Field(None, gt=0)
    hours: float | None = Field(None, gt=0)
    devig: Literal[PRICING_METHODS] | None = None
    ref_slip: str | None = Field(None, pattern=r"^(power|flex)[2-6]$")
    no_cache: bool = False
    # Promotions: at most one kind per run, as on the CLI.
    bonus: bool = False
    boost: float | None = Field(None, gt=1)
    promo_legs: list[PromoLegIn] = []
    feed_promos: bool = True

    @model_validator(mode="after")
    def one_promotion(self):
        if sum([self.bonus, self.boost is not None, bool(self.promo_legs)]) > 1:
            raise ValueError("use only one promotion per run: bonus, boost or promo legs")
        return self

    def apply(self, args):
        for name in ("sports", "stake", "hours", "devig"):
            if (value := getattr(self, name)) is not None:
                setattr(args, name, value)
        if self.ref_slip:
            args.ref_slip = (self.ref_slip[:-1], int(self.ref_slip[-1]))
        args.no_cache = self.no_cache
        args.bonus = self.bonus
        args.boost = self.boost
        args.promo_legs = [leg.cli_values() for leg in self.promo_legs]
        args.no_promos = not self.feed_promos
        return args


def stream_run(work):
    """Run `work(progress, announce)` on a worker thread and yield NDJSON: progress events (and any event the work
    announces, such as the board it fetched), then one "report" or "error".

    Closing the generator (Starlette does when the client goes away) cancels the run: the worker stops at its
    next request (the board's included) instead of scraping for a page nobody is watching.
    """
    events: queue.Queue = queue.Queue()
    progress = Progress(lambda e: events.put({"type": "progress", **e}))

    def worker():
        try:
            events.put({"type": "report", "report": work(progress, events.put)})
        except RunCancelled:
            pass
        except cli.UserError as e:
            events.put({"type": "error", "detail": str(e)})
        except Exception as e:  # noqa: BLE001 - the stream has started, so this is the only way to say so
            events.put({"type": "error", "detail": f"the engine failed: {e}"})

    threading.Thread(target=worker, daemon=True).start()
    try:
        while True:
            event = events.get()
            yield json.dumps(event) + "\n"
            if event["type"] in ("report", "error"):
                return
    finally:
        progress.cancel()


def create_app(static_dir=None, data_dir=None, root=None, collect=None, now=None, fetch_board=None) -> FastAPI:
    """`collect` stands in for the sportsbooks and `fetch_board(progress)` for PrizePicks' partner feed: it returns
    the board's raw bytes, unchecked, or raises FetchError. `progress` is the run's (None outside a run), there only
    so a run whose client has gone stops waiting; it is never ticked."""
    static_dir = Path(static_dir or os.environ.get("PPOPT_WEB_DIST") or DEFAULT_STATIC)
    data_dir = Path(data_dir or os.environ.get("PPOPT_DATA") or REPO / "data")
    root = Path(root or os.environ.get("PPOPT_ROOT") or cli.ROOT)
    if collect is None and os.environ.get("PPOPT_ODDS_FILE"):
        collect = markets_from_file(os.environ["PPOPT_ODDS_FILE"])
    if fetch_board is None and os.environ.get("PPOPT_BOARD_FILE"):
        fetch_board = board_from_file(os.environ["PPOPT_BOARD_FILE"])
    if fetch_board is None:
        # One Http for every board request the app makes, so they're paced across runs, not just within one (and a
        # push-back holds the next run's request too). No run progress: the board isn't a sportsbook request.
        # Board requests are made under write_lock, so one run at a time uses it, as stops_with needs.
        board_http = Http(data_dir / "cache")

        def fetch_board(progress=None) -> bytes:
            with board_http.stops_with(progress):
                return prizepicks.fetch_raw(board_http)
    now = now or cli.utcnow

    board_path, meta_path = data_dir / BOARD, data_dir / BOARD_META
    app = FastAPI(title="PrizePicks EV Optimizer")
    cache: dict = {}  # {"board": (mtime_ns, payload)}, swapped whole so a reader never sees half of it
    cache_lock = threading.Lock()
    # Held by whatever writes the board (an upload, a fetch, a run's fetch) from start to finish, so two writers
    # can't interleave. Always taken before cache_lock, never inside it.
    write_lock = threading.Lock()

    def load_board() -> dict:
        """The saved board, parsed once per upload (real boards run to tens of MB)."""
        if not board_path.is_file():
            raise HTTPException(409, "no board yet: fetch or upload one")
        with cache_lock:
            mtime = board_path.stat().st_mtime_ns
            cached = cache.get("board")
            if cached is None or cached[0] != mtime:
                cached = cache["board"] = (mtime, json.loads(board_path.read_text()))
            return cached[1]

    def board_info() -> dict | None:
        if not board_path.is_file() or not meta_path.is_file():
            return None
        with cache_lock:  # a save rewrites the meta and swaps the board under this lock
            meta = json.loads(meta_path.read_text())
            saved = datetime.fromtimestamp(board_path.stat().st_mtime, timezone.utc)
        # Boards saved before the source was recorded were all uploads.
        return {"saved_at": saved.isoformat(), "projections": meta["projections"],
                "source": meta.get("source", "uploaded")}

    def save_board(raw: bytes, payload: dict, source: str, filename: str | None = None) -> None:
        """Make this the board. Call under write_lock."""
        data_dir.mkdir(parents=True, exist_ok=True)
        # Written aside, then swapped in with its meta: a reader never sees half a board or a mismatched meta.
        with tempfile.NamedTemporaryFile(dir=data_dir, prefix="board.", suffix=".tmp", delete=False) as f:
            f.write(raw)
        tmp = Path(f.name)
        with cache_lock:
            meta_path.write_text(json.dumps({"projections": len(payload["data"]), "source": source,
                                             "filename": filename}))
            tmp.replace(board_path)
            cache["board"] = (board_path.stat().st_mtime_ns, payload)

    def fetch_and_save(progress: Progress | None = None) -> dict:
        """A fresh board from the partner feed, saved as the board. Call under write_lock. Raises FetchError, or
        RunCancelled once the run's client has gone: the download in flight can't be stopped, but nothing after it
        holds the board for a run nobody is watching."""
        raw = fetch_board(progress)
        if progress is not None:
            progress.check()
        payload = prizepicks.read_feed(raw)
        save_board(raw, payload, "fetched")
        return payload

    def seconds_old(info: dict) -> float:
        return now().timestamp() - datetime.fromisoformat(info["saved_at"]).timestamp()

    def recently_fetched() -> bool:
        """Whether the saved board was fetched (not uploaded) less than REUSE_SECONDS ago: as good as a new fetch,
        and kinder to the partner feed. A board saved "in the future" (the clock moved back) isn't trusted."""
        info = board_info()
        return info is not None and info["source"] == "fetched" and 0 <= seconds_old(info) < REUSE_SECONDS

    def board_for_run(progress: Progress | None, fresh: bool = False) -> tuple[dict, str | None]:
        """The board a run prices: one fetched under a minute ago (unless `fresh`), else a new fetch, or when that
        fails the saved board and a warning saying so. Raises UserError when there's none of them, and RunCancelled
        when the run's client has gone."""
        with write_lock:
            if progress is not None:
                progress.check()  # it may have waited its turn a while
            if not fresh and recently_fetched():
                return load_board(), None
            try:
                return fetch_and_save(progress), None
            except FetchError as e:
                reason = str(e)
            info = board_info()
            if info is None:
                raise cli.UserError(f"couldn't fetch the board from PrizePicks' partner feed ({reason}), and there's "
                                    "no saved board to fall back on: upload one")
            payload = load_board()
        age = seconds_old(info) / 60
        warning = (f"couldn't fetch the board from PrizePicks' partner feed ({reason}); this run used the saved "
                   f"board, {info['source']} {ago(age)}")
        if age > cli.STALE_MINUTES:
            warning += ", so PrizePicks lines may have moved"
        return payload, warning

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/api/options")
    def options() -> dict:
        defaults = cli.parse_args([])
        table = load_payouts(config_file(root, "payouts.json"))
        return {
            "sports": cli.SPORTS,
            "devig": list(PRICING_METHODS),
            "ref_slips": [f"{t}{n}" for t in table for n in sorted(table[t])],
            "defaults": {"sports": defaults.sports, "hours": defaults.hours, "stake": defaults.stake,
                         "devig": defaults.devig, "ref_slip": None},
            "board_app_url": prizepicks.APP_URL,  # where to save a board by hand when the fetch fails
        }

    @app.get("/api/board")
    def get_board() -> dict:
        info = board_info()
        if info is None:
            raise HTTPException(404, "no board yet")
        return info

    @app.post("/api/board/fetch")
    def fetch_board_now() -> dict:
        """Fetch the board from the partner feed and save it (the page does on opening, when it has none or it's
        stale). A board fetched under a minute ago is returned as it is."""
        with write_lock:
            if recently_fetched():
                return board_info()
            try:
                fetch_and_save()
            except FetchError as e:
                raise HTTPException(502, f"couldn't fetch the board from PrizePicks' partner feed: {e}") from e
        return board_info()

    @app.get("/api/board/lines")
    def board_lines(sports: Annotated[str | None, Query()] = None,
                    hours: Annotated[float | None, Query(gt=0)] = None) -> list[dict]:
        """Priceable standard lines on the board, for building promo legs."""
        payload = load_board()
        defaults = cli.parse_args([])
        wanted = [x.strip().upper() for x in sports.split(",")] if sports else defaults.sports
        cfg = Config.load(root)
        lines, _ = prizepicks.parse_projections(payload, cfg, wanted, now(), hours or defaults.hours)
        rows = {
            (l.player, cfg.stat_label(l.sport, l.stat), l.line, l.sport, matchup_label(game_id(l.sport, l.teams)))
            for l in lines if l.stat
        }
        return [
            {"sport": sport, "matchup": matchup, "player": player, "stat_label": label, "line": line}
            for player, label, line, sport, matchup in sorted(rows)
        ]

    @app.put("/api/board")
    def put_board(file: UploadFile) -> dict:
        # A plain def: FastAPI runs it on a worker thread, so parsing a big board doesn't stall the server.
        raw = file.file.read()
        try:
            payload = prizepicks.read_feed(raw)
        except FetchError as e:
            raise HTTPException(422, "that file isn't a PrizePicks projections feed (expected a JSON object with a \"data\" list)") from e
        with write_lock:
            save_board(raw, payload, "uploaded", file.filename)
        return board_info()

    @app.post("/api/run", response_model=None)
    def run(request: Request, settings: Annotated[RunSettings | None, Body()] = None):
        args = (settings or RunSettings()).apply(cli.parse_args([]))

        def report(progress: Progress | None = None, announce=lambda event: None) -> dict:
            if progress:
                progress.step("Fetching the PrizePicks board")
            # The run keeps the board it fetched (or fell back to): a later save can't change what it reports on.
            payload, fallback = board_for_run(progress, fresh=args.no_cache)  # "Fresh odds" mean a fresh board too
            if not fallback:  # the page shows the new board now, not when the report lands
                announce({"type": "board", "board": board_info()})
            http = Http(data_dir / "cache", use_cache=not args.no_cache, progress=progress)
            result = cli.report_for(args, root, payload, http, now(), collect=collect)
            if fallback:
                result["warnings"].insert(0, fallback)
            return result

        if "application/x-ndjson" not in request.headers.get("accept", ""):
            try:
                return report()
            except cli.UserError as e:
                raise HTTPException(422, str(e)) from e

        return StreamingResponse(stream_run(report), media_type="application/x-ndjson")

    @app.get("/api/{rest:path}", include_in_schema=False)
    def api_not_found(rest: str):
        raise HTTPException(404, "not found")

    @app.get("/{rest:path}", include_in_schema=False)
    def spa(rest: str):
        root_dir = static_dir.resolve()
        candidate = (root_dir / rest).resolve()
        if rest and candidate.is_file() and root_dir in candidate.parents:
            return FileResponse(candidate)
        index = root_dir / "index.html"
        if not index.is_file():
            raise HTTPException(404, "UI not built: run `npm run build` in web/")
        return FileResponse(index)

    return app


app = create_app()
