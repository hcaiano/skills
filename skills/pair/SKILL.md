---
name: pair
description: "Persistent Claude-Codex pairing, in a Herdr tab or headless outside it. Use for live peer work, workflows requesting a pair, any inbound `[agent ...]` / `[herdr-pair control ...]` line, resuming a pair after context compaction, or pairing with the opposite model when Herdr is absent."
---

# Pair

Pair Claude and Codex as equals on one task. Keep the pair and its `sid` alive
across tasks, accepted work cycles, and context compaction. Keep protocol
headers and identifiers literal.

Two backends carry the same protocol. Inside Herdr the partner is a visible
pane the user can read and interject in; outside it the partner is a persistent
headless session of the opposite CLI.

## Choose the backend

Read one backend reference in full and follow it:

- `HERDR_ENV=1` and `herdr` on `PATH` → [Herdr backend](references/herdr.md).
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

The partners are equals: propose a scope split — one write lease per scope,
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

`blocked` and `stalemate` also hand off without deleting the session. End the
session only when the user explicitly asks to end the pair; the backend
reference owns that command.
