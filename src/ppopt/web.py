"""HTTP front door to the ppopt engine. Serves the JSON API under /api and the built SPA everywhere else."""

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

DEFAULT_STATIC = Path(__file__).resolve().parents[2] / "web" / "dist"


def create_app(static_dir: Path | None = None) -> FastAPI:
    static_dir = Path(static_dir or os.environ.get("PPOPT_WEB_DIST") or DEFAULT_STATIC)
    app = FastAPI(title="PrizePicks EV Optimizer")

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/api/{rest:path}", include_in_schema=False)
    def api_not_found(rest: str):
        raise HTTPException(404, "not found")

    @app.get("/{rest:path}", include_in_schema=False)
    def spa(rest: str):
        root = static_dir.resolve()
        candidate = (root / rest).resolve()
        if rest and candidate.is_file() and root in candidate.parents:
            return FileResponse(candidate)
        index = root / "index.html"
        if not index.is_file():
            raise HTTPException(404, "UI not built: run `npm run build` in web/")
        return FileResponse(index)

    return app


app = create_app()
