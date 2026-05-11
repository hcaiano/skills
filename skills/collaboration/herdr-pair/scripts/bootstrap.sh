#!/usr/bin/env bash
# bootstrap.sh — initiator-side bootstrap for a herdr-pair session.
#
# Verifies the herdr CLI/env are present (HP3 preflight), resolves self,
# finds the opposite-agent partner in the same workspace+tab, generates
# a session id, and writes session.json atomically.
#
# Output (stdout): "<partner-pane-id> <sid>"
# Exit codes:
#   0 — bootstrap succeeded
#   1 — preflight failed (herdr CLI/env missing) — message on stderr
#   2 — no partner agent in tab (caller should run spawn flow)
#   3 — multiple partner candidates (caller should ask user)
#   4 — other unexpected error
#
# Does NOT spawn a partner. Spawn flow stays in SKILL.md; this primitive
# only handles the case where a partner pane already exists.
set -euo pipefail

# --- HP3 preflight ---
if ! command -v herdr >/dev/null 2>&1; then
  echo "herdr CLI not found on PATH. Load the herdr skill and ensure herdr is installed." >&2
  exit 1
fi
if [ "${HERDR_ENV:-}" != "1" ]; then
  echo "HERDR_ENV is not set to 1. This skill must run inside a herdr pane." >&2
  exit 1
fi
if [ -z "${HERDR_PANE_ID:-}" ]; then
  echo "HERDR_PANE_ID is not set. This skill must run inside a herdr pane." >&2
  exit 1
fi

# --- Resolve self ---
SELF_JSON=$(herdr pane get "$HERDR_PANE_ID")
WS=$(printf '%s' "$SELF_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["pane"]["workspace_id"])')
TAB=$(printf '%s' "$SELF_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["pane"]["tab_id"])')
SELF_AGENT=$(printf '%s' "$SELF_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["pane"]["agent"])')

# --- Find partner ---
PANES_JSON=$(herdr pane list --workspace "$WS")
PARTNER_LINE=$(printf '%s' "$PANES_JSON" | python3 - "$TAB" "$SELF_AGENT" <<'PY'
import sys, json
tab, self_agent = sys.argv[1], sys.argv[2]
data = json.load(sys.stdin)
candidates = [p for p in data["result"]["panes"]
              if p["tab_id"] == tab
              and p["agent"] in ("claude", "codex")
              and p["agent"] != self_agent]
if not candidates:
    print("NONE")
elif len(candidates) > 1:
    print("MULTI")
else:
    p = candidates[0]
    print(f"{p['agent']} {p['pane_id']}")
PY
)

case "$PARTNER_LINE" in
  NONE)  echo "no opposite-agent partner pane found in tab; caller should run spawn flow" >&2; exit 2 ;;
  MULTI) echo "multiple partner candidates in tab; ask the user which to pair with" >&2; exit 3 ;;
esac

PARTNER_AGENT=$(printf '%s' "$PARTNER_LINE" | awk '{print $1}')
PARTNER_PANE=$(printf '%s' "$PARTNER_LINE" | awk '{print $2}')

# --- Generate sid & write session.json atomically ---
SID="$(date +%s)-$(openssl rand -hex 2)"
SESSION_DIR="$HOME/.herdr-coworkers/$WS"
SESSION_FILE="$SESSION_DIR/session.json"
mkdir -p "$SESSION_DIR"

TMP="$SESSION_FILE.tmp.$$"
cat > "$TMP" <<JSON
{
  "sid": "$SID",
  "workspace_id": "$WS",
  "tab_id": "$TAB",
  "self": { "agent": "$SELF_AGENT", "pane_id": "$HERDR_PANE_ID" },
  "partner": { "agent": "$PARTNER_AGENT", "pane_id": "$PARTNER_PANE" },
  "round": 0,
  "last_status": { "claude": null, "codex": null },
  "no_progress_count": 0,
  "workbench": { "tab_id": null, "server_pane": null, "logs_pane": null },
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
mv "$TMP" "$SESSION_FILE"

# --- Output partner pane + sid ---
echo "$PARTNER_PANE $SID"
