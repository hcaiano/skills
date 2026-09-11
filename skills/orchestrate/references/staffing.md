# Staffing

Read before every wave and restaff. Pair's
[`models.md`](../../pair/references/models.md) owns family selection, current
roles, effort and catalog resolution. This file owns orchestration capacity and
the decision record. Preserve the user's explicit model choices and current
repository instructions over older preference tables.

## Decide

Match model intelligence to task difficulty. Joint planning uses Fable and Astra.
Execution receives the accepted plan and required evidence. Choose a family
that meets the scope and risk bar, then a working harness and an available
account. Balance equal-bar work across subscriptions; Grok is eligible for
bounded simple tasks instead of waiting for every premium pool to be exhausted.
Reserve strong-model capacity for review, corrections and ambiguous decisions.
Available quota never lowers the required proof or authorizes more work.

Use the family's latest supported version for a new session and preserve the
resolved model for an existing one. Record both the requested family/alias and
the resolved model reported by Pair. An unknown catalog is not permission to
invent a model ID or substitute another family. Explicit version pins remain
valid when Henrique requests them.
Use `--backend headless` for `latest:<family>` and named Codex identities,
even when the lead runs in Herdr; that backend does not yet resolve these inputs.

## Read capacity and choose an account

```bash
node <orchestrate-dir>/scripts/usage-state.mjs --live
```

The default invocation reads local snapshots and both monthly Cursor pools.
`--live` additionally queries Codex's read-only `account/rateLimits/read` for
each existing home; it starts no model turn. It retains the legacy `codex` key
and adds `codex_identities`: `default` from `~/.codex` and named homes under
`~/.codex-profiles/<name>`. Each entry reports canonical `home`, `pool`, `source`
and `state`. Symlink aliases to one home are deduplicated. These are configured
login homes, not Codex's `--profile` configuration layers. The helper neither
creates homes nor copies credentials. Confirm a discovered home belongs to the
intended user/account before first use.

`recommended_codex_identity` ranks available readings by lower pace, then lower
used percentage. This is a capacity hint: the selected account must also expose
the chosen model, and the active lead account may be ineligible as its own
partner. The recommendation does not reserve quota. Recheck before the next wave.

An account is unavailable at 90% weekly or short-window use, protected when
`pace > 1`, and unknown when usable evidence is absent or over 15 minutes old.
Stale protected/unavailable readings remain a floor; failed live reads never
promote an old reading to current availability. A null reading is unknown, not
zero usage. Ask before spending protected capacity; a refusal or rate limit
requires a different eligible account or a blocked result.

Every headless Codex turn receipt carries `rate_limits`, the same reading
taken right after the turn, and `throttle_signals` when the transcript showed
rate-limit or retry lines. Read them in the `status --all` round; a pool that
crossed into protected or unavailable during a wave moves the unit's next turn
to another eligible identity through restaff, not by waiting it out.

The devbox has one heavy-work slot. Every unit's validation serializes behind
it, and a queued turn is not stuck but is not progressing either. With the
default two active units expect one validating while the other waits; do not
admit a third unit whose validation is heavy, and stagger delivery turns so
at most one runs the full CI entrypoint at a time. The pair helper excludes
queued time from its budgets and shows it under `heavy_queue`; the wall
clock still adds up, so size the wave to the slot.

For headless Codex, pass `--identity <name>` to unit create/restaff. Pair pins
the selected home and reports it on resume/status. Existing sessions keep their
account; changing identity requires restaff with its checkpoint, not switching
login globally. Two homes do not prove two independent subscriptions: confirm
the account mapping once. A same-CLI partner requires an explicitly selected,
different Codex home (`default` is valid when the lead uses a named home).
Herdr does not yet support named account routing and must refuse it.

Claude's local usage timestamp can be stale. Grok has no local numeric quota
source here; a successful start is only evidence it can currently run, not a
claim of unlimited capacity. For Cursor, map the live model to
`cursor.cursor_models` or `cursor.other_models` and inspect that pool. If a
headless `cursor-agent` run proves that shell commands are rejected, use it for
consultation and read-only review. A Cursor pane on the Herdr backend keeps its
own permission plumbing; verify that lane separately.

## Record and restaff

Each unit records partner, account identity, requested model, resolved model
when proved, effort, timestamp and a one-line reason naming difficulty, role,
capacity evidence and any unavailable alternative. The registry and pair's
receipt own these facts; do not duplicate them in a parallel task database.

Restaff after refusal, rate limit or a proved capability miss. Keep normal
feedback on the current pair, then raise capability when a bounded correction
fails. Preserve the HEAD, worktree diff and receipt checkpoint. If neither the
required planning pair nor an adequate executor/reviewer is available, report
the exact blocker rather than silently dropping a required gate.
