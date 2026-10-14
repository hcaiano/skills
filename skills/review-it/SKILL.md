---
name: review-it
description: "Pre-PR review: grade a finished change by risk, have the strongest configured models review it, and fix the findings. Use before opening or updating a PR."
---

# Review it

## 1. Pin

Run the affected checks, commit everything including new files, fetch the
target branch, and pin `<merge-base with origin/<target>>..HEAD`. HEAD stays fixed while reviewers run.

Merging or rebasing the target branch into a reviewed branch changes no
reviewed code, so it needs no new review when the PR's own changes are
unchanged; `land-it` checks that by comparing trees. Review again only when the
PR's own changes moved.

Write down the intent and acceptance criteria, chat-only ones included, and the
model families that wrote the change, delegated workers included.

## 2. Grade

- `skip`: only docs, comments or copy; no code that runs and no agent
  instructions.
- `panel`: the change touches security, auth, permissions, payments,
  migrations or destructive data, or it is a one-way door (a public contract or
  stored format that is hard to revert).
- `single`: every other change, however many files or subsystems it touches.

A grade the user gives is a floor. `skip` goes straight to the receipt.

## 3. Review

`single`: one reviewer at `high` from the `interrogate reviewers` line of
`pstack-models.md`, resolved with `t3-capacity` as one tier per model in line
order, with a lead model that did not write the change first.
The brief carries the absolute path of the [review brief](references/review-brief.md),
the worktree, the pinned range, the intent and acceptance criteria, and the
paths of any spec, issue and repo instruction files.

`panel`: run `interrogate` on the pinned range with the same intent, its seats
at `xhigh`; its Act On findings are the findings.

Staff every reviewer through `delegate_task` in runtime mode `full-access` with
the read-only brief: a headless run has nobody to approve it. When every model
on the line is out of capacity, report a blocker. Where `delegate_task` is
unavailable, as in a subagent (`parent_not_active`), hand the pinned range back
to the parent as a blocker. After staffing, end the turn; the completion
notification wakes you.

A review counts once it returns a substantive verdict on the pinned HEAD; restaff
refusals, quota errors and empty results. Watch every seat for a _stalled_ run as
`~/.agents/skills/poteto-mode/references/t3-execution.md` describes: a stalled
seat's final verdict counts as its review. A finding that names a concrete
failure in a `panel` category, or a race or compatibility break with a real
consequence, promotes `single` to `panel`.

## 4. Fix

Verify and deduplicate the findings, then apply the valid in-scope ones,
structural simplifications included, in one batch. Out-of-scope ideas become
follow-ups. New contracts, architecture changes or fixes that roughly double
the diff go to the user. Rerun the affected checks and commit.

Check every fix yourself against its finding. Run a confirmation review only
when a fix changed behaviour beyond what its finding named: one new reviewer at
`high`, chosen like `single` with the authors of the fixes in place of the
change's authors, reads only the fix range (the last reviewed head to the new
HEAD) with the prior findings. Apply, check and commit its valid findings. After
that one confirmation, or for a finding that needs a new design, the remaining
findings count as `open` and go to the user. A PR gets one full review;
confirmations only read fixes.

## 5. Receipt

Return this line for `write-pr`'s Review section, plus any blocker and its next
step. `land-it` parses it, so keep its exact shape. `rejected` counts findings
the reviewers raised and the authors declined; `open` counts findings handed
to the user, blockers and seats that never returned a verdict; `reviewed`
names the head and base branch the last round saw:

`**Review.** <skip | single | panel> by <models>; <n> fixed, <n> rejected, <n> open; reviewed <short SHA> on <base branch>`
