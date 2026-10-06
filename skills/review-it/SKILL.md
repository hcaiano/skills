---
name: review-it
description: "Grade a finished change by risk, get it reviewed by other models through T3 Code, and fix the findings before a PR opens. Use before opening or updating any PR."
---

# Review it

This is the pre-PR review. It replaces the `interrogate` run that poteto-mode
asks for before a PR; `review-it` decides when the full panel is worth it.
Return a reviewed, committed change and a one-line receipt for the PR's Review
section. The caller owns push, PR, CI and merge.

## 1. Pin the range

Commit the change, including new files, then fetch `origin/<target-branch>`
and review `<merge-base>..HEAD`. Run the affected checks first. Keep HEAD
fixed while reviewers run.

Collect what the reviewers need: the intent and acceptance criteria in your
own words (chat-only requirements included), paths to any spec or issue, and
the model families that wrote the change, delegated workers included. Unknown
authorship counts as every family that may have written it.

## 2. Grade

Grade the actual diff, including agent behavior in instruction files:

- `skip`: low risk, with focused proof covering every changed behavior.
- `single`: a bounded runtime change within one subsystem.
- `dual`: security, auth, permissions, payments, migrations, destructive data,
  infrastructure, concurrency, public contracts, cross-subsystem changes,
  ambiguous requirements, or unbounded impact.

Weakening tests needs at least `single`. When unsure, grade up. A grade the
user gives is a floor. For `skip`, go to step 5.

## 3. Review

`single`: take the first seat in the `interrogate reviewers` line of
`pstack-models.md` that can resolve to a model family that did not write the
change. Resolve it with `t3-capacity`, as poteto-mode's
`references/t3-execution.md` describes, and check the family again after any
capacity fallback. With no other family available, report the capacity
blocker. Launch one `delegate_task` with `mode: "async"` and drain it with
`task_status`. The brief is self-contained: the absolute path of the
[review brief](references/review-brief.md), the worktree path, the pinned range
and HEAD, the intent and acceptance criteria, and the paths of the spec or
issue and the repo's instruction files.

`dual`: run the `interrogate` skill on the pinned range with the same intent.
Its Act On findings are the findings for step 4.

A review counts only when it returns substantive output on the pinned HEAD.
Retry or restaff refusals, quota errors and empty results. Promote `single` to
`dual` when the reviewer finds a material issue or a `dual` risk.

## 4. Fix

Verify and deduplicate findings. Apply valid, in-scope fixes in one batch,
including structural simplifications. Drop nits and keep out-of-scope ideas as
follow-ups. New contracts, architecture changes or fixes that roughly double
the diff need user direction. Rerun the affected checks and commit.

Run one more review only when the fixes change behavior, scope, security or
architecture: a new `delegate_task` on the new HEAD, carrying the prior
findings and the fixes. Apply its valid findings without a third round, then
rerun the affected checks and commit; stop for user direction if they need
another such change.

## 5. Receipt

Return this line for `write-pr`'s Review section, with blockers and their next
step when any remain:

`Review: <skip | single | dual> by <models>; <n> fixed, <n> rejected; reviewed <short SHA>`
