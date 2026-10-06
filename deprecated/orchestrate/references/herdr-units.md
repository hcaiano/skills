# Herdr units

Read when the user asks for visible executor panes (`--backend herdr` at
create) or a recorded unit's backend is `herdr`. Everything in `SKILL.md`
applies except where this file replaces it. A Herdr pane takes an exact model
ID or the CLI default, never `latest:<family>`, and runs its tab's own login,
so its partner is a CLI other than the lead's with no `--identity`.

## Create

The orchestrator session must run rooted in `REPO`: the caller pane proof binds
the live lead process to that repository, and `create` refuses a different root
and rolls back what it created. Read pair's
[`herdr.md`](../../pair/references/herdr.md), complete its caller pane proof
once, and keep the returned `CALLER_ID`. Append
`--backend herdr "${CALLER_ID[@]}"` to the create command. Omit `--effort` for
an OpenCode partner; its TUI has no variant flag.

The helper records that caller identity, spawns one visible partner pane in the
unit worktree with `--autonomy full`, initializes its session, and sends the
first task through Herdr. A CLI startup prompt can still stop the new pane:
read the exact recorded partner pane and answer its update or directory-trust
prompt with keys, as `herdr.md` specifies. The unit owns the session; closing
the pane stays manual, including after dismantle.

## Monitor

Headless `wait` and receipt deadlines do not apply. `unit status` routes
through the recorded Herdr pair and reconciles its sequence ACKs. Read
`observed.pair.delivery`, `session_active`, `in_flight`, `inbound_pending`, and
the visible executor pane. `in_flight` is only the lead's outbound turn;
`inbound_pending` lists messages the lead must receive. `session_active` is the
active flag of a verified Herdr session, not headless `session_known`. Process
inbound control lines and send later turns only with pair's Herdr helper, as
`herdr.md` specifies. If a CLI startup prompt blocks the executor, answer it
with keys in that exact recorded pane.

A Herdr task advances to `working` only after `receipt=acknowledged`. A lost,
pending, or unproved send keeps the unit in its recovery phase and records
`delivery_receipt` and the delivery reservation. Inspect the exact pane. If the
message is absent, use pair's explicit `reconcile --clear-pending true` path,
then repeat the matching unit command.

## Re-pin after a lead restart

A lead with a new terminal identity runs the caller pane proof again and
re-pins each Herdr unit before status, restaff, or dismantle:

```bash
node "$UNIT" repin --repo "$REPO" --unit <id> "${CALLER_ID[@]}"
```

The command compares the previous identity, updates the pair session, and
journals the change.

## Recovery

- A failed spawn closes its new split and rolls back the unit journal. Once
  spawn returns a pane, the helper records it before it validates the response
  or starts the session; a later failure keeps the journal, worktree, and pane
  id for a matching create retry with the same `CALLER_ID`. If that pane is no
  longer available, spawn can supply a replacement, and the helper records the
  old and new pane ids before it continues.
- Restaff of a session whose partner pane is proved absent or stale uses pair's
  stale end and records the recovery before it starts the replacement.
- Forced dismantle records a proved missing session or uses pair's
  `--stale true` end for a dead partner pane. A pane recorded before session
  init is still an outstanding resource; cleanup reports its pane id and leaves
  pane closure to the user.
