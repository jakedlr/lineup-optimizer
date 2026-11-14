"""Sprint 10: alert settings, the test alert and topic check, and every auto run alerting through ntfy."""

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.header import decode_header, make_header

import pytest
from fastapi.testclient import TestClient

from ppopt.web import create_app
from tests.test_alerts import Transport, lines, MESSAGE
from tests.test_auto_runs import MARK, auto_run, wait_for
from tests.test_cli import NOW, markets
from tests.test_web import ROOT, feed, feed_down

DEFAULTS = {"server": "https://ntfy.sh", "topic": "", "token_set": False, "timezone": None,
            "medium": {"enabled": True, "edge": 0.5, "legs": 3}, "high": {"enabled": True, "edge": 1.0, "legs": 3},
            "saved": False, "updated_at": None}


def make(tmp_path, ntfy=None, collect=None, fetch_board=None, **kw) -> TestClient:
    collect = collect or (lambda *a: (markets(), []))
    return TestClient(create_app(static_dir=tmp_path, data_dir=tmp_path / "data", root=ROOT, collect=collect,
                                 now=lambda: NOW, fetch_board=fetch_board or feed(), clock=lambda: MARK - 100,
                                 ntfy_http=ntfy or Transport(), **kw))


def title(request) -> str:
    return str(make_header(decode_header(request["headers"]["Title"])))


# --- settings ------------------------------------------------------------------------------------

def test_alert_settings_are_the_defaults_until_saved(tmp_path):
    assert make(tmp_path).get("/api/alerts").json() == DEFAULTS


def test_patching_alert_settings_merges_and_survives_a_restart(tmp_path):
    client = make(tmp_path)
    r = client.patch("/api/alerts", json={"topic": "pp-jake-1", "timezone": "America/New_York"})
    saved = {**DEFAULTS, "topic": "pp-jake-1", "timezone": "America/New_York", "saved": True,
             "updated_at": NOW.isoformat()}
    assert r.status_code == 200 and r.json() == saved
    r = client.patch("/api/alerts", json={"high": {"edge": 1.5}, "medium": {"enabled": False, "legs": 4}})
    saved = {**saved, "high": {"enabled": True, "edge": 1.5, "legs": 3},
             "medium": {"enabled": False, "edge": 0.5, "legs": 4}}
    assert r.json() == saved
    assert make(tmp_path).get("/api/alerts").json() == saved
    assert not list((tmp_path / "data").glob("*.tmp"))


def test_the_token_is_saved_but_never_sent_back(tmp_path):
    client = make(tmp_path)
    r = client.patch("/api/alerts", json={"token": "tk_secret"})
    assert r.json()["token_set"] is True and "tk_secret" not in r.text
    assert "tk_secret" not in client.get("/api/alerts").text
    assert json.loads((tmp_path / "data" / "alerts.json").read_text())["token"] == "tk_secret"
    assert client.patch("/api/alerts", json={"token": ""}).json()["token_set"] is False


def test_a_trailing_slash_on_the_server_is_dropped(tmp_path):
    assert make(tmp_path).patch("/api/alerts", json={"server": "http://ntfy.lan:8080/"}).json()["server"] == \
        "http://ntfy.lan:8080"


@pytest.mark.parametrize("body", [
    {}, {"surprise": 1}, {"saved": True}, {"token_set": True},
    {"server": "ftp://ntfy.sh"}, {"server": "ntfy.sh"}, {"server": "https://"}, {"server": "https://ntfy.sh?x=1"},
    {"server": "https://ntfy .sh"}, {"server": None},
    {"topic": "has space"}, {"topic": "a/b"}, {"topic": "x" * 65}, {"topic": None},
    {"token": "tk abc"}, {"token": "tk\nX-Evil: 1"}, {"token": 5},
    {"timezone": "Mars/Olympus"}, {"timezone": ""}, {"timezone": "../etc/passwd"}, {"timezone": None},
    {"high": {"edge": 0.15}}, {"high": {"edge": 0}}, {"high": {"edge": 20.1}}, {"high": {"edge": True}},
    {"high": {"edge": "1.0"}}, {"high": {"legs": 0}}, {"high": {"legs": 7}}, {"high": {"legs": 3.5}},
    {"high": {"legs": "3"}}, {"high": {"enabled": "yes"}}, {"high": {}}, {"high": None}, {"high": {"x": 1}},
    {"low": {"edge": 1.0}},
])
def test_bad_alert_settings_are_422_and_change_nothing(tmp_path, body):
    client = make(tmp_path)
    assert client.patch("/api/alerts", json=body).status_code == 422, body
    assert client.get("/api/alerts").json() == DEFAULTS


