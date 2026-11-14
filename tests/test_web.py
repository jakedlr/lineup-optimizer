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
    """A partner feed that answers with this board (the fixture board by default), as raw bytes."""
    return lambda progress=None: json.dumps(payload or pp_payload()).encode()


def feed_down(reason="HTTP 503 from the partner feed"):
    """A partner feed that can't be reached."""
    from ppopt.sources.http import FetchError

    def fetch(progress=None):
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
    assert "saved board" in first and "uploaded 45 min ago" in first and "may have moved" in first
    assert not any("min ago" in w or "minutes" in w for w in warnings[1:]), "the board's age is warned about twice"
    assert client.get("/api/board").json()["source"] == "uploaded"


def test_a_fallback_to_a_fresh_saved_board_still_says_the_fetch_failed(tmp_path):
    client = engine_app(tmp_path, fetch_board=feed_down())
    upload(client)
    board = tmp_path / "data" / "board.json"
    recent = NOW.timestamp() - 5 * 60
    os.utime(board, (recent, recent))
    first = client.post("/api/run").json()["warnings"][0]
    assert "partner feed" in first and "uploaded 5 min ago" in first
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
    client = engine_app(tmp_path, fetch_board=lambda progress=None: b'{"hello": 1}')
    r = client.post("/api/board/fetch")
    assert r.status_code == 502 and "projections feed" in r.json()["detail"]
    assert client.get("/api/board").status_code == 404


def test_fetches_runs_and_uploads_never_write_the_board_at_once(tmp_path):
    """Two fetches, or a fetch during a run's own fetch, must not interleave their writes."""
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor

    lock, state = threading.Lock(), {"now": 0, "peak": 0}

    def slow_feed(progress=None):
        with lock:
            state["now"] += 1
            state["peak"] = max(state["peak"], state["now"])
        time.sleep(0.02)
        with lock:
            state["now"] -= 1
        return json.dumps(pp_payload()).encode()

    client = engine_app(tmp_path, fetch_board=slow_feed)
    calls = [lambda: client.post("/api/board/fetch"), lambda: client.post("/api/run"), lambda: upload(client)] * 6
    with ThreadPoolExecutor(8) as pool:
        codes = [r.status_code for r in pool.map(lambda call: call(), calls)]
    runs = codes[1::3]
    assert 200 in runs and set(runs) <= {200, 409}, "one run at a time: the others are refused"
    assert codes[0::3] + codes[2::3] == [200] * 12
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
    raw = json.dumps(pp_payload()).encode()
    monkeypatch.setattr(web.prizepicks, "fetch_raw", lambda http: seen.append(http) or raw)
    client = TestClient(create_app(static_dir=tmp_path, data_dir=tmp_path / "data", root=ROOT, now=lambda: NOW))
    assert client.post("/api/board/fetch").status_code == 200
    assert len(seen) == 1 and seen[0].progress is None, "the board fetch must not count as a sportsbook request"


def test_a_network_error_on_the_default_fetch_is_a_fetch_failure(tmp_path, monkeypatch):
    import functools

    from ppopt import web

    monkeypatch.delenv("PPOPT_BOARD_FILE", raising=False)

    def broken(url):
        raise ConnectionError("connection reset by peer")

    monkeypatch.setattr(web, "Http", functools.partial(web.Http, fetch=broken, sleep=lambda s: None))
    client = TestClient(create_app(static_dir=tmp_path, data_dir=tmp_path / "data", root=ROOT, now=lambda: NOW))
    r = client.post("/api/board/fetch")
    assert r.status_code == 502 and "connection reset by peer" in r.json()["detail"]


def test_options_name_the_app_feed_for_saving_a_board_by_hand(tmp_path):
    from ppopt.sources import prizepicks

    assert engine_app(tmp_path).get("/api/options").json()["board_app_url"] == prizepicks.APP_URL


# --- Sprint 8 review fixes (server) ----------------------------------------------

@pytest.mark.parametrize("minutes, words", [
    (0, "just now"), (0.9, "just now"), (1, "1 min ago"), (45, "45 min ago"), (59.9, "59 min ago"),
    (60, "1 h ago"), (150, "2 h ago"), (1439, "23 h ago"), (1440, "1 d ago"), (4400, "3 d ago"), (-5, "just now"),
])
def test_the_board_age_reads_as_the_page_says_it(minutes, words):
    from ppopt.web import ago

    assert ago(minutes) == words  # web/src/format.ts ago()


def test_a_fetched_board_is_saved_byte_for_byte(tmp_path):
    raw = json.dumps(pp_payload(), indent=1).encode()  # not how json.dumps would write it back
    client = engine_app(tmp_path, fetch_board=lambda progress=None: raw)
    assert client.post("/api/board/fetch").status_code == 200
    assert (tmp_path / "data" / "board.json").read_bytes() == raw
    client.post("/api/run", json={"no_cache": True})
    assert (tmp_path / "data" / "board.json").read_bytes() == raw


