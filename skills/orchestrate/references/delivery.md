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

## Select the delivery mode

Use **executor delivery** by default. After the review fan-out and its correction
round below, send a pair `task` that names the scope-approved SHA and explicitly
tells the executor to use the installed `ship-it` skill. The executor must run
the proportional proof and graded review gate on the complete diff, push, open
or update one PR against the recorded base, put the complete `## Delivery gate`
receipt in the PR body, and return the PR URL, exact head SHA, check state, and
review-checked timestamp.

Use **orchestrator-owned Git mechanics** only after the executor proves that
its arena cannot reach Git metadata or the network. A failed command and its
error are proof; an arena label or expected sandbox behavior is not. The
executor still owns implementation, correction, and validation. The
orchestrator owns only these mechanics:

1. Verify that the ready diff has only the scope-approved paths. Stage exactly
   those bytes and create a checkpoint commit without editing them.
2. Give the resulting 40-character checkpoint SHA to the executor. The
   executor reruns its validation on that unchanged worktree and returns the
   commands and results bound to that SHA. Prove that HEAD and the tree stayed
   unchanged while validation ran.
3. Run the delivery gates with reviews delegated to their required arenas.
   Return every valid correction to the executor as one batch. After the
   executor validates the corrected bytes, commit exactly those bytes as the
   next checkpoint.
4. Push the verified checkpoint, open or update the PR, and write the delivery
   receipt. Record the implementation-ready SHA, every corrected checkpoint,
   the final validated SHA, the executor's validation evidence, and the actor
   that ran each Git command.

This mode does not authorize the orchestrator to implement or review unit
code. It keeps chain of custody when the executor cannot perform Git or network
operations. Write the proposed PR body to `PR_BODY.md` in the worktree; unit
creation has already excluded that root file from Git.

## Review fan-out and ship

Before the ship-it gate, send the complete scope-approved diff to one
read-only second-arena reviewer. Its CLI and model family must differ from the
executor's. Start this review for every delivery; if no legal second arena can
run, report the delivery blocked instead of omitting it. Record the reviewed
SHA, arena, model, and findings. Two independent reviews converged on the same
defects twice in the 2026-08-21 Mediavine run and once in this rework, so this
fan-out is the default evidence step.

Deduplicate the second-arena findings and send every material in-scope item to
the executor in the same single correction round. The executor validates and
returns `ready` on the corrected head. Repeat the scope scan, then start the
ship-it gate. Do not repeat the fan-out for that correction; ship-it owns the
later graded review and convergence rules.

A branch change after scope approval returns to `ready`, unless the delivery
receipt proves it is a bounded ship-it correction. Any new surface or
unexplained growth returns to the scope scan.

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

Use `hold` for visible UI, auth, payments, migrations, destructive data,
public contracts, or open product judgment. Visible UI also needs before and
after screenshots. A held PR stays open for Henrique's own review.
Orchestrate never merges it, including with admin rights or after its own
verification. Dependent units wait when this rule serializes them. Only
Henrique's explicit approval moves that exact head to `auto`; a changed head
needs fresh evidence and approval.

For `auto`, merge in the repository's configured style with the verified head
guard:

```bash
gh pr merge <number> --match-head-commit <verified-head> <repo-merge-flags>
```

Do not use `--delete-branch` while its worktree exists. Merge only this unit's
PR into its recorded base. After GitHub reports it merged, run the unit
dismantle command from `SKILL.md`.