@pytest.mark.parametrize("edge", [0.1, 1, 2.3, 20])
def test_edges_go_in_steps_of_a_tenth_from_0_1_to_20(tmp_path, edge):
    assert make(tmp_path).patch("/api/alerts", json={"high": {"edge": edge}}).json()["high"]["edge"] == edge


def test_an_empty_topic_is_no_topic(tmp_path):
    client = make(tmp_path)
    client.patch("/api/alerts", json={"topic": "abc"})
    assert client.patch("/api/alerts", json={"topic": ""}).json()["topic"] == ""


def test_unreadable_alert_settings_read_as_never_saved(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "alerts.json").write_text('{"topic": "a b"}')
    assert make(tmp_path).get("/api/alerts").json() == DEFAULTS


def test_the_time_zone_is_unset_until_chosen(tmp_path):
    client = make(tmp_path)
    assert client.get("/api/alerts").json()["timezone"] is None
    assert client.patch("/api/alerts", json={"topic": "abc"}).json()["timezone"] is None, "still unset once saved"
    assert client.patch("/api/alerts", json={"timezone": "America/Chicago"}).json()["timezone"] == "America/Chicago"
    assert client.patch("/api/alerts", json={"timezone": None}).status_code == 422, "chosen, it can't be unset"
    assert make(tmp_path).get("/api/alerts").json()["timezone"] == "America/Chicago"


def test_a_time_zone_saved_before_it_could_be_unset_is_kept(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "alerts.json").write_text(json.dumps({"topic": "abc", "timezone": "UTC",
                                                              "updated_at": NOW.isoformat()}))
    assert make(tmp_path).get("/api/alerts").json()["timezone"] == "UTC"


def test_alert_settings_saved_without_a_time_read_as_saved_when_the_file_was_written(tmp_path):
    (tmp_path / "data").mkdir()
    path = tmp_path / "data" / "alerts.json"
    path.write_text(json.dumps({"topic": "abc"}))
    written = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
    client = make(tmp_path)
    assert client.get("/api/alerts").json()["updated_at"] == written
    assert client.get("/api/status").json()["alerts_updated_at"] == written


def test_status_keeps_when_settings_were_saved_without_reading_them_each_poll(tmp_path):
    client = make(tmp_path)
    client.patch("/api/alerts", json={"topic": "abc"})
    client.patch("/api/settings", json={"stake": 25})
    (tmp_path / "data" / "alerts.json").unlink()
    (tmp_path / "data" / "settings.json").unlink()
    status = client.get("/api/status").json()
    assert (status["alerts_updated_at"], status["settings_updated_at"]) == (NOW.isoformat(), NOW.isoformat())


def test_status_says_when_the_alert_settings_were_last_saved(tmp_path):
    client = make(tmp_path)
    assert client.get("/api/status").json()["alerts_updated_at"] is None
    client.patch("/api/alerts", json={"topic": "abc"})
    assert client.get("/api/status").json()["alerts_updated_at"] == NOW.isoformat()