def test_the_board_file_stand_in_is_saved_byte_for_byte(tmp_path, monkeypatch):
    feed_file = tmp_path / "projections.json"
    feed_file.write_bytes(raw := json.dumps(pp_payload(), indent=2).encode())
    monkeypatch.setenv("PPOPT_BOARD_FILE", str(feed_file))
    client = TestClient(create_app(static_dir=tmp_path, data_dir=tmp_path / "data", root=ROOT,
                                   collect=lambda *a: (markets(), []), now=lambda: NOW))
    assert client.post("/api/board/fetch").status_code == 200
    assert (tmp_path / "data" / "board.json").read_bytes() == raw


class Clock:
    """Time that moves only when something sleeps."""

    def __init__(self):
        self.now, self.slept = 0.0, []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


def feed_app(tmp_path, monkeypatch, respond, clock=None, sleep=lambda s: None):
    """An app on the default board fetcher, whose network answers the partner feed with `respond(n)` (status and
    headers) on its nth request. Returns the client and the list of board requests made."""
    import functools

    from ppopt import web

    monkeypatch.delenv("PPOPT_BOARD_FILE", raising=False)
    calls = []

    def network(url):
        calls.append(url)
        status, headers = respond(len(calls))
        return status, json.dumps(pp_payload()).encode(), headers

    kw = {"sleep": clock.sleep, "clock": clock} if clock else {"sleep": sleep}
    monkeypatch.setattr(web, "Http", functools.partial(web.Http, fetch=network, **kw))
    client = TestClient(create_app(static_dir=tmp_path, data_dir=tmp_path / "data", root=ROOT,
                                   collect=lambda *a: (markets(), []), now=lambda: NOW))
    return client, calls


def test_board_requests_are_paced_across_runs(tmp_path, monkeypatch):
    clock = Clock()
    client, calls = feed_app(tmp_path, monkeypatch, lambda n: (200, {}), clock)
    for _ in range(3):
        assert client.post("/api/run", json={"no_cache": True}).json()["warnings"] == []
    assert len(calls) == 3
    assert len(clock.slept) == 2 and all(1 <= s <= 2 for s in clock.slept), "one at a time, 1-2 s apart"


@pytest.mark.parametrize("status", [429, 403])
def test_a_pushed_back_board_request_is_retried_after_the_wait_it_asks_for(tmp_path, monkeypatch, status):
    clock = Clock()
    client, calls = feed_app(tmp_path, monkeypatch,
                             lambda n: (status, {"Retry-After": "3"}) if n == 1 else (200, {}), clock)
    r = client.post("/api/run")
    assert r.json()["warnings"] == [], "no fallback: the retry fetched the board"
    assert len(calls) == 2 and clock.slept[0] >= (3 if status == 429 else 1)
    assert client.get("/api/board").json()["source"] == "fetched"
    assert r.json()["timing"]["books"] == {}, "the board request is not a sportsbook in the run's timing"


def test_a_board_request_asked_to_wait_too_long_falls_back_saying_so(tmp_path, monkeypatch):
    client, calls = feed_app(tmp_path, monkeypatch, lambda n: (429, {"Retry-After": "120"}))
    upload(client)
    first = client.post("/api/run").json()["warnings"][0]
    assert "rate-limited" in first and "asked to wait 120s" in first and len(calls) == 1


def counting_feed():
    """A partner feed that counts the requests it answers."""
    calls = []

    def fetch(progress=None):
        calls.append(1)
        return json.dumps(pp_payload()).encode()

    return fetch, calls


def age_board(tmp_path, seconds):
    """Make the saved board `seconds` old, as the app's clock (NOW) sees it."""
    board = tmp_path / "data" / "board.json"
    os.utime(board, (NOW.timestamp() - seconds, NOW.timestamp() - seconds))


def test_a_fetched_board_is_reused_for_as_long_as_the_odds_cache_keeps_a_response(tmp_path):
    from ppopt import web
    from ppopt.sources.http import REUSE_SECONDS, Http

    assert web.REUSE_SECONDS is REUSE_SECONDS and Http(tmp_path).ttl == REUSE_SECONDS == 60


@pytest.mark.parametrize("age, fetched_again", [(55, False), (65, True), (-30, True)])
def test_a_run_within_a_minute_of_a_fetch_prices_that_board_without_fetching_again(tmp_path, age, fetched_again):
    fetch, calls = counting_feed()
    client = engine_app(tmp_path, fetch_board=fetch)
    client.post("/api/board/fetch")
    age_board(tmp_path, age)  # -30: saved "in the future" (the clock moved back), so its age can't be trusted
    r = client.post("/api/run")
    assert r.status_code == 200 and r.json()["warnings"] == []
    assert len(calls) == (2 if fetched_again else 1)
    assert client.get("/api/board").json()["source"] == "fetched"


def test_fresh_odds_fetch_the_board_even_within_the_minute(tmp_path):
    fetch, calls = counting_feed()
    client = engine_app(tmp_path, fetch_board=fetch)
    client.post("/api/board/fetch")
    age_board(tmp_path, 5)
    assert client.post("/api/run", json={"no_cache": True}).json()["warnings"] == []
    assert len(calls) == 2


