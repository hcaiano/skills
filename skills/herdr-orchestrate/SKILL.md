---
name: herdr-orchestrate
description: "Manual-only orchestrator for delegating GitHub issues to agent pairs in dedicated Herdr tabs: triage, work units, worktree + pair per unit, implement → ship-it, status on demand."
disable-model-invocation: true
user-invocable: true
argument-hint: "[issue numbers | gh filters]"
---

# Herdr Orchestrate

A **work unit** is the atom of delegation: one worktree, one Herdr tab, one
agent pair, one PR. A unit holds one issue by default, or several issues that
belong together and ship as a single PR. This skill finds free issues, splits
them into units with the user, sets each unit up, and kicks it off; the user
then reviews and interjects per tab.

For herdr CLI mechanics — command syntax, IDs, JSON output — follow the
`herdr` skill installed alongside this one: print the relevant command group
(`herdr tab`, `herdr agent`, `herdr wait`) instead of guessing flags, and
read identifiers from command responses.

Talk to the user in their current language. Keep commands, paths, branch
names, and issue references literal.

## Preconditions

- `herdr` and `gh` on `PATH`, `HERDR_ENV=1`, and `HERDR_PANE_ID` set (the
  orchestrator must run inside Herdr). If missing, stop and say so.
- Run from the project repository (or `cd` to the repo the user names).
- Record the orchestrator's own location once (`herdr pane current`): its
  `workspace_id` and agent target are used throughout.

## Guardrails

1. The recorded `workspace_id` is this skill's entire world. Other Herdr
   workspaces belong to unrelated projects: never list, read, wait on, send
   to, or create anything in them. Scope every command with `--workspace`
   where the flag exists; where it doesn't (e.g. `herdr agent list`), filter
   the output to the recorded `workspace_id` before acting on any row.
2. One work unit per tab; address only panes this run created.
3. Delegation ends at kickoff: reviewing diffs, answering delegate questions,
   and merging belong to the user.
4. The delegate's `herdr-pair` run owns the pair protocol. Start the pair's
   two agents yourself at the unit's effort — `herdr-pair` adopts an existing
   peer and only spawns (at default effort) when one is missing.
5. The project's own tooling (worktree script, triage skill, implement skill)
   outranks any generic fallback in this file.
6. A failed unit stops at the failed step: clean up only what this run created
   for it, report, and continue with the remaining units.

## Phase 0 — Survey (every invocation)

The live Herdr session is the registry; unit tabs are recognizable by their
`#N`-prefixed labels, so a fresh orchestrator — new session, lost context —
recovers the full picture from it instead of from memory.

List the workspace's tabs and agents (`herdr tab list --workspace <id>`;
`herdr agent list` filtered to the recorded workspace per guardrail 1).
For each `#N`-labeled tab, note its issues, branch, agent states
(working / blocked / idle), and any open PR for its branch (`gh pr list`).

Then branch on the input:

- **Status** — "how are things going", "what needs me": jump to
  [Status report](#status-report).
- **Unit report** — input starting with `[unit`: jump to
  [Unit reports](#unit-reports). Reports name this skill; if one arrives
  when this skill is not in context, re-invoking it lands here.
- **Delegation** — continue with triage; in-flight issues are already taken.

## Phase 1 — Triage

Goal: a short list of issues with nothing blocking an agent from starting.

1. If the project has its own triage skill, use it for the analysis and skip
   to presenting.
2. Otherwise list candidates with
   `gh issue list --state open --json number,title,labels,assignees,url` and
   exclude blocked issues: labels like `blocked`/`on hold`; body or comments
   saying `blocked by #N` / `depends on #N` where `#N` is still open; native
   blocked-by relations if the repo uses them. Respect any filters passed as
   arguments.
3. Cross-check against the phase 0 in-flight map: an issue already in a unit
   tab is taken, not free — list it separately with its tab label.
4. Present a table — number, title, why it is free — and stop.

Done when the user has named the issues to delegate.

## Phase 2 — Group into work units

Read the selected issues' bodies
(`gh issue view N --json number,title,body,url`) and propose the split into
work units. Parallel isolation is the default; grouping needs a positive
reason:

- the issues touch the same files, package, or feature area, so parallel
  worktrees would collide or produce conflicting PRs;
- one is a follow-up, sub-task, or direct dependency of another in the
  selection (`part of #N`, `follow-up to #N`, same tracking issue/epic);
- they are trivial fixes in one area that would be noise as separate PRs.

A unit stays small enough to ship as one reviewable PR while the other tabs
run in parallel. When unsure, ask the user rather than guessing.

Grade each unit's **effort** — the reasoning level both its agents will run
at — from what the issues demand:

- `low` — mechanical change with an obvious diff: copy tweak, config value,
  straightforward rename.
- `medium` — routine feature or fix on an established pattern in one area.
- `high` — cross-cutting change, ambiguous spec, or unfamiliar subsystem.
- `xhigh` — architectural or algorithmic work where wrong turns are
  expensive.

Present the proposed split — one line per unit: issues, one-line rationale,
proposed branch name, effort — and stop.

Done when the user has approved a split and each unit's effort; their
regrouping and regrading win.

## Phase 3 — Delegate (per approved work unit)

Run the steps below for each unit. Report per-unit progress briefly. If an
approved issue turns out to already live in an in-flight tab, point the user
at that tab instead of creating a second unit for it.

1. **Branch.** Derive the name from the repo's convention (recent branches
   via `git branch -r --sort=-committerdate | head`); default
   `feat/N-short-slug` for a single issue, or a slug naming the shared theme
   for a multi-issue unit (e.g. `feat/notifications-cleanup`).
2. **Worktree via the project's pipeline.** In order of preference, from the
   repo root: the repo's worktree script (e.g. `bin/worktree-create <branch>`
   or a `worktree` script in `package.json` / justfile / Makefile); fallback
   only: `git worktree add`. Resolve the resulting path with
   `git worktree list --porcelain`. If the pipeline fails (deps, env), the
   unit fails here — hand the agent a fully set-up worktree or none.
