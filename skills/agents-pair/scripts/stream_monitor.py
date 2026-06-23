#!/usr/bin/env python3
"""Mirror Claude stream-json to disk and print compact live progress."""

from __future__ import annotations

import json
import os
import sys
from typing import Any


def shorten(value: Any, limit: int = 240) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        value = json.dumps(value, sort_keys=True)
    value = " ".join(value.replace("\r", " ").replace("\n", " ").split())
    if len(value) > limit:
        return value[: limit - 3] + "..."
    return value


def emit(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def describe_tool_input(name: str, tool_input: Any) -> str:
    if not isinstance(tool_input, dict):
        return shorten(tool_input)
    if name == "StructuredOutput":
        message = tool_input.get("message_to_codex")
        status = (tool_input.get("continuation_state") or {}).get("status")
        next_owner = (tool_input.get("proposed_next_turn") or {}).get("owner")
        return shorten(
            {
                "message_to_codex": message,
                "continuation_status": status,
                "next_owner": next_owner,
            }
        )
    if "command" in tool_input:
        return "command=" + shorten(tool_input.get("command"))
    if "file_path" in tool_input:
        return "file_path=" + shorten(tool_input.get("file_path"))
    if "path" in tool_input:
        return "path=" + shorten(tool_input.get("path"))
    if "pattern" in tool_input:
        return "pattern=" + shorten(tool_input.get("pattern"))
    return shorten(tool_input)


TEXT_LIMIT = int(os.environ.get("CLAUDE_MONITOR_TEXT_LIMIT", "3000"))
text_emitted = 0
text_limit_reported = False


def emit_text_delta(text: str) -> None:
    global text_emitted, text_limit_reported
    text = shorten(text, 400)
    if not text or TEXT_LIMIT <= 0:
        return
    remaining = TEXT_LIMIT - text_emitted
    if remaining <= 0:
        if not text_limit_reported:
            emit("[claude:text] live text limit reached; see stream transcript for full output")
            text_limit_reported = True
        return
    if len(text) > remaining:
        text = text[: max(0, remaining - 3)] + "..."
    text_emitted += len(text)
    emit(f"[claude:text] {text}")


def handle_event(obj: dict[str, Any]) -> None:
    event_type = obj.get("type")

    if event_type == "system":
        subtype = obj.get("subtype")
        if subtype == "init":
            tools = ",".join(obj.get("tools") or [])
            emit(
                "[claude:init] "
                f"session={obj.get('session_id')} model={obj.get('model')} tools={tools}"
            )
        elif subtype == "status":
            emit(f"[claude:status] {obj.get('status')}")
        elif subtype == "api_retry":
            emit(
                "[claude:retry] "
                f"attempt={obj.get('attempt')}/{obj.get('max_retries')} "
                f"status={obj.get('error_status')} error={obj.get('error')} "
                f"delay_ms={obj.get('retry_delay_ms')}"
            )
        elif subtype == "hook_response" and obj.get("outcome") != "success":
            emit(
                "[claude:hook] "
                f"{obj.get('hook_name')} outcome={obj.get('outcome')} "
                f"stderr={shorten(obj.get('stderr'))}"
            )
        return

    if event_type == "stream_event":
        event = obj.get("event") or {}
        nested_type = event.get("type")
        if nested_type == "content_block_start":
            block = event.get("content_block") or {}
            block_type = block.get("type")
            if block_type == "tool_use":
                emit(f"[claude:tool] start {block.get('name')}")
            elif block_type == "thinking":
                emit("[claude:thinking] hidden reasoning block started")
        elif nested_type == "content_block_delta":
            delta = event.get("delta") or {}
            if delta.get("type") == "text_delta":
                emit_text_delta(delta.get("text") or "")
        elif nested_type == "message_delta":
            usage = event.get("usage") or {}
            details = usage.get("output_tokens_details") or {}
            thinking_tokens = details.get("thinking_tokens")
            stop_reason = (event.get("delta") or {}).get("stop_reason")
            parts = []
            if thinking_tokens:
                parts.append(f"thinking_tokens={thinking_tokens}")
            if stop_reason:
                parts.append(f"stop_reason={stop_reason}")
            if parts:
                emit("[claude:progress] " + " ".join(parts))
        return

    if event_type == "assistant":
        message = obj.get("message") or {}
        for block in message.get("content") or []:
            if block.get("type") == "tool_use":
                name = block.get("name")
                emit(f"[claude:tool] {name} {describe_tool_input(name, block.get('input'))}")
            elif block.get("type") == "text" and obj.get("error"):
                emit(f"[claude:error] {shorten(block.get('text'), 500)}")
        return

    if event_type == "user":
        message = obj.get("message") or {}
        for block in message.get("content") or []:
            if block.get("type") == "tool_result":
                content = block.get("content")
                size = len(content) if isinstance(content, str) else 0
                emit(f"[claude:tool-result] {block.get('tool_use_id')} bytes={size}")
        return

    if event_type == "result":
        structured = obj.get("structured_output")
        if isinstance(structured, dict):
            status = (structured.get("continuation_state") or {}).get("status")
            next_owner = (structured.get("proposed_next_turn") or {}).get("owner")
            message = shorten(structured.get("message_to_codex"), 500)
            emit(
                "[claude:peer] "
                f"status={status} next_owner={next_owner} message={message}"
            )
        emit(
            "[claude:done] "
            f"terminal={obj.get('terminal_reason')} stop={obj.get('stop_reason')} "
            f"turns={obj.get('num_turns')} duration_ms={obj.get('duration_ms')}"
        )


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: stream_monitor.py RAW_STREAM_JSONL", file=sys.stderr)
        return 2

    with open(sys.argv[1], "w", encoding="utf-8") as raw:
        for line in sys.stdin:
            raw.write(line)
            raw.flush()
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                handle_event(obj)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
