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


def feed(payload=None):
    """A partner feed that answers with this board (the fixture board by default)."""
    return lambda: payload or pp_payload()


def feed_down(reason="HTTP 503 from the partner feed"):
    """A partner feed that can't be reached."""
    from ppopt.sources.http import FetchError

    def fetch():
        raise FetchError(reason)

    return fetch


def engine_app(tmp_path, collect=None, fetch_board=None):
    collect = collect or (lambda *a: (markets(), []))
    return TestClient(create_app(static_dir=tmp_path, data_dir=tmp_path / "data", root=ROOT,
                                 collect=collect, now=lambda: NOW, fetch_board=fetch_board or feed()))


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


def test_run_without_a_board_or_a_feed_fails_asking_for_an_upload_with_the_reason(tmp_path):
    r = engine_app(tmp_path, fetch_board=feed_down()).post("/api/run")
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "partner feed" in detail and "HTTP 503 from the partner feed" in detail and "upload" in detail


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


def test_a_failed_fetch_falls_back_to_the_saved_board_with_one_warning_saying_why_and_how_old(tmp_path):
    client = engine_app(tmp_path, fetch_board=feed_down())
    upload(client)
    board = tmp_path / "data" / "board.json"
    old = NOW.timestamp() - 45 * 60
    os.utime(board, (old, old))
    r = client.post("/api/run")
    assert r.status_code == 200
    warnings = r.json()["warnings"]
    first = warnings[0]
    assert "partner feed" in first and "HTTP 503 from the partner feed" in first
    assert "saved board" in first and "uploaded 45 minutes ago" in first and "may have moved" in first
    assert not any("minutes" in w for w in warnings[1:]), "the board's age is warned about twice"
    assert client.get("/api/board").json()["source"] == "uploaded"


def test_a_fallback_to_a_fresh_saved_board_still_says_the_fetch_failed(tmp_path):
    client = engine_app(tmp_path, fetch_board=feed_down())
    upload(client)
    board = tmp_path / "data" / "board.json"
    recent = NOW.timestamp() - 5 * 60
    os.utime(board, (recent, recent))
    first = client.post("/api/run").json()["warnings"][0]
    assert "partner feed" in first and "uploaded 5 minutes ago" in first
    assert "may have moved" not in first


def test_a_fallback_board_names_where_it_came_from(tmp_path):
    from ppopt.web import create_app as make

    data = tmp_path / "data"
    fetched = TestClient(make(static_dir=tmp_path, data_dir=data, root=ROOT, collect=lambda *a: (markets(), []),
                              now=lambda: NOW, fetch_board=feed()))
    assert fetched.post("/api/board/fetch").status_code == 200
    down = engine_app(tmp_path, fetch_board=feed_down())
    assert "fetched" in down.post("/api/run").json()["warnings"][0]


def test_every_run_fetches_a_fresh_board_and_saves_it(tmp_path):
    client = engine_app(tmp_path)
    r = client.post("/api/run")
    assert r.status_code == 200 and r.json()["legs"]
    info = client.get("/api/board").json()
    assert info["source"] == "fetched"
    assert info["projections"] == len(pp_payload()["data"])
    assert json.loads((tmp_path / "data" / "board.json").read_text()) == pp_payload()
    assert not any("partner feed" in w for w in r.json()["warnings"])


def test_a_run_prices_the_fetched_board_over_an_uploaded_one(tmp_path):
    client = engine_app(tmp_path)
    nba_only = pp_payload()
    nba_only["data"] = [p for p in nba_only["data"]
                        if p["relationships"]["league"]["data"]["id"] == "7"]
    upload(client, nba_only)
    assert client.get("/api/board").json()["source"] == "uploaded"
    report = client.post("/api/run").json()
    assert "NFL" in {l["sport"] for l in report["legs"]}
    assert client.get("/api/board").json()["source"] == "fetched"


def test_odds_file_replaces_live_books(tmp_path, monkeypatch):
    from ppopt.web import markets_from_file

    rows = [{"book": m.book, "sport": m.sport, "teams": sorted(m.teams), "player": m.player, "stat": m.stat,
             "line": m.line, "over_odds": m.over_odds, "under_odds": m.under_odds} for m in markets()]
    f = tmp_path / "markets.json"
    f.write_text(json.dumps(rows))
    collect = markets_from_file(f)
    got, warnings = collect(None, None, {}, ["NFL", "NBA"], NOW, 24, set())
    assert got == markets() and warnings == []


# --- run settings ------------------------------------------------------------

import pytest