def test_patches_at_once_keep_each_others_fields(tmp_path):
    client = make(tmp_path)
    pool = ThreadPoolExecutor(8)
    patches = [{"topic": "abc"}, {"timezone": "Europe/London"}, {"high": {"edge": 2.0}}, {"medium": {"legs": 5}},
               {"token": "tk_x"}, {"server": "http://n.lan"}, {"high": {"legs": 2}}, {"medium": {"edge": 0.7}}]
    for f in [pool.submit(client.patch, "/api/alerts", json=p) for p in patches]:
        assert f.result(5).status_code == 200
    got = client.get("/api/alerts").json()
    assert (got["topic"], got["timezone"], got["server"], got["token_set"]) == ("abc", "Europe/London",
                                                                                "http://n.lan", True)
    assert got["high"] == {"enabled": True, "edge": 2.0, "legs": 2}
    assert got["medium"] == {"enabled": True, "edge": 0.7, "legs": 5}


# --- the test alert ------------------------------------------------------------------------------

def test_a_test_alert_needs_a_topic(tmp_path):
    ntfy = Transport()
    r = make(tmp_path, ntfy).post("/api/alerts/test")
    assert r.status_code == 409 and "topic" in r.json()["detail"]
    assert ntfy.requests == []


def test_a_test_alert_goes_to_the_saved_topic(tmp_path):
    ntfy = Transport()
    client = make(tmp_path, ntfy)
    client.patch("/api/alerts", json={"topic": "pp-1", "server": "http://n.lan", "token": "tk_x"})
    r = client.post("/api/alerts/test")
    assert r.status_code == 200 and r.json() == {"sent": True}
    (sent,) = ntfy.requests
    assert sent["url"] == "http://n.lan/pp-1" and sent["headers"]["Priority"] == "3"
    assert sent["headers"]["Authorization"] == "Bearer tk_x"
    assert title(sent) == "Test alert · PrizePicks EV Optimizer" and sent["body"]


def test_a_test_alert_ntfy_refuses_is_502_saying_why(tmp_path):
    client = make(tmp_path, Transport(403, b'{"code":40301,"http":403,"error":"forbidden"}'))
    client.patch("/api/alerts", json={"topic": "pp-1"})
    r = client.post("/api/alerts/test")
    assert r.status_code == 502 and r.json()["detail"] == "ntfy refused it (403: forbidden)"


def test_a_test_alert_that_cannot_reach_ntfy_is_502(tmp_path):
    client = make(tmp_path, Transport(error=TimeoutError("timed out")))
    client.patch("/api/alerts", json={"topic": "pp-1"})
    assert client.post("/api/alerts/test").json()["detail"] == "couldn't reach https://ntfy.sh (timed out)"


# --- checking a topic ----------------------------------------------------------------------------

def test_checking_a_topic_named_in_the_request(tmp_path):
    ntfy = Transport(200, lines(MESSAGE))
    client = make(tmp_path, ntfy)
    client.patch("/api/alerts", json={"topic": "saved-one", "token": "tk_x"})
    r = client.post("/api/alerts/check", json={"topic": "candidate"})
    assert r.status_code == 200 and r.json()["state"] == "recent"
    assert ntfy.requests[0]["url"] == "https://ntfy.sh/candidate/json?poll=1&since=all"
    assert ntfy.requests[0]["headers"]["Authorization"] == "Bearer tk_x"


def test_checking_defaults_to_the_saved_topic(tmp_path):
    ntfy = Transport(200, b"")
    client = make(tmp_path, ntfy)
    client.patch("/api/alerts", json={"topic": "saved-one"})
    assert client.post("/api/alerts/check").json() == {"state": "unused",
                                                       "detail": "no recent messages on this topic"}
    assert client.post("/api/alerts/check", json={}).json()["state"] == "unused"
    assert [r["url"] for r in ntfy.requests] == ["https://ntfy.sh/saved-one/json?poll=1&since=all"] * 2


def test_checking_with_no_topic_at_all_is_409(tmp_path):
    assert make(tmp_path).post("/api/alerts/check").status_code == 409


@pytest.mark.parametrize("body", [{"topic": "a b"}, {"topic": ""}, {"topic": 5}, {"x": 1}])
def test_checking_a_bad_topic_is_422(tmp_path, body):
    assert make(tmp_path).post("/api/alerts/check", json=body).status_code == 422


