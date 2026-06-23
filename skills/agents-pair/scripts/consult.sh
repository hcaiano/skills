#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: consult.sh --session-id UUID --kind KIND --prompt PROMPT.md --out-dir DIR [options]

Required:
  --session-id UUID       Claude session id to create or resume.
  --kind KIND             Short turn label, e.g. brainstorm, plan-review, diff-review.
  --prompt PROMPT.md      Prompt file to send on stdin.
  --out-dir DIR           Transcript directory for JSON and Markdown outputs.

Options:
  --resume                Resume --session-id instead of creating it.
  --turn NNNN             Turn prefix. Defaults to the next numbered JSON file.
  --workspace PATH        Workspace root to add for repo review or edits.
  --tools none|read|write Tool mode. Defaults to write.
  --model MODEL           Claude model alias. Defaults to opus.
  --effort LEVEL          low, medium, high, xhigh, or max. Defaults to high.
  --permission-mode MODE  Defaults to bypassPermissions.
  --name NAME             Claude session display name.
  --max-turns N           Limit Claude's agentic turns for this call.
  --fallback-model MODELS Comma-separated fallback model chain.
  --timeout-seconds N     Kill the Claude call after N seconds. Exits 124.
  --agent NAME            Claude Code agent to run for this consult.
  --agents-json JSON|FILE JSON object defining custom Claude Code agents.
  --shared-skill NAME=PATH Codex skill to mirror to Claude. Repeatable.
  --mcp-config JSON|FILE  Claude MCP config to load. Repeatable.
  --settings JSON|FILE    Claude settings override for this session.
  --plugin-dir PATH       Load a Claude Code plugin directory. Repeatable.
  --plugin-url URL        Load a Claude Code plugin zip URL. Repeatable.
  --allowed-tools LIST    Comma or space-separated allowed tools.
  --disallowed-tools LIST Comma or space-separated denied tools.
  --json-schema JSON|FILE Validate Claude's result against a JSON schema.
  --append-system-prompt TEXT
                           Extra system prompt text for this consult.
  --claude-arg ARG        Raw Claude CLI arg passthrough. Repeatable.
  --disable-slash-commands Disable Claude slash commands and skills.
  --enable-slash-commands Kept for compatibility; slash commands are enabled by default.
EOF
}

