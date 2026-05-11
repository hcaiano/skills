#!/usr/bin/env python3
"""Atomic mutation of ~/.herdr-coworkers/<workspace_id>/session.json.

Usage:
    update-session.py <field-path> <value>
    update-session.py --inc <field-path>

Examples:
    update-session.py round 3
    update-session.py last_status.claude review
    update-session.py --inc no_progress_count

<field-path> is a dot-separated path into the JSON object.
<value> is parsed as JSON if it looks like JSON (true/false/null/number/quoted-string/array/object);
otherwise treated as a literal string.

Writes via temp file + rename for atomicity.
Exits 0 on success, non-zero on error with message on stderr.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def resolve_session_file() -> Path:
    pane_id = os.environ.get("HERDR_PANE_ID")
    if not pane_id:
        sys.exit("HERDR_PANE_ID is not set")
    try:
        out = subprocess.check_output(["herdr", "pane", "get", pane_id], text=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        sys.exit(f"failed to resolve self via herdr pane get: {exc}")
    ws = json.loads(out)["result"]["pane"]["workspace_id"]
    path = Path.home() / ".herdr-coworkers" / ws / "session.json"
    if not path.exists():
        sys.exit(f"no session file at {path}; run bootstrap.sh first")
    return path


def parse_value(raw: str):
    """Parse JSON if it looks like JSON; otherwise return the raw string."""
    stripped = raw.strip()
    if not stripped:
        return raw
    first = stripped[0]
    if first in '{[' or stripped in ("true", "false", "null") or first == '"' \
            or (first == '-' and stripped[1:2].isdigit()) or first.isdigit():
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass
    return raw


def set_path(obj: dict, dotted: str, value) -> None:
    parts = dotted.split(".")
    cur = obj
    for key in parts[:-1]:
        if key not in cur or not isinstance(cur[key], dict):
            sys.exit(f"field path {dotted!r} traverses non-object at {key!r}")
        cur = cur[key]
    cur[parts[-1]] = value


def inc_path(obj: dict, dotted: str) -> None:
    parts = dotted.split(".")
    cur = obj
    for key in parts[:-1]:
        if key not in cur or not isinstance(cur[key], dict):
            sys.exit(f"field path {dotted!r} traverses non-object at {key!r}")
        cur = cur[key]
    leaf = parts[-1]
    if leaf not in cur or not isinstance(cur[leaf], int):
        sys.exit(f"--inc target {dotted!r} is missing or not an integer")
    cur[leaf] += 1


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "--inc":
        mode, dotted, value = "inc", argv[2], None
    elif len(argv) == 3:
        mode, dotted, value = "set", argv[1], parse_value(argv[2])
    else:
        sys.exit(__doc__.strip())

    session_file = resolve_session_file()
    with session_file.open() as f:
        data = json.load(f)

    if mode == "set":
        set_path(data, dotted, value)
    else:
        inc_path(data, dotted)

    tmp = session_file.with_suffix(f".json.tmp.{os.getpid()}")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(session_file)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
