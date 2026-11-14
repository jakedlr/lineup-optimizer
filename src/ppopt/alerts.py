"""Alerts: the push an auto run sends to the user's phone through ntfy when it ends (GLOSSARY: Alert, Alert tier,
Qualifying leg). What an alert says is worked out here from the run's recorded outcome, with no I/O; sending it, and
checking a topic, go through a `Transport` so tests never reach a real ntfy server.

ntfy, as relied on (https://docs.ntfy.sh/publish/, https://docs.ntfy.sh/subscribe/api/):
- publish: POST the message body to `{server}/{topic}`, title in `Title`, priority (1-5) in `Priority`, an access token
  as `Authorization: Bearer <token>`. Header values may be RFC 2047 encoded words, which the server decodes.
- poll: `GET {server}/{topic}/json?poll=1&since=all` answers the topic's cached messages as JSON lines and ends.
- a topic the caller may not read or write answers 403 (`{"code":40301,"http":403,"error":"forbidden"}`); a login
  the server rejects answers 401. Errors are JSON with the reason in `error`.
"""

import base64
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Callable
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool, model_validator

TIMEOUT = 10  # seconds, for each request to ntfy
TOP = 6  # legs in an alert's body
TIERS = (("high", 4), ("medium", 3))  # (tier, ntfy priority), the higher tier first
QUIET = 1  # ntfy priority of an alert that meets no tier, repeats one, or reports a run that failed
TEST_ALERT_TITLE = "Test alert · PrizePicks EV Optimizer"
TEST_ALERT_BODY = "Auto runs' alerts will arrive here."

MINUS = "−"  # edges are signed with a real minus sign


@dataclass(frozen=True)
class Alert:
    priority: int  # ntfy priority: 1, 3 or 4
    title: str
    body: str


# --- what an alert says -------------------------------------------------------------------------

def pct(fraction: float) -> str:
    """An edge as signed percentage points to one decimal: `+1.4%`, `−0.4%` (and `+0.0%`, never `−0.0%`)."""
    value = round(fraction * 100, 1)
    return f"{MINUS if value < 0 else '+'}{abs(value):.1f}%"


def bar(points: float) -> str:
    return f"≥ +{points:.1f}%"


def best_per_game(legs: list[dict]) -> list[dict]:
    """Each game's best-edge leg, best first (a slip holds one leg per game)."""
    best: dict[str, dict] = {}
    for leg in legs:
        if leg["game"] not in best or leg["edge"] > best[leg["game"]]["edge"]:
            best[leg["game"]] = leg
    return sorted(best.values(), key=lambda leg: leg["edge"], reverse=True)


def identity(leg: dict) -> str:
    return "|".join(str(leg[k]) for k in ("player", "stat", "line", "side", "game"))


def qualifying(legs: list[dict], tier: dict) -> list[str]:
    """The tier's qualifying legs (each game's best, when it meets the edge bar), as sorted identities. The bar is
    in percentage points, compared at 6 dp so a leg on the bar isn't lost to float error (0.011 * 100 < 1.1)."""
    return sorted(identity(leg) for leg in best_per_game(legs) if round(leg["edge"] * 100, 6) >= tier["edge"])


def leg_line(n: int, leg: dict) -> str:
    side = "O" if leg["side"] == "over" else "U"
    text = (f"{n}. {leg['player']} {side} {leg['line']:g} {leg['stat_label']} · {leg['sport']} {leg['matchup']} · "
            f"{pct(leg['edge'])} ({leg['prob'] * 100:.1f}%)")
    return text + f" · {leg['promo_type']}" if leg["promo_type"] else text  # feed promos are named, "promo" at least


