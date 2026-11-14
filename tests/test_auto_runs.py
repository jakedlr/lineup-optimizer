"""Sprint 9: run settings on the server, one run at a time, the latest run kept, auto runs on the quarter hour."""

import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from ppopt.web import create_app
from tests.test_cli import NOW, markets
from tests.test_web import ROOT, feed

MARK = NOW.timestamp()  # 19:00 UTC: a quarter mark
assert MARK % 900 == 0


def iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def make(tmp_path, collect=None, fetch_board=None, clock=lambda: MARK - 100, **kw) -> TestClient:
    """An app over `tmp_path/data` whose scheduler's wall clock reads `clock()` (epoch seconds)."""
    collect = collect or (lambda *a: (markets(), []))
    return TestClient(create_app(static_dir=tmp_path, data_dir=tmp_path / "data", root=ROOT, collect=collect,
                                 now=lambda: NOW, fetch_board=fetch_board or feed(), clock=clock, **kw))


# --- run settings --------------------------------------------------------------------------------

SETTINGS = {"sports": ["NBA", "NHL"], "stake": 20.0, "hours": 12.0, "devig": "shin", "ref_slip": "flex6"}


def test_settings_are_the_cli_defaults_until_saved(tmp_path):
    assert make(tmp_path).get("/api/settings").json() == {
        "sports": ["NFL", "NBA", "NHL", "MLB"], "stake": 10.0, "hours": 24, "devig": "worst", "ref_slip": None,
        "saved": False}


def test_saved_settings_come_back_and_survive_a_restart(tmp_path):
    client = make(tmp_path)
    r = client.put("/api/settings", json=SETTINGS)
    assert r.status_code == 200 and r.json() == {**SETTINGS, "saved": True}
    assert client.get("/api/settings").json() == {**SETTINGS, "saved": True}
    assert make(tmp_path).get("/api/settings").json() == {**SETTINGS, "saved": True}
    assert json.loads((tmp_path / "data" / "settings.json").read_text()) == SETTINGS
    assert not list((tmp_path / "data").glob("*.tmp"))


def test_a_reference_slip_may_be_left_out(tmp_path):
    body = {k: v for k, v in SETTINGS.items() if k != "ref_slip"}
    assert make(tmp_path).put("/api/settings", json=body).json()["ref_slip"] is None


@pytest.mark.parametrize("change", [
    {"sports": []}, {"sports": ["XFL"]}, {"stake": 0}, {"hours": -1}, {"devig": "magic"}, {"ref_slip": "power9"},
    {"surprise": 1}, {"saved": True}, {"no_cache": True}, {"bonus": True},
])
def test_bad_settings_are_422_and_not_saved(tmp_path, change):
    client = make(tmp_path)
    assert client.put("/api/settings", json={**SETTINGS, **change}).status_code == 422, change
    assert client.get("/api/settings").json()["saved"] is False


@pytest.mark.parametrize("missing", ["sports", "stake", "hours", "devig"])
def test_settings_must_be_given_whole(tmp_path, missing):
    body = {k: v for k, v in SETTINGS.items() if k != missing}
    assert make(tmp_path).put("/api/settings", json=body).status_code == 422


def test_unreadable_saved_settings_read_as_never_saved(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "settings.json").write_text('{"sports": ["XFL"]')
    assert make(tmp_path).get("/api/settings").json()["saved"] is False


# --- auto runs on/off, status --------------------------------------------------------------------

def test_auto_runs_start_off_with_nothing_run_yet(tmp_path):
    assert make(tmp_path).get("/api/status").json() == {
        "auto": {"enabled": False, "next_run_at": None, "off_reason": None}, "running": None, "latest": None}


def test_switching_auto_runs_on_names_the_next_quarter_mark(tmp_path):
    client = make(tmp_path, clock=lambda: MARK - 100)
    r = client.put("/api/auto", json={"enabled": True})
    assert r.status_code == 200
    assert r.json() == {"enabled": True, "next_run_at": iso(MARK), "off_reason": None}
    assert client.get("/api/status").json()["auto"] == r.json()