3. **Tab and pair.** Create a tab in the recorded workspace with
   cwd = the worktree, without stealing focus. Label it so the user can tell
   the tabs apart at a glance while monitoring: the issue number plus a
   two-to-three-word gist of the work, e.g. `#142 login redirect` or
   `#88 rate limiter` (multi-issue: `#N+#M <shared theme>`, e.g.
   `#12+#15 notifications cleanup`). Not the issue's full title. Start both
   agents in that tab
   via herdr, each with the unit's effort in its argv:

   ```bash
   claude --effort <tier>
   codex -c model_reasoning_effort="<tier>"
   ```

   The lead is the same CLI you are running as (the one proven installed and
   authenticated); the other is its peer, in a split pane (guardrail 4).
   Wait until both report idle.
4. **Kickoff.** Fill the orchestrator target with your own agent target
   (recorded in the preconditions). Send the message below to the lead, then
   read the pane back; if the text sits unsubmitted in the composer, submit
   it (enter). The unit is live when the lead reports working.

### Kickoff message template

Fill every placeholder. Include the full body of every issue in the unit so
the delegate never depends on `gh` mid-flight; state the implementation order
when it matters.

```text
You are the lead agent for this work unit in a dedicated Herdr tab.
Issues in this unit: <#N[, #M, ...]> — implement them all on this branch and
ship them together as ONE PR that closes each of them.
Worktree: <path> (branch <branch>, already set up: deps and env installed).
Orchestrator: report milestones to it with
  herdr agent send <orchestrator target> "[unit <label>] <kind>: <one line>"
where <kind> is ready (pair accepted the work), shipped (PR URL, CI state),
or blocked (the decision you need). If a send fails, state the same line in
your own pane instead — the orchestrator's survey will find it.

1. Run the herdr-pair skill to pair with the peer already running in this
   tab.
2. Implement the issue(s) with the project's implement skill, coordinating
   through the pair protocol (write leases, review, ready/accepted).
   <For multi-issue units: suggested order and why, if ordering matters.>
3. When the pair accepts the work, report ready and wait for the
   orchestrator's go-ahead.
4. On go-ahead, run the ship-it skill to open the PR (reference every issue:
   "Closes #N, closes #M"), wait for green CI, then report shipped. Merging
   stays with the user.
5. If you need a user decision, report blocked and wait — the user reads this
   tab directly.

Issue #<N>: <title>
<url>

<full issue body>

<repeat the block above for each additional issue in the unit>
```

## Phase 4 — Report and monitor

1. After the last kickoff, summarize for the user: one line per unit — tab
   label, issues, branch, worktree path, effort, agent target, status.
2. End the turn after the summary: delegates push their milestones back as
   [unit reports](#unit-reports), so there is nothing to poll. Active
   watching (`herdr wait agent-status` on the delegate panes) is a fallback
   for when the user asks to be watched over.

Done when every approved unit is live in its own tab and the user has the
summary, or each failed unit has a per-unit failure report naming the failed
step.

## Unit reports

Delegates push milestones as input lines starting with `[unit <label>]`.
On receiving one, confirm the label matches an in-flight unit in this
workspace (run a fresh phase 0 survey if the map is stale or missing), then
act by kind:

- `ready` — the pair accepted the work. Reply with the go-ahead
  (`herdr agent send <lead> "..."`): run the ship-it skill, then report
  shipped. Tell the user the unit is shipping.
- `shipped` — record the PR URL and CI state; tell the user it is ready for
  their review and merge decision.
- `blocked` — read the unit's pane, and surface the tab and the exact
  decision to the user.

When the last in-flight unit reports shipped, give the user the final
per-unit summary.

Done when the report is acted on and the user has the one-line update.

## Status report

Answer "how are things going" from the phase 0 map so the user never has to
tour the tabs. Lead with what needs them, then the rest:

1. **Needs you** — units whose agents report `blocked`, or whose panes show a
   question waiting. Read those panes (`herdr agent read`) and quote the
   decision being asked.
2. **Working** — one line each: what the pane output shows the pair is doing.
3. **Shipped / idle** — units with an open PR (CI state via `gh pr checks`)
   or both agents idle with no PR; flag idle-without-PR as possibly stalled
   and read the pane to say why.

Done when every in-flight unit appears in exactly one of the three buckets
and each "needs you" entry names the tab and the decision it waits on.
