"""Sprint 10: what an auto run's alert says, and how it goes to ntfy (GLOSSARY: Alert, Alert tier, Qualifying leg)."""

import json
import socket
import threading
from datetime import datetime
from email.header import decode_header, make_header
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from ppopt import alerts
from ppopt.alerts import Alert, SendFailed

AT = datetime(2026, 10, 22, 14, 15)
TIERS = {"medium": {"enabled": True, "edge": 0.5, "legs": 3}, "high": {"enabled": True, "edge": 1.0, "legs": 3}}
NONE = {"medium": None, "high": None}


def leg(player, game, edge, prob=0.557, side="under", line=1.5, stat="sog", stat_label="Shots On Goal", sport="NHL",
        matchup=None, promo_type="", modelled=False) -> dict:
    """A report leg (cli.report_for's row): edge is a fraction, prob too."""
    return {"sport": sport, "game": game, "matchup": matchup or game.split(":")[1].replace("-", " vs "),
            "player": player, "side": side, "line": line, "stat": stat, "stat_label": stat_label, "prob": prob,
            "books": {}, "disagreement": 0.0, "promo_type": promo_type, "modelled": modelled, "edge": edge,
            "same_game": False}


def ran(*legs) -> dict:
    return {"id": "r1", "started_by": "auto", "started_at": "2026-10-22T19:15:00+00:00",
            "finished_at": "2026-10-22T19:15:20+00:00", "report": {"legs": list(legs)}, "switched_off": False}


def compose(outcome, tiers=None, previous=None):
    return alerts.compose(outcome, tiers or TIERS, previous or NONE, AT)


def tiers(**changes) -> dict:
    return {name: {**TIERS[name], **changes.get(name, {})} for name in TIERS}


# Four games, each with one leg clearing high's bar (+1.0) and a weaker second leg.
G = ["NHL:FLA-STL", "NHL:BOS-NYR", "NHL:DAL-SEA", "NHL:CHI-DET"]
HIGH4 = [leg("Connor McMichael", G[0], 0.014), leg("Second A", G[0], 0.012),
         leg("David Pastrnak", G[1], 0.0126), leg("Second B", G[1], 0.001),
         leg("Jason Robertson", G[2], 0.011), leg("Matty Beniers", G[3], 0.010)]


# --- tiers ---------------------------------------------------------------------------------------

def test_a_high_tier_met_for_the_first_time_alerts_at_priority_4():
    alert, sets = compose(ran(*HIGH4))
    assert alert.priority == 4
    assert alert.title == "HIGH · 4 legs ≥ +1.0% · 14:15"
    assert sets["high"] == sorted(sets["high"]) and len(sets["high"]) == 4
    assert sets["medium"] == sets["high"], "the same four legs clear medium's lower bar"


def test_qualifying_legs_count_one_per_game():
    two_games = [leg("A", G[0], 0.02), leg("B", G[0], 0.02), leg("C", G[0], 0.02), leg("D", G[1], 0.02)]
    alert, sets = compose(ran(*two_games))
    assert alert.priority == 1 and alert.title == "14:15 · best +2.0%", "two games: no tier's three legs"
    assert sets == NONE


def test_a_games_qualifying_leg_is_its_best_edge_leg():
    _, sets = compose(ran(*HIGH4))
    assert any(s.startswith("Connor McMichael|") for s in sets["high"])
    assert not any(s.startswith("Second A|") for s in sets["high"])


def test_a_leg_on_the_bar_qualifies_despite_float_error():
    assert 0.011 * 100 < 1.1  # the float error the bar must forgive
    legs = [leg("A", G[0], 0.011), leg("B", G[1], 0.011), leg("C", G[2], 0.011)]
    alert, _ = compose(ran(*legs), tiers(high={"edge": 1.1}))
    assert alert.title == "HIGH · 3 legs ≥ +1.1% · 14:15"


def test_a_leg_below_the_bar_does_not_qualify():
    legs = [leg("A", G[0], 0.0099999), leg("B", G[1], 0.02), leg("C", G[2], 0.02)]
    alert, sets = compose(ran(*legs))
    assert alert.title == "MEDIUM · 3 legs ≥ +0.5% · 14:15" and sets["high"] is None


def test_the_same_high_legs_again_go_at_priority_1_saying_unchanged():
    _, sets = compose(ran(*HIGH4))
    again, after = compose(ran(*HIGH4), previous=sets)
    assert again.priority == 1
    assert again.title == "HIGH, unchanged · 4 legs ≥ +1.0% · 14:15"
    assert after == sets


def test_high_unchanged_but_medium_changed_goes_at_medium():
    _, sets = compose(ran(*HIGH4))
    more = HIGH4 + [leg("Fifth", "NHL:LA-VGK", 0.006)]
    alert, after = compose(ran(*more), previous=sets)
    assert alert.priority == 3 and alert.title == "MEDIUM · 5 legs ≥ +0.5% · 14:15"
    assert after["high"] == sets["high"] and len(after["medium"]) == 5


