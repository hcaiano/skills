---
name: herdr-pair
description: Pair Claude and Codex as collaborating peer agents inside herdr. Use whenever the user invokes /herdr-pair, asks to "pair", "team up", "collaborate with codex", "collaborate with claude", "work with the other agent", or anything that means two AI agents should review each other's code and iterate to a finished result inside herdr. ALSO use whenever the agent's terminal input begins with a header in the form `[agent <name> -> <name> kind=<kind> sid=<...>]` — that is partner-agent traffic and the receiver MUST validate the herdr pane/session and respond per protocol, treating the message as machine-to-machine, not as ordinary user input. Trigger on the prefix even if the user did not invoke the skill themselves; the prefix is the protocol's auto-load signal.
user-invocable: true
argument-hint: "[task description]"
---

# Herdr Pair

Claude and Codex collaborate as peers inside herdr. One tab, two agent panes, plain-text messages flowing directly between them. The user reads along live and can interject in either pane at any time.

This skill is the protocol/policy doc. Mechanics (bootstrap, send-with-verify, atomic session updates) live in `scripts/`. Host-CLI specifics (placeholder strings, workbench tab) live in `references/`.

## Prerequisite

This skill requires the `herdr` CLI on PATH and the separate `herdr` skill loaded for pane primitives (`pane list`, `pane get`, `pane split`, `pane run`, `pane send-text`, `pane send-keys`, `wait agent-status`, etc.). `scripts/bootstrap.sh` runs a preflight check on the first call and surfaces a clear error if either is missing.

## Why this exists

Two agents collaborate fine when a human shuttles messages between panes — the bottleneck is the human typing. This skill removes that bottleneck without inventing a new transport: the agents type into each other's panes the same way the human would, with a structured header so the receiver can tell partner traffic apart from user input.

## Hard rules

1. **Workspace isolation.** Every pane operation is scoped to the caller's `workspace_id`. Cross-workspace activity is forbidden. If something points outside the workspace, refuse and surface to the user.
2. **Same-tab pair.** The pair lives in exactly one tab with exactly two agent panes. Discovery is filtered to the caller's `tab_id`.
3. **User override always wins.** If the user types in either pane and contradicts a partner message, the user wins. Surface the contradiction so the user knows it happened.
4. **No retries on spawn failure.** One failed partner spawn = handoff to the user with recent pane output. Do not loop.

## Message format

Every machine-to-machine message starts with a single header line, followed by a blank line, followed by plain English:

```
[agent <from> -> <to> kind=<kind> sid=<sid>]

<body>
```

- `<from>`, `<to>`: `claude` or `codex`.
- `<kind>`: one of `task`, `review`, `question`, `ready`, `accepted`, `blocked`, `stalemate`, `handoff`.
- `<sid>`: the session id (sortable, e.g. `1715000000-7a3f`).

The header is what the receiver matches on. The body is plain prose — write to a teammate, not to a parser.

### Kinds

- `task` — assign or update work. Mid-flight changes that invalidate the partner's current direction use `task` with a body that begins `STOP — <reason>`. No separate `interrupt` kind on purpose; the state machine stays small.
- `review` — request review of described changes (often paired with file paths and a short summary).
- `question` — ask for clarification before proceeding.
- `ready` — your side of the work is complete. Body summarizes what changed, how it was validated, and any residual risk.
- `accepted` — the partner's `ready` looks good. **Both sides sending `accepted` is the only completion signal.**
- `blocked` — you cannot proceed without the user's input. Body names the missing decision concretely.
- `stalemate` — you and the partner have restated the same disagreement at least twice without movement. Body summarizes the disagreement so the user can break the tie.
- `handoff` — final message back to the user (in your own pane, not via send-text). Used when a progress guard fires or when both sides have `accepted` and you're closing out.

## Bootstrap (initiator side)

Triggered by `/herdr-pair <task>` in either pane. The agent that received the invocation is the initiator.

```bash
# Resolve partner + create session. Output: "<partner-pane-id> <sid>"
read PARTNER_PANE SID < <(scripts/bootstrap.sh)
```

Exit codes from `bootstrap.sh`:

- `0` — partner found, session written. Continue.
- `1` — preflight failed (herdr CLI/env missing). Stop and surface.
- `2` — no partner in tab. Run spawn flow below, then call bootstrap again.
- `3` — multiple partner candidates. Stop and ask the user which to pair with.

Then send the first message:

```bash
# Body in a file (heredoc is safe for quotes/$/backticks).
cat > /tmp/first-task.txt <<'EOF'
<task body here, including any context from the user's invocation>

(Herdr pair protocol — if your skill didn't auto-load, run /herdr-pair, or follow the [agent X -> Y kind=... sid=...] header format.)
EOF

scripts/send.sh "$PARTNER_PANE" "$SID" task /tmp/first-task.txt
scripts/update-session.py round 1
scripts/update-session.py last_status.claude task   # or last_status.codex if you're codex
```

