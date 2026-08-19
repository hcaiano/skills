---
name: pair
description: "Persistent two-agent pairing across claude, codex, cursor, and grok, in a Herdr tab or headless outside it. Use for live peer work, workflows requesting a pair, any inbound `[agent ...]` / `[herdr-pair control ...]` line, resuming a pair after context compaction, or pairing with another CLI when Herdr is absent."
---

# Pair

Pair two agents on one task: you are the **lead**, and the partner is one of
`claude`, `codex`, `cursor`, or `grok` — any of them except the CLI you are
already running, because two panes of one CLI echo rather than review. Keep the
pair and its `sid` alive across tasks, accepted work cycles, and context
compaction, naming its `sid` in every command — one lead can run several
pairs at once. Keep protocol headers and identifiers literal.

Two backends carry the same protocol. Inside Herdr the partner is a visible
pane the user can read and interject in; outside it the partner is a persistent
headless session of the partner CLI.

## Choose the pair

Look for an existing pair before proposing one: a session recorded for this
Herdr tab, or a headless one in this repository (the backend reference names
the exact command). An existing pair is resumed as it is. When its partner, model,
or effort differs from what the user just asked for, say so and keep going —
respawning discards the pair's whole history, and a model is changed by ending
the pair, not by restarting its pane.

With no pair to resume, ask the user in plain chat text — no structured-question
tool needed — for three things, and start nothing until they answer:

- **Partner**: which of the four CLIs, other than yours.
- **Model**: `CLI default`, or any model name they name. When choosing a
  model, effort, or pool, read [`references/models.md`](references/models.md);
  it owns the risk, speed, context, catalog, and effort rubric. For a cursor
  partner run `cursor-agent --list-models`; for Grok run `grok models`; for the
  others take the user's answer as given.
- **Effort**: only for a partner that exposes it — Claude Code
  (`--effort low|medium|high|xhigh|max`), grok (`--reasoning-effort`), codex
  (`model_reasoning_effort`), or cursor (an `[effort=…]` suffix on the model
  name, so it needs a model too).

Then ask for the **role**, which sets who holds the write leases by default:

- `peer` (default): equals. Split scopes, one lease per scope, review each
  other's `ready`.
- `executor`: the partner holds the write leases and implements; you plan and
  review. Any individual `task` still redistributes leases.

The backend records partner, model, effort, and role in the session, so a
resumed pair keeps them without asking again.

## Choose the backend

Read one backend reference in full and follow it:

- `HERDR_ENV=1` → [Herdr backend](references/herdr.md). Its preconditions
  own the `herdr` CLI check: a Herdr environment missing the CLI stops there
  instead of falling through to a hidden headless session.
- Otherwise → [Headless backend](references/headless.md).

An inbound `[agent ...]` or `[herdr-pair control ...]` line always means the
Herdr backend, whatever else the environment looks like.

## Protocol

Messages start with a header:

```text
[agent <from> -> <to> kind=<kind> sid=<sid>]

<body>
```

The Herdr backend adds a `[herdr-pair control seq=<n>: ...]` line under it.

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

Send every partner message through the backend's helper. Reserve normal
assistant output for a header-free user handoff.

## Write leases

Give one agent the write lease for each file scope: owner, target files,
forbidden changes, validation, and stop point. The partner stays read-only on
that scope until handoff.

The role sets the opening distribution, and each `task` may redistribute from
there. Under `executor` the partner holds every lease until a task says
otherwise, and you review rather than edit.

Under `peer` the partners are equals: propose a scope split — one write lease per scope,
each partner implementing its own scopes and reviewing the other's `ready` —
and include enough context for independent work; the partner accepts or
counters before implementing. A task with no independent scopes takes one
lease: the holder drives while the partner reviews, and the lease alternates
across tasks.

## Broken-checkout windows

Announce every deliberate broken-checkout window. Before mutation testing,
bisect, or a deliberate revert, send a `task` naming the affected paths and
stop condition; send `ready` after the tree is restored and verified. Do not
wait for `accepted`: the notices are the protection. A partner that has seen
an open window treats that checkout's test results as unusable until the
close notice arrives, and asks rather than reports. Run an experiment that
cannot be announced, or that lasts more than a few minutes, in a separate
worktree.

## Work cycles and persistence

Continue while producing useful artifacts. Five consecutive turns with no new
code, test result, decision, or narrowed option require a `handoff`. Reset the
count on real progress. Settle a factual disagreement with one direct proof or
focused test before it can become a stalemate. Send `stalemate` after the same
judgment call repeats twice without movement.

Two `accepted` statuses complete one work cycle. The initiator gives the user a
local handoff naming the result, verification evidence, unresolved issues, and
every pair pane, worktree, or watcher still active. Both agents may idle; the
next task resumes the same pair and `sid`. The session remains active.

Session renewal is a user decision. If a fresh pair is chosen, carry continuity
in a written checkpoint in its first task.

`blocked` and `stalemate` also hand off without deleting the session. End the
session only when the user explicitly asks to end the pair; the backend
reference owns that command.
