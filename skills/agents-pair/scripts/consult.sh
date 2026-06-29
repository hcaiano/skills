#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PEER_SCHEMA_DEFAULT="$SCRIPT_DIR/../references/peer-message.schema.json"

usage() {
  cat >&2 <<'EOF'
usage: consult.sh (--active-session --workspace PATH | --session-id UUID --out-dir DIR) --kind KIND --prompt PROMPT.md [options]

Required:
  --kind KIND             Short turn label, e.g. brainstorm, plan-review, diff-review.
  --prompt PROMPT.md      Prompt file to send on stdin.

Options:
  --active-session        Load/create ~/.agents-pair state for this workspace and
                          keep reusing the same Claude conversation.
  --new-active-session    Start a new active pair session, archiving any existing
                          active session as stale.
  --goal TEXT             Pair-session goal to store when creating active state.
  --goal-file PATH        Read pair-session goal from PATH.
  --session-id UUID       Claude session id to create or resume.
  --resume                Resume --session-id instead of creating it.
  --out-dir DIR           Transcript directory for JSON and Markdown outputs.
                          Optional with --active-session; defaults to that
                          session's transcript directory.
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
  --stream                Monitor Claude via stream-json. Default for --pair-turn.
  --no-stream             Force single JSON output and wait silently.
  --no-stream-partials    Do not request partial assistant text chunks.
  --stream-text-limit N   Max live assistant text chars to print. Defaults to 3000.
  --pair-turn             Require a structured peer message back to Codex
                          (message, questions, proposed next turn, continuation
                          state, changed files, validation asks). Auto-attaches
                          the bundled peer-message schema unless --json-schema is
                          given, and appends the peer-protocol system prompt.
  --peer-message          Alias for --pair-turn.
  --append-system-prompt TEXT
                           Extra system prompt text for this consult.
  --claude-arg ARG        Raw Claude CLI arg passthrough. Repeatable.
                          --setting-sources is not allowed; default Claude
                          settings sources are disabled to preserve subscription auth.
  --disable-slash-commands Disable Claude slash commands and skills.
  --enable-slash-commands Kept for compatibility; slash commands are enabled by default.
EOF
}

SESSION_ID=""
ACTIVE_SESSION=false
NEW_ACTIVE_SESSION=false
GOAL=""
GOAL_FILE=""
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
ADD_DIRS=()
MCP_CONFIGS=()
SETTINGS=""
PLUGIN_DIRS=()
PLUGIN_URLS=()
ALLOWED_TOOLS=""
DISALLOWED_TOOLS=""
JSON_SCHEMA=""
STREAM_MODE="auto"
STREAM_PARTIALS=true
STREAM_TEXT_LIMIT="${CLAUDE_MONITOR_TEXT_LIMIT:-3000}"
PEER_MESSAGE=false
APPEND_SYSTEM_PROMPT=""
CLAUDE_ARGS=()
DISABLE_SLASH_COMMANDS=false
SUBSCRIPTION_AUTH_BLOCKED_ENV=(
  ANTHROPIC_API_KEY
  ANTHROPIC_AUTH_TOKEN
  ANTHROPIC_AWS_API_KEY
  ANTHROPIC_AWS_BASE_URL
  ANTHROPIC_AWS_WORKSPACE_ID
  ANTHROPIC_BASE_URL
  ANTHROPIC_BEDROCK_BASE_URL
  ANTHROPIC_BEDROCK_MANTLE_BASE_URL
  ANTHROPIC_CUSTOM_HEADERS
  ANTHROPIC_FOUNDRY_API_KEY
  ANTHROPIC_FOUNDRY_BASE_URL
  ANTHROPIC_FOUNDRY_RESOURCE
  ANTHROPIC_VERTEX_BASE_URL
  ANTHROPIC_VERTEX_PROJECT_ID
  ANTHROPIC_WORKSPACE_ID
  AWS_BEARER_TOKEN_BEDROCK
  CLAUDE_CODE_SIMPLE
  CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH
  CLAUDE_CODE_SKIP_BEDROCK_AUTH
  CLAUDE_CODE_SKIP_FOUNDRY_AUTH
  CLAUDE_CODE_SKIP_MANTLE_AUTH
  CLAUDE_CODE_SKIP_VERTEX_AUTH
  CLAUDE_CODE_USE_ANTHROPIC_AWS
  CLAUDE_CODE_USE_BEDROCK
  CLAUDE_CODE_USE_FOUNDRY
  CLAUDE_CODE_USE_MANTLE
  CLAUDE_CODE_USE_VERTEX
)