## Spawn flow (only when bootstrap returns exit 2)

```bash
PARTNER_BIN="$(command -v codex)"   # or claude — whichever is the opposite agent
[ -n "$PARTNER_BIN" ] || { echo "no partner binary on PATH" >&2; exit 1; }

NEW_PANE="$(herdr pane split "$HERDR_PANE_ID" --direction right --no-focus \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')"

herdr pane run "$NEW_PANE" "$PARTNER_BIN"
herdr wait agent-status "$NEW_PANE" --status idle --timeout 60000 \
  || { herdr pane read "$NEW_PANE" --source recent --lines 40; exit 1; }
```

Re-verify the new pane with `herdr pane get "$NEW_PANE"` (workspace, tab, agent type), then call `bootstrap.sh` again.

## Pre-send checks (your job, not the script's)

`scripts/send.sh` handles the mechanics (compose, send, verify, retry). The policy checks are yours before each call:

1. **Identity.** Confirm partner pane still exists and matches the session file. (`send.sh` also checks this and errors if mismatched.)
2. **Visible input guard.** Read `herdr pane read <partner> --source visible --lines 8`. Block only on real user-authored prose. Ignore host-CLI placeholder strings (`Try "..."`, `Summarize recent commits`, status lines, prompt glyphs) — full catalog in `references/placeholder-strings.md`. When uncertain, prefer sending; placeholders are overwritten harmlessly.
3. **Working partner.** If `agent_status == working`, only send if this is a `STOP — ...` interrupt. Otherwise wait: `herdr wait agent-status <partner> --status idle --timeout <budget>`. Note: `send.sh` will succeed with a "queued for next turn" state if the partner is mid-tool-call, which is fine for non-interrupt traffic.

## Post-send (handled by send.sh)

`scripts/send.sh` verifies delivery with one Enter retry, then exits 0 (delivered or queued) or 2 (still in input buffer after retry). After a successful send, update the session:

```bash
scripts/update-session.py --inc round
scripts/update-session.py last_status.<self-agent> <kind>
```

A send without a verified delivery is not a send — do not increment `round` on a non-zero exit.

## Receiving

When your terminal input begins with `[agent <X> -> <you> kind=<kind> sid=<sid>]`, treat it as partner traffic:

1. Re-resolve self: `herdr pane get $HERDR_PANE_ID`.
2. Load `~/.herdr-coworkers/<self.workspace_id>/session.json`. If missing → protocol violation; surface to the user, don't invent state.
3. **sid match.** The message's `sid` must equal `session.sid`. Mismatch is a hard error.
4. **Sender match.** Message claims `<from>`; session's `partner.agent` must equal that, and `partner.pane_id` must still resolve.
5. Process per `kind`. Prepare reply, run pre-send checks, call `send.sh`, update session.

## Progress guards

Two LLMs can disagree forever in good faith. Guards make the loop safe to leave running:

- **No fixed round cap.** Continue as long as the loop is producing useful artifacts. Recognize when the task is genuinely done and exchange `accepted`.
- **No-new-artifact heuristic.** Before each non-final send, self-check: have I produced new code, test results, a concrete decision, or narrowed an option since my last turn? If five consecutive turns produce nothing new, send `kind=handoff` instead of continuing. Increment `no_progress_count` each "nothing new" turn; reset on real progress.
- **Stalemate.** If you've restated the same disagreement at least twice without partner movement, send `kind=stalemate` with a short summary. Don't keep arguing.
- **User override.** Any user input in either pane wins over partner messages. Surface contradictions in your next partner message.

Why progress-based and not time-based? Time is a poor proxy. A long typecheck or useful review loop must not force a handoff.

## Session file

Path: `~/.herdr-coworkers/<workspace_id>/session.json`. One per workspace.

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

`self` is from the perspective of whichever agent is reading the file — both interpret it from their own viewpoint. All mutations go through `scripts/update-session.py` for atomicity.

Pane IDs are cached live handles, not durable identity. Before relying on a recorded pane ID, re-verify it via `herdr pane get`; herdr's docs warn that public pane IDs can compact when panes close.

## Workbench tab

Lazy/optional. See `references/workbench-tab.md` if an agent needs a separate tab for long-running shared processes (servers, log streams).

## Closing a session

When both sides have exchanged `accepted` and the work is done, the closing side emits a final `kind=handoff` to the user in its own pane (not via `send.sh`) summarizing the outcome, then:

```bash
trash ~/.herdr-coworkers/$(herdr pane get $HERDR_PANE_ID | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["pane"]["workspace_id"])')/
```

`blocked` and `stalemate` paths also end in `kind=handoff` + cleanup. Don't leave stale session files — the next `/herdr-pair` invocation will refuse to start if it finds one with live panes.
