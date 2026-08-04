---
name: herdr-pair
description: "Persistent Claude-Codex pairing inside one Herdr tab. Use for live peer work, workflows requesting a pair, or any inbound `[agent ...]` / `[herdr-pair control ...]` line — including after context compaction; resume the exact session and reply through the bundled transport."
---

# Herdr Pair

Pair Claude and Codex in one Herdr tab. Keep the pair and its `sid` alive across
tasks, accepted work cycles, and context compaction. The user can read and
interject in either pane. Keep protocol headers and identifiers literal.

## Preconditions

Set `SKILL_DIR` to this skill directory and
`PAIR_SCRIPT="$SKILL_DIR/scripts/herdr-pair.mjs"`. Always use that absolute
path; the project cwd is unrelated to the installed skill path.

Require `herdr` with the agent automation commands (`herdr agent start`,
`herdr agent prompt`), `jq`, and `trash` on `PATH`, plus `HERDR_ENV=1`. If
any is missing, stop and tell the user to install or start (or update) Herdr.

Before any Herdr mutation, read and execute
[Caller pane proof](references/caller-pane-resolution.md). It resolves the
explicit task repository, proves the unique caller from its own session id —
falling back to conversation markers when that id does not own exactly one
pane — and returns `PAIR_PROOF` plus the pinned `PAIR_ID`, including
`--tab-id`. Stop when that proof does not complete exactly.

## Guardrails

1. Scope every pane operation to the proven `workspace_id`,
   `tab_id`, `pane_id`, agent kind, terminal identity, and repository. Never
   address a pane discovered only by workspace, focus, label, cwd, direction,
   session metadata, or pane number.
2. Use `herdr-pair.mjs send` as the sole partner transport. Reserve normal
   assistant output for a header-free user handoff. `SendMessage`, subagent
   messaging, and direct pane writes are different channels.
3. Give one agent the write lease for each file scope: owner, target files,
   forbidden changes, validation, and stop point. The partner stays read-only
   on that scope until handoff.
4. A submitted user message overrides partner traffic. Surface any conflict in
   the next reply. One failed partner spawn ends the attempt.
5. Between work steps return to the prompt; never hold the pane in long
   foreground loops (sleep-and-poll receives, foreground CI watchers). A
   permanently-working pane starves inbound partner traffic — run
   long-running watchers in a background terminal and keep this pane
   promptable.

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

- `task`: propose or update the work split and its write leases. Begin a
  mid-flight stop with `STOP — <reason>`.
- `review`: request review with file paths and a short change summary.
- `question`: ask for clarification before proceeding.
- `ready`: report changed files, validation, and residual risk.
- `accepted`: accept the partner's `ready` and advance the work cycle.
- `blocked`: name the user decision required to continue.
- `stalemate`: report the same disagreement repeated twice without movement.
- `handoff`: return control to the user in normal local output.

## Start or resume

1. Run
   `node "$PAIR_SCRIPT" discover "${PAIR_ID[@]}"`.
   If no opposite agent exists, run
   `node "$PAIR_SCRIPT" spawn "${PAIR_ID[@]}"` once.
   Stop on multiple candidates or spawn failure.
2. Run `node "$PAIR_SCRIPT" init "${PAIR_ID[@]}"`.
   It creates a new tab-scoped session or
   idempotently resumes the exact live session.
   Record its exact `sid` as `PAIR_SID`; every send is
   bound to it so a wrong same-kind pane cannot borrow another tab's session.
3. Send the first `task` through the helper. The partners are equals:
   propose a scope split — one write lease per scope, each partner
   implementing its own scopes and reviewing the other's `ready` — and
   include enough context for independent work; the partner accepts or
   counters before implementing. A task with no independent scopes takes one
   lease: the holder drives while the partner reviews, and the lease
   alternates across tasks.

Done when the exact tab has one verified session and the first task has a
recorded receipt. Skill reload and compaction always resume that session.

## Send

Write only the body to a temp file, then invoke:

```bash
BODY=$(mktemp); trap 'trash "$BODY"' EXIT
# Write the partner message body to "$BODY".
node "$PAIR_SCRIPT" send "${PAIR_ID[@]}" --sid "$PAIR_SID" \
  --kind "$KIND" --body-file "$BODY"
```

The sender gives a busy partner a short grace period, then delivers anyway —
both harnesses queue a submitted prompt while working, so no message is ever
dropped for a partner that stays busy. It reserves the sequence and message
kind, submits header, control line, and body in one `herdr agent prompt`
call, and proves landing from the partner's composer itself: Enter until the
composer no longer holds the text, one full resend, then a loud failure. It
then waits for `receive` to acknowledge that sequence in `session.json`; an
ACK can recover an interruption immediately after submission.

- `receipt=acknowledged`: the partner ran `receive` for this message.
- `receipt=pending-partner-may-be-busy-do-not-retry`: the message landed
  (queued if the partner was working), but is not acknowledged yet. Do not
  resend. Later run `node "$PAIR_SCRIPT" reconcile`; the status advances only
  after its ACK.
- A nonzero exit after reservation is a transport failure. The pending
  reservation remains so an ACK can reconcile it; never claim delivery or clear
  it without inspection.

If inspection proves a pending message never reached the partner, clear only
that delivery with explicit user approval:

```bash
node "$PAIR_SCRIPT" reconcile "${PAIR_ID[@]}" --sid "<sid>" \
  --clear-pending true
```

## Receive and recover after compaction

For inbound `[agent ...]` traffic:

1. Run the exact command in `[herdr-pair control ...]`. It calls `receive` with
   `--sid`, `--from`, and `--seq`, validates the live tab binding, and persists
   the receipt acknowledgement.
2. Process the message, write the reply body to a temp file, and run
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
`node "$PAIR_SCRIPT" reset "${PAIR_ID[@]}"` only to clear work-cycle
counters/statuses in a verified live pair; it preserves identity and delivery
history.

End and trash the session only when the user explicitly asks to end the pair:

```bash
node "$PAIR_SCRIPT" end "${PAIR_ID[@]}" --sid "<sid>"
```

The script verifies sid, workspace, tab, and participants itself, and
refuses while delivery is pending (wait for the ACK or use the inspected
clear path). If old pane IDs or a missing partner prevent resume, explain
the mismatch and use `end "${PAIR_ID[@]}" --sid "<sid>" --stale true` only
with explicit user approval — a stale end may discard pending state only
when the partner pane is gone, its recorded binding is stale, or its
foreground agent process/repository no longer matches. Closing the Herdr tab
ends the panes naturally; stale state is never borrowed by another tab.

## Workbench tab

Read `references/workbench-tab.md` only when a separate tab is needed for a
long-running shared process.
