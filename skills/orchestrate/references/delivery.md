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

Send a new pair `task` that names the scope-approved SHA and explicitly tells
the executor to use the installed `ship-it` skill. The executor must:

- run the proportional proof and graded review gate on the complete diff;
- push and open or update one PR against the recorded base;
- put the complete `## Delivery gate` receipt in the PR body;
- return the PR URL, exact head SHA, check state, and review-checked timestamp.

A branch change after scope approval returns to `ready`, unless the delivery
receipt proves it is a bounded ship-it correction. Any new surface or
unexplained growth returns to the scope scan.

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

Use `hold` for visible UI, auth, payments, migrations, destructive data,
public contracts, or open product judgment. Visible UI also needs before and
after screenshots. Tell the user the exact decision and PR URL. Their approval
moves that exact head to `auto`; a changed head needs fresh evidence.

For `auto`, merge in the repository's configured style with the verified head
guard:

```bash
gh pr merge <number> --match-head-commit <verified-head> <repo-merge-flags>
```

Do not use `--delete-branch` while its worktree exists. Merge only this unit's
PR into its recorded base. After GitHub reports it merged, run the unit
dismantle command from `SKILL.md`.