add_dir_once() {
  local dir="$1"
  local existing
  if [[ -z "$dir" ]]; then
    return
  fi
  if ((${#ADD_DIRS[@]} > 0)); then
    for existing in "${ADD_DIRS[@]}"; do
      if [[ "$existing" == "$dir" ]]; then
        return
      fi
    done
  fi
  ADD_DIRS+=("$dir")
}

is_under_dir() {
  local child="$1"
  local parent="$2"
  if [[ -z "$child" || -z "$parent" ]]; then
    return 1
  fi
  case "$child/" in
    "$parent"/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --active-session)
      ACTIVE_SESSION=true
      shift
      ;;
    --new-active-session)
      NEW_ACTIVE_SESSION=true
      shift
      ;;
    --goal)
      GOAL="${2:-}"
      shift 2
      ;;
    --goal-file)
      GOAL_FILE="${2:-}"
      shift 2
      ;;
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
    --stream)
      STREAM_MODE="on"
      shift
      ;;
    --no-stream)
      STREAM_MODE="off"
      shift
      ;;
    --no-stream-partials)
      STREAM_PARTIALS=false
      shift
      ;;
    --stream-text-limit)
      STREAM_TEXT_LIMIT="${2:-}"
      shift 2
      ;;
    --pair-turn|--peer-message)
      PEER_MESSAGE=true
      shift
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

if [[ -z "$KIND" || -z "$PROMPT" ]]; then
  echo "error: --kind and --prompt are required" >&2
  usage
  exit 2
fi

if [[ "$ACTIVE_SESSION" != true && ( -z "$SESSION_ID" || -z "$OUT_DIR" ) ]]; then
  echo "error: either use --active-session with --workspace, or pass --session-id and --out-dir" >&2
  usage
  exit 2
fi

if [[ -n "$GOAL_FILE" ]]; then
  if [[ ! -f "$GOAL_FILE" ]]; then
    echo "error: goal file not found: $GOAL_FILE" >&2
    exit 2
  fi
  GOAL="$(cat "$GOAL_FILE")"
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

if [[ "$ACTIVE_SESSION" == true && -z "$WORKSPACE" ]]; then
  echo "error: --workspace is required with --active-session" >&2
  exit 2
fi

if [[ "$ACTIVE_SESSION" == true && "$TOOLS_MODE" == "none" ]]; then
  echo "error: --active-session cannot be combined with --tools none because no-tools turns must not resume prior pair history; use --session-id and --out-dir without --resume for an isolated no-tools consult" >&2
  exit 2
fi

if [[ "$TOOLS_MODE" == "none" && "$RESUME_SESSION" == true ]]; then
  echo "error: --resume cannot be combined with --tools none because no-tools turns must not resume prior Claude conversation history; use a fresh --session-id without --resume for an isolated no-tools consult" >&2
  exit 2
fi

for auth_env_name in "${SUBSCRIPTION_AUTH_BLOCKED_ENV[@]}"; do
  if [[ -n "${!auth_env_name+x}" ]]; then
    echo "warning: ignoring $auth_env_name; agents-pair uses Claude subscription auth only" >&2
    unset "$auth_env_name"
  fi
done

if ((${#CLAUDE_ARGS[@]} > 0)); then
  for claude_arg in "${CLAUDE_ARGS[@]}"; do
    case "$claude_arg" in
      --bare)
        echo "error: --claude-arg --bare is not allowed; agents-pair uses Claude subscription auth only, and --bare skips subscription OAuth/keychain auth" >&2
        exit 2
        ;;
      --settings|--settings=*)
        echo "error: pass Claude settings through --settings, not --claude-arg, so agents-pair can enforce subscription-only auth" >&2
        exit 2
        ;;
      --setting-sources|--setting-sources=*)
        echo "error: --claude-arg --setting-sources is not allowed; agents-pair disables default Claude settings sources to preserve subscription auth" >&2
        exit 2
        ;;
      *apiKeyHelper*|*ANTHROPIC_API_KEY*)
        echo "error: Claude API-key auth is not allowed in agents-pair raw args; use the logged-in Claude subscription session" >&2
        exit 2
        ;;
    esac
  done
