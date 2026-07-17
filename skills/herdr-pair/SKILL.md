---
name: herdr-pair
description: "Persistent Claude and Codex coworking inside one Herdr tab. Use when the user asks for Herdr pairing, another workflow needs a live peer, or input begins with `[agent` or includes `[herdr-pair control`. For inbound traffic, including after context compaction, run receive and reply through the bundled sender instead of local output."
---

# Herdr Pair

Pair Claude and Codex in one Herdr tab. Keep the pair and its `sid` alive across
tasks, accepted work cycles, and context compaction. The user can read and
interject in either pane.

Write partner messages and user handoffs in the user's current language. Keep
code, commands, paths, identifiers, errors, and protocol headers literal.

## Preconditions

Set `SKILL_DIR` to this skill directory and
`PAIR_SCRIPT="$SKILL_DIR/scripts/herdr-pair.mjs"`. Always use that absolute
path; the project cwd is unrelated to the installed skill path.

Require `herdr` and `trash` on `PATH`, `HERDR_ENV=1`, and `HERDR_PANE_ID`. If any is
missing, stop and tell the user to install or start Herdr.

## Guardrails

1. Scope every pane operation to the caller's exact `workspace_id` and
   `tab_id`. Never address a pane discovered only by workspace, focus, label,
   cwd, direction, or pane number.
2. Use `herdr-pair.mjs send` as the sole partner transport. Reserve normal
   assistant output for a header-free user handoff. `SendMessage`, subagent
   messaging, and direct pane writes are different channels.
3. Give one agent the write lease for each file scope: owner, target files,
   forbidden changes, validation, and stop point. The partner stays read-only
   on that scope until handoff.
4. A submitted user message overrides partner traffic. Surface any conflict in
   the next reply. One failed partner spawn ends the attempt.

## Protocol

Messages start with:

```text
[agent <from> -> <to> kind=<kind> sid=<sid>]
[herdr-pair control seq=<n>: ...]

<body>
```

The helper injects the control line. It contains the exact executable
`receive` command for this message and the rule to reply through the sender.
This line is the recovery anchor when model context has been compacted.

Use these kinds:

- `task`: assign or update work and the write lease. Begin a mid-flight stop
  with `STOP — <reason>`.
- `review`: request review with file paths and a short change summary.
- `question`: ask for clarification before proceeding.
- `ready`: report changed files, validation, and residual risk.
- `accepted`: accept the partner's `ready` and advance the work cycle.
- `blocked`: name the user decision required to continue.
- `stalemate`: report the same disagreement repeated twice without movement.
- `handoff`: return control to the user in normal local output.

## Start or resume

1. Run `node "$PAIR_SCRIPT" discover`. If no opposite agent exists, run
   `node "$PAIR_SCRIPT" spawn` once. Stop on multiple candidates or spawn
   failure.
2. Run `node "$PAIR_SCRIPT" init`. It creates a new tab-scoped session or
   idempotently resumes the exact live session. It also migrates supported
   legacy session shapes.
3. Send the first `task` through the helper. State the write lease and include
   enough task context for the partner to work independently.

Done when the exact tab has one verified session and the first task has a
recorded receipt. Skill reload and compaction always resume that session.

## Send

Write only the body to a temp file, then invoke:

```bash
BODY=$(mktemp); trap 'trash "$BODY"' EXIT
# Write the partner message body to "$BODY".
node "$PAIR_SCRIPT" send --kind "$KIND" --body-file "$BODY"
```

The sender reserves the sequence and message kind before submission, then
re-verifies both panes, injects the control line, and records positive UI
evidence. It waits for `receive` to acknowledge that sequence in
`session.json`; an ACK can recover an interruption immediately after Enter.

- `receipt=acknowledged`: the partner ran `receive` for this message.
- `receipt=pending-partner-may-be-busy-do-not-retry`: submission was observed,
  but the partner has not acknowledged it yet. Do not resend. Later run
  `node "$PAIR_SCRIPT" reconcile`; the status advances only after its ACK.
- A nonzero exit is a transport failure. The pending reservation remains so an
  ACK can reconcile it; never claim delivery or clear it without inspection.

A working Claude is never queued; wait for it to become available. A working
Codex may be queued only when its exact queue marker contains this message's
header.

If inspection proves a pending message never reached the partner, clear only
that delivery with explicit user approval:

```bash
node "$PAIR_SCRIPT" reconcile --sid "<sid>" --clear-pending true
```

## Receive and recover after compaction

For inbound `[agent ...]` traffic:

1. Run the exact command in `[herdr-pair control ...]`. It calls `receive` with
   `--sid`, `--from`, and `--seq`, validates the live tab binding, and persists
   the receipt acknowledgement.
2. For a legacy message without a control line, run:

   ```bash
   node "$PAIR_SCRIPT" receive --sid "<sid>" --from "<from>"
   ```

3. Process the message, write the reply body to a temp file, and run
   `node "$PAIR_SCRIPT" send ...`.

Done when `receive` records the sequence and the reply has a recorded receipt.
On failure, give the user a header-free transport report. After compaction,
reconstruct pane IDs, `sid`, task status, and close state from the control line
and verified session.

## Work cycles and persistence

Continue while producing useful artifacts. Five consecutive turns with no new
code, test result, decision, or narrowed option require a `handoff`. Reset the
count on real progress. Send `stalemate` after the same disagreement repeats
twice.

Two `accepted` statuses complete one work cycle. The initiator gives the user a
local handoff; both agents may idle; the next task resumes the same pair and
`sid`. The session remains active.

`blocked` and `stalemate` also hand off without deleting the session. Use
`node "$PAIR_SCRIPT" reset` only to clear work-cycle counters/statuses in a
verified live pair; it preserves identity and delivery history.

End and trash the session only when the user explicitly asks to end the pair:

```bash
node "$PAIR_SCRIPT" end --sid "<sid>"
```

`end` verifies the exact sid, workspace, tab, and participants, then trashes
only that tab's session and removes an empty workspace directory. Closing the
Herdr tab ends the panes naturally; stale state must never be borrowed by
another tab. If old pane IDs or a missing partner prevent resume, explain the
mismatch and use `end --sid "<sid>" --stale true` only with explicit user
approval. `end` refuses while delivery is pending; wait for its ACK or use the
explicit inspected clear path before ending.

## Workbench tab

Read `references/workbench-tab.md` only when a separate tab is needed for a
long-running shared process.