SESSION_ID=""
RESUME_SESSION=false
KIND=""
PROMPT=""
OUT_DIR=""
TURN=""
WORKSPACE=""
TOOLS_MODE="write"
MODEL="${CLAUDE_MODEL:-opus}"
EFFORT="${CLAUDE_EFFORT:-high}"
PERMISSION_MODE="${CLAUDE_PERMISSION_MODE:-bypassPermissions}"
SESSION_NAME=""
MAX_TURNS=""
FALLBACK_MODEL=""
TIMEOUT_SECONDS=""
AGENT_NAME=""
AGENTS_JSON=""
SHARED_SKILLS=()
MCP_CONFIGS=()
SETTINGS=""
PLUGIN_DIRS=()
PLUGIN_URLS=()
ALLOWED_TOOLS=""
DISALLOWED_TOOLS=""
JSON_SCHEMA=""
APPEND_SYSTEM_PROMPT=""
CLAUDE_ARGS=()
DISABLE_SLASH_COMMANDS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-id)
      SESSION_ID="${2:-}"
      shift 2
      ;;
    --resume)
      RESUME_SESSION=true
      shift
      ;;
    --kind)
      KIND="${2:-}"
      shift 2
      ;;
    --prompt)
      PROMPT="${2:-}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --turn)
      TURN="${2:-}"
      shift 2
      ;;
    --workspace)
      WORKSPACE="${2:-}"
      shift 2
      ;;
    --tools)
      TOOLS_MODE="${2:-}"
      shift 2
      ;;
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --effort)
      EFFORT="${2:-}"
      shift 2
      ;;
    --permission-mode)
      PERMISSION_MODE="${2:-}"
      shift 2
      ;;
    --name)
      SESSION_NAME="${2:-}"
      shift 2
      ;;
    --max-turns)
      MAX_TURNS="${2:-}"
      shift 2
      ;;
    --fallback-model)
      FALLBACK_MODEL="${2:-}"
      shift 2
      ;;
    --timeout-seconds)
      TIMEOUT_SECONDS="${2:-}"
      shift 2
      ;;
    --agent)
      AGENT_NAME="${2:-}"
      shift 2
      ;;
    --agents-json)
      AGENTS_JSON="${2:-}"
      shift 2
      ;;
    --shared-skill)
      SHARED_SKILLS+=("${2:-}")
      shift 2
      ;;
    --mcp-config)
      MCP_CONFIGS+=("${2:-}")
      shift 2
      ;;
    --settings)
      SETTINGS="${2:-}"
      shift 2
      ;;
    --plugin-dir)
      PLUGIN_DIRS+=("${2:-}")
      shift 2
      ;;
    --plugin-url)
      PLUGIN_URLS+=("${2:-}")
      shift 2
      ;;
    --allowed-tools)
      ALLOWED_TOOLS="${2:-}"
      shift 2
      ;;
    --disallowed-tools)
      DISALLOWED_TOOLS="${2:-}"
      shift 2
      ;;
    --json-schema)
      JSON_SCHEMA="${2:-}"
      shift 2
      ;;
    --append-system-prompt)
      APPEND_SYSTEM_PROMPT="${2:-}"
      shift 2
      ;;
    --claude-arg)
      CLAUDE_ARGS+=("${2:-}")
      shift 2
      ;;
    --disable-slash-commands)
      DISABLE_SLASH_COMMANDS=true
      shift
      ;;
    --enable-slash-commands)
      DISABLE_SLASH_COMMANDS=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$SESSION_ID" || -z "$KIND" || -z "$PROMPT" || -z "$OUT_DIR" ]]; then
  echo "error: --session-id, --kind, --prompt, and --out-dir are required" >&2
  usage
  exit 2
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "error: claude CLI not found on PATH" >&2
  exit 127
fi

if [[ ! -f "$PROMPT" ]]; then
  echo "error: prompt file not found: $PROMPT" >&2
  exit 2
fi

case "$TOOLS_MODE" in
  none|read|write)
    ;;
  *)
    echo "error: --tools must be 'none', 'read', or 'write'" >&2
    exit 2
    ;;
esac

if [[ "$TOOLS_MODE" != "none" && -z "$WORKSPACE" ]]; then
  echo "error: --workspace is required with --tools $TOOLS_MODE" >&2
  exit 2
fi

