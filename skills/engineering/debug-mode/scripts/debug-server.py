#!/usr/bin/env python3
"""Small JSONL HTTP collector for debug-mode instrumentation."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, TextIO


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_event(payload: dict[str, Any]) -> dict[str, Any]:
    event = dict(payload)
    event.setdefault("timestamp", now_iso())
    return event


def make_handler(sink: TextIO, lock: threading.Lock) -> type[BaseHTTPRequestHandler]:
    class DebugHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - stdlib hook name
            if self.path != "/log":
                self.send_response(404)
                self.end_headers()
                return

            length = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"invalid json\n")
                return

            if not isinstance(payload, dict):
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"json body must be an object\n")
                return

            line = json.dumps(normalize_event(payload), sort_keys=True) + "\n"
            with lock:
                sink.write(line)
                sink.flush()

            self.send_response(204)
            self.end_headers()

        def log_message(self, format: str, *args: Any) -> None:
            # Suppress default stderr access logs — keep the user's terminal clean.
            return

    return DebugHandler


def main() -> None:
    parser = argparse.ArgumentParser(description="Collect debug events as JSONL")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    with output.open("a", encoding="utf-8") as sink:
        lock = threading.Lock()
        server = ThreadingHTTPServer((args.host, args.port), make_handler(sink, lock))
        print(f"debug server listening on http://{args.host}:{args.port}/log")
        print(f"writing events to {output}")

        def shutdown(*_: Any) -> None:
            threading.Thread(target=server.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)

        try:
            server.serve_forever()
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