def test_a_check_that_cannot_reach_ntfy_is_unknown_not_an_error(tmp_path):
    client = make(tmp_path, Transport(error=ConnectionRefusedError(111, "Connection refused")))
    r = client.post("/api/alerts/check", json={"topic": "abc"})
    assert r.status_code == 200 and r.json()["state"] == "unknown"


# --- auto runs alert -----------------------------------------------------------------------------

# The fixture board prices two games: CHI-NE's best leg is a taco promo at +14.9%, CLE-PHI's best is −1.1%.
ONE_LEG = {"high": {"legs": 1}, "medium": {"legs": 1}}


def alerted(client):
    """The latest run's alert, once it's there."""
    wait_for(lambda: client.get("/api/status").json()["latest"]["alert"] is not None)
    return client.get("/api/status").json()["latest"]["alert"]


def test_no_topic_no_alert(tmp_path):
    ntfy = Transport()
    client = make(tmp_path, ntfy)
    latest = auto_run(client)
    assert latest["alert"] is None and client.get("/api/status").json()["latest"]["alert"] is None
    time.sleep(0.05)
    assert ntfy.requests == []


def test_an_auto_run_sends_its_alert_and_keeps_how_it_went(tmp_path):
    ntfy = Transport()
    client = make(tmp_path, ntfy)
    client.patch("/api/alerts", json={"topic": "pp-1", "timezone": "America/New_York", **ONE_LEG})
    auto_run(client)
    alert = alerted(client)
    assert alert == {"sent": True, "priority": 4, "title": "HIGH · 1 leg ≥ +1.0% · 15:00", "error": None}
    (sent,) = ntfy.requests
    assert sent["url"] == "https://ntfy.sh/pp-1" and sent["headers"]["Priority"] == "4"
    assert title(sent) == alert["title"], "19:00 UTC is 15:00 in New York in October"
    assert sent["body"].decode().splitlines() == [
        "1. Caleb Williams O 215.5 Pass Yards · NFL CHI vs NE · +14.9% (69.1%) · taco",
        "2. Joel Embiid O 35.5 Pts+Rebs+Asts · NBA CLE vs PHI · −1.1% (53.1%)",
    ]
    latest = client.get("/api/report/latest").json()
    assert latest["alert"] == alert and "report" in latest
    assert json.loads((tmp_path / "data" / "latest.json").read_text())["alert"] == alert
    assert make(tmp_path).get("/api/status").json()["latest"]["alert"] == alert, "kept across a restart"


def test_an_alert_title_tells_the_time_in_utc_while_no_time_zone_is_set(tmp_path):
    client = make(tmp_path)
    client.patch("/api/alerts", json={"topic": "pp-1", **ONE_LEG})
    auto_run(client)
    assert alerted(client)["title"] == "HIGH · 1 leg ≥ +1.0% · 19:00"


def next_auto_run(client, tmp_path=None):
    """Reach the next quarter mark (auto runs already on) and return the new run's alert."""
    first_id = client.get("/api/status").json()["latest"]["id"]
    client.put("/api/auto", json={"enabled": True})
    client.app.state.scheduler.tick(MARK + 1 + 900)
    wait_for(lambda: client.get("/api/status").json()["latest"]["id"] != first_id)
    return alerted(client)


@pytest.mark.parametrize("move", [{"topic": "pp-2"}, {"server": "http://ntfy.lan"}])
def test_the_first_alert_somewhere_new_is_never_a_repeat(tmp_path, move):
    ntfy = Transport()
    client = make(tmp_path, ntfy)
    client.patch("/api/alerts", json={"topic": "pp-1", **ONE_LEG})
    auto_run(client)
    assert alerted(client)["priority"] == 4
    client.patch("/api/alerts", json=move)
    assert next_auto_run(client)["priority"] == 4, "the new topic never heard the first alert"
    assert json.loads((tmp_path / "data" / "alerts_state.json").read_text())["topic"] == (move.get("topic")
                                                                                         or "pp-1")


