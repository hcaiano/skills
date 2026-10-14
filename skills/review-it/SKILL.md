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
- `high`: you can name the concrete hazard: the diff changes how auth,
  permissions, payments, secrets, migrations or stored data behave, or a public
  contract or stored format that is hard to revert. A file in one of those areas
  whose behaviour stays the same is not a hazard.
- `standard`: every other change, however many files or subsystems it touches.

`standard` is the grade unless you can name a `high` hazard. A grade the user
gives is a floor. `skip` goes straight to the receipt. The grade sets reviewer
effort and whether `land-it` may merge without the user.

## 3. Review

Run `interrogate` once on the pinned range: two reviewers in parallel from the
`interrogate reviewers` line of `pstack-models.md`, resolved with
`t3-capacity`, starting with the seat whose lead model did not write the
change, each seat falling through its tiers when a model is out of capacity. Reviewers run at `high` for `standard` and `xhigh` for `high`. Every brief carries the intent and
acceptance criteria, the pinned range, the absolute path of the
[review brief](references/review-brief.md), the worktree, and the paths of any
spec, issue and repo instruction files. The Act On findings are the findings; a
Consider finding you do not apply counts as `open`, and a Dismissed one as
`rejected`, so the receipt shows every disagreement.

Staff every reviewer through `delegate_task` in runtime mode `full-access` with
the read-only brief: a headless run has nobody to approve it. When every model
on the line is out of capacity, report a blocker. Where `delegate_task` is
unavailable, as in a subagent (`parent_not_active`), hand the pinned range back
to the parent as a blocker. After staffing, end the turn; the completion
notifications wake you.

A review counts once it returns a substantive verdict on the pinned HEAD; restaff
refusals, quota errors and empty results. Watch every seat for a _stalled_ run as
`~/.agents/skills/poteto-mode/references/t3-execution.md` describes: a stalled
seat's final verdict counts as its review. A finding that names a concrete
`high` hazard raises the grade to `high` in the receipt, so the user merges; it
adds no review round.

## 4. Fix

Verify and deduplicate the findings, then apply the valid in-scope ones,
structural simplifications included, in one batch. Out-of-scope ideas become
follow-ups. New contracts, architecture changes or fixes that roughly double
the diff go to the user. Rerun the affected checks and commit.

Check every fix yourself against its finding and commit it. Run a confirmation review only
when a fix changed behaviour beyond what its finding named: one new reviewer at
`high` from the `interrogate reviewers` line, preferably one that did not
write the fixes, reads only the fix range (the last reviewed head to the new
HEAD) with the prior findings. Apply, check and commit its valid findings. After
that one confirmation, or for a finding that needs a new design, the remaining
findings count as `open` and go to the user. A PR gets one full review;
confirmations only read fixes.

## 5. Receipt

Return this line for `write-pr`'s Review section, plus any blocker and its next
step. `land-it` parses it, so keep its exact shape. `rejected` counts findings
the reviewers raised and the authors declined; `open` counts findings handed
to the user, blockers and seats that never returned a verdict; `reviewed`
names the base branch and the head the last round saw, or the head after the
fixes you checked against their findings when no confirmation ran:

`**Review.** <skip | standard | high> by <models>; <n> fixed, <n> rejected, <n> open; reviewed <short SHA> on <base branch>`

Under it, write one line per rejected finding:

`- Declined: <finding> (raised by <model>): <specific reason>`

Name every model that raised the finding. A finding two reviewers raised
cannot be declined: it stays `open`.
