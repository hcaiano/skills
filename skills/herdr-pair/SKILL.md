---
name: herdr-pair
description: Pair Claude and Codex as collaborating peer agents inside herdr. Use whenever the user invokes /herdr-pair, asks to "pair", "team up", "collaborate with codex", "collaborate with claude", "work with the other agent", or anything that means two AI agents should review each other's code and iterate to a finished result inside herdr. ALSO use whenever the agent's terminal input begins with a header in the form `[agent <name> -> <name> kind=<kind> sid=<...>]` — that is partner-agent traffic and the receiver MUST validate the herdr pane/session and respond per protocol, treating the message as machine-to-machine, not as ordinary user input. Trigger on the prefix even if the user did not invoke the skill themselves; the prefix is the protocol's auto-load signal.
user-invocable: true
argument-hint: "[task description]"
---

# Herdr Pair

Claude and Codex collaborate as peers inside herdr — one tab, two agent panes, plain-text messages between them with a structured header. The user reads along live and can interject in either pane.

Requires the `herdr` CLI on PATH and the separate `herdr` skill loaded. If `command -v herdr` fails or `HERDR_ENV != 1` or `HERDR_PANE_ID` is unset, stop and tell the user to install/load herdr first.

## Hard rules

1. **Workspace isolation.** Every pane operation is scoped to the caller's `workspace_id`. Cross-workspace activity is forbidden.
2. **Per-tab session.** Exactly one pair per `tab_id` — two agent panes in that tab. Multiple pairs in different tabs of the same workspace are allowed and MUST NOT clobber each other; session state is stored under `<workspace_id>/<tab_slug>/` so concurrent tab pairs are isolated. Discovery is filtered to the caller's `tab_id`.
3. **User override always wins.** If the user submits a message that contradicts a partner message, the user wins. Surface the contradiction.
4. **No retries on spawn failure.** One failed partner spawn → handoff to the user with recent pane output.

## Message format

```
[agent <from> -> <to> kind=<kind> sid=<sid>]

<body>
```

- `<from>`, `<to>`: `claude` or `codex`.
- `<kind>`: `task`, `review`, `question`, `ready`, `accepted`, `blocked`, `stalemate`, `handoff`.
- `<sid>`: sortable session id, e.g. `1715000000-7a3f`.

Header matches; body is plain prose — write to a teammate, not a parser.

### Kinds

- `task` — assign or update work. Mid-flight stop: body begins `STOP — <reason>`.
- `review` — request review of described changes (file paths + short summary).
- `question` — ask for clarification before proceeding.
- `ready` — your side is complete. Summarize what changed, how it was validated, residual risk.
- `accepted` — partner's `ready` looks good. **Both sides sending `accepted` is the only completion signal.**
- `blocked` — cannot proceed without user input. Name the missing decision.
- `stalemate` — same disagreement restated twice without movement. Summarize for the user.
- `handoff` — final message back to the user (in your own pane, not via send-text).

## Bootstrap

Triggered by `/herdr-pair <task>` in either pane. The receiving agent is the initiator.

