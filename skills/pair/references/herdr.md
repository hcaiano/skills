# Herdr backend

Pair Claude and Codex in one Herdr tab. The user can read and interject in
either pane. The protocol, kinds, write leases, broken-checkout announcements,
and work cycles are in [`SKILL.md`](../SKILL.md); this file owns the transport.

## Preconditions

Set `SKILL_DIR` to this skill directory and
`PAIR_SCRIPT="$SKILL_DIR/scripts/herdr-pair.mjs"`. Always use that absolute
path; the project cwd is unrelated to the installed skill path.

Require `herdr` with the agent automation commands (`herdr agent start`,
`herdr agent prompt`), `jq`, and `trash` on `PATH`, plus `HERDR_ENV=1`. If
any is missing, stop and tell the user to install or start (or update) Herdr.

Before any Herdr mutation, read and execute
[Caller pane proof](caller-pane-resolution.md). It resolves the
explicit task repository, proves the unique caller from its own process
ancestry — falling back to conversation markers when that ancestry matches
anything other than exactly one pane — and returns `PAIR_PROOF` plus the pinned
`PAIR_ID`, including `--tab-id`. Stop when that proof does not complete exactly.

## Guardrails

1. Scope every pane operation to the transcript-proven `workspace_id`,
   `tab_id`, `pane_id`, agent kind, terminal identity, and repository. Never
   address a pane discovered only by workspace, focus, label, cwd, direction,
   session metadata, or pane number.
2. Use `herdr-pair.mjs send` as the sole partner transport. Reserve normal
   assistant output for a header-free user handoff. `SendMessage`, subagent
   messaging, and direct pane writes are different channels.
3. A submitted user message overrides partner traffic. Surface any conflict in
   the next reply. One failed partner spawn ends the attempt.
4. Between work steps return to the prompt; never hold the pane in long
   foreground loops (sleep-and-poll receives, foreground CI watchers). A
   permanently-working pane starves inbound partner traffic — run
   long-running watchers in a background terminal and keep this pane
   promptable.

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
3. Send the first `task` through the helper, splitting scopes and write leases
   as `SKILL.md` describes.

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

The helper injects the `[herdr-pair control seq=<n>: ...]` line under the
header. It contains the exact executable `receive` command for this message and
the rule to reply through the sender. This line is the recovery anchor when
model context has been compacted.

The sender gives a busy partner a short grace period, then delivers anyway.
Measured on Herdr 0.8.0, Claude accepts a mid-turn prompt atomically, while a
multi-line prompt to Codex still needs Enter. When the partner is still working,
the helper sends exactly one `agent prompt` with the header, control line, and
body, then runs the harmless Enter loop. It skips the visible-arrival check and
the full resend because that status has no reliable composer signal and a
resend may duplicate a queued body. Only `receive` proves the exact sequence in
`session.json`; without that ACK the receipt says the delivery is unproven.

For an idle partner, the helper proves landing from the composer: the composer
must first be seen to change, because a paste that never arrived and one already
submitted look identical; then it sends Enter until the composer releases the
text, performs one full resend, and fails loudly if delivery still cannot be
proved. The sequence ACK can recover an interruption immediately after
submission on either path.

- `receipt=acknowledged`: the partner ran `receive` for this message.
- `receipt=pending-partner-may-be-busy-do-not-retry`: the message landed and the
  partner is working, so it is queued but not acknowledged yet. Do not resend.
  Later run `node "$PAIR_SCRIPT" reconcile`; the status advances only after its
  ACK.
- `receipt=unproven-working-inspect-that-pane-then-reconcile`: the partner was
  working, received one prompt plus the Enter protection, but did not ACK before
  the deadline. The helper cannot distinguish a queued prompt from a silent
  drop. Do not resend while its reservation is pending; inspect after the agent
  settles, then reconcile or clear the proved-absent delivery before retrying.
- `receipt=lost-partner-idle-inspect-that-pane-then-reconcile`: the partner is
  idle and never acknowledged, so it did not receive the message. Read that
  pane, confirm the message is absent, and clear the pending delivery below.
  Long bodies are the usual cause; send those as a short message naming a file
  path.
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

## Reset and end

Use `node "$PAIR_SCRIPT" reset "${PAIR_ID[@]}"` only to clear work-cycle
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

Read [`workbench-tab.md`](workbench-tab.md) only when a separate tab is needed
for a long-running shared process.