@pytest.mark.parametrize("offset, after", [(0, 900), (1, 900), (899, 900)])
def test_the_next_quarter_mark_is_strictly_after_now(tmp_path, offset, after):
    client = make(tmp_path, clock=lambda: MARK + offset)
    assert client.put("/api/auto", json={"enabled": True}).json()["next_run_at"] == iso(MARK + after)


def test_switching_auto_runs_off(tmp_path):
    client = make(tmp_path)
    client.put("/api/auto", json={"enabled": True})
    assert client.put("/api/auto", json={"enabled": False}).json() == {
        "enabled": False, "next_run_at": None, "off_reason": None}


def test_auto_runs_stay_on_across_a_restart(tmp_path):
    make(tmp_path).put("/api/auto", json={"enabled": True})
    assert make(tmp_path).get("/api/status").json()["auto"]["enabled"] is True
    assert json.loads((tmp_path / "data" / "auto.json").read_text())["enabled"] is True


@pytest.mark.parametrize("body", [{}, {"enabled": "yes"}, {"enabled": True, "extra": 1}])
def test_bad_auto_switches_are_422(tmp_path, body):
    assert make(tmp_path).put("/api/auto", json=body).status_code == 422


# --- one run at a time ---------------------------------------------------------------------------

import threading
import time
from concurrent.futures import ThreadPoolExecutor

from tests.test_cli import pp_payload
from tests.test_web import NDJSON, stream

pool = ThreadPoolExecutor(16)


def wait_for(condition, timeout=5.0):
    end = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < end, "timed out"
        time.sleep(0.005)


def held_feed():
    """A partner feed that answers only once released. Returns it, an event set when a request arrives, and the
    release."""
    asked, release = threading.Event(), threading.Event()

    def fetch(progress=None):
        asked.set()
        assert release.wait(5)
        return json.dumps(pp_payload()).encode()

    return fetch, asked, release


def held_books():
    """Sportsbooks that answer only once released (after the run has fetched and announced its board)."""
    asked, release = threading.Event(), threading.Event()

    def collect(*a):
        asked.set()
        assert release.wait(5)
        return markets(), []

    return collect, asked, release


def runner(client):
    return client.app.state.runner


def test_a_manual_run_while_another_is_going_is_409_saying_which(tmp_path):
    fetch, asked, release = held_feed()
    client = make(tmp_path, fetch_board=fetch)
    first = pool.submit(client.post, "/api/run")
    assert asked.wait(5)
    r = client.post("/api/run")
    assert r.status_code == 409
    assert r.json()["detail"] == "a run is already going (manual run)"
    assert client.post("/api/run", json={}, headers=NDJSON).status_code == 409
    release.set()
    assert first.result(5).status_code == 200
    assert client.post("/api/run").status_code == 200, "the next run may start as soon as one has ended"


def test_runs_posted_at_once_start_only_one(tmp_path):
    fetch, asked, release = held_feed()
    client = make(tmp_path, fetch_board=fetch)
    posts = [pool.submit(client.post, "/api/run") for _ in range(8)]
    assert asked.wait(5)
    wait_for(lambda: sum(p.done() for p in posts) == 7)
    release.set()
    assert sorted(p.result(5).status_code for p in posts) == [200] + [409] * 7


def test_status_says_which_run_is_going_and_then_how_it_ended(tmp_path):
    fetch, asked, release = held_feed()
    client = make(tmp_path, fetch_board=fetch)
    first = pool.submit(client.post, "/api/run")
    assert asked.wait(5)
    assert client.get("/api/status").json()["running"] == {"started_by": "manual", "started_at": NOW.isoformat()}
    release.set()
    first.result(5)
    status = client.get("/api/status").json()
    assert status["running"] is None
    assert status["latest"] == {"started_by": "manual", "started_at": NOW.isoformat(),
                                "finished_at": NOW.isoformat(), "ok": True, "error": None}


# --- the latest run --------------------------------------------------------------------------------

def test_no_latest_report_before_any_run_has_finished(tmp_path):
    assert make(tmp_path).get("/api/report/latest").status_code == 404


