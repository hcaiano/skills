# Herdr backend

Pair two agents — any two of `claude`, `codex`, `cursor`, `grok`, and
`opencode`, never
twice the same kind — in one Herdr tab. A lead pane may hold several such
pairs at once, each its own `sid`-scoped session. The user can read and interject in
either pane. The protocol, kinds, write leases, broken-checkout announcements,
and work cycles are in [`SKILL.md`](../SKILL.md); this file owns the transport.

## Preconditions

Set `SKILL_DIR` to this skill directory and
`PAIR_SCRIPT="$SKILL_DIR/scripts/herdr-pair.mjs"`. Always use that absolute
path; the project cwd is unrelated to the installed skill path.

Require `herdr` with the agent automation commands (`herdr agent start`,
`herdr agent prompt`), `jq`, and `trash` on `PATH`, plus `HERDR_ENV=1`. If
any is missing, stop and tell the user to install or start (or update) Herdr.

Before any Herdr mutation, read and execute the
[`caller pane proof`](caller-pane-resolution.md), running this skill's
`scripts/caller-proof.mjs` helper. It resolves the explicit task repository,
proves the unique caller from its own process ancestry — falling back to
conversation markers when that ancestry matches anything other than exactly one
pane — and returns `CALLER_PROOF` plus the pinned `CALLER_ID`, including
`--tab-id`. Stop when that proof does not complete exactly.

## Guardrails

1. Scope every pane operation to the transcript-proven `workspace_id`,
   `tab_id`, `pane_id`, agent kind, terminal identity, and repository. Never
   address a pane discovered only by workspace, focus, label, cwd, direction,
   session metadata, or pane number.
   An orchestrated executor may use a different recorded repository root from
   its lead. Keep each participant on its own exact root.
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
   `node "$PAIR_SCRIPT" discover "${CALLER_ID[@]}"`. It reports you, the tab's
   candidate partner panes, and every pair this tab already runs — each `sid`
   with its partner kind and pane. Resume an existing pair as it is, whatever
   kind it runs, and never respawn to change its model. For a partner that does
   not exist yet, ask the user for partner, model, and effort as `SKILL.md`
   describes, then run once:

   ```bash
   node "$PAIR_SCRIPT" spawn "${CALLER_ID[@]}" --partner "$PARTNER" \
     [--partner-repo-root <executor-worktree>] \
     [--model "$MODEL"] [--effort "$EFFORT"] [--autonomy full]
   ```

   The model and effort reach the new pane as the partner CLI's own arguments
   after `--`, which only a pane being created can take. OpenCode's TUI accepts
   `-m <provider/model>`, but it does not expose the headless `--variant` flag;
   an OpenCode Herdr spawn therefore refuses `--effort`. `--autonomy full`
   launches the partner past its permission prompts (each CLI through its own
   flag) — required for an unattended run, since a pane has no per-turn
   permission switch. The spawn retries a still-starting shell and closes its
   own split pane on failure. Stop on spawn failure.

   `--partner-repo-root` keeps the caller pinned to `CALLER_ID` while it starts
   the executor in a different unit worktree. Omit it for an ordinary pair in
   one repository.

   A new pane can pause at its CLI's own startup prompt. Observed prompts
   include a Codex self-update restart and Codex or Cursor directory trust.
   Read that exact pane and answer the prompt with keys, then continue after
   the CLI reaches its agent session. Startup control is separate from partner
   traffic.

   One lead pane may hold several pairs at once — one session per partner pane.
   Spawn once per partner and record the pane id it prints; every later command
   names the pair it means.
