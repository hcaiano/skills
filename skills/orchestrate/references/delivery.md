# Unit delivery

Read this reference after a unit returns `ready`. It owns the scope-to-merge
chain. `ship-it` owns code review and final validation; orchestrate owns scope,
live PR evidence, merge authority, and cleanup.

## Approve scope

Resolve the PR base and merge base from current remote state. Compare the task,
ready summary, and diff stat. Confirm the expected surfaces are present, every
extra surface is explained, and no requested outcome is missing. This is a
scope scan, not a code review.

Record the exact scope-approved SHA. If the base advanced, fetch it and tell the
executor to merge `origin/<base>`, resolve, validate, and return through `ready`.
Published history is merged, never rebased or force-pushed.

## Ship

Use **executor delivery** by default. Send the executor one pair `task` (the
headless send is in `SKILL.md`'s Monitor section) that names the
scope-approved SHA and tells it to use the installed `ship-it` skill. Pair's
writable-task budget is 120 minutes with time queued for the heavy slot
excluded; when the repository's full local-CI run approaches that, size the
send's `--total-min` to it. The executor runs ship-it's proportional proof and
graded review gate on the complete diff, pushes, opens or updates one PR
against the recorded base with the complete `## Delivery gate` receipt in its
body, and returns the PR URL, exact head SHA, check state, and review-checked
timestamp. Ship-it delegation carries no merge authority: the executor stops at
merge-ready, and the PR stays held under Hold or merge.

The review-it gate inside ship-it is the delivery's code review: it grades the
complete diff and staffs reviewers from families that did not implement it.
The orchestrator's part is the scope scan above and the live evidence below.

A branch change after scope approval returns to `ready`, unless the delivery
receipt proves it is a bounded ship-it correction. Any new surface or
unexplained growth returns to the scope scan.

### Orchestrator-owned Git mechanics

Use this mode only after the executor proves that its arena cannot reach Git
metadata or the network. A failed command and its error are proof; an arena
label or expected sandbox behavior is not. The executor still owns
implementation, correction, and validation. The orchestrator owns only these
mechanics:

1. Verify that the ready diff has only the scope-approved paths. Stage exactly
   those bytes and create a checkpoint commit without editing them.
2. Give the resulting 40-character checkpoint SHA to the executor. The
   executor reruns its validation on that unchanged worktree and returns the
   commands and results bound to that SHA. Prove that HEAD and the tree stayed
   unchanged while validation ran.
3. Run ship-it's gates; review-it staffs and runs its own reviewers. Return
   every valid correction to the executor as one batch. After the executor
   validates the corrected bytes, commit exactly those bytes as the next
   checkpoint.
4. Push the verified checkpoint, open or update the PR, and write the delivery
   receipt. Record the implementation-ready SHA, every corrected checkpoint,
   the final validated SHA, the executor's validation evidence, and the actor
   that ran each Git command.

This mode does not authorize the orchestrator to implement or review unit
code. It keeps chain of custody when the executor cannot perform Git or network
operations. Write the proposed PR body to `PR_BODY.md` in the worktree; unit
creation has already excluded that root file from Git.

### Push credentials

For every push, inspect the configured fetch and push URLs. Prefer an existing
SSH push URL or SSH remote. Use HTTPS only when no SSH route exists. If the
diff touches `.github/workflows/*` and the only available GitHub credential is
an OAuth `gh` token without workflow scope, run this exact user-authenticated
fix and retry:

```bash
gh auth refresh -s workflow
```

Report a real authentication refusal after this check; do not replace it with
an opaque push failure.

## Verify live evidence

Before merge, prove all of these on the same PR head:

- `Final validated HEAD` equals the exact PR head. `Reviewed HEAD` and `Gate
  HEAD` are ancestors of it.
- The receipt contains `Gate:`, `Risk:`, `Regrade:`, and `Focused proof:` plus
  the embedded review-gate block.
- Required checks and every check delegated by the receipt are green.
- Current paginated reviews, issue comments, inline comments, and review
  threads have no newer actionable item and no unresolved thread.
- The head still targets the recorded base and the PR is not a draft.

Any new commit or actionable review returns to the executor, then re-enters
scope and delivery on the new head.

## Hold or merge

Every unit PR is held for Henrique's own review before merge, including a PR
whose base is an epic branch. The full delivery still runs first: the ship-it
gate and live evidence. The hold comes after all of it, never instead of it.
Orchestrate never merges a PR he has not reviewed, including with admin rights
or after its own verification; a recorded `auto` merge policy waits for the
same review. Visible UI also needs before and after screenshots. Dependent
units wait when this rule serializes them. His feedback on the held PR returns
to the executor as a correction round through ship-it's PR-feedback step on the
same PR, which refreshes the delivery receipt for the new head.
Only his explicit approval of that exact verified head authorizes the merge; a
changed head needs fresh evidence and approval.

For a browser flow, the executor first exercises the acceptance path itself.
Hand off the exact preview URL and route, the tested commit, test-data or login
prerequisites, the actions Henrique should try, and remaining limitations.
Verify that the link is reachable through the user's existing Mac/mobile remote
access path; a Linux localhost URL alone is not that proof. Keep the preview
process recorded with a cleanup instruction. A short video helps for motion or
multi-step flows; screenshots suffice for static changes. Redact private data
from evidence. If preview access cannot be proved, report that gap explicitly.

After his approval, merge in the repository's configured style with the
verified head guard:

```bash
gh pr merge <number> --match-head-commit <verified-head> <repo-merge-flags>
```

Do not use `--delete-branch` while its worktree exists. Merge only this unit's
PR into its recorded base. After GitHub reports it merged, run the unit
dismantle command from `SKILL.md`.
