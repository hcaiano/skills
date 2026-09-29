---
name: ship-it
description: "Manual-only delivery for finished work: focused proof, the graded review gate, final-HEAD validation, then push, PR, CI, and authorized merge. Invoke only when the user explicitly names ship-it or another explicitly invoked workflow delegates its delivery."
disable-model-invocation: true
---

# Ship it

Take finished work to a green PR, and through merge and deploy when the user
authorizes them. Quality is checked locally before the PR exists, by the
[review gate](../review-it/SKILL.md). This skill runs that gate and never
reimplements it.

Run it only when the user invokes ship-it or another workflow delegates to it.

1. **Prepare.** Read the repo instructions. Inspect the branch, diff, and
   working tree, and keep unrelated user changes out. Run
   `git fetch origin <target-branch>` and take every merge base against
   `origin/<target-branch>`. Mark intended untracked paths with
   `git add --intent-to-add -- <path>`. If you are on the target branch,
   create a task branch first.

2. **Focused proof.** List each behavior the change alters and the direct
   consumers of each changed contract. Run the smallest repo-defined tests and
   checks that cover that list. If the local platform blocks a check after one
   real attempt, record the command and error and hand that check to the PR's
   CI by name. Done when every listed check passes or is explicitly handed to
   CI.

3. **Review.** Read and execute [review-it](../review-it/SKILL.md) over the
   proven diff, with the merge base against `origin/<target-branch>` as its
   range. Do not regrade its result, rerun its reviews, or add your own review.
   If the gate stops for user direction, delivery stops too. Keep its
   `## Review gate` receipt for step 5.

4. **Validate the final HEAD and push.** On the clean final HEAD, rerun the
   step 2 checks for the final diff, plus the repo's lint, typecheck, and build
   for the changed code. Run the full local-CI entrypoint only when the repo
   names it as the delivery gate. Use the repo's queued entrypoint when it has
   one; otherwise its documented `global-ci` lease. Push normally. Never
   force-push; when the base moved, merge `origin/<target-branch>` in.

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

6. **Get CI green.** Wait for the required checks and every check handed to CI
   on the exact PR head. Poll every 60–120 s. Pending is not green. A check
   that cannot run at all (billing, runner outage) blocks the delivery; never
   waive it. Cloud review bots are off by design: do not wait for or summon
   them.

   Fix red checks and real review comments in batches, each through step 4
   and a receipt update. After two fix batches (a base merge counts), stop and
   report. A batch that changes behavior, expands scope, or adds a security or
   architecture risk goes through review-it's second review first. A commit on
   the remote that this delivery did not make is new input: stop for user
   direction.

   Review convergence: after three LLM review rounds for this delivery,
   including any review an orchestrator ran, do not review again unless the
   latest commit caused a regression. Record other findings as residuals.

   Before you report, re-fetch all reviews, comments, and threads, confirm the
   live `headRefOid` equals `Final validated HEAD`, and confirm GitHub reports
   the PR mergeable.

7. **Merge and deploy only when authorized.** Invoking ship-it authorizes the
   local gate, push, and PR. Merge and deploy need the user's explicit
   authorization for this delivery. A delegating workflow or merge policy never
   carries it: a delegated delivery stops at merge-ready and returns the PR to
   its caller. With authorization, merge with the repo's method, verify the
   merged commit, and run and verify the documented deploy when it is in scope.

8. **Report** the PR link, exact head, check status, receipt summary, merge and
   deploy evidence when applicable, and any deferred or discarded findings.

Do not modify `main`, broaden scope, or change the target branch without
explicit authorization.
