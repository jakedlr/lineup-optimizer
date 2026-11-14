"""Runs as the app holds them: one at a time, watched by any number of pages, the latest one kept, and auto runs
started on the quarter hour. Nothing here knows about HTTP or what a run does; `web.create_app` wires it up."""

import json
import logging
import queue
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterator

from .cli import UserError
from .progress import Progress, RunCancelled

log = logging.getLogger(__name__)
FINAL = ("report", "error")  # the event types a run ends with

QUARTER = 900  # seconds: auto runs start at :00, :15, :30 and :45 (epoch seconds, so UTC-based, as every zone is)
LATE = 60  # seconds: a quarter mark not reached within this long (the app was down, the thread late) is missed


def next_mark(epoch: float) -> float:
    """The first quarter mark strictly after `epoch`."""
    return (epoch // QUARTER + 1) * QUARTER


def read_json(path: Path):
    """The JSON saved at `path`, or None when there's none or it can't be read."""
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def write_json(path: Path, data) -> None:
    """Save `data` at `path`, written aside and swapped in, so a reader (or a crash) never sees half of it."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, prefix=f"{path.stem}.", suffix=".tmp",
                                     delete=False) as f:
        json.dump(data, f)
    Path(f.name).replace(path)


class Busy(Exception):
    """A run is already going; `run` is it."""

    def __init__(self, run: "Run"):
        super().__init__("a run is already going")
        self.run = run


class Run:
    """One run in flight: who started it and when, its progress, and every event it sends, fanned out to whoever
    is watching. A page that starts watching late first hears where the run is now (its latest progress, and the
    board it announced, if it has), then everything after, as the run's starter does."""

    def __init__(self, started_by: str, started_at: datetime):
        self.started_by, self.started_at = started_by, started_at
        self.progress = Progress(lambda e: self.publish({"type": "progress", **e}))
        self.stopped_because = "the page that started it was closed"
        self._lock = threading.Lock()  # guards everything below; taken inside the progress lock, never around it
        self._watchers: list[queue.SimpleQueue] = []
        self._progress: dict | None = None  # the latest progress event
        self._board: dict | None = None  # the board event, once the run has announced its board
        self._final: dict | None = None  # the report or error it ended with

    @property
    def watchers(self) -> int:
        with self._lock:
            return len(self._watchers)

    @property
    def finished(self) -> bool:
        with self._lock:
            return self._final is not None

    def publish(self, event: dict) -> None:
        """Send an event to everyone watching (the run's `announce`; progress arrives here too)."""
        with self._lock:
            if event["type"] == "progress":
                self._progress = event
            elif event["type"] == "board":
                self._board = event
            for q in self._watchers:
                q.put(event)

    def finish(self, event: dict) -> None:
        """End the run with this report or error: everyone watching hears it, and so does anyone who starts
        watching later."""
        with self._lock:
            self._final = event
            for q in self._watchers:
                q.put(event)
            self._watchers.clear()

    def snapshot(self) -> list[dict]:
        with self._lock:
            return self._snapshot()

    def _snapshot(self) -> list[dict]:
        events = [self._progress or {"type": "progress", "done": 0, "total": 0, "step": ""}]
        return events + [e for e in (self._board, self._final) if e is not None]

    def watch(self, snapshot: bool = True, cancel_on_close: bool = False) -> Iterator[dict]:
        """The run's events from now on, ending with its report or error; with `snapshot`, led by where it is now.
        Watching starts on the call, not on the first `next`, so nothing sent in between is missed. With
        `cancel_on_close`, closing the events before the end cancels the run (its starter went away)."""
        q: queue.SimpleQueue = queue.SimpleQueue()
        with self._lock:
            for event in self._snapshot() if snapshot else []:
                q.put(event)
            if self._final is None:
                self._watchers.append(q)
            elif not snapshot:
                q.put(self._final)
        return self._follow(q, cancel_on_close)

    def _follow(self, q: queue.SimpleQueue, cancel_on_close: bool) -> Iterator[dict]:
        try:
            while True:
                event = q.get()
                yield event
                if event["type"] in FINAL:
                    return
        finally:
            with self._lock:
                if q in self._watchers:
                    self._watchers.remove(q)
                ended = self._final is not None
            if cancel_on_close and not ended:
                self.cancel()

    def cancel(self, because: str | None = None) -> None:
        """Stop the run at its next request. It ends in an error saying it was stopped, and isn't recorded."""
        if because:
            self.stopped_because = because
        self.progress.cancel()


Work = Callable[[Progress, Callable[[dict], None]], dict]  # (progress, announce) -> report; raises to fail


class Runner:
    """The app's one run at a time. Starting a run while one is going raises Busy, so the run that got there first
    is the only one; a finished run is handed to `record` (as the latest run) before the next may start."""

    def __init__(self, now: Callable[[], datetime], record: Callable[[dict], None]):
        self.now, self.record = now, record
        self._lock = threading.Lock()
        self._run: Run | None = None

    @property
    def current(self) -> Run | None:
        with self._lock:
            return self._run

    def start(self, work: Work, started_by: str, on_end: Callable[[dict], None] | None = None,
              watch: bool = False) -> Iterator[dict] | None:
        """Start `work(progress, announce)` on its own thread, or raise Busy. `on_end(entry)` hears how it ended,
        as recorded (not when cancelled). With `watch`, returns the starter's events: every one from the first,
        ending with the report or error; closing them early cancels the run."""
        with self._lock:
            if self._run is not None:
                raise Busy(self._run)
            run = self._run = Run(started_by, self.now())
        events = run.watch(snapshot=False, cancel_on_close=True) if watch else None
        threading.Thread(target=self._work, args=(run, work, on_end), daemon=True,
                         name=f"{started_by} run").start()
        return events

    def _work(self, run: Run, work: Work, on_end) -> None:
        try:
            outcome = {"report": work(run.progress, run.publish)}
        except RunCancelled:
            outcome = None
        except UserError as e:
            outcome = {"error": str(e)}
        except Exception as e:  # noqa: BLE001 - nobody else will hear of it
            log.exception("run failed")
            outcome = {"error": f"the engine failed: {e}"}
        entry = None
        if outcome is not None:
            entry = {"started_by": run.started_by, "started_at": run.started_at.isoformat(),
                     "finished_at": self.now().isoformat(), **outcome}
            try:
                self.record(entry)
            except Exception:  # noqa: BLE001 - the run's result still reaches whoever is watching
                log.exception("couldn't record the run")
        # The run is over before anyone hears its end: whoever does may start the next one straight away.
        with self._lock:
            self._run = None
        if entry is None:
            run.finish({"type": "error", "detail": f"the run was stopped: {run.stopped_because}"})
        elif "report" in entry:
            run.finish({"type": "report", "report": entry["report"]})
        else:
            run.finish({"type": "error", "detail": entry["error"]})
        if entry is not None and on_end is not None:
            try:
                on_end(entry)
            except Exception:  # noqa: BLE001
                log.exception("the run's end hook failed")


class Scheduler:
    """Calls `on_mark()` at each quarter mark, on its own thread while started. Each mark is acted on at most once,
    and only within LATE seconds of it: marks passed while the app was down, or before it started, aren't caught
    up. `clock` is the wall clock in epoch seconds; `wait(seconds)` pauses, returning True once stopped (the stop
    event's wait, so stopping interrupts it)."""

    def __init__(self, on_mark: Callable[[], object], clock: Callable[[], float] = time.time, wait=None):
        self.on_mark, self.clock = on_mark, clock
        self._stop = threading.Event()
        self._wait = wait or self._stop.wait
        self._lock = threading.Lock()
        self._done = clock() // QUARTER * QUARTER  # the last mark acted on, or passed before the app started
        self._thread: threading.Thread | None = None

    def tick(self, now: float) -> None:
        """Act on the quarter mark at or before `now`, if that's still to do."""
        mark = now // QUARTER * QUARTER
        with self._lock:
            if mark <= self._done or now - mark > LATE:
                return
            self._done = mark
        self.on_mark()

    def run(self) -> None:
        """Tick at each mark until stopped. Wakes at least once a minute, in case the wall clock jumped (a laptop
        sleeping, the clock set) while it waited."""
        while True:
            now = self.clock()
            try:
                self.tick(now)
            except Exception:  # noqa: BLE001 - the next mark still comes
                log.exception("the quarter mark failed")
            if self._wait(min(max(next_mark(now) - self.clock(), 0), LATE)):
                return

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self.run, daemon=True, name="auto runs")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(5)
