---
name: ship-it
description: "Prove, review, and deliver finished work as a PR; also the loop for feedback on an existing PR."
disable-model-invocation: true
---

# Ship it

Take finished work to a green PR, and through merge and deploy when the user
authorizes them. The [review gate](../review-it/SKILL.md) checks quality
before the PR exists; this skill runs that gate and never reimplements it.
Invoked on an existing PR to handle its feedback, start at step 6; when that PR
body has no `## Delivery gate` receipt yet, run steps 1–5 on its branch first.

1. **Prepare.** Read the repo instructions. Inspect the branch, diff, and
   working tree, and keep unrelated user changes out. If you are on the target
   branch, create a task branch first.

2. **Focused proof.** List each behavior the change alters and the direct
   consumers of each changed contract. Run the smallest repo-defined tests and
   checks that cover that list. If the local platform blocks a check after one
   real attempt, record the command and error and hand that check to the PR's
   CI by name. Done when every listed check passes or is explicitly handed to
   CI.

3. **Review.** Read and execute [review-it](../review-it/SKILL.md) over the
   proven branch with its default range. Take its grade and fixes as final
   and add no review of your own; step 6 owns the only later review. If the
   gate stops for user direction, delivery stops too. Keep its `## Review gate` receipt for step 5.

4. **Validate the final HEAD and push.** On the clean final HEAD, rerun the
   step 2 checks for the final diff, plus the repo's lint, typecheck, and build
   for the changed code. Run the full local-CI entrypoint only when the repo
   names it as the delivery gate, through the repo's documented CI queue or
   lease. Push normally. Never force-push; when the base moved, merge
   `origin/<target-branch>` in.

5. **Open or update the PR.** Keep one ready-for-review (non-draft) PR. Its
   body carries this receipt:

   ```markdown
   ## Delivery gate
   - Focused proof: <commands, and why they cover every altered behavior>
   - Final validated HEAD: <40-char SHA pasted from `git rev-parse HEAD`>
   - Final checks: <commands and results on that SHA>
   - Delegated to CI: <check and reason, or none>
   - Residual findings: <review findings left open, or none>

   <the `## Review gate` block, verbatim>
   ```

6. **Get CI green and close the feedback.** This is the one loop for PR
   feedback.

   Wait for the required checks and every check handed to CI on the exact PR
   head. Poll every 60–120 s. Pending is not green. A check that cannot run at
   all (billing, runner outage) blocks the delivery; never waive it.

   Collect the open feedback: human reviews, bot and issue comments, unresolved
   and outdated threads, and failing checks. Cloud review bots are off by
   design: summon none, and treat a bot's silence as nothing to wait for.
   Triage each item against the code:

   - **Fix**: a red check, a real correctness, security, or data-integrity
     problem, or a change a human reviewer requested.
   - **Reply and resolve**: nits, hardening for invariants that already hold,
     and duplicate or inflated findings. A nit never earns a push.
   - **Ask the user**: product or architecture decisions, scope expansion, and
     conflicting reviewer guidance.

   Make each fix batch one commit. While the review cap allows, a batch that
   changes behavior, expands scope, or adds a security or architecture risk
   first runs review-it with that commit as its range; add its receipt block
   to the PR body. Then take the batch through step 4 and refresh the
   `## Delivery gate` receipt so `Final validated HEAD` equals the new PR head.
   Stop after two fix batches, a base merge counting as one, and report the
   remaining items with your triage and a recommendation. Feedback after the
   final push does not reopen the loop.

   Review cap: three LLM review rounds per delivery. Each review-it review,
   first or second, counts as one, and so does each `/code-review` the user ran
   on this branch before invoking ship-it. Step 3's gate runs even past the
   cap. Past it, only a regression from the latest commit earns another
   review; record other findings as residuals.

   Answer every thread with its commit or its reason, then resolve it. A
   commit on the remote that this delivery did not make is new input: stop for
   user direction. Done when you have re-fetched all reviews, comments, and
   threads, every thread is resolved or left open only for the user's
   decision, the live `headRefOid` equals `Final validated HEAD`, the required
   checks are green on it, and GitHub reports the PR mergeable.

7. **Merge and deploy only when authorized.** Invoking ship-it authorizes the
   local gate, push, and PR. Merge and deploy need the user's explicit
   authorization for this delivery. A delegating workflow or merge policy never
   carries it: a delegated delivery stops at merge-ready and returns the PR to
   its caller. With authorization, merge with the repo's method, verify the
   merged commit, and run and verify the documented deploy when it is in scope.

8. **Report** the PR link, exact head, check status, receipt summary, merge and
   deploy evidence when applicable, and any deferred or discarded findings.