fi

if [[ -n "$SETTINGS" ]]; then
  if [[ "$SETTINGS" == *apiKeyHelper* ]]; then
    echo "error: Claude settings with apiKeyHelper are not allowed; agents-pair uses Claude subscription auth only" >&2
    exit 2
  fi
  for auth_env_name in "${SUBSCRIPTION_AUTH_BLOCKED_ENV[@]}"; do
    if [[ "$SETTINGS" == *"$auth_env_name"* ]]; then
      echo "error: Claude settings mention $auth_env_name; agents-pair uses Claude subscription auth only" >&2
      exit 2
    fi
  done
  if [[ -f "$SETTINGS" ]]; then
    if grep -Eqi 'apiKeyHelper' "$SETTINGS"; then
      echo "error: Claude settings file contains apiKeyHelper; agents-pair uses Claude subscription auth only" >&2
      exit 2
    fi
    for auth_env_name in "${SUBSCRIPTION_AUTH_BLOCKED_ENV[@]}"; do
      if grep -Eq "\"$auth_env_name\"|\\b$auth_env_name\\b" "$SETTINGS"; then
        echo "error: Claude settings file mentions $auth_env_name; agents-pair uses Claude subscription auth only" >&2
        exit 2
      fi
    done
  fi
fi

if [[ -n "$TIMEOUT_SECONDS" && ! "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "error: --timeout-seconds must be a positive integer" >&2
  exit 2
fi

if [[ -n "$MAX_TURNS" && ! "$MAX_TURNS" =~ ^[0-9]+$ ]]; then
  echo "error: --max-turns must be a positive integer" >&2
  exit 2
fi

if [[ ! "$STREAM_TEXT_LIMIT" =~ ^[0-9]+$ ]]; then
  echo "error: --stream-text-limit must be a non-negative integer" >&2
  exit 2
fi

USE_STREAM=false
case "$STREAM_MODE" in
  auto)
    if [[ "$PEER_MESSAGE" == true ]]; then
      USE_STREAM=true
    fi
    ;;
  on)
    USE_STREAM=true
    ;;
  off)
    USE_STREAM=false
    ;;
  *)
    echo "error: internal invalid stream mode: $STREAM_MODE" >&2
    exit 2
    ;;
esac

PROMPT_DIR="$(cd "$(dirname "$PROMPT")" && pwd -P)"
PROMPT="$PROMPT_DIR/$(basename "$PROMPT")"

if [[ -n "$WORKSPACE" ]]; then
  WORKSPACE="$(cd "$WORKSPACE" && pwd -P)"
  add_dir_once "$WORKSPACE"
fi

ACTIVE_STATE_PATH=""
PAIR_SESSION_ID=""
ACTIVE_LOCK_DIR=""
ACTIVE_LOCK_HELD=false
# shellcheck disable=SC2329 # Invoked indirectly by the EXIT trap below.
cleanup_active_lock() {
  if [[ "$ACTIVE_LOCK_HELD" == true && -n "$ACTIVE_LOCK_DIR" ]]; then
    rmdir "$ACTIVE_LOCK_DIR" 2>/dev/null || true
  fi
}

if [[ "$ACTIVE_SESSION" == true ]]; then
  ACTIVE_WORKSPACE_HASH="$(printf '%s' "$WORKSPACE" | shasum -a 256 | awk '{print substr($1,1,16)}')"
  ACTIVE_WORKSPACE_DIR="$HOME/.agents-pair/workspaces/$ACTIVE_WORKSPACE_HASH"
  mkdir -p "$ACTIVE_WORKSPACE_DIR"
  ACTIVE_LOCK_DIR="$ACTIVE_WORKSPACE_DIR/active-session.lock"
  ACTIVE_LOCK_DEADLINE=$((SECONDS + 600))
  while ! mkdir "$ACTIVE_LOCK_DIR" 2>/dev/null; do
    if (( SECONDS >= ACTIVE_LOCK_DEADLINE )); then
      echo "error: timed out waiting for active pair session lock: $ACTIVE_LOCK_DIR" >&2
      exit 124
    fi
    sleep 1
  done
  ACTIVE_LOCK_HELD=true
  trap cleanup_active_lock EXIT

  set +e
  active_output="$(python3 - "$WORKSPACE" "$KIND" "$GOAL" "$NEW_ACTIVE_SESSION" <<'PY'
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import uuid

