---
name: review-it
description: "Pre-PR review: grade a finished change by risk, have the strongest configured models review it, and fix the findings. Use before opening or updating a PR."
---

# Review it

## 1. Pin

Run the affected checks, commit everything including new files, fetch the
target branch, and pin `<merge-base with origin/<target>>..HEAD`. HEAD stays fixed while reviewers run.

Write down the intent and acceptance criteria, chat-only ones included, and the
model families that wrote the change, delegated workers included.

## 2. Grade

- `skip`: only docs, comments or copy; no code that runs and no agent
  instructions.
- `single`: any other change bounded to one subsystem.
- `dual`: security, auth, permissions, payments, migrations, destructive data,
  infrastructure, concurrency, public contracts, cross-subsystem changes,
  ambiguous requirements, or unbounded impact.

When unsure, grade up. A grade the user gives is a floor. `skip` goes straight
to the receipt.

## 3. Review

`single`: one reviewer from the first two seats of the `interrogate reviewers`
line of `pstack-models.md` (the strongest Claude and GPT models), resolved with
`t3-capacity`. When only one of those two families wrote the change, take the
other family's seat; otherwise take the first seat with capacity. The brief
carries the absolute path of the [review brief](references/review-brief.md), the
worktree, the pinned range, the intent and acceptance criteria, and the paths of
any spec, issue and repo instruction files.

`dual`: run `interrogate` on the pinned range with the same intent; its Act On
findings are the findings.

Staff every reviewer, `dual` seats and the final review included, through
`delegate_task` in runtime mode `full-access` with the read-only brief: a
headless run has nobody to approve it. Every seat comes from the `interrogate
reviewers` line, in its order: those are the strongest models the user pays
for. Authorship only picks between seats of equal strength, so a reviewer from
the author's family is a normal review. When the first two seats are out of
capacity, take the next seat down the line; when every seat is out, report a
blocker. Where `delegate_task` is unavailable, as in a subagent
(`parent_not_active`), hand the pinned range back to the parent as a blocker.

A review counts once it returns a substantive verdict on the pinned HEAD; restaff
refusals, quota errors and empty results. A material finding or a `dual` risk
promotes `single` to `dual`.

## 4. Fix

Verify and deduplicate the findings, then apply the valid in-scope ones,
structural simplifications included, in one batch. Out-of-scope ideas become
follow-ups. New contracts, architecture changes or fixes that roughly double
the diff go to the user. Rerun the affected checks and commit.

When the fixes change behavior, scope, security or architecture, run one final
review: a new reviewer from the first two seats on the new HEAD with the prior
findings, taking the seat whose family wrote none of the fixes when there is
one. Apply, check and commit its valid findings; anything needing another such
change goes to the user.

## 5. Receipt

Return this line for `write-pr`'s Review section, plus any blocker and its next
step:

`**Review.** <skip | single | dual> by <models>; <n> fixed, <n> rejected; reviewed <short SHA>`