def test_an_uploaded_board_never_stands_in_for_a_fetch(tmp_path):
    fetch, calls = counting_feed()
    client = engine_app(tmp_path, fetch_board=fetch)
    upload(client)
    age_board(tmp_path, 5)
    client.post("/api/run")
    assert len(calls) == 1 and client.get("/api/board").json()["source"] == "fetched"


def test_fetching_now_within_the_minute_returns_the_board_just_fetched(tmp_path):
    fetch, calls = counting_feed()
    client = engine_app(tmp_path, fetch_board=fetch)
    client.post("/api/board/fetch")
    age_board(tmp_path, 30)
    before = client.get("/api/board").json()
    r = client.post("/api/board/fetch")
    assert r.status_code == 200 and r.json() == before and len(calls) == 1


def test_a_streamed_run_announces_the_board_it_reuses(tmp_path):
    """The reused board is the run's board, so the page hears about it straight after the board step, as it does
    after a fetch."""
    fetch, calls = counting_feed()
    client = engine_app(tmp_path, fetch_board=fetch)
    client.post("/api/board/fetch")
    age_board(tmp_path, 10)
    _, events = stream(client)
    at = [i for i, e in enumerate(events) if e["type"] == "board"]
    assert len(at) == 1 and events[at[0]]["board"] == client.get("/api/board").json()
    assert [e["step"] for e in events[:at[0]]] == ["Fetching the PrizePicks board"]
    assert events[-1]["type"] == "report" and events[-1]["report"]["warnings"] == [] and len(calls) == 1


def run_watched_by(client, monkeypatch, progress) -> dict:
    """POST a streamed run whose client is `progress` (cancel it to have the client leave). Returns {"report": ...}
    or {"cancelled": True}, and "announced": the events the run announced."""
    from ppopt import runs

    def given(emit):
        progress.emit = emit
        return progress

    monkeypatch.setattr(runs, "Progress", given)
    _, events = stream(client)
    end = events[-1]
    outcome = {"announced": [e for e in events if e["type"] == "board"]}
    if end["type"] == "report":
        outcome["report"] = end["report"]
    else:
        assert end["type"] == "error" and end["detail"].startswith("the run was stopped"), end
        outcome["cancelled"] = True
    return outcome


def test_a_run_whose_client_left_while_it_waited_for_the_board_never_asks_for_one(tmp_path, monkeypatch):
    import threading
    import time

    from ppopt.progress import Progress

    release, calls = threading.Event(), []

    def feed_(progress=None):
        calls.append(1)
        if len(calls) == 1:
            release.wait(5)  # the page's own fetch, holding the board while the run waits its turn
        return json.dumps(pp_payload()).encode()

    client = engine_app(tmp_path, fetch_board=feed_)
    page = threading.Thread(target=lambda: client.post("/api/board/fetch"))
    page.start()
    while not calls:
        time.sleep(0.005)
    progress, outcome = Progress(lambda e: None), {}
    run = threading.Thread(target=lambda: outcome.update(run_watched_by(client, monkeypatch, progress)))
    run.start()
    time.sleep(0.05)
    progress.cancel()  # the browser went away while the run waited
    release.set()
    page.join(5), run.join(5)
    assert outcome["cancelled"] and len(calls) == 1
    assert outcome["announced"] == []


def test_a_run_whose_client_left_during_its_board_request_saves_nothing(tmp_path, monkeypatch):
    from ppopt.progress import Progress

    progress = Progress(lambda e: None)

    def feed_(progress_=None):
        progress.cancel()  # the browser went away while the board downloaded
        return json.dumps(pp_payload()).encode()

    client = engine_app(tmp_path, fetch_board=feed_)
    outcome = run_watched_by(client, monkeypatch, progress)
    assert outcome["cancelled"] and outcome["announced"] == []
    assert client.get("/api/board").status_code == 404


def test_a_run_whose_client_left_stops_waiting_out_the_partner_feeds_retry_after(tmp_path, monkeypatch):
    import threading
    import time

    from ppopt.progress import Progress

    client, calls = feed_app(tmp_path, monkeypatch, lambda n: (429, {"Retry-After": "5"}) if n == 1 else (200, {}),
                             sleep=None)  # real, interruptible waits
    progress = Progress(lambda e: None)
    threading.Timer(0.1, progress.cancel).start()
    began = time.monotonic()
    outcome = run_watched_by(client, monkeypatch, progress)
    assert outcome["cancelled"] and len(calls) == 1
    assert time.monotonic() - began < 1, "the run sat out the Retry-After nobody was waiting for"
    began = time.monotonic()
    assert upload(client).status_code == 200 and time.monotonic() - began < 1, "the board is free to write"


def test_the_next_run_fetches_the_board_after_a_cancelled_one(tmp_path, monkeypatch):
    from ppopt.progress import Progress

    client, calls = feed_app(tmp_path, monkeypatch, lambda n: (200, {}))
    cancelled = Progress(lambda e: None)
    cancelled.cancel()
    assert run_watched_by(client, monkeypatch, cancelled)["cancelled"]
    outcome = run_watched_by(client, monkeypatch, Progress(lambda e: None))
    assert outcome["report"]["warnings"] == [] and len(calls) == 1
