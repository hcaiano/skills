---
name: herdr-pair
description: "Pair Claude and Codex live inside one Herdr tab. Use when the user asks for Herdr pairing, another skill needs a live Claude/Codex partner, or input begins with `[agent <name> -> <name> kind=<kind> sid=<...>]`."
user-invocable: true
argument-hint: "[task description]"
---

# Herdr Pair

Claude and Codex collaborate as peers inside herdr: one tab, two agent panes,
plain-text messages with a structured header. The user reads along live and can
interject in either pane.

If the current input begins with `[agent <from> -> <to> kind=<kind> sid=<sid>]`,
treat it as inbound pair transport: validate the current-tab session and respond
through the bundled sender. It is not an ordinary prompt to answer locally.

Requires the `herdr` CLI on PATH. The bundled helper owns the pane primitives;
do not invoke the separate `herdr` skill just to transport pair messages. If
`command -v herdr` fails or `HERDR_ENV != 1` or `HERDR_PANE_ID` is unset, stop
and tell the user to install/start Herdr first.

## Hard rules

1. **Workspace isolation.** Every pane operation is scoped to the caller's
   `workspace_id`. Cross-workspace activity is forbidden.
2. **Per-tab session.** Exactly one pair per `tab_id`; session state lives under
   `<workspace_id>/<tab_slug>/`. Never address a pane discovered only by
   workspace, direction, focus, label, cwd, or pane number. Resolve and verify
   the opposite agent in the caller's exact current tab before every send.
3. **User-language continuity.** Use the language of the user's current
   conversation for partner messages and the final user handoff. Keep code,
   commands, paths, identifiers, quoted errors, and protocol headers literal
   when needed. A user language switch changes the next message.
4. **One partner transport.** Send every partner message through the bundled
   `herdr-pair.mjs send` command. An agent-prefixed inbound message is transport
   traffic, not a prompt to answer visibly in your own pane. `SendMessage`,
   subagent messaging, normal assistant output, and direct `herdr pane
   send-text` are not pair delivery. The final `handoff` is different: address
   it to the user as normal output in your own pane and never send it through
   the helper.
5. **Write lease.** One agent holds the pen for a declared file scope: owner,
   target files, forbidden changes, validation, and stop point. The partner stays
   read/review-only on that scope until handoff.
6. **User override.** A submitted user message beats partner traffic. Surface the
   contradiction in the next reply.
7. **No retries on spawn failure.** One failed partner spawn means handoff to the
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
- `handoff` — final message back to the user.

## Bootstrap

When the skill starts from a pairing request or another active skill, the
receiving agent is the initiator. Inbound partner traffic follows Receiving
instead.

Set `SKILL_DIR` to the directory containing the loaded `herdr-pair/SKILL.md`,
then set `PAIR_SCRIPT="$SKILL_DIR/scripts/herdr-pair.mjs"`. Use that absolute
path; the user's project cwd is unrelated to the installed skill path.

1. Run `node "$PAIR_SCRIPT" discover`. It accepts exactly one
   opposite-agent pane in the caller's current tab. If none exists, run
   `node "$PAIR_SCRIPT" spawn`; it creates the opposite agent in a split
   of this tab only. More than one candidate or a failed spawn stops the pair.
2. Run `node "$PAIR_SCRIPT" init`. It creates the per-tab session
   atomically and stops on existing state. Done when the exact current-tab
   session exists or stale state has been surfaced to the user.
3. Send the first message (see Sending below). Body should include a one-line
   fallback hint so a partner whose skill didn't auto-load can still recover:
   > `(Herdr pair protocol — if your skill didn't auto-load, run /herdr-pair, or follow the [agent X -> Y kind=... sid=...] header format.)`

## Sending (with verify)

Write only the body to a temp file, in the user's current conversation language,
then use the bundled sender:

```bash
BODY=$(mktemp); trap 'trash "$BODY"' EXIT
# Write the partner message body to "$BODY".
node "$PAIR_SCRIPT" send --kind "$KIND" --body-file "$BODY"
```

The sender re-resolves the current-tab binding immediately before writing,
presses Enter, and requires one positive signal: an available partner starts
working, or a working Codex shows `Messages to be submitted after next tool
call` with the exact protocol header. A working Claude is never queued.
Composer text, scrollback text, and disappearance from the viewport are not
delivery evidence. It retries Enter only when the exact header remains visibly
in the composer; ambiguous timeouts fail without risking a duplicate submit.
Session updates are serialized per tab.

## Receiving

Input begins with `[agent <X> -> <you> kind=<kind> sid=<sid>]`:

1. Run `node "$PAIR_SCRIPT" receive --sid "<sid>" --from "<X>"`. It fail-closes
   unless the inbound header, self, partner, session, workspace, and current tab
   all agree.
2. Process per `kind` and compose the reply body in the user's current
   conversation language.
3. Put a partner-reply body in a temp file and run `node "$PAIR_SCRIPT" send
   ...`. Do not print a partner reply in your own pane and do not use
   `SendMessage`. For `kind=handoff`, write only to the user in your own pane.
   Done only when the helper reports the partner header and this tab's session
   file records the new round/status. If the helper fails, surface the transport
   failure to the user without pretending the partner received anything.

## Progress guards

- **No fixed round cap.** Continue while producing useful artifacts; exchange `accepted` when done.
- **No-new-artifact heuristic.** If five consecutive turns produce nothing new (code, test results, decision, narrowed option), send `kind=handoff` instead. Track via `no_progress_count` (manually `+1` per "nothing new" turn, reset to 0 on real progress).
- **Stalemate.** Same disagreement restated twice without movement → `kind=stalemate` with a summary.

## Session file

The helper owns the full JSON shape at
`~/.herdr-coworkers/<workspace_id>/<tab_slug>/session.json`. Agents rely only on
`sid`, `participants`, `initiator`, and the helper's verified status updates;
they do not mutate the file directly.

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
