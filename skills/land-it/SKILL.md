---
name: land-it
description: "Merge a revertible PR whose review findings are all fixed or declined with a reason, test it after merge, and hand the thread back ready to settle. Use when a PR reaches merge-ready."
---

# Land it

A PR is _landable_ when a revert undoes it (`Door: two-way`) and every review
finding on the code that merges is fixed, or raised by one reviewer and
declined with a written reason. The review grade sets how hard the PR was
reviewed, not who merges: landable PRs merge without asking the user, and the
after-merge test in step 4 is the safety net. Only one-way doors and the holds
below wait for the user, with their reasons.

## 1. Check the conversation

Every turn of this skill, wakes included, starts here. The gate reads only the
PR. Before it runs, look for holds that live in the
conversation, the task brief, the issue and the repo: the user asked to merge
the PR themselves, not to merge, or to stay local; or the repo's instructions
name a person who must merge. Any such hold makes the PR the user's: skip to
step 5 and name the hold. An acceptance check the task asks for (browser,
device, end-to-end) is yours to run before the gate, and a failure is yours to
fix and run again; it holds only when it needs something only the user has,
such as their hands on a device. A repo rule that asks for review or approval
before a schema, API or dependency change is met by the review receipt; the
`Door` line decides whether the change waits.

## 2. Run the gate

Set `SKILL_DIR` to this skill's directory and run, from a checkout of the PR's
repository:

```bash
node "$SKILL_DIR/scripts/land-gate.mjs" <pr-url> --merge
```

It prints the `action` it took or needs, with `reasons`. The script header
lists every rule. Risk comes from what the PR already records: `Door:
two-way` from `write-pr`, and the `review-it` receipt graded `standard` or
`high` (or the older `single` or `panel`) with no
open findings and a `- Declined:` reason under it for each rejected finding, none raised by more than one reviewer unless it went to a follow-up issue, on the code and base being merged. It merges with a method the repository allows and leaves branch
protection to GitHub; a rule it cannot satisfy becomes a hold. When only a
ruleset the user may always bypass blocks a PR that passed every rule (an
owner-only branch), it merges as the user.

## 3. Act on the action

- `merge` with `acted: merged`: the PR landed at the head the gate checked.
  Run the repo's post-merge steps, such as reinstalling skills per its README.
- `update-branch`, `wait`, or `acted: queued`: arm `watch_pull_request`, end
  the turn, and run the gate again on the wake.
- `hold` because the code or base changed since the review, or findings are
  `open` only because their fixes were never confirmed: run `review-it`'s
  confirmation review on what changed since the reviewed head, carry its
  receipt into the body with `write-pr`, and run the gate again. When that
  confirmation still leaves findings or unconfirmed fixes, the PR is the
  user's.
- `hold` because the grade was `skip` or the receipt is missing or in an
  older shape: run `review-it` on the whole PR graded at least `standard`,
  and run the gate again.
- `hold` because the PR could not be read or the code could not be compared:
  fix the access or checkout (GitHub login, fetch access, the PR's
  repository) and run the gate again.
- `hold` for anything else: the PR is the user's. Report it in step 5.
- `done` with `PR is merged`: go to step 4 if its after-merge test has not run.
- `done` with `PR was closed without merging`: report it in step 5.

PRs into the default branch or an `epic/*` integration branch land here. In a
stack, the bottom PR lands first; the owner then rebases the next layer onto
the bottom PR's base and retargets it, and that layer takes its one final review
before the gate.

## 4. Test after merge

For each PR that landed, watch the merge commit's checks on the target branch
and, when the repo deploys on merge, the deploy's status and health; when the
target runs no checks after merge, the PR's own green checks stand. When the
repo has a `verify-<app>` skill, run its journey for the changed feature
against a preview or staging deploy, or the target branch locally; against
production, run only journeys the skill marks production-safe. A red
result is new work in this thread: fix forward in a new PR, or revert through
a PR that lands by this skill when the fix is not obvious, and report it.

## 5. Hand back

End the turn with one final message the user can triage at a glance. Read
`list_thread_pull_requests` first, and `unwatch_pull_request` every PR that
merged or now waits for the user. Start the message with one of:

- `Ready to settle:` every linked PR is merged and passed its after-merge
  test, or was closed on purpose with the reason in this thread, and no child task, scheduled task or requested check is
  open. Name what landed and how it was tested.
- `Needs you:` then each open PR with the gate's `reasons`, or the open
  work, and the one decision or action that would unblock it, with your
  recommendation.

The user settles the thread; leave that to them.

Done when every PR of the task is merged and tested, or reported with its
hold, and the final message starts with one of the two labels.
