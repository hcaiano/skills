---
name: ship-it
description: "Manual-only delivery for finished work: focused proof, the graded review gate, deterministic final-HEAD validation, then push, PR, CI, and authorized merge. Invoke only when the user explicitly names ship-it or another explicitly invoked workflow delegates its delivery."
disable-model-invocation: true
---

# Ship It

Open or update a PR for the current work, then carry an authorized delivery
through merge and deploy. Quality is enforced locally, before the PR exists —
by the [review gate](../review-gate/SKILL.md), which this skill runs and never
reimplements.

Run it only when the user invokes ship-it or another skill (an orchestrator's
graded gate) delegates to it — finishing a change is not an invitation to
ship it.

1. **Prepare the delivery.** Read the repository instructions and inspect
   the current branch, diff, and working tree. Preserve unrelated user changes.
   `git fetch origin <target-branch>` first, and take every merge base in this
   skill against `origin/<target-branch>` — a stale local target reviews
   another PR's commits. Mark each intended untracked path with
   `git add --intent-to-add -- <path>` so focused proof sees the complete
   change; never do this to unrelated files. If the worktree is on the target
   branch, create an intentional task branch before step 2. This step is
   complete when the target branch and the task branch are explicit.
2. **Finish the implementation and proportional focused proof.** Keep the
   branch local. Map each changed runtime contract to its changed behavior and
   changed direct consumers, then run the smallest repository-defined tests and
   checks that exercise that map. A changed direct consumer is a path in the
   final diff that imports, calls, builds against, or relies on the changed
   contract; sharing a path or subsystem does not make it part of the proof.

   Treat path migrations as a focused branch: prove applicable old references
   are gone, new paths resolve, moved artifacts preserve their invariants, and
   changed direct consumers pass. The PR's native CI owns broader subsystem and
   platform coverage.

   When the local platform blocks a focused command, make one focused attempt
   through the repository's existing command or configuration. If the same
   incompatibility remains, record the command and evidence, then assign that
   check to the PR's native CI. Keep the local validation map closed to changed
   surfaces: an unrelated passing suite does not compensate for missing
   platform proof. This step is complete when the requested behavior is
   present, every mapped local check passes, and each platform-delegated check
   is explicit.
3. **Run the graded review gate.** Read and execute
   [review-gate](../review-gate/SKILL.md) over the focused-proven diff, with
   the merge base against `origin/<target-branch>` as its range. It owns the
   risk grade, the simplify decision, reviewer staffing and capacity
   degradation, the review round, and the one correction batch — this skill
   never regrades its result, reruns its reviews, or substitutes its own
   reading of the diff for them.

   The gate returns a clean local HEAD and a `## Review gate` receipt. Carry
   that block into step 4 verbatim; restating its fields here would fork the
   record of what was reviewed. A gate that stops for user direction stops the
   delivery too. This step is complete when the gate's receipt exists, its
   `Gate HEAD` is the current clean HEAD, and nothing is pushed.