def test_a_changed_high_set_alerts_again_at_4():
    _, sets = compose(ran(*HIGH4))
    moved = [dict(l, line=2.5) if l["player"] == "Matty Beniers" else l for l in HIGH4]
    alert, _ = compose(ran(*moved), previous=sets)
    assert alert.priority == 4, "a line that moved is a different leg"


def test_medium_alone_met_goes_at_3_then_1_when_unchanged():
    legs = [leg("A", G[0], 0.006), leg("B", G[1], 0.007), leg("C", G[2], 0.009)]
    first, sets = compose(ran(*legs))
    assert first.priority == 3 and first.title == "MEDIUM · 3 legs ≥ +0.5% · 14:15"
    assert sets == {"medium": sets["medium"], "high": None}
    second, _ = compose(ran(*legs), previous=sets)
    assert second.priority == 1 and second.title == "MEDIUM, unchanged · 3 legs ≥ +0.5% · 14:15"


def test_a_tier_not_met_forgets_its_legs_so_meeting_it_again_alerts():
    _, sets = compose(ran(*HIGH4))
    _, gone = compose(ran(*HIGH4[:2]), previous=sets)
    assert gone == NONE
    back, _ = compose(ran(*HIGH4), previous=gone)
    assert back.priority == 4


def test_a_switched_off_tier_never_alerts_and_forgets_its_legs():
    off = tiers(high={"enabled": False})
    _, sets = compose(ran(*HIGH4))
    alert, after = compose(ran(*HIGH4), off, previous=sets)
    assert alert.priority == 1 and alert.title == "MEDIUM, unchanged · 4 legs ≥ +0.5% · 14:15"
    assert after["high"] is None
    both_off = tiers(high={"enabled": False}, medium={"enabled": False})
    alert, after = compose(ran(*HIGH4), both_off)
    assert alert.priority == 1 and alert.title == "14:15 · best +1.4%" and after == NONE


def test_one_leg_is_a_leg():
    alert, _ = compose(ran(leg("A", G[0], 0.02)), tiers(high={"legs": 1}))
    assert alert.title == "HIGH · 1 leg ≥ +1.0% · 14:15"


def test_nothing_met_names_the_best_edge():
    alert, sets = compose(ran(leg("A", G[0], 0.003), leg("B", G[1], -0.01)))
    assert (alert.priority, alert.title) == (1, "14:15 · best +0.3%") and sets == NONE


def test_a_negative_best_edge_takes_a_minus_sign():
    alert, _ = compose(ran(leg("A", G[0], -0.004), leg("B", G[1], -0.01)))
    assert alert.title == "14:15 · best −0.4%"


def test_a_tiny_negative_edge_rounds_to_plus_zero():
    assert compose(ran(leg("A", G[0], -0.00001)))[0].title == "14:15 · best +0.0%"


def test_no_legs_priced():
    alert, sets = compose(ran())
    assert (alert.priority, alert.title) == (1, "14:15 · no legs priced") and sets == NONE
    assert alert.body


# --- the body ------------------------------------------------------------------------------------

def test_the_body_lists_each_games_best_leg_best_first():
    alert, _ = compose(ran(*HIGH4))
    assert alert.body.splitlines() == [
        "1. Connor McMichael U 1.5 Shots On Goal · NHL FLA vs STL · +1.4% (55.7%)",
        "2. David Pastrnak U 1.5 Shots On Goal · NHL BOS vs NYR · +1.3% (55.7%)",
        "3. Jason Robertson U 1.5 Shots On Goal · NHL DAL vs SEA · +1.1% (55.7%)",
        "4. Matty Beniers U 1.5 Shots On Goal · NHL CHI vs DET · +1.0% (55.7%)",
    ]


def test_the_body_holds_at_most_six_legs():
    many = [leg(f"P{i}", f"NBA:A{i}-B{i}", i / 1000, side="over", line=20.5, stat="pts", stat_label="Points",
                sport="NBA", prob=0.5 + i / 100) for i in range(9)]
    lines = compose(ran(*many))[0].body.splitlines()
    assert len(lines) == 6
    assert lines[0] == "1. P8 O 20.5 Points · NBA A8 vs B8 · +0.8% (58.0%)"
    assert lines[5].startswith("6. P3 O 20.5 ")