2. Run `node "$PAIR_SCRIPT" init "${CALLER_ID[@]}"
   [--partner-pane <pane_id>] [--partner-repo-root <executor-worktree>]
   [--model "$MODEL"] [--effort "$EFFORT"] [--role peer|executor]`. Pass the
   same partner root, model, and effort that the spawn used. The session records
   them. It creates a session for that partner pane, or idempotently resumes the
   exact live one. Name
   `--partner-pane` for every pair after the first; with one unpaired candidate
   in the tab it is optional. Run init directly to resume — an established
   session resumes through its recorded panes, so a `discover` first is neither
   needed nor required to succeed. The role is recorded and
   contractual here — Herdr panes hold no per-turn permission switch, so an
   `executor` partner holds the write leases because the protocol says so
   (spawn with `--autonomy full` when the partner must also clear its own
   CLI's permission prompts unattended).
   A session written before the universal pair schema is refused with the exact
   `end … --stale true` command that clears it; there is no migration.
   Record its exact `sid` as `PAIR_SID`. Every command binds to it, which is
   both what keeps a lead's concurrent pairs apart and what stops a wrong
   same-kind pane borrowing another session. `verify`, `reconcile`, `reset`,
   `nudge`, and `watch` take `--sid` too, and require it once the tab holds
   more than one pair.
3. Send the first `task` through the helper, splitting scopes and write leases
   as `SKILL.md` describes.

Done when the exact tab has one verified session and the first task has a
recorded receipt. Skill reload and compaction always resume that session.

## Send

Write only the body to a temp file, then invoke:

```bash
BODY=$(mktemp); trap 'trash "$BODY"' EXIT
# Write the partner message body to "$BODY".
node "$PAIR_SCRIPT" send "${CALLER_ID[@]}" --sid "$PAIR_SID" \
  --kind "$KIND" --body-file "$BODY"
```

The helper injects the `[herdr-pair control seq=<n>: ...]` line under the
header. It contains the exact executable `receive` command for this message and
the rule to reply through the sender. This line is the recovery anchor when
model context has been compacted.

The sender gives a busy partner a short grace period, then delivers anyway.
Measured on Herdr 0.8.0, Claude accepts a mid-turn prompt atomically, while a
multi-line prompt to Codex still needs Enter. Cursor, Grok, and OpenCode are
unmeasured here and take the conservative Codex-shaped path: one prompt, the
Enter protection, and proof only from the `receive` ACK. When the partner is still working,
the helper sends exactly one `agent prompt` with the header,
control line, and body, then runs the harmless Enter loop. It skips the visible-arrival check and
the full resend because that status has no reliable
composer signal and a resend may duplicate a queued body. Only `receive`
proves the exact sequence in the pair's own session file; without that ACK the
receipt says the delivery is unproven.

For an idle partner, the helper proves landing from the composer: the composer
must first be seen to change, because a paste that never arrived and one already
submitted look identical; then it sends Enter until the composer releases the
text, performs one full resend, and fails loudly if delivery still cannot be
proved. The sequence ACK can recover an interruption immediately after
submission on either path.

- `receipt=acknowledged`: the partner ran `receive` for this message.
- `receipt=pending-partner-may-be-busy-do-not-retry`: the message landed and the
  partner is working, so it is queued but not acknowledged yet. Do not resend.
  Later run `node "$PAIR_SCRIPT" reconcile "${CALLER_ID[@]}" --sid "$PAIR_SID"`;
  the status advances only after its ACK.
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
node "$PAIR_SCRIPT" reconcile "${CALLER_ID[@]}" --sid "<sid>" \
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

Use `node "$PAIR_SCRIPT" reset "${CALLER_ID[@]}" --sid "$PAIR_SID"` only to clear work-cycle
counters/statuses in a verified live pair; it preserves identity and delivery
history.

End and trash the session only when the user explicitly asks to end the pair:

```bash
node "$PAIR_SCRIPT" end "${CALLER_ID[@]}" --sid "<sid>"
```

The script verifies sid, workspace, tab, and participants itself, and
refuses while delivery is pending (wait for the ACK or use the inspected
clear path). If old pane IDs or a missing partner prevent resume, explain
the mismatch and use `end "${CALLER_ID[@]}" --sid "<sid>" --stale true` only
with explicit user approval — a stale end may discard pending state only
when the partner pane is gone, its recorded binding is stale, or its
foreground agent process/repository no longer matches. Closing the Herdr tab
ends the panes naturally; stale state is never borrowed by another pair or
tab. Ending one pair leaves the tab's other pairs running.

## Workbench tab

Read [`workbench-tab.md`](workbench-tab.md) only when a separate tab is needed
for a long-running shared process.