def test_options_come_from_the_engine(tmp_path):
    opts = engine_app(tmp_path).get("/api/options").json()
    assert opts["sports"] == ["NFL", "NBA", "NHL", "MLB"]
    assert opts["devig"] == ["worst", "multiplicative", "additive", "power", "shin"]
    assert opts["ref_slips"] == [f"{t}{n}" for t in ("power", "flex") for n in range(2, 7)]
    assert opts["defaults"] == {"sports": ["NFL", "NBA", "NHL", "MLB"], "hours": 24, "stake": 10.0,
                                "devig": "worst", "ref_slip": None}


def test_run_applies_settings(tmp_path):
    seen = {}

    def collect(http, cfg, books, sports, now, hours, needs):
        seen.update(sports=sports, hours=hours, use_cache=http.use_cache)
        return markets(), []

    client = engine_app(tmp_path, collect=collect)
    upload(client)
    body = {"sports": ["NBA"], "stake": 20, "hours": 12, "devig": "shin", "ref_slip": "flex6", "no_cache": True}
    report = client.post("/api/run", json=body).json()

    assert seen == {"sports": ["NBA"], "hours": 12, "use_cache": False}
    assert report["settings"] == {"sports": ["NBA"], "hours": 12, "stake": 20.0, "devig": "shin", "mode": "cash"}
    assert report["ref_slip"]["type"] == "flex" and report["ref_slip"]["size"] == 6
    assert {l["sport"] for l in report["legs"]} == {"NBA"}


def test_run_accepts_worst_case_devig(tmp_path):
    client = engine_app(tmp_path)
    upload(client)
    report = client.post("/api/run", json={"devig": "worst"}).json()
    assert report["settings"]["devig"] == "worst"


def test_run_settings_are_all_optional(tmp_path):
    client = engine_app(tmp_path)
    upload(client)
    report = client.post("/api/run", json={"stake": 5}).json()
    assert report["settings"]["stake"] == 5.0
    assert report["settings"]["sports"] == ["NFL", "NBA", "NHL", "MLB"]


@pytest.mark.parametrize("body", [
    {"sports": []},
    {"sports": ["XFL"]},
    {"stake": 0},
    {"hours": -1},
    {"devig": "magic"},
    {"ref_slip": "power9"},
    {"surprise": 1},
])
def test_run_rejects_bad_settings(tmp_path, body):
    client = engine_app(tmp_path)
    upload(client)
    r = client.post("/api/run", json=body)
    assert r.status_code == 422, body


# --- promotions --------------------------------------------------------------

def ran(tmp_path, body):
    client = engine_app(tmp_path)
    upload(client)
    return client.post("/api/run", json=body)


def test_bonus_entry(tmp_path):
    report = ran(tmp_path, {"bonus": True}).json()
    assert report["settings"]["mode"] == "bonus"
    assert all(s["type"] == "power" for s in report["slips"])


def test_boost(tmp_path):
    plain = ran(tmp_path, {"feed_promos": False}).json()
    boosted = ran(tmp_path, {"boost": 1.5}).json()
    assert boosted["settings"]["mode"] == "boost 1.5x"
    best = lambda r: max(s["ev"] for s in r["slips"] if s["type"] == "power" and s["size"] == 2)
    assert best(boosted) > best(plain)


def test_feed_promos_can_be_turned_off(tmp_path):
    assert any(l["promo_type"] == "taco" for l in ran(tmp_path, {}).json()["legs"])
    assert not any(l["promo_type"] for l in ran(tmp_path, {"feed_promos": False}).json()["legs"])


def test_promo_legs_are_priced(tmp_path):
    leg = {"sport": "NBA", "matchup": "CLE vs PHI", "player": "Joel Embiid",
           "stat_label": "Pts+Rebs+Asts", "side": "over", "line": 30.5}
    report = ran(tmp_path, {"promo_legs": [leg]}).json()
    manual = [l for l in report["legs"] if l["promo_type"] == "manual"]
    assert len(manual) == 1 and manual[0]["line"] == 30.5 and manual[0]["side"] == "over"


def test_unpriceable_promo_leg_is_422_with_the_engine_message(tmp_path):
    leg = {"sport": "NFL", "matchup": "CHI vs NE", "player": "Nobody",
           "stat_label": "Pass Yards", "side": "over", "line": 200.5}
    r = ran(tmp_path, {"promo_legs": [leg]})
    assert r.status_code == 422 and "Nobody" in r.json()["detail"]


