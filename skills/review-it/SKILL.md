---
name: review-it
description: "Grade a finished change by risk, get it reviewed by other models through T3 Code, and fix the findings before a PR opens. Use before opening or updating any PR."
---

# Review it

Return a reviewed, committed change and a one-line receipt for the PR's Review
section. The caller owns push, PR, CI and merge.

## 1. Pin the range

Fetch `origin/<target-branch>` and review `<merge-base>..HEAD`, or the working
tree when the change is uncommitted. Run the affected checks first. Keep HEAD
fixed while reviewers run.

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

Take seats from the `interrogate reviewers` line in `pstack-models.md`, in
order. `single` uses the first seat whose model family did not write the
change. `dual` adds the first other seat, in parallel; a fresh context on the
author's model still counts. Resolve each seat to an instance and model with
`t3-capacity`, as poteto-mode's `references/t3-execution.md` describes.

Launch one `delegate_task` per reviewer with `mode: "async"` and drain with
`task_status`. Each brief is self-contained: the absolute path of the
[review brief](references/review-brief.md), the worktree path, the pinned range
and HEAD, and the paths of the spec or issue and the repo's instruction files.

A review counts only when it returns substantive output on the pinned HEAD.
Retry or restaff refusals, quota errors and empty results. Promote `single` to
`dual` when a reviewer finds a material issue or a `dual` risk.

## 4. Fix

Verify and deduplicate findings. Apply valid, in-scope fixes in one batch,
including structural simplifications. Drop nits and keep out-of-scope ideas as
follow-ups. New contracts, architecture changes or fixes that roughly double
the diff need user direction.

Run one more review only when the fixes change behavior, scope, security or
architecture. It is a new `delegate_task` carrying the prior findings and the
new HEAD. Apply its valid findings without a third round; stop for user
direction if they need another such change. Rerun the affected checks and
commit.

## 5. Receipt

Return this line for `write-pr`'s Review section, with blockers and their next
step when any remain:

`Review: <skip | single | dual> by <models>; <n> fixed, <n> rejected; reviewed <short SHA>`