1. Resolve self with `herdr pane get $HERDR_PANE_ID` → `workspace_id`, `tab_id`, `agent`.
2. Find the partner with `herdr pane list --workspace <ws>`, filter to the same `tab_id`, pick the one whose `agent` is the opposite of self. Zero candidates → spawn flow below. Multiple → stop and ask the user.
3. Generate the session id and write the session file atomically. Session storage is per `(workspace, tab)`, not per workspace, so concurrent pairs in different tabs of the same workspace stay isolated. Tab ids may contain `:`, which is filesystem-safe on macOS/Linux but not Windows — flatten with `${TAB_ID//:/_}` for the slug:
   ```bash
   SID="$(date +%s)-$(openssl rand -hex 2)"
   TAB_SLUG="${TAB_ID//:/_}"
   SESSION_DIR="$HOME/.herdr-coworkers/<workspace_id>/$TAB_SLUG"
   mkdir -p "$SESSION_DIR"
   TMP="$SESSION_DIR/session.json.tmp.$$"
   cat > "$TMP" <<JSON
   {"sid":"$SID","workspace_id":"<ws>","tab_id":"<tab>","self":{"agent":"<self>","pane_id":"$HERDR_PANE_ID"},"partner":{"agent":"<partner>","pane_id":"<partner-pane>"},"round":0,"last_status":{"claude":null,"codex":null},"no_progress_count":0,"workbench":{"tab_id":null,"server_pane":null,"logs_pane":null},"created_at":"$(date -u +%FT%TZ)"}
   JSON
   mv "$TMP" "$SESSION_DIR/session.json"
   ```
   If `$SESSION_DIR/session.json` already exists for the same tab, that's a leftover from a previous pair in this tab — stop and ask the user whether to resume or overwrite.
4. Send the first message (see Sending below). Body should include a one-line fallback hint so a partner whose skill didn't auto-load can still recover:
   > `(Herdr pair protocol — if your skill didn't auto-load, run /herdr-pair, or follow the [agent X -> Y kind=... sid=...] header format.)`

## Spawn flow (only when no opposite-agent pane in the tab)

```bash
PARTNER_BIN="$(command -v codex)"   # or claude — opposite of self
[ -n "$PARTNER_BIN" ] || { echo "no partner binary on PATH" >&2; exit 1; }

NEW_PANE="$(herdr pane split "$HERDR_PANE_ID" --direction right --no-focus \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')"
herdr pane run "$NEW_PANE" "$PARTNER_BIN"
herdr wait agent-status "$NEW_PANE" --status idle --timeout 60000 \
  || { herdr pane read "$NEW_PANE" --source recent --lines 40; exit 1; }
```

Re-verify the new pane (`herdr pane get`), then resume bootstrap.

## Pre-send

1. **Identity.** Confirm the partner pane still exists and matches the session file.
2. **Ignore visible input text.** Don't gate on autosuggestions in the partner's input line — `send-text` overwrites them. Only submitted user messages count.
3. **Working partner.** If `agent_status == working`, send only if this is a `STOP — ...` interrupt. Otherwise wait: `herdr wait agent-status <partner> --status idle --timeout <budget>`. Non-interrupt sends to a working partner are accepted by the host CLI in a "queued for next turn" state — that's fine.

## Sending (with verify)

Compose the message in a temp file (heredoc handles quotes/`$`/backticks safely):

```bash
MSG=$(mktemp); trap 'rm -f "$MSG"' EXIT
{
  printf '[agent %s -> %s kind=%s sid=%s]\n\n' "$SELF_AGENT" "$PARTNER_AGENT" "$KIND" "$SID"
  cat <body-file>
} > "$MSG"
HEADER="[agent $SELF_AGENT -> $PARTNER_AGENT kind=$KIND sid=$SID]"

herdr pane send-text "$PARTNER_PANE" "$(cat "$MSG")"
sleep 1
herdr pane send-keys "$PARTNER_PANE" Enter
sleep 2

# Verify: read the partner's visible buffer and look for the header.
# Acceptable end states: header in scrollback, OR header under a "Messages to be
# submitted after next tool call" / "queued" notice. Failure: header still in the
# input buffer at a leading prompt glyph (›, >) — needs another Enter.
visible=$(herdr pane read "$PARTNER_PANE" --source visible --lines 12)
if ! grep -qF "$HEADER" <<<"$visible"; then : ; # not visible → assume delivered (off-screen)
elif grep -qE "Messages to be submitted|queued|Press up to edit queued" <<<"$visible"; then : ;
elif grep -qE "^[›>] *\[agent" <<<"$visible"; then
  herdr pane send-keys "$PARTNER_PANE" Enter; sleep 2  # retry once
  visible=$(herdr pane read "$PARTNER_PANE" --source visible --lines 12)
  grep -qE "^[›>] *\[agent" <<<"$visible" && { echo "send failed: still in input after retry" >&2; exit 1; }
fi
```