def test_a_manual_run_is_kept_as_the_latest_and_survives_a_restart(tmp_path):
    client = make(tmp_path)
    report = client.post("/api/run").json()
    latest = {"started_by": "manual", "started_at": NOW.isoformat(), "finished_at": NOW.isoformat(),
              "report": report}
    assert client.get("/api/report/latest").json() == latest
    assert make(tmp_path).get("/api/report/latest").json() == latest
    assert make(tmp_path).get("/api/status").json()["latest"]["ok"] is True
    assert not list((tmp_path / "data").glob("*.tmp"))


def test_a_streamed_run_is_kept_as_the_latest_too(tmp_path):
    client = make(tmp_path)
    _, events = stream(client)
    assert client.get("/api/report/latest").json()["report"] == events[-1]["report"]


def test_a_failed_run_is_kept_as_the_latest_with_its_error(tmp_path):
    client = make(tmp_path, collect=lambda *a: ([], ["draftkings unavailable: blocked"]))
    detail = client.post("/api/run").json()["detail"]
    latest = client.get("/api/report/latest").json()
    assert latest["error"] == detail and "report" not in latest and latest["started_by"] == "manual"
    assert client.get("/api/status").json()["latest"] == {
        "started_by": "manual", "started_at": NOW.isoformat(), "finished_at": NOW.isoformat(), "ok": False,
        "error": detail}


def test_a_cancelled_run_is_not_kept(tmp_path, monkeypatch):
    from ppopt.progress import Progress
    from tests.test_web import run_watched_by

    client = make(tmp_path)
    client.post("/api/run")
    before = client.get("/api/report/latest").json()
    cancelled = Progress(lambda e: None)
    cancelled.cancel()
    assert run_watched_by(client, monkeypatch, cancelled)["cancelled"]
    assert client.get("/api/report/latest").json() == before
    assert client.get("/api/status").json()["running"] is None


# --- watching the run in progress ------------------------------------------------------------------

def live(client):
    r = client.get("/api/run/live")
    return r, [json.loads(line) for line in r.text.splitlines() if line]


def test_watching_when_no_run_is_going_is_204(tmp_path):
    assert make(tmp_path).get("/api/run/live").status_code == 204


def test_a_page_joining_a_run_hears_where_it_is_then_the_rest(tmp_path):
    collect, asked, release = held_books()
    client = make(tmp_path, collect=collect)
    started = pool.submit(stream, client)
    assert asked.wait(5)
    watchers = [pool.submit(live, client) for _ in range(2)]  # several pages at once
    wait_for(lambda: runner(client).current.watchers == 3)
    release.set()
    _, own = started.result(5)
    for w in watchers:
        r, events = w.result(5)
        assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ndjson")
        assert events[0]["type"] == "progress" and {"done", "total", "step"} <= set(events[0])
        assert events[1] == {"type": "board", "board": client.get("/api/board").json()}
        assert all(e["type"] == "progress" for e in events[2:-1])
        assert events[-1] == own[-1] and own[-1]["type"] == "report"
    assert client.get("/api/run/live").status_code == 204


def test_the_snapshot_is_where_the_run_is_now(tmp_path):
    from ppopt.runs import Runner

    gate = threading.Event()

    def work(progress, announce):
        progress.step("Fetching the PrizePicks board")
        announce({"type": "board", "board": {"projections": 3}})
        progress.plan("draftkings", "NFL", 4)
        progress.tick("draftkings")
        assert gate.wait(5)
        progress.tick("draftkings")
        return {"legs": []}

    r = Runner(now=lambda: NOW, record=lambda entry: None)
    r.start(work, "auto")
    wait_for(lambda: r.current is not None and r.current.snapshot()[0]["done"] == 1)
    events = r.current.watch()
    assert next(events) == {"type": "progress", "done": 1, "total": 4, "step": "Fetching the PrizePicks board"}
    assert next(events) == {"type": "board", "board": {"projections": 3}}
    gate.set()
    assert next(events) == {"type": "progress", "done": 2, "total": 4, "step": "Fetching the PrizePicks board"}
    assert next(events) == {"type": "report", "report": {"legs": []}}
    assert list(events) == []


