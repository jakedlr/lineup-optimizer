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
from datetime import datetime, timezone
from pathlib import Path

from typing import Annotated, Literal

from fastapi import Body, FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from . import cli
from .models import BookMarket
from .odds import DEVIG_METHODS
from .payouts import load_payouts
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


class RunSettings(BaseModel):
    """What the web app may change about a run. Anything left out takes the CLI default."""

    model_config = ConfigDict(extra="forbid")

    sports: list[Literal[tuple(cli.SPORTS)]] | None = Field(None, min_length=1)
    stake: float | None = Field(None, gt=0)
    hours: float | None = Field(None, gt=0)
    devig: Literal[DEVIG_METHODS] | None = None
    ref_slip: str | None = Field(None, pattern=r"^(power|flex)[2-6]$")
    no_cache: bool = False

    def apply(self, args):
        for name in ("sports", "stake", "hours", "devig"):
            if (value := getattr(self, name)) is not None:
                setattr(args, name, value)
        if self.ref_slip:
            args.ref_slip = (self.ref_slip[:-1], int(self.ref_slip[-1]))
        args.no_cache = self.no_cache
        return args


def create_app(static_dir=None, data_dir=None, root=None, collect=None, now=None) -> FastAPI:
    static_dir = Path(static_dir or os.environ.get("PPOPT_WEB_DIST") or DEFAULT_STATIC)
    data_dir = Path(data_dir or os.environ.get("PPOPT_DATA") or REPO / "data")
    root = Path(root or os.environ.get("PPOPT_ROOT") or cli.ROOT)
    if collect is None and os.environ.get("PPOPT_ODDS_FILE"):
        collect = markets_from_file(os.environ["PPOPT_ODDS_FILE"])
    now = now or cli.utcnow

    board_path, meta_path = data_dir / BOARD, data_dir / BOARD_META
    app = FastAPI(title="PrizePicks EV Optimizer")

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
        table = load_payouts(root / "payouts.json")
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

    @app.put("/api/board")
    async def put_board(file: UploadFile) -> dict:
        raw = await file.read()
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
        tmp.replace(board_path)
        return board_info()

    @app.post("/api/run")
    def run(settings: Annotated[RunSettings | None, Body()] = None) -> dict:
        if not board_path.is_file():
            raise HTTPException(409, "upload a board before running")
        payload = json.loads(board_path.read_text())
        args = (settings or RunSettings()).apply(cli.parse_args([]))
        http = Http(data_dir / "cache", use_cache=not args.no_cache)
        try:
            report = cli.report_for(args, root, payload, http, now(), collect=collect)
        except cli.UserError as e:
            raise HTTPException(422, str(e)) from e

        age = (now().timestamp() - board_path.stat().st_mtime) / 60
        if age > cli.STALE_MINUTES:
            report["warnings"].insert(0, f"board is {age:.0f} minutes old; PrizePicks lines may have moved")
        return report

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