def test_promo_legs_are_marked():
    legs = [leg("Caleb Williams", "NFL:CHI-NE", 0.1487, prob=0.691, side="over", line=215.5, stat="pass_yards",
                stat_label="Pass Yards", sport="NFL", matchup="CHI vs NE", promo_type="taco"),
            leg("Joel Embiid", "NBA:CLE-PHI", -0.0114, prob=0.531, side="over", line=35.5, stat="pra",
                stat_label="Pts+Rebs+Asts", sport="NBA", matchup="CLE vs PHI")]
    assert compose(ran(*legs))[0].body.splitlines() == [
        "1. Caleb Williams O 215.5 Pass Yards · NFL CHI vs NE · +14.9% (69.1%) · taco",
        "2. Joel Embiid O 35.5 Pts+Rebs+Asts · NBA CLE vs PHI · −1.1% (53.1%)",
    ]


# --- failures ------------------------------------------------------------------------------------

def test_a_failed_board_fetch_alerts_at_4_that_auto_runs_are_off():
    reason = "the board couldn't be fetched (HTTP 429), so auto runs were switched off"
    outcome = {**ran(), "switched_off": True, "error": reason}
    del outcome["report"]
    _, sets = compose(ran(*HIGH4))
    alert, after = compose(outcome, previous=sets)
    assert alert == Alert(4, "AUTO RUNS OFF · board fetch failed · 14:15", reason)
    assert after == sets, "a failed run says nothing about which legs qualify"


def test_any_other_failure_alerts_at_1_with_the_reason():
    outcome = {**ran(), "error": "no sportsbook odds"}
    del outcome["report"]
    assert compose(outcome)[0] == Alert(1, "14:15 · run failed", "no sportsbook odds")


# --- headers -------------------------------------------------------------------------------------

def decoded(value: str) -> str:
    return str(make_header(decode_header(value)))


def test_an_ascii_header_goes_as_it_is():
    assert alerts.header_value("14:15 - run failed") == "14:15 - run failed"


@pytest.mark.parametrize("title", ["HIGH · 4 legs ≥ +1.0% · 14:15", "14:15 · best −0.4%",
                                   "Test alert · PrizePicks EV Optimizer", "HIGH, unchanged · 6 legs ≥ +12.5% · 23:45 " * 3])
def test_a_non_ascii_header_goes_as_rfc_2047_encoded_words(title):
    value = alerts.header_value(title)
    value.encode("ascii")
    assert "\n" not in value and "\r" not in value
    assert all(len(word) <= 75 for word in value.split(" "))
    assert decoded(value) == title


# --- sending -------------------------------------------------------------------------------------

class Transport:
    """Stands in for HTTP: records each request and answers with `status` and `body` (or raises `error`)."""

    def __init__(self, status=200, body=b"{}", error=None):
        self.status, self.body, self.error, self.requests = status, body, error, []

    def __call__(self, method, url, headers, body, timeout):
        self.requests.append({"method": method, "url": url, "headers": headers, "body": body, "timeout": timeout})
        if self.error:
            raise self.error
        return self.status, self.body


ALERT = Alert(4, "HIGH · 4 legs ≥ +1.0% · 14:15", "1. Connor McMichael U 1.5 Shots On Goal · NHL FLA vs STL · +1.4% (55.7%)")


def test_an_alert_is_posted_to_the_topic_with_its_title_and_priority():
    http = Transport()
    alerts.publish(ALERT, "https://ntfy.sh", "pp-alerts", "", http)
    (sent,) = http.requests
    assert sent["method"] == "POST" and sent["url"] == "https://ntfy.sh/pp-alerts"
    assert decoded(sent["headers"]["Title"]) == ALERT.title and sent["headers"]["Priority"] == "4"
    assert "Authorization" not in sent["headers"]
    assert sent["body"] == ALERT.body.encode()
    assert sent["timeout"] == 10
    for value in sent["headers"].values():
        value.encode("ascii")


def test_a_token_goes_as_a_bearer_and_a_trailing_slash_is_dropped():
    http = Transport()
    alerts.publish(ALERT, "http://ntfy.local:8080/", "t", "tk_abc", http)
    assert http.requests[0]["url"] == "http://ntfy.local:8080/t"
    assert http.requests[0]["headers"]["Authorization"] == "Bearer tk_abc"


def test_ntfy_refusing_an_alert_says_why():
    body = json.dumps({"code": 40301, "http": 403, "error": "forbidden"}).encode()
    with pytest.raises(SendFailed, match=r"^ntfy refused it \(403: forbidden\)$"):
        alerts.publish(ALERT, "https://ntfy.sh", "t", "", Transport(403, body))
    with pytest.raises(SendFailed, match=r"^ntfy refused it \(502\)$"):
        alerts.publish(ALERT, "https://ntfy.sh", "t", "", Transport(502, b"<html>bad gateway</html>"))


