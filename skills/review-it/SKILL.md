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
- `panel`: security, auth, permissions, payments, migrations, destructive data,
  infrastructure, concurrency, public contracts, cross-subsystem changes,
  ambiguous requirements, or unbounded impact.

When unsure, grade up. A grade the user gives is a floor. `skip` goes straight
to the receipt.

## 3. Review

`single`: one reviewer from the `interrogate reviewers` line of
`pstack-models.md`, resolved with `t3-capacity` as one tier per model in this
order: the lead models of the first two seats (Opus and Sol), then every
other model on the line in line order. When only one of those two families
wrote the change, the other family's lead model goes first. The brief
carries the absolute path of the [review brief](references/review-brief.md), the
worktree, the pinned range, the intent and acceptance criteria, and the paths of
any spec, issue and repo instruction files.

`panel`: run `interrogate` on the pinned range with the same intent; its Act On
findings are the findings. Add one seat from the `high-risk extra reviewer`
line only for a one-way door, or a change to security, auth, payments or
stored data.

Effort follows the grade: `panel` seats run at `xhigh`; `single` reviewers and
confirmation reviews run at `high`.

Staff every reviewer, `panel` seats and the confirmation review included, through
`delegate_task` in runtime mode `full-access` with the read-only brief: a
headless run has nobody to approve it. Every seat comes from the `interrogate
reviewers` line, except the high-risk extra seat from its own line: those are
the strongest models the user pays for. Authorship
only orders the two lead models, so a reviewer from the author's family is a
normal review. When every model on the line is out of capacity, report a
blocker. Where `delegate_task` is unavailable, as in a subagent
(`parent_not_active`), hand the pinned range back to the parent as a blocker.

A review counts once it returns a substantive verdict on the pinned HEAD; restaff
refusals, quota errors and empty results. Watch every seat for a _stalled_ run as
`~/.agents/skills/poteto-mode/references/t3-execution.md` describes: a stalled
seat's final verdict counts as its review. A material finding or a `panel` risk
promotes `single` to `panel`.

## 4. Fix

Verify and deduplicate the findings, then apply the valid in-scope ones,
structural simplifications included, in one batch. Out-of-scope ideas become
follow-ups. New contracts, architecture changes or fixes that roughly double
the diff go to the user. Rerun the affected checks and commit.

When fixes landed, run one confirmation review at `high`: a new reviewer,
chosen like `single` with the authors of the fixes in place of the change's
authors, reads only the fix range (the reviewed head to the new HEAD) with the
prior findings. Apply, check and commit its valid findings; each one counts as
`open` in the receipt, because no reviewer saw its fix, and goes to the user. A
PR gets these two rounds and no more.

## 5. Receipt

Return this line for `write-pr`'s Review section, plus any blocker and its next
step. `land-it` parses it, so keep its exact shape. `rejected` counts findings
the reviewers raised and the authors declined; `open` counts findings handed
to the user, blockers and seats that never returned a verdict; `reviewed`
names the head and base branch the last round saw:

`**Review.** <skip | single | panel> by <models>; <n> fixed, <n> rejected, <n> open; reviewed <short SHA> on <base branch>`