def compose(outcome: dict, tiers: dict, previous: dict, at: datetime) -> tuple[Alert, dict]:
    """The alert for an auto run's recorded `outcome` ("report" or "error", and "switched_off"), and each tier's
    qualifying legs to remember for the next one. `tiers` is {"medium"|"high": {enabled, edge, legs}}, `previous`
    what the last alert remembered ({tier: identities or None}), `at` the run's start in the user's zone.

    A tier is met when enough games' best legs clear its bar. The high tier, if met with legs that changed since its
    last alert, goes at priority 4; else medium likewise at 3; else priority 1. Each met tier remembers its legs and
    a tier not met (or switched off) forgets them, so meeting it again alerts. A failed run changes nothing."""
    time = at.strftime("%H:%M")
    if "error" in outcome:
        if outcome.get("switched_off"):
            return Alert(4, f"AUTO RUNS OFF · board fetch failed · {time}", outcome["error"]), dict(previous)
        return Alert(QUIET, f"{time} · run failed", outcome["error"]), dict(previous)

    legs = outcome["report"]["legs"]
    sets = {}
    for name, _ in TIERS:
        tier = tiers[name]
        found = qualifying(legs, tier) if tier["enabled"] else []
        sets[name] = found if found and len(found) >= tier["legs"] else None

    def headline(name: str) -> str:
        n = len(sets[name])
        return f"{n} {'leg' if n == 1 else 'legs'} {bar(tiers[name]['edge'])} · {time}"

    met = [(name, priority) for name, priority in TIERS if sets[name] is not None]
    changed = [(name, priority) for name, priority in met if sets[name] != previous.get(name)]
    shown = best_per_game(legs)[:TOP]
    body = "\n".join(leg_line(n, leg) for n, leg in enumerate(shown, 1)) or "No legs were priced."
    if changed:
        name, priority = changed[0]
        title = f"{name.upper()} · {headline(name)}"
    elif met:
        name, priority = met[0][0], QUIET
        title = f"{name.upper()}, unchanged · {headline(name)}"
    else:
        priority = QUIET
        title = f"{time} · best {pct(shown[0]['edge'])}" if shown else f"{time} · no legs priced"
    return Alert(priority, title, body), sets


# --- sending ------------------------------------------------------------------------------------

# (method, url, headers, body, timeout) -> (status, body). Answers any HTTP status; raises OSError when the server
# can't be reached or doesn't answer in time.
Transport = Callable[[str, str, dict, bytes | None, float], tuple[int, bytes]]


def urllib_transport(method: str, url: str, headers: dict, body: bytes | None, timeout: float) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(1 << 20)
    except urllib.error.HTTPError as e:
        with e:
            return e.code, e.read(1 << 16)


class SendFailed(Exception):
    """ntfy refused an alert or couldn't be reached; says why."""


WORD = 45  # bytes of UTF-8 per encoded word: base64'd and wrapped, 72 characters, inside RFC 2047's 75


def header_value(text: str) -> str:
    """`text` fit for an HTTP header: as it is when ASCII, else RFC 2047 encoded words (`=?UTF-8?B?...?=`), which
    ntfy decodes. Titles carry ≥, · and −, which HTTP libraries (urllib among them) won't send raw. Long text is
    split between characters into several words, joined by spaces a decoder drops."""
    if text.isascii():
        return text
    words, chunk = [], b""
    for char in text:
        encoded = char.encode()
        if len(chunk) + len(encoded) > WORD:
            words.append(chunk)
            chunk = b""
        chunk += encoded
    words.append(chunk)
    return " ".join(f"=?UTF-8?B?{base64.b64encode(w).decode()}?=" for w in words)


def topic_url(server: str, topic: str) -> str:
    return f"{server.rstrip('/')}/{topic}"


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"} if token else {}


def unreachable(server: str, e: OSError) -> str:
    reason = e.reason if isinstance(e, urllib.error.URLError) else e
    return f"couldn't reach {server.rstrip('/')} ({reason})"


def ntfy_error(body: bytes) -> str | None:
    """The reason in ntfy's JSON error, if that's what came back."""
    try:
        error = json.loads(body).get("error")
    except (ValueError, AttributeError):
        return None
    return error if isinstance(error, str) and error else None


def publish(alert: Alert, server: str, topic: str, token: str, transport: Transport) -> None:
    """Post `alert` to the topic. Raises SendFailed when ntfy refuses it or can't be reached. No retries."""
    headers = {"Title": header_value(alert.title), "Priority": str(alert.priority),
               "Content-Type": "text/plain; charset=utf-8", **auth(token)}
    try:
        status, body = transport("POST", topic_url(server, topic), headers, alert.body.encode(), TIMEOUT)
    except OSError as e:
        raise SendFailed(unreachable(server, e)) from e
    if not 200 <= status < 300:
        error = ntfy_error(body)
        raise SendFailed(f"ntfy refused it ({status}: {error})" if error else f"ntfy refused it ({status})")


def check(server: str, topic: str, token: str, transport: Transport) -> dict:
    """Advice on whether a topic looks free to use: {"state": "unused" | "recent" | "reserved" | "unknown",
    "detail"}, from its cached messages (a poll). With a token, the check reads as the token's holder."""
    url = f"{topic_url(server, topic)}/json?poll=1&since=all"
    try:
        status, body = transport("GET", url, {**auth(token)}, None, TIMEOUT)
    except OSError as e:
        return {"state": "unknown", "detail": unreachable(server, e)}
    if status == 200:
        messages = 0
        for line in body.splitlines():
            try:
                messages += json.loads(line).get("event") == "message"
            except (ValueError, AttributeError):
                continue
        through = " (read with your token)" if token else ""
        if messages:
            plural = "message" if messages == 1 else "messages"
            whose = through or ": someone else may be using it"
            return {"state": "recent", "detail": f"{messages} {plural} posted to this topic recently{whose}"}
        return {"state": "unused", "detail": f"no recent messages on this topic{through}"}
    if status == 403:
        detail = ("this topic is reserved and your token can't read it" if token
                  else "someone has reserved this topic: only they can read it")
        return {"state": "reserved", "detail": detail}
    if status == 401:
        if token:
            return {"state": "unknown", "detail": "ntfy refused the access token"}
        return {"state": "reserved", "detail": "this topic needs a login to read: someone has reserved it"}
    error = ntfy_error(body)
    return {"state": "unknown", "detail": f"ntfy answered {status}: {error}" if error else f"ntfy answered {status}"}


