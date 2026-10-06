# Staffing

Read before every wave and restaff. Pair's
[roster](../../pair/references/models.md) owns families, seats, effort, pools,
and pool states; this file owns what orchestrate does with them. Henrique's
explicit model choices and current repository instructions win over both.

## Choose the seat

Staff the roster's
[planning seat](../../pair/references/models.md#planning-seat) for joint
planning, routed per lead in `SKILL.md`, and the
[executor seat](../../pair/references/models.md#executor-seat) for each unit,
following its [routing rules](../../pair/references/models.md#route-the-work).
A new unit requests its family as `--model latest:<family>`; a live unit keeps
the model it resolved. Record the requested form and the resolved model that
pair reports; explicit version pins stand when Henrique requests them.

## Read capacity

```bash
node <pair-dir>/scripts/usage-state.mjs
```

The roster's [pool rules](../../pair/references/models.md#pools) say what
each state allows. Orchestrate adds these actions:

- Recheck before every wave. `recommended_codex_identity` is a hint, not a
  reservation: the account must also expose the chosen model.
- Read each headless Codex receipt's `rate_limits` and `throttle_signals` in
  the `status --all` round. A pool that turns `protected` or `unavailable`
  mid-wave moves the unit's next turn to another eligible identity through
  restaff.

## Codex identities

Pass `--identity <name>` to `unit create` and `restaff` for a headless Codex
partner: `<name>` selects the existing account home
`~/.codex-profiles/<name>`, and `default` selects `~/.codex`. Pair pins that
home and reports it on status. A live session keeps its account, so changing
identity is a restaff with its checkpoint, never a global login switch. Confirm once that a discovered home
belongs to the intended account; two homes do not prove two subscriptions, and
neither pair nor its capacity helper creates homes or copies credentials.

A Codex lead's Codex partner runs on a home other than the lead's: a named home
when the lead runs `~/.codex`, or `default` when the lead runs a named home.
With no second home, `--identity` refuses; staff another harness's seat for a
unit, and report the Astra planning seat blocked.

## Cursor executors

A headless `cursor-agent` run that proves shell commands are rejected staffs
only consultation and read-only review, never implementation. A Cursor pane on
the Herdr backend keeps its own permission plumbing; verify that lane
separately.

## Record

Each unit records partner, account identity, requested model, resolved model
when proved, effort, timestamp, and a one-line reason naming difficulty, role,
capacity evidence, and any unavailable alternative. The registry and pair's
receipt own these facts; keep no parallel task database. When no eligible seat
remains for a unit or a required gate, report the exact blocker and hold that
work until it clears.
