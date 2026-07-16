---
name: herdr-pair
description: "Live Claude/Codex pairing inside herdr. Use when the user invokes `/herdr-pair` or asks for live pairing in herdr. Use when input begins with `[agent <name> -> <name> kind=<kind> sid=<...>]`; that is partner-agent traffic, so validate pane/session state before responding."
user-invocable: true
disable-model-invocation: true
argument-hint: "[task description]"
---

# Herdr Pair

Claude and Codex collaborate as peers inside herdr: one tab, two agent panes,
plain-text messages with a structured header. The user reads along live and can
interject in either pane.

Requires the `herdr` CLI on PATH and the separate `herdr` skill loaded. If `command -v herdr` fails or `HERDR_ENV != 1` or `HERDR_PANE_ID` is unset, stop and tell the user to install/load herdr first.

## Hard rules

1. **Workspace isolation.** Every pane operation is scoped to the caller's
   `workspace_id`. Cross-workspace activity is forbidden.
2. **Per-tab session.** Exactly one pair per `tab_id`; session state lives under
   `<workspace_id>/<tab_slug>/`, and discovery is filtered to the caller's tab.
3. **Write lease.** One agent holds the pen for a declared file scope: owner,
   target files, forbidden changes, validation, and stop point. The partner stays
   read/review-only on that scope until handoff.
4. **User override.** A submitted user message beats partner traffic. Surface the
   contradiction in the next reply.
5. **No retries on spawn failure.** One failed partner spawn means handoff to the
   user with recent pane output.

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

- `task` — assign or update work, including the write lease. Mid-flight stop:
  body begins `STOP — <reason>`.
- `review` — request review of described changes (file paths + short summary).
- `question` — ask for clarification before proceeding.
- `ready` — your side is complete. Summarize changed files, validation, and
  residual risk.
- `accepted` — partner's `ready` looks good. **Both sides sending `accepted` is the only completion signal.**
- `blocked` — cannot proceed without user input. Name the missing decision.
- `stalemate` — same disagreement restated twice without movement. Summarize for the user.
- `handoff` — final message back to the user (in your own pane, not via send-text).

## Bootstrap

Triggered by `/herdr-pair <task>` in either pane. The receiving agent is the initiator.

1. Resolve self with `herdr pane get $HERDR_PANE_ID` → `workspace_id`, `tab_id`, `agent`.
2. Find the partner with `herdr pane list --workspace <ws>`, filter to the same `tab_id`, pick the one whose `agent` is the opposite of self. Zero candidates → spawn flow below. Multiple → stop and ask the user.
3. Generate the session id and write the per-tab session file atomically. Tab ids
   may contain `:`, which is filesystem-safe on macOS/Linux but not Windows;
   flatten with `${TAB_ID//:/_}` for the slug:
   ```bash
   SID="$(date +%s)-$(openssl rand -hex 2)"
   TAB_SLUG="${TAB_ID//:/_}"
   SESSION_DIR="$HOME/.herdr-coworkers/<workspace_id>/$TAB_SLUG"
   [ -f "$SESSION_DIR/session.json" ] && { echo "stale session.json for this tab — stop and ask the user to resume or overwrite" >&2; exit 1; }
   mkdir -p "$SESSION_DIR"
   TMP="$SESSION_DIR/session.json.tmp.$$"
   cat > "$TMP" <<JSON
   {"sid":"$SID","workspace_id":"<ws>","tab_id":"<tab>","initiator":"<self>","participants":{"claude":{"pane_id":"<claude-pane>"},"codex":{"pane_id":"<codex-pane>"}},"round":0,"last_status":{"claude":null,"codex":null},"no_progress_count":0,"workbench":{"tab_id":null,"server_pane":null,"logs_pane":null},"created_at":"$(date -u +%FT%TZ)"}
   JSON
   mv "$TMP" "$SESSION_DIR/session.json"
   ```
   Done when `session.json` exists for this tab, or a stale file has been surfaced
   to the user for resume/overwrite.
4. Send the first message (see Sending below). Body should include a one-line
   fallback hint so a partner whose skill didn't auto-load can still recover:
   > `(Herdr pair protocol — if your skill didn't auto-load, run /herdr-pair, or follow the [agent X -> Y kind=... sid=...] header format.)`

## Spawn flow

Only when no opposite-agent pane exists in the tab:

```bash
PARTNER_BIN="$(command -v codex)"   # or claude — opposite of self
[ -n "$PARTNER_BIN" ] || { echo "no partner binary on PATH" >&2; exit 1; }

NEW_PANE="$(herdr pane split "$HERDR_PANE_ID" --direction right --no-focus \
  | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).result.pane.pane_id)')"
herdr pane run "$NEW_PANE" "$PARTNER_BIN"
herdr wait agent-status "$NEW_PANE" --status idle --timeout 60000 \
  || { herdr pane read "$NEW_PANE" --source recent --lines 40; exit 1; }
```

Done when the new pane resolves with `herdr pane get` and is idle, then resume
bootstrap.

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

On verified delivery, update the session: increment `round` and set
`last_status.<self> = <kind>`. Atomic JSON update: read, mutate, write a temp
file, rename over (`fs.renameSync` replaces atomically on POSIX and Windows):

```bash
TAB_SLUG="${TAB_ID//:/_}"
node -e '
const fs = require("fs");
const [path, agent, kind] = process.argv.slice(1);
const s = JSON.parse(fs.readFileSync(path, "utf8"));
s.round += 1;
s.last_status[agent] = kind;
const tmp = `${path}.tmp.${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
fs.renameSync(tmp, path);
' "$HOME/.herdr-coworkers/$WS/$TAB_SLUG/session.json" "$SELF_AGENT" "$KIND"
```

A failed send (Enter never submitted after one retry) is not a send; do not
update the session. Done when the message is delivered or the session is left
unchanged with the failure visible.

## Receiving

Input begins with `[agent <X> -> <you> kind=<kind> sid=<sid>]`:

1. Re-resolve self: `herdr pane get $HERDR_PANE_ID`. Capture `workspace_id`,
   `tab_id`, AND your own `agent` name.
2. Load `~/.herdr-coworkers/<workspace_id>/<tab_slug>/session.json` where
   `tab_slug = ${TAB_ID//:/_}`. Missing means protocol violation; surface it, and
   do not invent or borrow state. A file without `participants` (old
   `self`/`partner` shape) is stale — surface it the same way.
3. **sid match.** Mismatch is a hard error.
4. **Identity match.** Your own pane must equal `participants[<you>].pane_id`.
   Claimed `<from>` must be the other `participants` key;
   `participants[<from>].pane_id` must still resolve and its `tab_id` must equal
   the session's `tab_id`.
5. Process per `kind`, run pre-send checks, send the reply, update the session.
   Done when the reply is delivered and this tab's session file is updated.

## Progress guards

- **No fixed round cap.** Continue while producing useful artifacts; exchange `accepted` when done.
- **No-new-artifact heuristic.** If five consecutive turns produce nothing new (code, test results, decision, narrowed option), send `kind=handoff` instead. Track via `no_progress_count` (manually `+1` per "nothing new" turn, reset to 0 on real progress).
- **Stalemate.** Same disagreement restated twice without movement → `kind=stalemate` with a summary.

## Session file

Path: `~/.herdr-coworkers/<workspace_id>/<tab_slug>/session.json` where
`tab_slug = ${TAB_ID//:/_}`. Shape:

```json
{
  "sid": "1715000000-7a3f",
  "workspace_id": "w...",
  "tab_id": "w...:1",
  "initiator": "codex",
  "participants": {
    "claude": { "pane_id": "w...-1" },
    "codex": { "pane_id": "w...-2" }
  },
  "round": 0,
  "last_status": { "claude": null, "codex": null },
  "no_progress_count": 0,
  "workbench": { "tab_id": null, "server_pane": null, "logs_pane": null },
  "created_at": "..."
}
```

`participants` is keyed by agent name, so the one shared file reads identically
from both panes: your entry is the one matching your pane's `agent`; the partner
is the other key. `initiator` records who bootstrapped the session and owns the
close.

All mutations write via temp file + `mv` for atomicity. Re-verify recorded pane
IDs via `herdr pane get` before relying on them; public pane IDs can compact when
panes close.

## Workbench tab

Lazy. See `references/workbench-tab.md` if you need a separate tab for long-running shared processes.

## Closing

After both sides exchange `accepted`, exactly one agent closes: the
**initiator** (from the session file) emits the final `kind=handoff` to the user
in its own pane, then trashes only this tab's session dir. The non-initiator
sends or acknowledges its `accepted` and stops — no handoff, no cleanup. Only if
the initiator's pane no longer resolves does the surviving agent close instead.

```bash
TAB_SLUG="${TAB_ID//:/_}"
trash "$HOME/.herdr-coworkers/$WS/$TAB_SLUG"
```

On `blocked` and `stalemate` paths the agent that declared the state owns the
same handoff-plus-cleanup, whoever initiated. Done when the handoff is visible
and only this tab's session dir is gone.