On verified delivery, update the session: increment `round` and set `last_status.<self> = <kind>`. Atomic JSON update — read, mutate, write to `session.json.tmp.$$`, `mv` over:

```bash
TAB_SLUG="${TAB_ID//:/_}"
python3 - "$HOME/.herdr-coworkers/$WS/$TAB_SLUG/session.json" "$SELF_AGENT" "$KIND" <<'PY'
import json, os, sys
path, agent, kind = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f: s = json.load(f)
s["round"] += 1
s["last_status"][agent] = kind
tmp = f"{path}.tmp.{os.getpid()}"
with open(tmp, "w") as f: json.dump(s, f, indent=2)
os.replace(tmp, path)
PY
```

A failed send (Enter never submitted after one retry) is not a send — do not update the session.

## Receiving

Input begins with `[agent <X> -> <you> kind=<kind> sid=<sid>]`:

1. Re-resolve self: `herdr pane get $HERDR_PANE_ID`. Capture `workspace_id` AND `tab_id`.
2. Load `~/.herdr-coworkers/<workspace_id>/<tab_slug>/session.json` where `tab_slug = ${TAB_ID//:/_}`. Missing → protocol violation; surface, don't invent state. Do NOT fall back to any workspace-level path — concurrent pairs in other tabs live under their own `<tab_slug>` and reading theirs is a hard error.
3. **sid match.** Mismatch is a hard error.
4. **Sender match.** Claimed `<from>` must equal `session.partner.agent`; `partner.pane_id` must still resolve and its `tab_id` must equal the session's `tab_id`.
5. Process per `kind`, run pre-send checks, send the reply, update the session.

## Progress guards

- **No fixed round cap.** Continue while producing useful artifacts; exchange `accepted` when done.
- **No-new-artifact heuristic.** If five consecutive turns produce nothing new (code, test results, decision, narrowed option), send `kind=handoff` instead. Track via `no_progress_count` (manually `+1` per "nothing new" turn, reset to 0 on real progress).
- **Stalemate.** Same disagreement restated twice without movement → `kind=stalemate` with a summary.
- **User override.** Submitted user messages win; surface contradictions in your next partner message.

## Session file

Path: `~/.herdr-coworkers/<workspace_id>/<tab_slug>/session.json` where `tab_slug = ${TAB_ID//:/_}` (one per `(workspace, tab)` pair, so multiple paired tabs in one workspace stay isolated). Shape:

```json
{
  "sid": "1715000000-7a3f",
  "workspace_id": "w...",
  "tab_id": "w...:1",
  "self": { "agent": "claude", "pane_id": "w...-1" },
  "partner": { "agent": "codex", "pane_id": "w...-2" },
  "round": 0,
  "last_status": { "claude": null, "codex": null },
  "no_progress_count": 0,
  "workbench": { "tab_id": null, "server_pane": null, "logs_pane": null },
  "created_at": "..."
}
```

All mutations write via temp file + `mv` for atomicity (two agents can race). Re-verify recorded pane IDs via `herdr pane get` before relying on them — public pane IDs can compact when panes close.

## Workbench tab

Lazy. See `references/workbench-tab.md` if you need a separate tab for long-running shared processes.

## Closing

After both sides exchange `accepted`, the closing agent emits a final `kind=handoff` to the user in its own pane summarizing the outcome, then trashes ONLY this tab's session dir (other tabs in the same workspace may host concurrent pairs — leave them alone):

```bash
TAB_SLUG="${TAB_ID//:/_}"
trash "$HOME/.herdr-coworkers/$WS/$TAB_SLUG"
```

`blocked` and `stalemate` paths also end in `handoff` + cleanup. Stale per-tab session dirs block the next `/herdr-pair` invocation in that tab, but not in others.