workspace, kind, goal, new_requested = sys.argv[1:5]
force_new = new_requested == "true"
workspace_path = Path(workspace).resolve()
workspace_hash = hashlib.sha256(str(workspace_path).encode()).hexdigest()[:16]
root = Path.home() / ".agents-pair" / "workspaces" / workspace_hash
active_path = root / "active-session.json"
root.mkdir(parents=True, exist_ok=True)


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def safe_kind(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-")
    return value or "pair"


def write_state(state: dict) -> None:
    active_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = active_path.with_name(f"{active_path.name}.tmp.{os.getpid()}")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, active_path)


def new_state() -> dict:
    ts = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    pair_session_id = f"{ts}-{safe_kind(kind)}"
    claude_session_id = str(uuid.uuid4())
    transcript_dir = root / "sessions" / pair_session_id / "transcript"
    transcript_dir.mkdir(parents=True, exist_ok=True)
    return {
        "workspace_root": str(workspace_path),
        "workspace_hash": workspace_hash,
        "session_id": pair_session_id,
        "claude_session_id": claude_session_id,
        "goal": goal,
        "model": None,
        "effort": None,
        "capability_profile": "peer-autonomous",
        "status": "active",
        "session_established": False,
        "session_establishing": False,
        "turn": 0,
        "no_progress_count": 0,
        "checkpoints": [],
        "created_at": now(),
        "updated_at": now(),
    }


state = None
if active_path.exists() and force_new:
    with open(active_path, "r", encoding="utf-8") as f:
        existing = json.load(f)
    recorded_workspace = Path(existing.get("workspace_root", "")).resolve()
    if recorded_workspace != workspace_path:
        raise SystemExit(
            f"error: active-session workspace mismatch: {recorded_workspace} != {workspace_path}"
        )
    archive_dir = root / "sessions" / str(existing.get("session_id", "unknown"))
    archive_dir.mkdir(parents=True, exist_ok=True)
    existing["status"] = "stale"
    existing["stale_reason"] = "replaced by --new-active-session"
    existing["updated_at"] = now()
    with open(archive_dir / "session-state.json", "w", encoding="utf-8") as f:
        json.dump(existing, f, indent=2, sort_keys=True)
        f.write("\n")
    state = new_state()
    state["replaces_session_id"] = existing.get("session_id")
    write_state(state)
elif active_path.exists():
    with open(active_path, "r", encoding="utf-8") as f:
        state = json.load(f)
    recorded_workspace = Path(state.get("workspace_root", "")).resolve()
    if recorded_workspace != workspace_path:
        raise SystemExit(
            f"error: active-session workspace mismatch: {recorded_workspace} != {workspace_path}"
        )
    if state.get("status") != "active":
        state = new_state()
        write_state(state)
else:
    state = new_state()
    write_state(state)

if goal and not state.get("goal"):
    state["goal"] = goal
    state["updated_at"] = now()
    write_state(state)
elif goal and state.get("goal") and state.get("goal") != goal:
    raise SystemExit(
        "error: active pair-session goal differs from --goal; omit --goal to continue the existing session "
        "or pass --new-active-session after recording why the old session is stale"
    )

if "session_established" not in state:
    raise SystemExit(
        "error: active-session.json is from an older format and lacks session_established; "
        "resume it once explicitly with --session-id ... --resume or mark it stale before using --active-session"
    )

claude_session_id = state.get("claude_session_id")
if not claude_session_id:
    raise SystemExit("error: active-session.json is missing claude_session_id")

transcript_dir = root / "sessions" / state["session_id"] / "transcript"
transcript_dir.mkdir(parents=True, exist_ok=True)

print(str(active_path))
print(state["session_id"])
print(str(transcript_dir))
print(claude_session_id)
print("true" if (state.get("session_established") or state.get("session_establishing")) else "false")
PY
  )"
  active_status=$?
  set -e
  if [[ "$active_status" -ne 0 ]]; then
    exit "$active_status"
  fi
  active_line=0
  while IFS= read -r active_value; do
    case "$active_line" in
      0) ACTIVE_STATE_PATH="$active_value" ;;
      1) PAIR_SESSION_ID="$active_value" ;;
      2) ACTIVE_TRANSCRIPT_DIR="$active_value" ;;
      3) SESSION_ID="$active_value" ;;
      4) ACTIVE_RESUME="$active_value" ;;
    esac
    active_line=$((active_line + 1))
  done <<EOF