if [[ -n "$TIMEOUT_SECONDS" && ! "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "error: --timeout-seconds must be a positive integer" >&2
  exit 2
fi

if [[ -n "$MAX_TURNS" && ! "$MAX_TURNS" =~ ^[0-9]+$ ]]; then
  echo "error: --max-turns must be a positive integer" >&2
  exit 2
fi

PROMPT_DIR="$(cd "$(dirname "$PROMPT")" && pwd -P)"
PROMPT="$PROMPT_DIR/$(basename "$PROMPT")"

if [[ -n "$WORKSPACE" ]]; then
  WORKSPACE="$(cd "$WORKSPACE" && pwd -P)"
fi

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd -P)"
RUN_CWD="$PWD"
if [[ -n "$WORKSPACE" ]]; then
  RUN_CWD="$WORKSPACE"
fi

if [[ -z "$TURN" ]]; then
  count="$(find "$OUT_DIR" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
  printf -v TURN "%04d" "$((count + 1))"
fi

SAFE_KIND="$(printf '%s' "$KIND" | tr -c 'A-Za-z0-9._-' '-')"
BASE="$OUT_DIR/$TURN-$SAFE_KIND"
JSON_OUT="$BASE.json"
MD_OUT="$BASE.md"
TMP_JSON="$JSON_OUT.tmp.$$"

cmd=(claude -p)

if [[ "$RESUME_SESSION" == true ]]; then
  cmd+=(--resume "$SESSION_ID")
else
  cmd+=(--session-id "$SESSION_ID")
fi

cmd+=(--model "$MODEL"
  --effort "$EFFORT"
  --permission-mode "$PERMISSION_MODE"
  --output-format json)

if [[ -n "$SESSION_NAME" ]]; then
  cmd+=(--name "$SESSION_NAME")
fi

if [[ -n "$MAX_TURNS" ]]; then
  cmd+=(--max-turns "$MAX_TURNS")
fi

if [[ -n "$FALLBACK_MODEL" ]]; then
  cmd+=(--fallback-model "$FALLBACK_MODEL")
fi

if [[ "$DISABLE_SLASH_COMMANDS" == true ]]; then
  cmd+=(--disable-slash-commands)
fi

if [[ -n "$AGENT_NAME" ]]; then
  cmd+=(--agent "$AGENT_NAME")
fi

if [[ -n "$AGENTS_JSON" ]]; then
  if [[ -f "$AGENTS_JSON" ]]; then
    AGENTS_PAYLOAD="$(cat "$AGENTS_JSON")"
  else
    AGENTS_PAYLOAD="$AGENTS_JSON"
  fi
  cmd+=(--agents "$AGENTS_PAYLOAD")
fi

if ((${#MCP_CONFIGS[@]} > 0)); then
  for mcp_config in "${MCP_CONFIGS[@]}"; do
    cmd+=(--mcp-config "$mcp_config")
  done
fi

if [[ -n "$SETTINGS" ]]; then
  cmd+=(--settings "$SETTINGS")
fi

if ((${#PLUGIN_DIRS[@]} > 0)); then
  for plugin_dir in "${PLUGIN_DIRS[@]}"; do
    cmd+=(--plugin-dir "$plugin_dir")
  done
fi

if ((${#PLUGIN_URLS[@]} > 0)); then
  for plugin_url in "${PLUGIN_URLS[@]}"; do
    cmd+=(--plugin-url "$plugin_url")
  done
fi

if [[ "$TOOLS_MODE" != "write" ]]; then
  if [[ -n "$DISALLOWED_TOOLS" ]]; then
    DISALLOWED_TOOLS="$DISALLOWED_TOOLS,mcp__*"
  else
    DISALLOWED_TOOLS="mcp__*"
  fi
fi

if [[ -n "$ALLOWED_TOOLS" ]]; then
  cmd+=(--allowed-tools "$ALLOWED_TOOLS")
fi

if [[ -n "$DISALLOWED_TOOLS" ]]; then
  cmd+=(--disallowed-tools "$DISALLOWED_TOOLS")
fi

if [[ -n "$JSON_SCHEMA" ]]; then
  if [[ -f "$JSON_SCHEMA" ]]; then
    JSON_SCHEMA_PAYLOAD="$(cat "$JSON_SCHEMA")"
  else
    JSON_SCHEMA_PAYLOAD="$JSON_SCHEMA"
  fi
  cmd+=(--json-schema "$JSON_SCHEMA_PAYLOAD")
fi

if [[ -n "$APPEND_SYSTEM_PROMPT" ]]; then
  APPEND_SYSTEM_PROMPT="${APPEND_SYSTEM_PROMPT}"$'\n\n'
fi

if ((${#SHARED_SKILLS[@]} > 0)); then
  APPEND_SYSTEM_PROMPT="${APPEND_SYSTEM_PROMPT}Shared Codex skill context. Codex selected these skills for the current task. Before acting, follow the same workflow contracts and pass the same skill context to any Claude agents/specialists you spawn:"$'\n'
  for shared_skill in "${SHARED_SKILLS[@]}"; do
    skill_name="${shared_skill%%=*}"
    skill_path="${shared_skill#*=}"
    if [[ "$skill_name" == "$skill_path" ]]; then
      echo "error: --shared-skill must use NAME=PATH" >&2
      exit 2
    fi
    if [[ -d "$skill_path" && -f "$skill_path/SKILL.md" ]]; then
      skill_path="$skill_path/SKILL.md"
    fi
    if [[ ! -f "$skill_path" ]]; then
      echo "error: shared skill file not found: $skill_path" >&2
      exit 2
    fi
    skill_dir="$(cd "$(dirname "$skill_path")" && pwd -P)"
    skill_path="$skill_dir/$(basename "$skill_path")"
    APPEND_SYSTEM_PROMPT="${APPEND_SYSTEM_PROMPT}- ${skill_name}: ${skill_path}"$'\n'
  done
fi

if [[ "$TOOLS_MODE" == "none" ]]; then
  APPEND_SYSTEM_PROMPT="${APPEND_SYSTEM_PROMPT}You have no tools this turn. Do not narrate, simulate, or fabricate tool calls; answer only from the prompt text."
fi

if [[ -n "$APPEND_SYSTEM_PROMPT" ]]; then
  cmd+=(--append-system-prompt "$APPEND_SYSTEM_PROMPT")
fi

case "$TOOLS_MODE" in
  none)
    cmd+=(--tools "")
    ;;
  read)
    cmd+=(--tools "Read,Grep,Glob" --add-dir "$WORKSPACE")
    ;;
  write)
    cmd+=(--tools default --add-dir "$WORKSPACE")
    ;;
esac

if ((${#CLAUDE_ARGS[@]} > 0)); then
  cmd+=("${CLAUDE_ARGS[@]}")
fi

run_claude() {
  if [[ -z "$TIMEOUT_SECONDS" ]]; then
    (cd "$RUN_CWD" && "${cmd[@]}" < "$PROMPT" > "$TMP_JSON")
    return $?
  fi

  if command -v timeout >/dev/null 2>&1; then
    (cd "$RUN_CWD" && timeout "$TIMEOUT_SECONDS" "${cmd[@]}" < "$PROMPT" > "$TMP_JSON")
    return $?
  fi

  if command -v gtimeout >/dev/null 2>&1; then
    (cd "$RUN_CWD" && gtimeout "$TIMEOUT_SECONDS" "${cmd[@]}" < "$PROMPT" > "$TMP_JSON")
    return $?
  fi

  local pid watchdog status timed_out
  timed_out="$TMP_JSON.timeout.$$"
  rm -f "$timed_out"
  (cd "$RUN_CWD" && "${cmd[@]}" < "$PROMPT" > "$TMP_JSON") &
  pid=$!
  (
    sleep "$TIMEOUT_SECONDS"
    if kill -0 "$pid" 2>/dev/null; then
      touch "$timed_out"
      kill "$pid" 2>/dev/null || true
      sleep 2
      kill -9 "$pid" 2>/dev/null || true
    fi
  ) &
  watchdog=$!
  wait "$pid"
  status=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  if [[ -f "$timed_out" ]]; then
    rm -f "$timed_out"
    return 124
  fi
  return "$status"
}

set +e
run_claude
claude_status=$?
set -e

if [[ -s "$TMP_JSON" ]]; then
  mv "$TMP_JSON" "$JSON_OUT"
else
  rm -f "$TMP_JSON"
fi

if [[ "$claude_status" -ne 0 ]]; then
  echo "error: claude exited with status $claude_status" >&2
  if [[ -f "$JSON_OUT" ]]; then
    ERROR_OUT="$BASE.error.json"
    mv "$JSON_OUT" "$ERROR_OUT"
    echo "partial output: $ERROR_OUT" >&2
  fi
  exit "$claude_status"
fi

python3 - "$JSON_OUT" "$MD_OUT" <<'PY'
import json
import sys

json_path, md_path = sys.argv[1], sys.argv[2]
with open(json_path, "r", encoding="utf-8") as f:
    data = json.load(f)

if "structured_output" in data and data.get("structured_output") is not None:
    result = json.dumps(data["structured_output"], indent=2, sort_keys=True)
else:
    result = data.get("result", "")
    if not isinstance(result, str):
        result = json.dumps(result, indent=2, sort_keys=True)

with open(md_path, "w", encoding="utf-8") as f:
    f.write(result)
    if result and not result.endswith("\n"):
        f.write("\n")

summary = {
    "json": json_path,
    "markdown": md_path,
    "is_error": data.get("is_error", False),
    "session_id": data.get("session_id"),
    "duration_ms": data.get("duration_ms"),
    "num_turns": data.get("num_turns"),
    "has_structured_output": data.get("structured_output") is not None,
}
print(json.dumps(summary, sort_keys=True))

if data.get("is_error"):
    sys.exit(2)
PY