@pytest.mark.parametrize("body", [
    {"bonus": True, "boost": 1.4},
    {"bonus": True, "promo_legs": [{"sport": "NBA", "matchup": "CLE vs PHI", "player": "Joel Embiid",
                                    "stat_label": "Points", "side": "over", "line": 20.5}]},
    {"boost": 1.0},
    {"promo_legs": [{"sport": "NBA", "matchup": "CLE vs PHI", "player": "Joel Embiid",
                     "stat_label": "Points", "side": "sideways", "line": 20.5}]},
])
def test_bad_promotions_are_422(tmp_path, body):
    assert ran(tmp_path, body).status_code == 422, body


def test_board_lines_list_priceable_lines_in_the_window(tmp_path):
    client = engine_app(tmp_path)
    assert client.get("/api/board/lines").status_code == 409
    upload(client)
    lines = client.get("/api/board/lines").json()
    assert {"sport": "NFL", "matchup": "CHI vs NE", "player": "Drake Maye",
            "stat_label": "Pass Yards", "line": 249.5} in lines
    assert lines == sorted(lines, key=lambda l: (l["player"], l["stat_label"], l["line"]))
    assert len({tuple(l.values()) for l in lines}) == len(lines)

    nba = client.get("/api/board/lines", params={"sports": "NBA", "hours": 24}).json()
    assert nba and {l["sport"] for l in nba} == {"NBA"}
    assert client.get("/api/board/lines", params={"hours": 0.0001}).json() == []


# --- streamed progress -------------------------------------------------------

NDJSON = {"Accept": "application/x-ndjson"}


def stream(client, body=None):
    r = client.post("/api/run", json=body or {}, headers=NDJSON)
    assert r.headers["content-type"].startswith("application/x-ndjson")
    return r, [json.loads(line) for line in r.text.splitlines() if line]


def test_run_streams_progress_then_the_report(tmp_path):
    client = engine_app(tmp_path)
    upload(client)
    r, events = stream(client)
    assert r.status_code == 200
    progress = [e for e in events if e["type"] == "progress"]
    assert progress and all({"done", "total", "step"} <= set(e) for e in progress)
    assert progress[0] == {"type": "progress", "done": 0, "total": 0, "step": "Fetching the PrizePicks board"}
    assert progress[1]["done"] == 0 and progress[1]["total"] > 0
    assert progress[-1]["step"] == "Pricing lines and building slips"
    assert events[-1]["type"] == "report"
    assert events[-1]["report"]["legs"]


def test_streamed_engine_errors_end_the_stream(tmp_path):
    client = engine_app(tmp_path, collect=lambda *a: ([], ["draftkings unavailable: blocked"]))
    upload(client)
    _, events = stream(client)
    assert events[-1] == {"type": "error", "detail": "no sportsbook odds available: draftkings unavailable: blocked"}


def test_problems_found_before_running_are_still_plain_http_errors(tmp_path):
    client = engine_app(tmp_path)
    assert client.post("/api/run", json={"stake": 0}, headers=NDJSON).status_code == 422


def test_a_streamed_run_with_no_feed_and_no_board_ends_in_an_error_asking_for_an_upload(tmp_path):
    client = engine_app(tmp_path, fetch_board=feed_down())
    _, events = stream(client)
    assert events[0]["step"] == "Fetching the PrizePicks board"
    assert events[-1]["type"] == "error"
    assert "HTTP 503 from the partner feed" in events[-1]["detail"] and "upload" in events[-1]["detail"]


def test_a_streamed_fallback_run_leads_its_warnings_with_the_failed_fetch(tmp_path):
    client = engine_app(tmp_path, fetch_board=feed_down())
    upload(client)
    _, events = stream(client)
    assert events[-1]["type"] == "report"
    assert "partner feed" in events[-1]["report"]["warnings"][0]


def test_a_streamed_run_announces_the_fetched_board_as_soon_as_it_is_saved(tmp_path):
    client = engine_app(tmp_path)
    _, events = stream(client)
    at = [i for i, e in enumerate(events) if e["type"] == "board"]
    assert len(at) == 1
    board = events[at[0]]["board"]
    assert board == client.get("/api/board").json() and board["source"] == "fetched"
    # Straight after the board step: before any sportsbook request is planned.
    assert [e["step"] for e in events[:at[0]]] == ["Fetching the PrizePicks board"]


def test_a_streamed_fallback_run_announces_no_board(tmp_path):
    client = engine_app(tmp_path, fetch_board=feed_down())
    upload(client)
    _, events = stream(client)
    assert events[-1]["type"] == "report"
    assert not [e for e in events if e["type"] == "board"]


# --- review fixes --------------------------------------------------------------