def test_a_page_joining_before_the_first_step_still_hears_a_progress_snapshot():
    from ppopt.runs import Runner

    gate = threading.Event()
    r = Runner(now=lambda: NOW, record=lambda entry: None)
    r.start(lambda progress, announce: gate.wait(5) and {"legs": []}, "auto")
    events = r.current.watch()
    assert next(events) == {"type": "progress", "done": 0, "total": 0, "step": ""}
    gate.set()
    assert next(events)["type"] == "report"


def test_a_page_joining_as_the_run_ends_still_hears_the_end():
    from ppopt.runs import Runner

    gate = threading.Event()
    r = Runner(now=lambda: NOW, record=lambda entry: None)
    r.start(lambda progress, announce: gate.wait(5) and (progress.step("Pricing") or {"legs": []}), "auto")
    run = r.current
    gate.set()
    wait_for(lambda: r.current is None)
    assert list(run.watch()) == [{"type": "progress", "done": 0, "total": 0, "step": "Pricing"},
                                 {"type": "report", "report": {"legs": []}}]


def test_a_page_that_stops_watching_does_not_stop_the_run():
    from ppopt.runs import Runner

    gate, ended = threading.Event(), []
    r = Runner(now=lambda: NOW, record=ended.append)

    def work(progress, announce):
        progress.step("Fetching the PrizePicks board")
        assert gate.wait(5)
        progress.tick("draftkings")  # raises if the run was cancelled
        return {"legs": []}

    r.start(work, "manual")
    events = r.current.watch()
    next(events)
    events.close()
    assert r.current.watchers == 0
    gate.set()
    wait_for(lambda: ended)
    assert "report" in ended[0]


def test_closing_the_starters_events_cancels_the_run():
    from ppopt.progress import RunCancelled
    from ppopt.runs import Runner

    finished, ended = threading.Event(), []

    def work(progress, announce):
        try:
            while True:
                progress.tick()  # a request every loop, like a book fetching props
                threading.Event().wait(0.01)
        except RunCancelled:
            finished.set()
            raise

    r = Runner(now=lambda: NOW, record=ended.append)
    events = r.start(work, "manual", watch=True)
    assert next(events)["type"] == "progress"
    events.close()  # what Starlette does when the client goes away
    assert finished.wait(2), "the worker kept running after the stream closed"
    wait_for(lambda: r.current is None)
    assert ended == [], "a cancelled run is not recorded"


def test_the_starter_hears_every_event_from_the_first():
    from ppopt.runs import Runner

    r = Runner(now=lambda: NOW, record=lambda entry: None)

    def work(progress, announce):
        progress.step("one")
        progress.step("two")
        return {"legs": []}

    assert list(r.start(work, "manual", watch=True)) == [
        {"type": "progress", "done": 0, "total": 0, "step": "one"},
        {"type": "progress", "done": 0, "total": 0, "step": "two"},
        {"type": "report", "report": {"legs": []}}]


def test_only_one_of_many_starts_at_once_gets_to_run():
    from ppopt.runs import Busy, Runner

    gate = threading.Event()
    r = Runner(now=lambda: NOW, record=lambda entry: None)
    barrier = threading.Barrier(12)

    def start(_):
        barrier.wait()
        try:
            r.start(lambda progress, announce: gate.wait(5) and {}, "auto")
            return "started"
        except Busy as e:
            assert e.run is r.current
            return "busy"

    outcomes = list(ThreadPoolExecutor(12).map(start, range(12)))
    gate.set()
    assert sorted(outcomes) == ["busy"] * 11 + ["started"]


def test_the_runner_records_how_each_run_ended():
    from ppopt.cli import UserError
    from ppopt.runs import Runner

    ended = []
    r = Runner(now=lambda: NOW, record=ended.append)

    def fails(progress, announce):
        raise UserError("no games in the window")

    def breaks(progress, announce):
        raise KeyError("oops")

    for work in (lambda p, a: {"legs": []}, fails, breaks):
        list(r.start(work, "auto", watch=True))
    base = {"started_by": "auto", "started_at": NOW.isoformat(), "finished_at": NOW.isoformat()}
    assert ended == [{**base, "report": {"legs": []}}, {**base, "error": "no games in the window"},
                     {**base, "error": "the engine failed: 'oops'"}]


# --- the schedule ----------------------------------------------------------------------------------