4. **Validate the final HEAD, then push it.** On the clean final HEAD, rerun
   step 2's proportional validation map for the final diff: repository-defined
   test, lint, typecheck, and build entries covering the changed contracts and
   their changed direct consumers. One aggregate command may satisfy its
   included checks; run the complete local-CI entrypoint only when repository
   instructions or branch policy name it as the delivery authority. Use the
   repo's queued/coalesced entrypoint without a manual lease when present;
   otherwise use its documented `global-ci` lease. Fix a code failure in one
   batch under the gate's conditional-review trigger, then rerun the affected
   proportional gate on the resulting HEAD. Preserve a platform incompatibility
   already delegated in step 2 as an explicit pending PR-CI obligation. Missing
   native coverage for an applicable risk blocks delivery; it does not expand
   the local validation map.

   **Post-gate correction rule.** A bounded delivery mutation — a validation
   fix, base merge, live-review fix, or required-CI fix — keeps the existing
   review-gate receipt. Apply one correction batch, rerun the affected proof,
   and run only the review-gate's conditional review when the mutation
   substantially changes behavior, expands scope, or introduces a new
   behavior, security, or architectural risk. A bounded fix does not regrade,
   simplify, or start a new full gate. A correction that needs a new contract
   or architecture stops for user direction.

   After it passes, push normally. Mandatory pre-push checks must also pass,
   but do not replace the already-recorded final-HEAD validation. Record the
   exact pushed HEAD and successful results. This step is complete only when
   the remote head equals the final validated HEAD, its proportional local gate
   passed on that SHA, and every native-CI delegation is named for step 6.

   Leave a `## Delivery gate` receipt for the PR body. It embeds the gate's
   `## Review gate` block verbatim — grade, risk, regrade, simplify, reviewers,
   findings and their dispositions, `Reviewed HEAD`, `Gate HEAD`, and every
   transport record — and adds delivery's own fields around it:
   `Focused proof:` (why its exact commands cover every altered behavior),
   `Final validated HEAD: <40-character pushed SHA>`, the deterministic commands
   and results, and every check delegated to native PR CI and why.
   `Reviewed HEAD`, `Gate HEAD`, and `Final validated HEAD` are the delivery's
   chain of custody — reviewed at this ancestor, fixed in these SHAs, validated
   on the head that ships — so a corrected delivery is expected to carry
   different HEADs. The receipt is complete when it truthfully distinguishes the
   gate's review evidence, proportional final-HEAD proof, and pending native-CI
   obligations.
5. **Open or update the PR and verify its receipt.** Maintain one accurate,
   ready-for-review PR whose body carries the review and final-CI receipts —
   no receipt, no PR. Create new PRs as non-draft and verify GitHub preserved
   that state. Record the live-review baseline timestamp immediately before the
   first complete paginated fetch of current reviews, comments, and unresolved
   threads, then handle those surfaces. A branch mutation enters step 4's
   post-gate correction rule and must finish with deterministic validation,
   push, and PR update; it does not re-run the whole gate by default.
   This step is complete when the live PR, its body, its base, and its head all
   match the verified final receipt and the baseline is explicit.
6. Wait for required checks and every native-CI check delegated in steps 2 or
   4 on the exact PR head (poll at 60–120 s intervals, never tight loops).
   Delegated checks are delivery-required even when branch protection does not
   mark them required. Cloud auto-review bots are disabled by design — never
   wait for or solicit one. Green means every required and delegated check
   passed; pending is not green. A check that cannot run at all (billing,
   runner outage, missing native coverage) is a blocker — report the PR blocked
   on it, never shipped with a waiver. Fix a red check with one batched commit
   under the gate's conditional-review trigger and return to step 4; after
   two red rounds, stop and report.
   Immediately before reporting shipped, re-fetch complete paginated reviews,
   issue comments, inline comments, and review threads, and capture the live
   `headRefOid`. Require it to match both the final-CI receipt SHA and the SHA
   whose required and delegated checks passed; any mismatch returns to step 4's
   post-gate correction rule. Handle every item newer than the baseline and
   every unresolved thread. A branch change returns to that rule. Require
   GitHub to report the PR mergeable against its base; a conflict merges the
   base into the branch and returns to the same rule. Record the clean check
   timestamp and head.
7. **Merge and deploy when authorized.** A ship-it invocation authorizes its
   local gate, push, and PR work; merge and deployment require explicit user
   authorization or an enclosing workflow with standing authorization. When
   that authority is already present, proceed directly without another LLM
   review or confirmation. Merge with the repository's documented method,
   verify the merged commit and base state, then run the repository's
   documented deployment path when deployment is in scope. Verify the
   deployment with its required rollout, health, or canary evidence. Without
   merge or deploy authority, stop at the corresponding ready state and name
   the missing authorization.
8. Report the outcome to the user: PR link, exact head, deterministic and
   required-check status, live-review timestamp, receipt summary, merge and
   deployment evidence when applicable, and any findings discarded or
   deferred.

Do not force-push, modify `main`, broaden scope, or change the target branch
without explicit authorization. When the base moved under the branch, merge
`origin/<target>` in and apply the gate's conditional-review trigger to the
merge HEAD — a pushed branch is never rebased, so force-push is never needed.
Done when the PR has truthful review and passing final-validation receipts,
required checks and live-review surfaces are clean on the exact head, every
authorized merge or deployment is verified, and the user has the report.
