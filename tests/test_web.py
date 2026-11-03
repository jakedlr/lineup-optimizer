from fastapi.testclient import TestClient

from ppopt.web import create_app


def test_health_reports_ok():
    client = TestClient(create_app())
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_serves_spa_index_when_built(tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><title>PP</title>")
    client = TestClient(create_app(static_dir=tmp_path))
    r = client.get("/")
    assert r.status_code == 200
    assert "<title>PP</title>" in r.text


def test_unknown_client_routes_fall_back_to_index(tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><title>PP</title>")
    client = TestClient(create_app(static_dir=tmp_path))
    assert "<title>PP</title>" in client.get("/some/client/route").text


def test_unknown_api_routes_are_404_not_index(tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><title>PP</title>")
    client = TestClient(create_app(static_dir=tmp_path))
    assert client.get("/api/nope").status_code == 404


def test_static_dir_comes_from_env_when_not_given(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("<!doctype html><title>FROM ENV</title>")
    monkeypatch.setenv("PPOPT_WEB_DIST", str(tmp_path))
    client = TestClient(create_app())
    assert "<title>FROM ENV</title>" in client.get("/").text


# --- board and run -----------------------------------------------------------

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from tests.test_cli import NOW, markets, pp_payload

ROOT = Path(__file__).resolve().parents[1]


def engine_app(tmp_path, collect=None):
    collect = collect or (lambda *a: (markets(), []))
    return TestClient(create_app(static_dir=tmp_path, data_dir=tmp_path / "data", root=ROOT,
                                 collect=collect, now=lambda: NOW))


def upload(client, payload=None, raw=None):
    body = raw if raw is not None else json.dumps(payload or pp_payload()).encode()
    return client.put("/api/board", files={"file": ("projections.json", body, "application/json")})


def test_no_board_yet_is_404(tmp_path):
    assert engine_app(tmp_path).get("/api/board").status_code == 404


def test_uploaded_board_persists_to_the_data_dir_and_reports_its_age(tmp_path):
    client = engine_app(tmp_path)
    r = upload(client)
    assert r.status_code == 200
    info = r.json()
    assert info["projections"] == len(pp_payload()["data"])
    saved = datetime.fromisoformat(info["saved_at"])
    assert saved.tzinfo is not None
    assert json.loads((tmp_path / "data" / "board.json").read_text()) == pp_payload()

    again = engine_app(tmp_path).get("/api/board")  # a fresh app sees the same volume
    assert again.json() == info


def test_board_must_be_a_prizepicks_projections_feed(tmp_path):
    client = engine_app(tmp_path)
    for raw in (b"not json", b'{"hello": 1}', b"[]"):
        r = upload(client, raw=raw)
        assert r.status_code == 422, raw
        assert "PrizePicks" in r.json()["detail"]
    assert client.get("/api/board").status_code == 404


def test_run_without_a_board_is_409(tmp_path):
    r = engine_app(tmp_path).post("/api/run")
    assert r.status_code == 409
    assert "board" in r.json()["detail"].lower()


def test_run_returns_the_report_with_defaults(tmp_path):
    client = engine_app(tmp_path)
    upload(client)
    r = client.post("/api/run")
    assert r.status_code == 200
    report = r.json()
    assert report["settings"]["stake"] == 10.0
    assert report["settings"]["sports"] == ["NFL", "NBA", "NHL", "MLB"]
    assert report["legs"] and report["slips"]
    assert report["legs"][0]["matchup"]
    assert sum(report["unmatched"].values()) > 0


def test_run_engine_errors_are_422_with_the_message(tmp_path):
    client = engine_app(tmp_path, collect=lambda *a: ([], ["draftkings unavailable: blocked"]))
    upload(client)
    r = client.post("/api/run")
    assert r.status_code == 422
    assert "draftkings unavailable: blocked" in r.json()["detail"]


def test_run_warns_when_the_board_is_stale(tmp_path):
    client = engine_app(tmp_path)
    upload(client)
    board = tmp_path / "data" / "board.json"
    old = NOW.timestamp() - 45 * 60
    os.utime(board, (old, old))
    warnings = client.post("/api/run").json()["warnings"]
    assert any("45 minutes old" in w for w in warnings)


def test_odds_file_replaces_live_books(tmp_path, monkeypatch):
    from ppopt.web import markets_from_file

    rows = [{"book": m.book, "sport": m.sport, "teams": sorted(m.teams), "player": m.player, "stat": m.stat,
             "line": m.line, "over_odds": m.over_odds, "under_odds": m.under_odds} for m in markets()]
    f = tmp_path / "markets.json"
    f.write_text(json.dumps(rows))
    collect = markets_from_file(f)
    got, warnings = collect(None, None, {}, ["NFL", "NBA"], NOW, 24, set())
    assert got == markets() and warnings == []