$active_output
EOF
  if [[ -z "$ACTIVE_STATE_PATH" || -z "$PAIR_SESSION_ID" || -z "$ACTIVE_TRANSCRIPT_DIR" || -z "$SESSION_ID" ]]; then
    echo "error: failed to load or create active pair session" >&2
    exit 2
  fi
  if [[ "${ACTIVE_RESUME:-}" == "true" ]]; then
    RESUME_SESSION=true
  else
    RESUME_SESSION=false
  fi
  if [[ -z "$OUT_DIR" ]]; then
    OUT_DIR="$ACTIVE_TRANSCRIPT_DIR"
  fi
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
STREAM_OUT="$BASE.stream.jsonl"
TMP_STREAM="$STREAM_OUT.tmp.$$"

cmd=(claude -p)

if [[ "$RESUME_SESSION" == true ]]; then
  cmd+=(--resume "$SESSION_ID")
else
  cmd+=(--session-id "$SESSION_ID")
fi

cmd+=(--model "$MODEL"
  --effort "$EFFORT"
  --permission-mode "$PERMISSION_MODE")

cmd+=(--setting-sources "")

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

if [[ "$PEER_MESSAGE" == true && -z "$JSON_SCHEMA" ]]; then
  if [[ ! -f "$PEER_SCHEMA_DEFAULT" ]]; then
    echo "error: peer-message schema not found: $PEER_SCHEMA_DEFAULT" >&2
    exit 2
  fi
  JSON_SCHEMA="$PEER_SCHEMA_DEFAULT"
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
    shared_skill_note=""
    if [[ "$TOOLS_MODE" == "read" ]] || is_under_dir "$skill_dir" "$WORKSPACE"; then
      add_dir_once "$skill_dir"
    elif [[ "$TOOLS_MODE" == "write" ]]; then
      shared_skill_note=" (external skill dir not mounted in write mode; use the prompt's extracted rules, or ask Codex for a read-mode skill-inspection turn if needed)"
    fi
    APPEND_SYSTEM_PROMPT="${APPEND_SYSTEM_PROMPT}- ${skill_name}: ${skill_path}${shared_skill_note}"$'\n'
  done
fi

if [[ "$PEER_MESSAGE" == true ]]; then
  APPEND_SYSTEM_PROMPT="${APPEND_SYSTEM_PROMPT}You and Codex are equal engineers on this repo, mid-conversation. Do your real work this turn (write code, review, investigate) and then end by emitting the required peer-message structured output. Use message_to_codex to speak to Codex directly as a peer: state what you did or concluded, push back where you disagree, and say what the pair should do next. Fill every schema field; use empty arrays when you have no questions, disagreements, changed files, or validation requests. Put your handoff in proposed_next_turn, edited files in changed_files, and set continuation_state.status honestly (continue/blocked/needs-user/done). Codex is required to read and answer this message next turn, so write it as one side of an ongoing dialogue, not a closing report."$'\n'
fi

if [[ "$TOOLS_MODE" == "none" || "$TOOLS_MODE" == "read" ]]; then
  if [[ "$DISABLE_SLASH_COMMANDS" != true ]]; then
    cmd+=(--disable-slash-commands)
  fi
fi

if [[ "$TOOLS_MODE" == "none" ]]; then
  APPEND_SYSTEM_PROMPT="${APPEND_SYSTEM_PROMPT}You have no tools this turn. Do not narrate, simulate, or fabricate tool calls; answer only from the prompt text."
fi

if [[ -n "$APPEND_SYSTEM_PROMPT" ]]; then
  cmd+=(--append-system-prompt "$APPEND_SYSTEM_PROMPT")
fi

if [[ "$USE_STREAM" == true ]]; then
  cmd+=(--output-format stream-json --verbose)
  if [[ "$STREAM_PARTIALS" == true ]]; then
    cmd+=(--include-partial-messages)
  fi
else
  cmd+=(--output-format json)
fi

