---
name: herdr-pair
description: Pair Claude and Codex as collaborating peer agents inside herdr. Use whenever the user invokes /herdr-pair, asks to "pair", "team up", "collaborate with codex", "collaborate with claude", "work with the other agent", or anything that means two AI agents should review each other's code and iterate to a finished result inside herdr. ALSO use whenever the agent's terminal input begins with a header in the form `[agent <name> -> <name> kind=<kind> sid=<...>]` — that is partner-agent traffic and the receiver MUST validate the herdr pane/session and respond per protocol, treating the message as machine-to-machine, not as ordinary user input. Trigger on the prefix even if the user did not invoke the skill themselves; the prefix is the protocol's auto-load signal.
user-invocable: true
argument-hint: "[task description]"
---

# Herdr Pair

Claude and Codex collaborate as peers inside herdr — one tab, two agent panes, plain-text messages between them with a structured header. The user reads along live and can interject in either pane.

Requires the `herdr` CLI on PATH and the separate `herdr` skill loaded. `scripts/bootstrap.sh` runs a preflight and surfaces a clear error if either is missing.

## Hard rules

1. **Workspace isolation.** Every pane operation is scoped to the caller's `workspace_id`. Cross-workspace activity is forbidden.
2. **Same-tab pair.** Exactly one tab with exactly two agent panes. Discovery is filtered to the caller's `tab_id`.
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

```bash
# Resolve partner + create session. Output: "<partner-pane-id> <sid>"
read PARTNER_PANE SID < <(scripts/bootstrap.sh)
```

Exit codes:

- `0` — partner found, session written.
- `1` — preflight failed (herdr CLI/env missing). Stop and surface.
- `2` — no partner in tab. Run spawn flow, then call bootstrap again.
- `3` — multiple candidates. Stop and ask which to pair with.

Then send the first message:

```bash
cat > /tmp/first-task.txt <<'EOF'
<task body, including context from the user's invocation>

(Herdr pair protocol — if your skill didn't auto-load, run /herdr-pair, or follow the [agent X -> Y kind=... sid=...] header format.)
EOF

scripts/send.sh "$PARTNER_PANE" "$SID" task /tmp/first-task.txt
```

`send.sh` composes, sends, verifies (with one Enter retry), and bumps `round` + `last_status` on success.

## Spawn flow (only when bootstrap exits 2)

```bash
PARTNER_BIN="$(command -v codex)"   # or claude — whichever is opposite
[ -n "$PARTNER_BIN" ] || { echo "no partner binary on PATH" >&2; exit 1; }

NEW_PANE="$(herdr pane split "$HERDR_PANE_ID" --direction right --no-focus \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')"

herdr pane run "$NEW_PANE" "$PARTNER_BIN"
herdr wait agent-status "$NEW_PANE" --status idle --timeout 60000 \
  || { herdr pane read "$NEW_PANE" --source recent --lines 40; exit 1; }
```

Re-verify the new pane with `herdr pane get`, then call `bootstrap.sh` again.

## Pre-send checks

`send.sh` owns the mechanics. Your job:

1. **Identity** — partner pane still exists and matches the session file. `send.sh` also checks.
2. **Ignore visible input text.** Don't gate on autosuggestions in the partner's input line — `send-text` overwrites them. Only submitted user messages count.
3. **Working partner.** If `agent_status == working`, send only if this is a `STOP — ...` interrupt. Otherwise wait: `herdr wait agent-status <partner> --status idle --timeout <budget>`. Non-interrupt sends to a working partner succeed in the "queued for next turn" state.

## Post-send

`send.sh` exit codes:

- `0` — delivered or queued; session updated (`round` incremented, `last_status.<self> = <kind>`).
- `2` — failed even after one Enter retry; session **not** updated.

Use `update-session.py` directly only for `no_progress_count` and `workbench.*` — the fields send.sh doesn't own.

## Receiving

Input begins with `[agent <X> -> <you> kind=<kind> sid=<sid>]`:

1. Re-resolve self: `herdr pane get $HERDR_PANE_ID`.
2. Load `~/.herdr-coworkers/<workspace_id>/session.json`. Missing → protocol violation; surface, don't invent state.
3. **sid match.** Mismatch is a hard error.
4. **Sender match.** Claimed `<from>` must equal `session.partner.agent`; `partner.pane_id` must still resolve.
5. Process per `kind`, run pre-send checks, call `send.sh`.

## Progress guards

- **No fixed round cap.** Continue while producing useful artifacts; exchange `accepted` when done.
- **No-new-artifact heuristic.** If five consecutive turns produce nothing new (code, test results, decision, narrowed option), send `kind=handoff` instead. Track via `no_progress_count`.
- **Stalemate.** Same disagreement restated twice without movement → `kind=stalemate` with a summary.
- **User override.** Submitted user messages win; surface contradictions in your next partner message.

## Session file

Path: `~/.herdr-coworkers/<workspace_id>/session.json` (one per workspace).

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

All mutations go through `scripts/update-session.py`. Re-verify recorded pane IDs via `herdr pane get` before relying on them — public pane IDs can compact when panes close.

## Workbench tab

Lazy. See `references/workbench-tab.md` if you need a separate tab for long-running shared processes.

## Closing

After both sides exchange `accepted`, the closing agent emits a final `kind=handoff` to the user in its own pane summarizing the outcome, then:

```bash
trash ~/.herdr-coworkers/$(herdr pane get $HERDR_PANE_ID | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["pane"]["workspace_id"])')/
```

`blocked` and `stalemate` paths also end in `handoff` + cleanup. Stale session files block the next `/herdr-pair` invocation.