def test_closing_the_stream_cancels_the_run():
    import threading

    from ppopt.progress import RunCancelled
    from ppopt.web import stream_run

    finished = threading.Event()

    def work(progress, announce):
        try:
            while True:
                progress.tick()  # a request every loop, like a book fetching props
                threading.Event().wait(0.01)
        except RunCancelled:
            finished.set()
            raise

    lines = stream_run(work)
    first = json.loads(next(lines))
    assert first["type"] == "progress"
    lines.close()  # what Starlette does when the client goes away
    assert finished.wait(2), "the worker kept running after the stream closed"


def test_upload_primes_the_board_cache(tmp_path, monkeypatch):
    client = engine_app(tmp_path)
    upload(client)
    real = json.loads
    parsed = []
    monkeypatch.setattr("ppopt.web.json.loads", lambda s, *a, **k: parsed.append(len(s)) or real(s, *a, **k))
    client.get("/api/board/lines")
    board_size = (tmp_path / "data" / "board.json").stat().st_size
    assert board_size not in parsed, "the board was parsed again after upload"


# --- live requests -------------------------------------------------------------

def _books_app(tmp_path, monkeypatch):
    """An app whose collector fetches one sportsbook URL through the run's Http (fake network)."""
    import functools

    from ppopt import web
    from ppopt.sources.http import Http

    monkeypatch.setattr(web, "Http", functools.partial(Http, fetch=lambda url: (200, b"{}"),
                                                       sleep=lambda s: None))

    def collect(http, *a):
        http.get_json("https://book.test/odds")
        return markets(), []

    client = engine_app(tmp_path, collect=collect)
    upload(client)
    return client


def test_run_reports_live_requests_and_a_cached_rerun_reports_none(tmp_path, monkeypatch):
    client = _books_app(tmp_path, monkeypatch)
    assert client.post("/api/run").json()["live_requests"] == 1
    assert client.post("/api/run").json()["live_requests"] == 0
    assert client.post("/api/run", json={"no_cache": True}).json()["live_requests"] == 1


def test_streamed_report_carries_live_requests(tmp_path, monkeypatch):
    client = _books_app(tmp_path, monkeypatch)
    _, events = stream(client)
    assert events[-1]["type"] == "report"
    assert events[-1]["report"]["live_requests"] == 1


def test_canned_odds_count_as_live(tmp_path, monkeypatch):
    rows = [{"book": m.book, "sport": m.sport, "teams": sorted(m.teams), "player": m.player, "stat": m.stat,
             "line": m.line, "over_odds": m.over_odds, "under_odds": m.under_odds} for m in markets()]
    f = tmp_path / "markets.json"
    f.write_text(json.dumps(rows))
    monkeypatch.setenv("PPOPT_ODDS_FILE", str(f))
    client = TestClient(create_app(static_dir=tmp_path, data_dir=tmp_path / "data", root=ROOT, now=lambda: NOW,
                                   fetch_board=feed()))
    upload(client)
    assert client.post("/api/run").json()["live_requests"] >= 1
    assert client.post("/api/run").json()["live_requests"] >= 1  # canned odds are never a cached run


def test_concurrent_board_uploads_all_succeed(tmp_path):
    """Two browsers saving a board at once must not trip over each other's half-written file."""
    from concurrent.futures import ThreadPoolExecutor

    client = engine_app(tmp_path)
    with ThreadPoolExecutor(8) as pool:
        codes = list(pool.map(lambda _: upload(client).status_code, range(40)))
    assert codes == [200] * 40
    assert json.loads((tmp_path / "data" / "board.json").read_text())["data"]
    assert not list((tmp_path / "data").glob("*.tmp"))


# --- board from the partner feed (Sprint 8) ---------------------------------------

def test_an_uploaded_board_says_so(tmp_path):
    client = engine_app(tmp_path)
    assert upload(client).json()["source"] == "uploaded"
    assert client.get("/api/board").json()["source"] == "uploaded"


def test_a_board_saved_before_sources_were_recorded_reads_as_uploaded(tmp_path):
    client = engine_app(tmp_path)
    upload(client)
    meta = tmp_path / "data" / "board.meta.json"
    meta.write_text(json.dumps({"projections": 11, "filename": "projections.json"}))
    assert client.get("/api/board").json()["source"] == "uploaded"


def test_fetching_the_board_now_saves_it_and_returns_its_info(tmp_path):
    client = engine_app(tmp_path)
    r = client.post("/api/board/fetch")
    assert r.status_code == 200
    info = r.json()
    assert info["source"] == "fetched" and info["projections"] == len(pp_payload()["data"])
    assert datetime.fromisoformat(info["saved_at"]).tzinfo is not None
    assert client.get("/api/board").json() == info
    assert client.get("/api/board/lines").json(), "the fetched board feeds the promo-leg picker"


