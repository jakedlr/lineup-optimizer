"""A stand-in ntfy server for the e2e suite (docker-compose.e2e.yml), so alerts never reach a real one.

As ntfy (https://docs.ntfy.sh/publish/, https://docs.ntfy.sh/subscribe/api/):
- POST|PUT /{topic}: publish; the body is the message, Title and Priority headers (Title may be RFC 2047 encoded).
- GET /{topic}/json?poll=1&since=all: the topic's messages as JSON lines, then the response ends.
- The topic `reserved-topic` answers 403 to anyone, as a topic someone else reserved does.

For specs:
- GET /_published: every publish so far, oldest first: {method, path, topic, headers, title (decoded), priority,
  authorization, body}.
- DELETE /_published: forget them all (and every topic's messages).
"""

import json
import re
import sys
import threading
import time
from email.header import decode_header, make_header
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 80
RESERVED = "reserved-topic"
TOPIC = re.compile(r"^/([-_A-Za-z0-9]{1,64})$")
POLL = re.compile(r"^/([-_A-Za-z0-9]{1,64})/json$")

lock = threading.Lock()
published: list[dict] = []


def decoded(value: str | None) -> str | None:
    return None if value is None else str(make_header(decode_header(value)))


class Ntfy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def answer(self, status: int, body: bytes = b"", kind: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def forbidden(self) -> None:
        self.answer(403, b'{"code":40301,"http":403,"error":"forbidden","link":"https://ntfy.sh/docs/publish/"}\n')

    def publish(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8", "replace")
        path = urlsplit(self.path).path
        found = TOPIC.match(path)
        if not found:
            return self.answer(404, b'{"code":40401,"http":404,"error":"page not found"}\n')
        topic = found.group(1)
        if topic == RESERVED:
            return self.forbidden()
        record = {
            "method": self.command, "path": path, "topic": topic, "headers": dict(self.headers.items()),
            "title": decoded(self.headers.get("Title")), "priority": self.headers.get("Priority"),
            "authorization": self.headers.get("Authorization"), "body": body,
            "time": int(time.time()),
        }
        with lock:
            published.append(record)
            n = len(published)
        message = {"id": f"m{n}", "time": record["time"], "event": "message", "topic": topic, "message": body,
                   "title": record["title"], "priority": int(record["priority"] or 3)}
        self.answer(200, (json.dumps(message) + "\n").encode())

    do_POST = publish
    do_PUT = publish

    def do_GET(self) -> None:
        parts = urlsplit(self.path)
        if parts.path == "/_published":
            with lock:
                return self.answer(200, json.dumps(published).encode())
        if parts.path == "/_health":
            return self.answer(200, b'{"healthy":true}\n')
        found = POLL.match(parts.path)
        if not found:
            return self.answer(404, b'{"code":40401,"http":404,"error":"page not found"}\n')
        topic = found.group(1)
        if topic == RESERVED:
            return self.forbidden()
        with lock:
            lines = [json.dumps({"id": f"m{i + 1}", "time": p["time"], "event": "message", "topic": topic,
                                 "message": p["body"], "title": p["title"]})
                     for i, p in enumerate(published) if p["topic"] == topic]
        self.answer(200, "".join(line + "\n" for line in lines).encode(), "application/x-ndjson")

    def do_DELETE(self) -> None:
        if urlsplit(self.path).path != "/_published":
            return self.answer(404, b'{"code":40401,"http":404,"error":"page not found"}\n')
        with lock:
            published.clear()
        self.answer(200, b'{"cleared":true}\n')

    def log_message(self, format, *args) -> None:  # noqa: A002 - the base class's name
        sys.stderr.write(f"fake-ntfy: {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}\n")


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Ntfy).serve_forever()
