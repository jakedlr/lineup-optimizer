"""HTTP front door to the ppopt engine. Serves the JSON API under /api and the built SPA everywhere else.

Paths come from the environment so the same code runs from a checkout and from the Docker image:
  PPOPT_ROOT      folder holding the engine's config JSON (payouts.json, books.json, ...)
  PPOPT_DATA      writable folder for the saved board and the odds cache
  PPOPT_WEB_DIST  built SPA
  PPOPT_ODDS_FILE optional JSON list of book markets used instead of live FanDuel/DraftKings
                  (offline runs and the e2e suite)
"""

import json
import os
import queue
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
from .odds import DEVIG_METHODS
from .payouts import load_payouts
from .progress import Progress, RunCancelled
from .sources import prizepicks
from .sources.http import Http

REPO = Path(__file__).resolve().parents[2]
DEFAULT_STATIC = REPO / "web" / "dist"
BOARD = "board.json"
BOARD_META = "board.meta.json"


def markets_from_file(path: Path):
    """A market collector that reads canned book markets instead of fetching them."""
    rows = json.loads(Path(path).read_text())
    markets = [BookMarket(**{**r, "teams": frozenset(r["teams"])}) for r in rows]

    def collect(http, cfg, books, sports, now, hours, wanted):
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
    devig: Literal[DEVIG_METHODS] | None = None
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
    """Run `work(progress)` on a worker thread and yield NDJSON: progress events, then one "report" or "error".

    Closing the generator (Starlette does when the client goes away) cancels the run: the worker stops at its
    next sportsbook request instead of scraping for a page nobody is watching.
    """
    events: queue.Queue = queue.Queue()
    progress = Progress(lambda e: events.put({"type": "progress", **e}))

    def worker():
        try:
            events.put({"type": "report", "report": work(progress)})
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
            if event["type"] != "progress":
                return
    finally:
        progress.cancel()


def create_app(static_dir=None, data_dir=None, root=None, collect=None, now=None) -> FastAPI:
    static_dir = Path(static_dir or os.environ.get("PPOPT_WEB_DIST") or DEFAULT_STATIC)
    data_dir = Path(data_dir or os.environ.get("PPOPT_DATA") or REPO / "data")
    root = Path(root or os.environ.get("PPOPT_ROOT") or cli.ROOT)
    if collect is None and os.environ.get("PPOPT_ODDS_FILE"):
        collect = markets_from_file(os.environ["PPOPT_ODDS_FILE"])
    now = now or cli.utcnow

    board_path, meta_path = data_dir / BOARD, data_dir / BOARD_META
    app = FastAPI(title="PrizePicks EV Optimizer")
    cache: dict = {}  # {"board": (mtime_ns, payload)}, swapped whole so a reader never sees half of it
    cache_lock = threading.Lock()

    def load_board() -> dict:
        """The saved board, parsed once per upload (real boards run to tens of MB)."""
        if not board_path.is_file():
            raise HTTPException(409, "upload a board first")
        with cache_lock:
            mtime = board_path.stat().st_mtime_ns
            cached = cache.get("board")
            if cached is None or cached[0] != mtime:
                cached = cache["board"] = (mtime, json.loads(board_path.read_text()))
            return cached[1]

    def board_info() -> dict | None:
        if not board_path.is_file() or not meta_path.is_file():
            return None
        meta = json.loads(meta_path.read_text())
        saved = datetime.fromtimestamp(board_path.stat().st_mtime, timezone.utc)
        return {"saved_at": saved.isoformat(), "projections": meta["projections"]}

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/api/options")
    def options() -> dict:
        defaults = cli.parse_args([])
        table = load_payouts(config_file(root, "payouts.json"))
        return {
            "sports": cli.SPORTS,
            "devig": list(DEVIG_METHODS),
            "ref_slips": [f"{t}{n}" for t in table for n in sorted(table[t])],
            "defaults": {"sports": defaults.sports, "hours": defaults.hours, "stake": defaults.stake,
                         "devig": defaults.devig, "ref_slip": None},
        }

    @app.get("/api/board")
    def get_board() -> dict:
        info = board_info()
        if info is None:
            raise HTTPException(404, "no board uploaded yet")
        return info

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
            payload = json.loads(raw)
        except ValueError:
            payload = None
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
            raise HTTPException(422, "that file isn't a PrizePicks projections feed (expected a JSON object with a \"data\" list)")

        data_dir.mkdir(parents=True, exist_ok=True)
        tmp = board_path.with_suffix(".tmp")
        tmp.write_bytes(raw)
        meta_path.write_text(json.dumps({"projections": len(payload["data"]), "filename": file.filename}))
        with cache_lock:
            tmp.replace(board_path)
            cache["board"] = (board_path.stat().st_mtime_ns, payload)
        return board_info()

    @app.post("/api/run", response_model=None)
    def run(request: Request, settings: Annotated[RunSettings | None, Body()] = None):
        if not board_path.is_file():
            raise HTTPException(409, "upload a board before running")
        payload = load_board()
        args = (settings or RunSettings()).apply(cli.parse_args([]))

        def report(progress: Progress | None = None) -> dict:
            http = Http(data_dir / "cache", use_cache=not args.no_cache, progress=progress)
            result = cli.report_for(args, root, payload, http, now(), collect=collect)
            age = (now().timestamp() - board_path.stat().st_mtime) / 60
            if age > cli.STALE_MINUTES:
                result["warnings"].insert(0, f"board is {age:.0f} minutes old; PrizePicks lines may have moved")
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