# --- settings -----------------------------------------------------------------------------------

def _server(url: str) -> str:
    parts = urlsplit(url)
    if (parts.scheme not in ("http", "https") or not parts.hostname or parts.query or parts.fragment
            or any(c.isspace() for c in url)):
        raise ValueError("the server must be an http(s) URL, e.g. https://ntfy.sh")
    return url.rstrip("/")


def _zone(name: str) -> str:
    try:
        ZoneInfo(name)
    except Exception as e:  # noqa: BLE001 - ValueError, ZoneInfoNotFoundError, OSError: not a zone either way
        raise ValueError(f"not an IANA time zone: {name!r}") from e
    return name


def _tenths(edge: float) -> float:
    if abs(edge * 10 - round(edge * 10)) > 1e-6:
        raise ValueError("the edge goes in steps of 0.1")
    return round(edge, 1)


Server = Annotated[str, Field(strict=True), AfterValidator(_server)]
Topic = Annotated[str, Field(strict=True, pattern=r"^[-_A-Za-z0-9]{0,64}$")]  # "" is no topic: no alerts
SomeTopic = Annotated[str, Field(strict=True, pattern=r"^[-_A-Za-z0-9]{1,64}$")]
Token = Annotated[str, Field(strict=True, max_length=256, pattern=r"^[\x21-\x7e]*$")]  # "" is none
Zone = Annotated[str, Field(strict=True), AfterValidator(_zone)]
Edge = Annotated[float, Field(strict=True, ge=0.1, le=20), AfterValidator(_tenths)]  # percentage points
Legs = Annotated[int, Field(strict=True, ge=1, le=6)]


class Tier(BaseModel):
    """An alert tier: met when at least `legs` games' best legs reach `edge` points."""

    model_config = ConfigDict(extra="forbid")

    enabled: StrictBool
    edge: Edge
    legs: Legs


class AlertSettings(BaseModel):
    """Where alerts go and when they're loud, saved whole. Separate from the run settings."""

    model_config = ConfigDict(extra="forbid")

    server: Server = "https://ntfy.sh"
    topic: Topic = ""
    token: Token = ""
    timezone: Zone = "UTC"  # alert titles' clock
    medium: Tier = Field(default_factory=lambda: Tier(enabled=True, edge=0.5, legs=3))
    high: Tier = Field(default_factory=lambda: Tier(enabled=True, edge=1.0, legs=3))

    def view(self) -> dict:
        """As the page sees them: never the token, only whether there is one."""
        return {**self.model_dump(exclude={"token"}), "token_set": bool(self.token)}


def _some(model: BaseModel) -> BaseModel:
    if not model.model_fields_set:
        raise ValueError("change at least one setting")
    if nulls := sorted(f for f in model.model_fields_set if getattr(model, f) is None):
        raise ValueError(f"{', '.join(nulls)} can't be null")
    return model


class TierPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: StrictBool | None = None
    edge: Edge | None = None
    legs: Legs | None = None

    some_settings = model_validator(mode="after")(_some)


class AlertsPatch(BaseModel):
    """Some of the alert settings, changed on top of the saved ones (or the defaults); a tier may be changed in
    part. A token of "" clears it."""

    model_config = ConfigDict(extra="forbid")

    server: Server | None = None
    topic: Topic | None = None
    token: Token | None = None
    timezone: Zone | None = None
    medium: TierPatch | None = None
    high: TierPatch | None = None

    some_settings = model_validator(mode="after")(_some)

    def onto(self, base: AlertSettings) -> AlertSettings:
        merged = base.model_dump()
        for field in self.model_fields_set:
            value = getattr(self, field)
            if isinstance(value, TierPatch):
                merged[field].update(value.model_dump(include=value.model_fields_set))
            else:
                merged[field] = value
        # Each field was checked as it arrived, and the base is valid, so the merge is too.
        return AlertSettings.model_validate(merged)


class TopicCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    topic: SomeTopic | None = None