def test_the_same_legs_next_time_alert_at_priority_1(tmp_path):
    ntfy = Transport()
    client = make(tmp_path, ntfy)
    client.patch("/api/alerts", json={"topic": "pp-1", **ONE_LEG})
    auto_run(client)
    alerted(client)
    assert (tmp_path / "data" / "alerts_state.json").is_file()
    second = make(tmp_path, ntfy)  # a restart in between: what was alerted is remembered
    first_id = second.get("/api/status").json()["latest"]["id"]
    second.put("/api/auto", json={"enabled": True})
    second.app.state.scheduler.tick(MARK + 1)
    wait_for(lambda: second.get("/api/status").json()["latest"]["id"] != first_id)
    alert = alerted(second)
    assert alert == {"sent": True, "priority": 1, "title": "HIGH, unchanged · 1 leg ≥ +1.0% · 19:00", "error": None}


def test_an_alert_that_was_not_delivered_is_tried_again_at_its_tier(tmp_path):
    down = Transport(error=ConnectionRefusedError(111, "Connection refused"))
    client = make(tmp_path, down)
    client.patch("/api/alerts", json={"topic": "pp-1", **ONE_LEG})
    auto_run(client)
    alert = alerted(client)
    assert alert == {"sent": False, "priority": 4, "title": "HIGH · 1 leg ≥ +1.0% · 19:00",
                     "error": "couldn't reach https://ntfy.sh ([Errno 111] Connection refused)"}
    assert client.get("/api/status").json()["auto"]["enabled"] is True, "auto runs go on"
    up = Transport()
    again = make(tmp_path, up)
    first_id = again.get("/api/status").json()["latest"]["id"]
    again.app.state.scheduler.tick(MARK + 1)
    wait_for(lambda: again.get("/api/status").json()["latest"]["id"] != first_id)
    assert alerted(again)["priority"] == 4, "the phone never heard the first one"


def test_an_alert_ntfy_refuses_is_kept_with_the_reason(tmp_path, caplog):
    client = make(tmp_path, Transport(429, b'{"code":42901,"http":429,"error":"limit reached: too many requests"}'))
    client.patch("/api/alerts", json={"topic": "pp-1"})
    auto_run(client)
    alert = alerted(client)
    assert alert["sent"] is False and alert["error"] == "ntfy refused it (429: limit reached: too many requests)"
    assert "alert not delivered" in caplog.text


def test_a_failed_board_fetch_alerts_at_4(tmp_path):
    ntfy = Transport()
    client = make(tmp_path, ntfy, fetch_board=feed_down("HTTP 429 from the partner feed"))
    client.patch("/api/alerts", json={"topic": "pp-1"})
    latest = auto_run(client)
    alert = alerted(client)
    assert alert == {"sent": True, "priority": 4, "title": "AUTO RUNS OFF · board fetch failed · 19:00",
                     "error": None}
    assert ntfy.requests[0]["body"].decode() == latest["error"]


def test_any_other_failure_alerts_at_1(tmp_path):
    ntfy = Transport()
    client = make(tmp_path, ntfy, collect=lambda *a: ([], ["draftkings unavailable: blocked"]))
    client.patch("/api/alerts", json={"topic": "pp-1"})
    latest = auto_run(client)
    assert alerted(client)["title"] == "19:00 · run failed"
    assert ntfy.requests[0]["headers"]["Priority"] == "1" and ntfy.requests[0]["body"].decode() == latest["error"]


def test_a_manual_run_never_alerts(tmp_path):
    ntfy = Transport()
    client = make(tmp_path, ntfy)
    client.patch("/api/alerts", json={"topic": "pp-1"})
    client.post("/api/run")
    assert client.get("/api/status").json()["latest"]["alert"] is None
    assert client.get("/api/report/latest").json()["alert"] is None
    assert ntfy.requests == []


def test_the_end_hook_still_hears_each_auto_run(tmp_path):
    heard = []
    client = make(tmp_path, Transport(), on_auto_run_end=heard.append)
    client.patch("/api/alerts", json={"topic": "pp-1"})
    auto_run(client)
    wait_for(lambda: heard)
    assert heard[0]["switched_off"] is False and "report" in heard[0]