@pytest.mark.parametrize("error, reason", [
    (TimeoutError("timed out"), "couldn't reach https://ntfy.sh (timed out)"),
    (ConnectionRefusedError(111, "Connection refused"), "couldn't reach https://ntfy.sh ([Errno 111] Connection refused)"),
])
def test_ntfy_out_of_reach_says_why(error, reason):
    with pytest.raises(SendFailed) as e:
        alerts.publish(ALERT, "https://ntfy.sh", "t", "", Transport(error=error))
    assert str(e.value) == reason


# --- checking a topic ----------------------------------------------------------------------------

def lines(*events) -> bytes:
    return "".join(json.dumps(e) + "\n" for e in events).encode()


MESSAGE = {"id": "abc", "time": 1, "event": "message", "topic": "t", "message": "hi"}


def check(http, token=""):
    return alerts.check("https://ntfy.sh", "t", token, http)


def test_checking_polls_the_topics_cached_messages():
    http = Transport(200, b"")
    check(http)
    (sent,) = http.requests
    assert sent["method"] == "GET" and sent["url"] == "https://ntfy.sh/t/json?poll=1&since=all"
    assert sent["body"] is None and "Authorization" not in sent["headers"]


def test_a_topic_with_cached_messages_is_recent():
    result = check(Transport(200, lines(MESSAGE, {**MESSAGE, "id": "def"})))
    assert result["state"] == "recent" and "2 messages" in result["detail"]


def test_a_topic_with_no_messages_is_unused():
    assert check(Transport(200, b""))["state"] == "unused"
    assert check(Transport(200, lines({"id": "o", "time": 1, "event": "open", "topic": "t"})))["state"] == "unused"


def test_a_topic_denied_to_anyone_without_a_login_is_reserved():
    forbidden = json.dumps({"code": 40301, "http": 403, "error": "forbidden"}).encode()
    result = check(Transport(403, forbidden))
    assert result["state"] == "reserved" and "someone" in result["detail"]
    assert check(Transport(401, b'{"code":40101,"http":401,"error":"unauthorized"}'))["state"] == "reserved"


def test_with_a_token_the_check_reads_as_the_token_holder():
    http = Transport(200, lines(MESSAGE))
    result = check(http, token="tk_abc")
    assert http.requests[0]["headers"]["Authorization"] == "Bearer tk_abc"
    assert result["state"] == "recent" and "token" in result["detail"]
    denied = check(Transport(403, b'{"error":"forbidden"}'), token="tk_abc")
    assert denied["state"] == "reserved" and "token" in denied["detail"]
    refused = check(Transport(401, b'{"error":"unauthorized"}'), token="tk_bad")
    assert refused["state"] == "unknown" and "token" in refused["detail"]


@pytest.mark.parametrize("http, detail", [
    (Transport(429, b'{"code":42901,"http":429,"error":"limit reached: too many requests"}'),
     "ntfy answered 429: limit reached: too many requests"),
    (Transport(500, b"oops"), "ntfy answered 500"),
    (Transport(error=TimeoutError("timed out")), "couldn't reach https://ntfy.sh (timed out)"),
])
def test_anything_else_is_unknown_with_the_reason(http, detail):
    assert check(http) == {"state": "unknown", "detail": detail}


# --- the real transport, against a local stand-in ------------------------------------------------

class Stub(BaseHTTPRequestHandler):
    heard: list = []
    answer = (200, b'{"id":"x","event":"message"}')

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        Stub.heard.append((self.command, self.path, dict(self.headers), self.rfile.read(length)))
        self._answer()

    def do_GET(self):
        Stub.heard.append((self.command, self.path, dict(self.headers), b""))
        self._answer()

    def _answer(self):
        status, body = Stub.answer
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@pytest.fixture
def stub():
    server = HTTPServer(("127.0.0.1", 0), Stub)
    Stub.heard, Stub.answer = [], (200, b'{"id":"x","event":"message"}')
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()


def test_the_real_transport_posts_a_non_ascii_title(stub):
    alerts.publish(ALERT, stub, "pp", "tk_abc", alerts.urllib_transport)
    ((method, path, headers, body),) = Stub.heard
    assert (method, path) == ("POST", "/pp")
    assert decoded(headers["Title"]) == ALERT.title and headers["Priority"] == "4"
    assert headers["Authorization"] == "Bearer tk_abc"
    assert body.decode() == ALERT.body


def test_the_real_transport_hands_back_an_error_status(stub):
    Stub.answer = (403, b'{"code":40301,"http":403,"error":"forbidden"}')
    assert alerts.urllib_transport("GET", f"{stub}/t/json?poll=1&since=all", {}, None, 5) == (
        403, b'{"code":40301,"http":403,"error":"forbidden"}')


def test_the_real_transport_raises_os_error_when_nothing_answers():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    with pytest.raises(SendFailed, match=r"^couldn't reach http://127\.0\.0\.1:\d+ \(.*refused.*\)$"):
        alerts.publish(ALERT, f"http://127.0.0.1:{port}", "t", "", alerts.urllib_transport)