def test_a_quarter_mark_is_acted_on_once_and_only_within_a_minute():
    from ppopt.runs import Scheduler

    marks = []
    s = Scheduler(lambda: marks.append(1), clock=lambda: MARK - 100)
    s.tick(MARK + 1)
    s.tick(MARK + 2)  # the thread woke twice in the same quarter
    assert len(marks) == 1
    s.tick(MARK + 900 + 61)  # more than a minute late: missed, not caught up
    s.tick(MARK + 900 + 120)
    assert len(marks) == 1
    s.tick(MARK + 1800 + 59)
    assert len(marks) == 2


def test_marks_passed_before_the_app_started_are_not_caught_up():
    from ppopt.runs import Scheduler

    marks = []
    s = Scheduler(lambda: marks.append(1), clock=lambda: MARK + 10)  # started 10 s after the mark
    s.tick(MARK + 20)
    assert marks == []
    s.tick(MARK + 900)
    assert marks == [1]


def test_the_schedule_wakes_on_each_quarter_mark():
    from ppopt.runs import Scheduler

    now, marks, waits = [MARK - 5], [], []

    def wait(seconds):  # stands in for the stop event's wait; time passes only here
        waits.append(seconds)
        now[0] += seconds
        return len(marks) == 3  # stopped

    s = Scheduler(lambda: marks.append(now[0]), clock=lambda: now[0], wait=wait)
    s.run()
    assert marks == [MARK, MARK + 900, MARK + 1800]
    assert all(0 <= w <= 60 for w in waits), "it wakes at least once a minute, in case the wall clock jumps"


def test_a_failing_mark_does_not_stop_the_schedule():
    from ppopt.runs import Scheduler

    now, calls = [MARK - 5], []

    def on_mark():
        calls.append(now[0])
        if len(calls) == 1:
            raise RuntimeError("boom")

    def wait(seconds):
        now[0] += seconds
        return len(calls) == 2

    Scheduler(on_mark, clock=lambda: now[0], wait=wait).run()
    assert calls == [MARK, MARK + 900]


def test_the_schedule_thread_stops_promptly():
    from ppopt.runs import Scheduler

    s = Scheduler(lambda: None)
    s.start()
    assert s.running
    began = time.monotonic()
    s.stop()
    assert not s.running and time.monotonic() - began < 1


def test_the_app_runs_its_schedule_only_while_it_is_up(tmp_path):
    app = make(tmp_path).app
    with TestClient(app):
        assert app.state.scheduler.running
    assert not app.state.scheduler.running


def test_an_app_made_without_a_schedule_starts_none(tmp_path):
    app = make(tmp_path, schedule=False).app
    with TestClient(app):
        assert not app.state.scheduler.running


def test_shutting_down_stops_the_run_in_flight_without_recording_it(tmp_path):
    fetch, asked, release = held_feed()  # a run stops at its next request; the board's is checked as it lands
    client = make(tmp_path, fetch_board=fetch, schedule=False)
    with TestClient(client.app):
        client.put("/api/auto", json={"enabled": True})
        client.app.state.scheduler.tick(MARK + 1)
        assert asked.wait(5)
        going = runner(client).current
    release.set()
    wait_for(lambda: going.finished)
    assert going.snapshot()[-1] == {"type": "error", "detail": "the run was stopped: the app shut down"}
    assert client.get("/api/report/latest").status_code == 404


# --- auto runs -------------------------------------------------------------------------------------

def auto_run(client, at=MARK + 1):
    """Switch auto runs on, reach a quarter mark, and wait for the auto run to finish. Returns the latest run."""
    client.put("/api/auto", json={"enabled": True})
    client.app.state.scheduler.tick(at)
    wait_for(lambda: client.get("/api/status").json()["latest"] is not None)
    return client.get("/api/report/latest").json()


def test_no_auto_run_while_auto_runs_are_off(tmp_path):
    client = make(tmp_path)
    client.app.state.scheduler.tick(MARK + 1)
    time.sleep(0.05)
    assert client.get("/api/status").json()["running"] is None
    assert client.get("/api/report/latest").status_code == 404