def test_an_auto_run_is_going_until_its_alert_is_done(tmp_path):
    """No run can start (and take the latest's place) while an auto run's alert is still on its way."""
    held, release = threading.Event(), threading.Event()

    class Slow(Transport):
        def __call__(self, *a):
            held.set()
            assert release.wait(5)
            return super().__call__(*a)

    client = make(tmp_path, Slow())
    client.patch("/api/alerts", json={"topic": "pp-1"})
    client.put("/api/auto", json={"enabled": True})
    client.app.state.scheduler.tick(MARK + 1)
    assert held.wait(5)
    status = client.get("/api/status").json()
    assert status["running"]["started_by"] == "auto"
    r = client.post("/api/run")
    assert r.status_code == 409 and r.json()["detail"] == "a run is already going (auto run)"
    release.set()
    wait_for(lambda: client.get("/api/status").json()["running"] is None)
    latest = client.get("/api/status").json()["latest"]
    assert latest["started_by"] == "auto" and latest["alert"]["sent"] is True, "the alert is there once it's over"
    assert client.post("/api/run").status_code == 200


def test_an_alert_the_app_fails_to_make_is_kept_as_not_delivered(tmp_path, monkeypatch, caplog):
    from ppopt import alerts

    def broken(*a):
        raise KeyError("legs")

    monkeypatch.setattr(alerts, "compose", broken)
    ntfy = Transport()
    client = make(tmp_path, ntfy)
    client.patch("/api/alerts", json={"topic": "pp-1"})
    auto_run(client)
    alert = alerted(client)
    assert alert == {"sent": False, "priority": None, "title": None, "error": "the app failed (KeyError: 'legs')"}
    assert ntfy.requests == [] and "the auto run's alert failed" in caplog.text
    assert client.get("/api/status").json()["running"] is None


def test_an_alert_whose_sending_breaks_is_kept_with_what_it_would_have_said(tmp_path, caplog):
    client = make(tmp_path, Transport(error=ValueError("bad header")))
    client.patch("/api/alerts", json={"topic": "pp-1", **ONE_LEG})
    auto_run(client)
    alert = alerted(client)
    assert alert == {"sent": False, "priority": 4, "title": "HIGH · 1 leg ≥ +1.0% · 19:00",
                     "error": "the app failed (ValueError: bad header)"}
    assert "the auto run's alert failed" in caplog.text
    assert not (tmp_path / "data" / "alerts_state.json").exists(), "not delivered, so not remembered"


# --- forgetting what was alerted (e2e) -------------------------------------------------------------

def test_forget_is_not_there_outside_the_e2e_suite(tmp_path):
    client = make(tmp_path, Transport(), e2e=False)
    client.patch("/api/alerts", json={"topic": "pp-1", **ONE_LEG})
    auto_run(client)
    alerted(client)
    assert client.post("/api/alerts/forget").status_code == 404
    assert (tmp_path / "data" / "alerts_state.json").is_file()


def test_forget_clears_the_tiers_memory_so_the_same_legs_alert_at_their_tier_again(tmp_path):
    ntfy = Transport()
    client = make(tmp_path, ntfy, e2e=True)
    assert client.post("/api/alerts/forget").json() == {"forgotten": True}, "nothing to forget is fine"
    client.patch("/api/alerts", json={"topic": "pp-1", **ONE_LEG})
    auto_run(client)
    first_id = alerted(client) and client.get("/api/status").json()["latest"]["id"]
    assert client.post("/api/alerts/forget").json() == {"forgotten": True}
    assert not (tmp_path / "data" / "alerts_state.json").exists()
    client.app.state.scheduler.tick(MARK + 1 + 900)
    wait_for(lambda: client.get("/api/status").json()["latest"]["id"] != first_id)
    assert alerted(client)["priority"] == 4, "not a repeat: the last alert was forgotten"
