#!/usr/bin/env bash
# send.sh — deliver one machine-to-machine message to the partner pane,
# verify delivery, and update the session file on success.
#
# Usage: send.sh <partner-pane-id> <sid> <kind> <body-file>
#
# Steps:
#   1. Identity check (partner pane still alive, same workspace/tab).
#   2. Compose the message (header + body) into a temp file.
#   3. Send via herdr pane send-text + send-keys Enter.
#   4. Post-send verify: read partner's visible buffer; accept "header in
#      scrollback" or "header under queued notice". Retry Enter once if
#      the header is still in the input buffer. Hard stop after the retry.
#   5. On verified delivery: increment session round and set
#      last_status[<self-agent>] = <kind>. (Other session mutations like
#      no_progress_count stay with the caller via update-session.py.)
#
# Pre-send visible-input-guard (block on real user-authored prose) is the
# CALLER's responsibility — see SKILL.md "Pre-send checks". This script
# does mechanics, not policy.
#
# Exit codes:
#   0 — verified delivered (or queued for next turn); session updated
#   1 — partner pane no longer valid
#   2 — send failed (Enter didn't submit even after one retry); session NOT updated
#   3 — argument/usage error
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$#" -ne 4 ]; then
  echo "usage: send.sh <partner-pane-id> <sid> <kind> <body-file>" >&2
  exit 3
fi

PARTNER_PANE="$1"
SID="$2"
KIND="$3"
BODY_FILE="$4"

[ -r "$BODY_FILE" ] || { echo "body file not readable: $BODY_FILE" >&2; exit 3; }

# --- Identity check ---
if ! PARTNER_JSON=$(herdr pane get "$PARTNER_PANE" 2>/dev/null); then
  echo "partner pane no longer exists: $PARTNER_PANE" >&2
  exit 1
fi
SELF_JSON=$(herdr pane get "$HERDR_PANE_ID")
SELF_AGENT=$(printf '%s' "$SELF_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["pane"]["agent"])')
SELF_WS=$(printf '%s' "$SELF_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["pane"]["workspace_id"])')
SELF_TAB=$(printf '%s' "$SELF_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["pane"]["tab_id"])')
PARTNER_AGENT=$(printf '%s' "$PARTNER_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["pane"]["agent"])')
PARTNER_WS=$(printf '%s' "$PARTNER_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["pane"]["workspace_id"])')
PARTNER_TAB=$(printf '%s' "$PARTNER_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["pane"]["tab_id"])')

[ "$SELF_WS" = "$PARTNER_WS" ] || { echo "workspace mismatch (self=$SELF_WS partner=$PARTNER_WS)" >&2; exit 1; }
[ "$SELF_TAB" = "$PARTNER_TAB" ] || { echo "tab mismatch (self=$SELF_TAB partner=$PARTNER_TAB)" >&2; exit 1; }

# --- Compose message ---
MSG=$(mktemp -t herdr-pair-msg.XXXXXX)
trap 'rm -f "$MSG"' EXIT
{
  printf '[agent %s -> %s kind=%s sid=%s]\n\n' "$SELF_AGENT" "$PARTNER_AGENT" "$KIND" "$SID"
  cat "$BODY_FILE"
} > "$MSG"

HEADER="[agent $SELF_AGENT -> $PARTNER_AGENT kind=$KIND sid=$SID]"

# --- Send + Enter ---
herdr pane send-text "$PARTNER_PANE" "$(cat "$MSG")" >/dev/null
sleep 1
herdr pane send-keys "$PARTNER_PANE" Enter >/dev/null
sleep 2

# --- Post-send verify ---
verify() {
  local visible
  visible=$(herdr pane read "$PARTNER_PANE" --source visible --lines 12 2>/dev/null || true)
  # Accept two end states:
  #   1. Header present AND a queued notice → queued for next turn.
  #   2. Header present, no queued notice → in scrollback, already processing.
  # Failure: header still in input buffer with no queued notice — needs another Enter.
  if printf '%s' "$visible" | grep -qF "$HEADER"; then
    if printf '%s' "$visible" | grep -qE "Messages to be submitted|queued|Press up to edit queued"; then
      return 0  # queued
    fi
    # Heuristic: if the header isn't sitting at the prompt (no leading '›' or '>'),
    # treat as delivered to scrollback. If it IS at the prompt line, it's still in the input.
    if printf '%s' "$visible" | grep -qE "^[›>] *\[agent"; then
      return 1  # still in input
    fi
    return 0  # in scrollback
  fi
  # Header not visible at all — could be off-screen below or above; assume delivered.
  return 0
}

update_session_on_success() {
  # Best-effort: session updates failing shouldn't mark the send as failed,
  # but log to stderr so the caller can repair manually.
  "$SCRIPT_DIR/update-session.py" --inc round 2>&1 >&2 || \
    echo "warn: send.sh failed to increment round" >&2
  "$SCRIPT_DIR/update-session.py" "last_status.$SELF_AGENT" "$KIND" 2>&1 >&2 || \
    echo "warn: send.sh failed to set last_status.$SELF_AGENT" >&2
}

if verify; then
  update_session_on_success
  exit 0
fi

# Retry Enter once
herdr pane send-keys "$PARTNER_PANE" Enter >/dev/null
sleep 2
if verify; then
  update_session_on_success
  exit 0
fi

echo "send failed: header still in input buffer after one Enter retry" >&2
herdr pane read "$PARTNER_PANE" --source visible --lines 12 >&2 || true
exit 2
