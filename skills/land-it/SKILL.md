---
name: land-it
description: "Merge a low-risk PR that every reviewer approved, then settle its T3 thread. Use when a PR reaches merge-ready, or when a thread's PRs have all landed."
---

# Land it

A PR is _landable_ when the change is easy to revert, low risk, and every
reviewer agreed on the code that merges. Landable PRs merge without asking
the user; everything else waits for the user with its reasons.

## 1. Check the conversation

The gate reads only the PR. Before it runs, look for holds that live in the
conversation, the task brief, the issue and the repo: the user asked to merge
himself, not to merge, to stay local, or for an acceptance check that has not
passed yet (browser, device, end-to-end, production data); or the repo's
instructions reserve merging to people. Any such hold makes the PR the user's:
skip to step 4 and name the hold. A narrower grant the user gave elsewhere,
such as merging children into an epic branch, keeps its own conditions; this
skill adds no permission to it.

## 2. Run the gate

Set `SKILL_DIR` to this skill's directory and run, from a checkout of the PR's
repository:

```bash
node "$SKILL_DIR/scripts/land-gate.mjs" <pr-url> --merge
```

It prints the `action` it took or needs, with `reasons`. The script header
lists every rule. Risk comes from what the PR already records: `Door:
two-way` from `write-pr`, and the `review-it` receipt graded `single` (or
`skip` on plain docs) with no rejected and no open findings on the code being
merged. It merges with a method the repository allows and leaves branch
protection to GitHub; a rule it cannot satisfy becomes a hold.

## 3. Act on the action

- `merge` with `acted: merged`: the PR landed at the head the gate checked.
  Run the repo's post-merge steps, such as reinstalling skills per its README.
- `update-branch`, `wait`, or `acted: queued`: arm `watch_pull_request`, end
  the turn, and run the gate again on the wake.
- `hold` because the code changed since the review, the base changed, or the
  receipt is missing or in an older shape: run `review-it`'s final review once
  on the current head, carry its receipt into the body with `write-pr`, and
  run the gate again. The receipt states what that review found; a second
  such hold makes the PR the user's.
- `hold` for anything else: the PR is the user's. Report it in step 4.
- `done`: the PR already merged or closed.

Only PRs into the default branch land here. In a stack, the bottom PR lands
first; the owner then rebases the next layer onto the default branch and
retargets it, and that layer takes its one final review before the gate.

## 4. Settle or hand back

Read `list_thread_pull_requests`. When every linked PR is merged or closed and
no child task, scheduled task or requested check is still open, call
`unwatch_pull_request` for any watch and settle the thread with
`t3_thread_organize`. Otherwise end with each PR still open and the reason it
waits, quoting the gate's `reasons`.

Done when every PR of the task is merged, or reported with its hold, and the
thread is settled or its open work is named.
