---
name: ship-it
description: "Validate and deliver finished work as a PR, including feedback on an existing PR."
disable-model-invocation: true
---

# Ship it

Deliver a merge-ready PR. Merge and deploy require explicit user authorization
for this delivery; delegation or a merge policy does not grant it.

For an existing PR with an accessible delivery record for its current head,
start at step 6. Otherwise run the full gate. Accept legacy PR-body receipts,
then move them into the internal record when updating the PR.

1. **Prepare.** Follow repo instructions, work on a task branch, and exclude
   unrelated changes.
2. **Prove.** Run the smallest repo checks covering every changed behavior and
   direct contract consumer. A platform-blocked check needs one real attempt,
   its command and error, and a named CI check to take over.
3. **Review.** Execute [review-it](../review-it/SKILL.md) on the proven branch.
   Its grade, fixes, and stop decisions are final. Retain its record; add no
   independent review here.
4. **Validate and push.** Merge an advanced `origin/<target-branch>` first;
   never force-push. On the clean final HEAD, rerun focused proof and the repo's
   lint, typecheck, and build for changed code. Run full local CI only when the
   repo requires it, using its queue or lease. Push that validated HEAD.
5. **Publish.** Keep one non-draft PR. Describe the problem and resulting
   behavior, summarize validation, and expose material risks or decisions.
   Include issue links and visual evidence where relevant. Follow required
   templates; otherwise a small change needs only a short paragraph and a
   validation line. Rewrite for the final change rather than appending history.
   Keep technical receipts in the internal record below, outside PR bodies and
   comments.
6. **Close feedback.** Fetch all reviews, comments, unresolved and outdated
   threads, and checks. Fix failures, material defects, and human requests.
   Explain and resolve nits, duplicates, and unsupported findings without a
   push. Ask about scope, product or architecture decisions, or conflicting
   guidance. Answer threads with the fix commit or reason before resolving;
   leave user decisions open. Never summon cloud review bots or wait for silence.

   Make each fix batch one commit. Behavioral, scope, security, or architecture
   changes run review-it on that commit while the review cap allows. Repeat
   step 4 and refresh the delivery record; update the PR summary when needed.
   Stop after two fix batches, counting a base merge as one, and report remaining
   items with a recommendation. Feedback after the final push does not reopen
   the loop. A remote commit made by someone else requires user direction.

   Allow three LLM review rounds per delivery, including second passes and prior
   user `/code-review` runs. Step 3 always runs. Beyond the cap, review only a
   regression from the latest commit; retain other findings as residuals.

   Finish only after a fresh feedback fetch, with threads resolved or awaiting
   user decisions, `headRefOid` equal to `Final validated HEAD`, GitHub reporting
   mergeable, and all required and delegated checks green on that head. Pending
   or unavailable checks block completion. Use the runtime's PR watcher when
   available; otherwise poll every 60–120 seconds.
7. **Merge if authorized.** Use the repo's method, verify the merge commit,
   and perform and verify the documented deploy only when authorized in scope.
   A delegated delivery returns to its caller at merge-ready.
8. **Report.** Give the PR link, readiness, and any blocker or decision in a few
   sentences. Distinguish local checks, CI, and production evidence. Keep audit
   details internal unless requested; unresolved material findings block a
   merge-ready claim.

## Internal record

Save one record per validated HEAD under
`$(git rev-parse --git-path agent-receipts)/ship-it/<branch>/`. Give the caller
its absolute path, or send the contents through agent transport if inaccessible.
These are local evidence, not GitHub links.

```markdown
## Delivery gate
- Focused proof: <commands and behavior covered>
- Final validated HEAD: <full SHA from git rev-parse HEAD>
- Final checks: <commands and results on that SHA>
- Delegated to CI: <check and reason, or none>
- Residual findings: <open findings, or none>

<review-it's internal Review gate record>
```