def test_an_auto_run_prices_the_saved_settings_with_feed_promos_and_cached_odds(tmp_path):
    seen = {}

    def collect(http, cfg, books, sports, now, hours, needs):
        seen.update(sports=sports, hours=hours, use_cache=http.use_cache)
        return markets(), []

    client = make(tmp_path, collect=collect)
    client.put("/api/settings", json={"sports": ["NBA"], "stake": 20, "hours": 12, "devig": "shin",
                                      "ref_slip": "flex6"})
    latest = auto_run(client)
    assert latest["started_by"] == "auto" and latest["started_at"] == NOW.isoformat()
    report = latest["report"]
    assert seen == {"sports": ["NBA"], "hours": 12, "use_cache": True}
    assert report["settings"] == {"sports": ["NBA"], "hours": 12, "stake": 20.0, "devig": "shin", "mode": "cash"}
    assert report["ref_slip"]["type"] == "flex" and report["ref_slip"]["size"] == 6
    assert client.get("/api/status").json()["auto"]["enabled"] is True


def test_an_auto_run_takes_the_defaults_until_settings_are_saved(tmp_path):
    report = auto_run(make(tmp_path))["report"]
    assert report["settings"]["sports"] == ["NFL", "NBA", "NHL", "MLB"] and report["settings"]["stake"] == 10.0
    assert any(l["promo_type"] == "taco" for l in report["legs"]), "feed promos are on"


def test_an_auto_run_reuses_a_board_fetched_under_a_minute_ago(tmp_path):
    from tests.test_web import age_board, counting_feed

    fetch, calls = counting_feed()
    client = make(tmp_path, fetch_board=fetch)
    client.post("/api/board/fetch")
    age_board(tmp_path, 10)
    assert "report" in auto_run(client) and len(calls) == 1


def test_a_quarter_mark_that_finds_a_run_going_is_skipped(tmp_path):
    fetch, asked, release = held_feed()
    client = make(tmp_path, fetch_board=fetch)
    client.put("/api/auto", json={"enabled": True})
    manual = pool.submit(client.post, "/api/run")
    assert asked.wait(5)
    client.app.state.scheduler.tick(MARK + 1)
    assert client.get("/api/status").json()["running"]["started_by"] == "manual"
    release.set()
    assert manual.result(5).status_code == 200
    client.app.state.scheduler.tick(MARK + 2)  # the mark was skipped, not put off
    time.sleep(0.05)
    assert client.get("/api/status").json()["latest"]["started_by"] == "manual"
    assert client.get("/api/status").json()["running"] is None


def test_a_manual_run_while_an_auto_run_is_going_is_409_naming_it(tmp_path):
    fetch, asked, release = held_feed()
    client = make(tmp_path, fetch_board=fetch)
    client.put("/api/auto", json={"enabled": True})
    client.app.state.scheduler.tick(MARK + 1)
    assert asked.wait(5)
    r = client.post("/api/run")
    assert r.status_code == 409 and r.json()["detail"] == "a run is already going (auto run)"
    assert client.get("/api/status").json()["running"] == {"started_by": "auto", "started_at": NOW.isoformat()}
    release.set()
    wait_for(lambda: client.get("/api/status").json()["running"] is None)


def test_a_page_can_watch_an_auto_run(tmp_path):
    collect, asked, release = held_books()
    client = make(tmp_path, collect=collect)
    client.put("/api/auto", json={"enabled": True})
    client.app.state.scheduler.tick(MARK + 1)
    assert asked.wait(5)
    watching = pool.submit(live, client)
    wait_for(lambda: runner(client).current.watchers == 1)
    release.set()
    r, events = watching.result(5)
    assert events[0]["type"] == "progress" and events[1]["type"] == "board"
    assert events[-1] == {"type": "report", "report": client.get("/api/report/latest").json()["report"]}


