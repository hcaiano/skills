#!/usr/bin/env node
// Mirror Claude stream-json to disk and print compact live progress.

import fs from "node:fs";

function pythonJsonString(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function stableStringify(value) {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return pythonJsonString(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const pairs = Object.keys(value)
      .sort()
      .map((key) => `${pythonJsonString(key)}: ${stableStringify(value[key])}`);
    return `{${pairs.join(", ")}}`;
  }
  return pythonJsonString(String(value));
}

function shorten(value, limit = 240) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    value = stableStringify(value);
  }
  value = value.replace(/\r/g, " ").replace(/\n/g, " ");
  value = value.trim() ? value.trim().split(/\s+/).join(" ") : "";
  if (value.length > limit) {
    return `${value.slice(0, limit - 3)}...`;
  }
  return value;
}

function emit(message) {
  process.stderr.write(`${message}\n`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function get(obj, key) {
  return isObject(obj) && Object.hasOwn(obj, key) ? obj[key] : null;
}

function pyStr(value) {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  return String(value);
}

function describeToolInput(name, toolInput) {
  if (!isObject(toolInput)) {
    return shorten(toolInput);
  }
  if (name === "StructuredOutput") {
    const continuationState = get(toolInput, "continuation_state") || {};
    const proposedNextTurn = get(toolInput, "proposed_next_turn") || {};
    const message = get(toolInput, "message_to_codex");
    const status = get(continuationState, "status");
    const nextOwner = get(proposedNextTurn, "owner");
    return shorten({
      message_to_codex: message,
      continuation_status: status,
      next_owner: nextOwner,
    });
  }
  if (Object.hasOwn(toolInput, "command")) {
    return `command=${shorten(get(toolInput, "command"))}`;
  }
  if (Object.hasOwn(toolInput, "file_path")) {
    return `file_path=${shorten(get(toolInput, "file_path"))}`;
  }
  if (Object.hasOwn(toolInput, "path")) {
    return `path=${shorten(get(toolInput, "path"))}`;
  }
  if (Object.hasOwn(toolInput, "pattern")) {
    return `pattern=${shorten(get(toolInput, "pattern"))}`;
  }
  return shorten(toolInput);
}

const textLimit = Number.parseInt(process.env.CLAUDE_MONITOR_TEXT_LIMIT || "3000", 10);
let textEmitted = 0;
let textLimitReported = false;

function emitTextDelta(text) {
  text = shorten(text, 400);
  if (!text || textLimit <= 0) {
    return;
  }
  const remaining = textLimit - textEmitted;
  if (remaining <= 0) {
    if (!textLimitReported) {
      emit("[claude:text] live text limit reached; see stream transcript for full output");
      textLimitReported = true;
    }
    return;
  }
  if (text.length > remaining) {
    text = `${text.slice(0, Math.max(0, remaining - 3))}...`;
  }
  textEmitted += text.length;
  emit(`[claude:text] ${text}`);
}

function handleEvent(obj) {
  const eventType = get(obj, "type");

  if (eventType === "system") {
    const subtype = get(obj, "subtype");
    if (subtype === "init") {
      const toolsValue = get(obj, "tools");
      const tools = Array.isArray(toolsValue) ? toolsValue.join(",") : "";
      emit(
        `[claude:init] session=${pyStr(get(obj, "session_id"))} ` +
          `model=${pyStr(get(obj, "model"))} tools=${tools}`,
      );
    } else if (subtype === "status") {
      emit(`[claude:status] ${pyStr(get(obj, "status"))}`);
    } else if (subtype === "api_retry") {
      emit(
        `[claude:retry] attempt=${pyStr(get(obj, "attempt"))}/${pyStr(get(obj, "max_retries"))} ` +
          `status=${pyStr(get(obj, "error_status"))} error=${pyStr(get(obj, "error"))} ` +
          `delay_ms=${pyStr(get(obj, "retry_delay_ms"))}`,
      );
    } else if (subtype === "hook_response" && get(obj, "outcome") !== "success") {
      emit(
        `[claude:hook] ${pyStr(get(obj, "hook_name"))} outcome=${pyStr(get(obj, "outcome"))} ` +
          `stderr=${shorten(get(obj, "stderr"))}`,
      );
    }
    return;
  }

  if (eventType === "stream_event") {
    const event = get(obj, "event") || {};
    const nestedType = get(event, "type");
    if (nestedType === "content_block_start") {
      const block = get(event, "content_block") || {};
      const blockType = get(block, "type");
      if (blockType === "tool_use") {
        emit(`[claude:tool] start ${pyStr(get(block, "name"))}`);
      } else if (blockType === "thinking") {
        emit("[claude:thinking] hidden reasoning block started");
      }
    } else if (nestedType === "content_block_delta") {
      const delta = get(event, "delta") || {};
      if (get(delta, "type") === "text_delta") {
        emitTextDelta(get(delta, "text") || "");
      }
    } else if (nestedType === "message_delta") {
      const usage = get(event, "usage") || {};
      const details = get(usage, "output_tokens_details") || {};
      const thinkingTokens = get(details, "thinking_tokens");
      const delta = get(event, "delta") || {};
      const stopReason = get(delta, "stop_reason");
      const parts = [];
      if (thinkingTokens) {
        parts.push(`thinking_tokens=${pyStr(thinkingTokens)}`);
      }
      if (stopReason) {
        parts.push(`stop_reason=${pyStr(stopReason)}`);
      }
      if (parts.length) {
        emit(`[claude:progress] ${parts.join(" ")}`);
      }
    }
    return;
  }

  if (eventType === "assistant") {
    const message = get(obj, "message") || {};
    const content = get(message, "content") || [];
    for (const block of content) {
      if (!isObject(block)) {
        continue;
      }
      if (get(block, "type") === "tool_use") {
        const name = get(block, "name");
        emit(`[claude:tool] ${pyStr(name)} ${describeToolInput(name, get(block, "input"))}`);
      } else if (get(block, "type") === "text" && get(obj, "error")) {
        emit(`[claude:error] ${shorten(get(block, "text"), 500)}`);
      }
    }
    return;
  }

  if (eventType === "user") {
    const message = get(obj, "message") || {};
    const content = get(message, "content") || [];
    for (const block of content) {
      if (!isObject(block)) {
        continue;
      }
      if (get(block, "type") === "tool_result") {
        const resultContent = get(block, "content");
        const size = typeof resultContent === "string" ? resultContent.length : 0;
        emit(`[claude:tool-result] ${pyStr(get(block, "tool_use_id"))} bytes=${size}`);
      }
    }
    return;
  }

  if (eventType === "result") {
    const structured = get(obj, "structured_output");
    if (isObject(structured)) {
      const continuationState = get(structured, "continuation_state") || {};
      const proposedNextTurn = get(structured, "proposed_next_turn") || {};
      const status = get(continuationState, "status");
      const nextOwner = get(proposedNextTurn, "owner");
      const message = shorten(get(structured, "message_to_codex"), 500);
      emit(`[claude:peer] status=${pyStr(status)} next_owner=${pyStr(nextOwner)} message=${message}`);
    }
    emit(
      `[claude:done] terminal=${pyStr(get(obj, "terminal_reason"))} ` +
        `stop=${pyStr(get(obj, "stop_reason"))} turns=${pyStr(get(obj, "num_turns"))} ` +
        `duration_ms=${pyStr(get(obj, "duration_ms"))}`,
    );
  }
}

function processLine(fd, line) {
  fs.writeSync(fd, line, undefined, "utf8");
  try {
    const obj = JSON.parse(line);
    if (isObject(obj)) {
      handleEvent(obj);
    }
  } catch {
    // Match the Python monitor: malformed stream lines are still mirrored.
  }
}

async function main() {
  if (process.argv.length !== 3) {
    process.stderr.write("usage: stream_monitor.mjs RAW_STREAM_JSONL\n");
    return 2;
  }

  const fd = fs.openSync(process.argv[2], "w");
  let buffer = "";
  process.stdin.setEncoding("utf8");
  try {
    for await (const chunk of process.stdin) {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex + 1);
        buffer = buffer.slice(newlineIndex + 1);
        processLine(fd, line);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (buffer) {
      processLine(fd, buffer);
    }
  } finally {
    fs.closeSync(fd);
  }
  return 0;
}

process.exitCode = await main();