case "$TOOLS_MODE" in
  none)
    cmd+=(--tools "")
    ;;
  read)
    cmd+=(--tools "Read,Grep,Glob")
    if ((${#ADD_DIRS[@]} > 0)); then
      cmd+=(--add-dir "${ADD_DIRS[@]}")
    fi
    ;;
  write)
    cmd+=(--tools default)
    if ((${#ADD_DIRS[@]} > 0)); then
      cmd+=(--add-dir "${ADD_DIRS[@]}")
    fi
    ;;
esac

if ((${#CLAUDE_ARGS[@]} > 0)); then
  cmd+=("${CLAUDE_ARGS[@]}")
fi

if [[ -n "$ACTIVE_STATE_PATH" && "$RESUME_SESSION" != true ]]; then
  python3 - "$ACTIVE_STATE_PATH" "$KIND" <<'PY'
import datetime as dt
import json
import os
import sys

state_path, kind = sys.argv[1:3]
with open(state_path, "r", encoding="utf-8") as f:
    state = json.load(f)
state["session_establishing"] = True
state["last_attempt_kind"] = kind
state["updated_at"] = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
tmp = f"{state_path}.tmp.{os.getpid()}"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, state_path)
PY
fi

run_claude_json() {
  if [[ -z "$TIMEOUT_SECONDS" ]]; then
    (cd "$RUN_CWD" && CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1 "${cmd[@]}" < "$PROMPT" > "$TMP_JSON")
    return $?
  fi

  if command -v timeout >/dev/null 2>&1; then
    (cd "$RUN_CWD" && CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1 timeout "$TIMEOUT_SECONDS" "${cmd[@]}" < "$PROMPT" > "$TMP_JSON")
    return $?
  fi

  if command -v gtimeout >/dev/null 2>&1; then
    (cd "$RUN_CWD" && CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1 gtimeout "$TIMEOUT_SECONDS" "${cmd[@]}" < "$PROMPT" > "$TMP_JSON")
    return $?
  fi

  local pid watchdog status timed_out
  timed_out="$TMP_JSON.timeout.$$"
  rm -f "$timed_out"
  (cd "$RUN_CWD" && CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1 "${cmd[@]}" < "$PROMPT" > "$TMP_JSON") &
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
  wait "$pid" 2>/dev/null
  status=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  if [[ -f "$timed_out" ]]; then
    rm -f "$timed_out"
    return 124
  fi
  return "$status"
}

run_claude_stream() {
  local fifo monitor pid watchdog status monitor_status timed_out
  fifo="$TMP_STREAM.fifo.$$"
  timed_out="$TMP_STREAM.timeout.$$"
  rm -f "$fifo" "$timed_out" "$TMP_STREAM"
  mkfifo "$fifo"

  CLAUDE_MONITOR_TEXT_LIMIT="$STREAM_TEXT_LIMIT" \
    "$SCRIPT_DIR/stream_monitor.py" "$TMP_STREAM" < "$fifo" &
  monitor=$!

  (cd "$RUN_CWD" && CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1 "${cmd[@]}" < "$PROMPT" > "$fifo") &
  pid=$!

  watchdog=""
  if [[ -n "$TIMEOUT_SECONDS" ]]; then
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
  fi

  wait "$pid" 2>/dev/null
  status=$?
  if [[ -n "$watchdog" ]]; then
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
  fi
  wait "$monitor"
  monitor_status=$?
  rm -f "$fifo"

  if [[ -f "$timed_out" ]]; then
    rm -f "$timed_out"
    return 124
  fi
  if [[ "$status" -ne 0 ]]; then
    return "$status"
  fi
  return "$monitor_status"
}

run_selected_claude() {
  if [[ "$USE_STREAM" == true ]]; then
    run_claude_stream
  else
    run_claude_json
  fi
}

set +e
run_selected_claude
claude_status=$?
set -e

if [[ "$USE_STREAM" == true ]]; then
  if [[ -s "$TMP_STREAM" ]]; then
    mv "$TMP_STREAM" "$STREAM_OUT"
  else
    rm -f "$TMP_STREAM"
  fi
else
  if [[ -s "$TMP_JSON" ]]; then
    mv "$TMP_JSON" "$JSON_OUT"
  else
    rm -f "$TMP_JSON"
  fi
fi

STREAM_EXTRACT_STATUS=0
if [[ "$USE_STREAM" == true ]]; then
  if [[ -f "$STREAM_OUT" ]]; then
    set +e
    python3 - "$STREAM_OUT" "$JSON_OUT" <<'PY'
import json
import sys

stream_path, json_path = sys.argv[1], sys.argv[2]
result = None
with open(stream_path, "r", encoding="utf-8") as f:
    for line in f:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and event.get("type") == "result":
            result = event

if result is None:
    print(f"error: no result event found in stream: {stream_path}", file=sys.stderr)
    sys.exit(2)

with open(json_path, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=2, sort_keys=True)
    f.write("\n")
PY
    STREAM_EXTRACT_STATUS=$?
    set -e
  fi
fi

if [[ "$claude_status" -ne 0 ]]; then
  echo "error: claude exited with status $claude_status" >&2
  if [[ -n "$ACTIVE_STATE_PATH" ]]; then
    python3 - "$ACTIVE_STATE_PATH" "$JSON_OUT" "$STREAM_OUT" "$claude_status" <<'PY'
import datetime as dt
import json
import os
import sys

state_path, json_path, stream_path, status = sys.argv[1:5]


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def has_session_signal() -> bool:
    for path in (json_path, stream_path):
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                if path.endswith(".jsonl"):
                    for line in f:
                        try:
                            data = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(data, dict) and data.get("session_id"):
                            return True
                else:
                    data = json.load(f)
                    if isinstance(data, dict) and data.get("session_id"):
                        return True
        except (OSError, json.JSONDecodeError):
            continue
    return False


with open(state_path, "r", encoding="utf-8") as f:
    state = json.load(f)

if not state.get("session_established") and not has_session_signal():
    state["session_establishing"] = False
state["last_error_status"] = int(status)
state["updated_at"] = now()

tmp = f"{state_path}.tmp.{os.getpid()}"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, state_path)
PY
  fi
  if [[ "$USE_STREAM" == true && -f "$STREAM_OUT" ]]; then
    ERROR_OUT="$BASE.error.stream.jsonl"
    mv "$STREAM_OUT" "$ERROR_OUT"
    echo "partial stream output: $ERROR_OUT" >&2
  fi
  if [[ -f "$JSON_OUT" ]]; then
    ERROR_OUT="$BASE.error.json"
    mv "$JSON_OUT" "$ERROR_OUT"
    echo "partial result output: $ERROR_OUT" >&2
  fi
  exit "$claude_status"
fi

if [[ "$USE_STREAM" == true && "$STREAM_EXTRACT_STATUS" -ne 0 ]]; then
  exit "$STREAM_EXTRACT_STATUS"
fi

set +e
render_output="$(python3 - "$JSON_OUT" "$MD_OUT" "$STREAM_OUT" <<'PY'
import json
import os
import sys

json_path, md_path, stream_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(json_path, "r", encoding="utf-8") as f:
    data = json.load(f)

structured = data.get("structured_output")
is_peer = isinstance(structured, dict) and "message_to_codex" in structured


def render_peer(peer):
    lines = ["# Claude peer message", "", peer.get("message_to_codex", "").strip(), ""]
    questions = peer.get("questions_for_codex") or []
    if questions:
        lines.append("## Questions for Codex")
        lines += [f"- {q}" for q in questions]
        lines.append("")
    disagreements = peer.get("disagreements") or []
    if disagreements:
        lines.append("## Disagreements")
        lines += [f"- {d}" for d in disagreements]
        lines.append("")
    nxt = peer.get("proposed_next_turn") or {}
    if nxt:
        lines.append("## Proposed next turn")
        if nxt.get("owner"):
            lines.append(f"- owner: {nxt['owner']}")
        if nxt.get("goal"):
            lines.append(f"- goal: {nxt['goal']}")
        for tf in nxt.get("target_files") or []:
            lines.append(f"- target: {tf}")
        for v in nxt.get("validation") or []:
            lines.append(f"- validation: {v}")
        lines.append("")
    changed = peer.get("changed_files") or []
    if changed:
        lines.append("## Changed files")
        for c in changed:
            path = c.get("path", "")
            summ = c.get("summary", "")
            lines.append(f"- {path}{(' - ' + summ) if summ else ''}")
        lines.append("")
    asks = peer.get("validation_requests") or []
    if asks:
        lines.append("## Validation requests")
        lines += [f"- {a}" for a in asks]
        lines.append("")
    state = peer.get("continuation_state") or {}
    if state:
        status = state.get("status", "")
        reason = state.get("reason", "")
        lines.append(f"## Continuation: {status}{(' - ' + reason) if reason else ''}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


if is_peer:
    result = render_peer(structured)
elif structured is not None:
    result = json.dumps(structured, indent=2, sort_keys=True)
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
    "has_structured_output": structured is not None,
    "is_peer_message": is_peer,
}

if os.path.exists(stream_path):
    summary["stream"] = stream_path

if is_peer:
    state = structured.get("continuation_state") or {}
    summary["peer"] = {
        "message_to_codex": structured.get("message_to_codex", ""),
        "questions_for_codex": structured.get("questions_for_codex") or [],
        "continuation_status": state.get("status"),
        "next_owner": (structured.get("proposed_next_turn") or {}).get("owner"),
    }

print(json.dumps(summary, sort_keys=True))

if data.get("is_error"):
    sys.exit(2)
PY
)"
render_status=$?
set -e
if [[ -n "$render_output" ]]; then
  printf '%s\n' "$render_output"
fi

if [[ "$render_status" -ne 0 && -n "$ACTIVE_STATE_PATH" ]]; then
  python3 - "$ACTIVE_STATE_PATH" "$JSON_OUT" "$STREAM_OUT" "$render_status" <<'PY'
import datetime as dt
import json
import os
import sys

state_path, json_path, stream_path, status = sys.argv[1:5]


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def has_session_signal() -> bool:
    for path in (json_path, stream_path):
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                if path.endswith(".jsonl"):
                    for line in f:
                        try:
                            data = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(data, dict) and data.get("session_id"):
                            return True
                else:
                    data = json.load(f)
                    if isinstance(data, dict) and data.get("session_id"):
                        return True
        except (OSError, json.JSONDecodeError):
            continue
    return False


with open(state_path, "r", encoding="utf-8") as f:
    state = json.load(f)

if not state.get("session_established") and not has_session_signal():
    state["session_establishing"] = False
state["last_error_status"] = int(status)
state["last_error_stage"] = "render"
state["updated_at"] = now()

tmp = f"{state_path}.tmp.{os.getpid()}"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, state_path)
PY
fi

if [[ "$render_status" -eq 0 && -n "$ACTIVE_STATE_PATH" ]]; then
  python3 - "$ACTIVE_STATE_PATH" "$JSON_OUT" "$MD_OUT" "$STREAM_OUT" "$MODEL" "$EFFORT" "$KIND" <<'PY'
import datetime as dt
import json
import os
import sys

state_path, json_path, md_path, stream_path, model, effort, kind = sys.argv[1:8]


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


with open(state_path, "r", encoding="utf-8") as f:
    state = json.load(f)
with open(json_path, "r", encoding="utf-8") as f:
    result = json.load(f)

if result.get("is_error"):
    raise SystemExit(0)

structured = result.get("structured_output")
peer_status = None
next_owner = None
if isinstance(structured, dict):
    peer_status = (structured.get("continuation_state") or {}).get("status")
    next_owner = (structured.get("proposed_next_turn") or {}).get("owner")

turn = int(state.get("turn") or 0) + 1
checkpoint = {
    "turn": turn,
    "kind": kind,
    "json": json_path,
    "markdown": md_path,
    "updated_at": now(),
}
if os.path.exists(stream_path):
    checkpoint["stream"] = stream_path
if peer_status:
    checkpoint["peer_status"] = peer_status
if next_owner:
    checkpoint["next_owner"] = next_owner

state["claude_session_id"] = result.get("session_id") or state.get("claude_session_id")
state["session_established"] = True
state["session_establishing"] = False
state["model"] = model
state["effort"] = effort
state["turn"] = turn
state["last_kind"] = kind
state["last_json"] = json_path
state["last_markdown"] = md_path
if os.path.exists(stream_path):
    state["last_stream"] = stream_path
state["last_peer_status"] = peer_status
state["last_next_owner"] = next_owner
state["updated_at"] = now()
state.setdefault("checkpoints", []).append(checkpoint)
state["checkpoints"] = state["checkpoints"][-50:]

tmp = f"{state_path}.tmp.{os.getpid()}"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, state_path)
PY
fi

exit "$render_status"