def test_a_failed_fetch_now_is_502_with_the_reason_and_keeps_the_saved_board(tmp_path):
    client = engine_app(tmp_path, fetch_board=feed_down())
    before = upload(client).json()
    r = client.post("/api/board/fetch")
    assert r.status_code == 502
    assert "partner feed" in r.json()["detail"] and "HTTP 503 from the partner feed" in r.json()["detail"]
    assert client.get("/api/board").json() == before


def test_a_fetch_that_answers_with_something_other_than_a_feed_is_a_failure(tmp_path):
    client = engine_app(tmp_path, fetch_board=lambda: {"hello": 1})
    r = client.post("/api/board/fetch")
    assert r.status_code == 502 and "projections feed" in r.json()["detail"]
    assert client.get("/api/board").status_code == 404


def test_fetches_runs_and_uploads_never_write_the_board_at_once(tmp_path):
    """Two fetches, or a fetch during a run's own fetch, must not interleave their writes."""
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor

    lock, state = threading.Lock(), {"now": 0, "peak": 0}

    def slow_feed():
        with lock:
            state["now"] += 1
            state["peak"] = max(state["peak"], state["now"])
        time.sleep(0.02)
        with lock:
            state["now"] -= 1
        return pp_payload()

    client = engine_app(tmp_path, fetch_board=slow_feed)
    calls = [lambda: client.post("/api/board/fetch"), lambda: client.post("/api/run"), lambda: upload(client)] * 6
    with ThreadPoolExecutor(8) as pool:
        codes = [r.status_code for r in pool.map(lambda call: call(), calls)]
    assert codes == [200] * len(calls)
    assert state["peak"] == 1
    assert not list((tmp_path / "data").glob("*.tmp"))


def test_the_run_saves_its_board_into_the_cache(tmp_path, monkeypatch):
    client = engine_app(tmp_path)
    client.post("/api/run")
    real = json.loads
    parsed = []
    monkeypatch.setattr("ppopt.web.json.loads", lambda s, *a, **k: parsed.append(len(s)) or real(s, *a, **k))
    client.get("/api/board/lines")
    board_size = (tmp_path / "data" / "board.json").stat().st_size
    assert board_size not in parsed, "the fetched board was parsed again"


def test_board_file_env_stands_in_for_the_partner_feed(tmp_path, monkeypatch):
    feed_file = tmp_path / "feed" / "projections.json"
    monkeypatch.setenv("PPOPT_BOARD_FILE", str(feed_file))
    client = TestClient(create_app(static_dir=tmp_path, data_dir=tmp_path / "data", root=ROOT,
                                   collect=lambda *a: (markets(), []), now=lambda: NOW))

    missing = client.post("/api/board/fetch")
    assert missing.status_code == 502 and str(feed_file) in missing.json()["detail"]

    feed_file.parent.mkdir()
    feed_file.write_text("<html>blocked</html>")
    bad = client.post("/api/board/fetch")
    assert bad.status_code == 502 and "projections feed" in bad.json()["detail"]

    feed_file.write_text(json.dumps(pp_payload()))
    assert client.post("/api/board/fetch").json()["source"] == "fetched"
    assert client.post("/api/run").status_code == 200


def test_the_default_fetch_goes_to_the_partner_feed(tmp_path, monkeypatch):
    from ppopt import web

    monkeypatch.delenv("PPOPT_BOARD_FILE", raising=False)
    seen = []
    monkeypatch.setattr(web.prizepicks, "fetch", lambda http: seen.append(http) or pp_payload())
    client = TestClient(create_app(static_dir=tmp_path, data_dir=tmp_path / "data", root=ROOT, now=lambda: NOW))
    assert client.post("/api/board/fetch").status_code == 200
    assert len(seen) == 1 and seen[0].progress is None, "the board fetch must not count as a sportsbook request"


def test_a_network_error_on_the_default_fetch_is_a_fetch_failure(tmp_path, monkeypatch):
    from ppopt import web

    monkeypatch.delenv("PPOPT_BOARD_FILE", raising=False)

    def broken(http):
        raise ConnectionError("connection reset by peer")

    monkeypatch.setattr(web.prizepicks, "fetch", broken)
    client = TestClient(create_app(static_dir=tmp_path, data_dir=tmp_path / "data", root=ROOT, now=lambda: NOW))
    r = client.post("/api/board/fetch")
    assert r.status_code == 502 and "connection reset by peer" in r.json()["detail"]


def test_options_name_the_app_feed_for_saving_a_board_by_hand(tmp_path):
    from ppopt.sources import prizepicks

    assert engine_app(tmp_path).get("/api/options").json()["board_app_url"] == prizepicks.APP_URL