def test_an_auto_run_whose_board_fetch_fails_does_not_fall_back_and_switches_auto_runs_off(tmp_path):
    from tests.test_web import feed_down, upload

    client = make(tmp_path, fetch_board=feed_down("HTTP 429 from the partner feed"))
    upload(client)  # a saved board a manual run would fall back on
    latest = auto_run(client)
    reason = ("the board couldn't be fetched from PrizePicks' partner feed (HTTP 429 from the partner feed), "
              "so auto runs were switched off")
    assert latest["error"] == reason and "report" not in latest and latest["started_by"] == "auto"
    status = client.get("/api/status").json()
    assert status["auto"] == {"enabled": False, "next_run_at": None, "off_reason": reason}
    assert status["latest"]["ok"] is False
    assert make(tmp_path).get("/api/status").json()["auto"]["off_reason"] == reason, "remembered across restarts"
    assert client.put("/api/auto", json={"enabled": True}).json()["off_reason"] is None


@pytest.mark.parametrize("collect, error", [
    (lambda *a: ([], ["draftkings unavailable: blocked", "fanduel unavailable: blocked"]), "no sportsbook odds"),
    (lambda *a: (_ for _ in ()).throw(KeyError("oops")), "the engine failed"),
])
def test_any_other_failure_leaves_auto_runs_on(tmp_path, collect, error):
    client = make(tmp_path, collect=collect)
    latest = auto_run(client)
    assert error in latest["error"]
    assert client.get("/api/status").json()["auto"] == {"enabled": True, "next_run_at": iso(MARK), "off_reason": None}


def test_the_auto_run_end_hook_hears_each_outcome(tmp_path):
    from tests.test_web import feed_down

    heard = []
    ok = make(tmp_path / "ok", on_auto_run_end=heard.append)
    report = auto_run(ok)["report"]
    ok.post("/api/run")  # a manual run is not an auto run
    failed = make(tmp_path / "failed", on_auto_run_end=heard.append,
                  collect=lambda *a: ([], ["draftkings unavailable: blocked"]))
    error = auto_run(failed)["error"]
    off = make(tmp_path / "off", on_auto_run_end=heard.append, fetch_board=feed_down())
    reason = auto_run(off)["error"]
    wait_for(lambda: len(heard) == 3)
    base = {"started_by": "auto", "started_at": NOW.isoformat(), "finished_at": NOW.isoformat()}
    assert heard == [{**base, "report": report, "switched_off": False},
                     {**base, "error": error, "switched_off": False},
                     {**base, "error": reason, "switched_off": True}]


def test_a_failing_hook_does_not_break_the_run(tmp_path):
    def hook(outcome):
        raise RuntimeError("ntfy is down")

    client = make(tmp_path, on_auto_run_end=hook)
    assert "report" in auto_run(client)
    assert client.post("/api/run").status_code == 200


# --- starting an auto run now (e2e) ----------------------------------------------------------------

def test_run_now_is_not_there_outside_the_e2e_suite(tmp_path, monkeypatch):
    monkeypatch.delenv("PPOPT_E2E", raising=False)
    client = make(tmp_path)
    client.put("/api/auto", json={"enabled": True})
    assert client.post("/api/auto/run-now").status_code == 404
    assert client.get("/api/status").json()["running"] is None


def test_run_now_starts_an_auto_run_as_a_quarter_mark_would(tmp_path, monkeypatch):
    monkeypatch.setenv("PPOPT_E2E", "1")
    fetch, asked, release = held_feed()
    client = make(tmp_path, fetch_board=fetch)
    assert client.post("/api/auto/run-now").json() == {"started": False}, "auto runs are off"
    client.put("/api/auto", json={"enabled": True})
    assert client.post("/api/auto/run-now").json() == {"started": True}
    assert asked.wait(5)
    assert client.post("/api/auto/run-now").json() == {"started": False}, "a run is going"
    release.set()
    wait_for(lambda: client.get("/api/status").json()["latest"] is not None)
    assert client.get("/api/report/latest").json()["started_by"] == "auto"


@pytest.mark.parametrize("junk", ["[1, 2]", "{not json", '{"report": {}}', "null"])
def test_unreadable_auto_and_latest_files_read_as_nothing_saved(tmp_path, junk):
    (tmp_path / "data").mkdir()
    for name in ("auto.json", "latest.json"):
        (tmp_path / "data" / name).write_text(junk)
    client = make(tmp_path)
    assert client.get("/api/status").json() == {
        "auto": {"enabled": False, "next_run_at": None, "off_reason": None}, "running": None, "latest": None}
    assert client.get("/api/report/latest").status_code == 404
