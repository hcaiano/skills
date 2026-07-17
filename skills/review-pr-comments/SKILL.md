---
name: review-pr-comments
description: "On-demand review cleanup for an existing PR that has actual feedback: verify each comment, apply valid in-scope fixes in one batched round, respond where useful, and leave the PR merge-ready. Only runs when the user explicitly invokes review-pr-comments."
user-invocable: true
disable-model-invocation: true
argument-hint: "[PR number, URL, or 'all' for all open PRs]"
---

# Review PR Comments

Handle real review feedback on an existing PR. This is an on-demand, exception
path: most PRs have no comments because cloud auto-review is disabled and the
heavy review already happened locally (ship-it's dual-review gate). Do not
summon bot reviews (`@codex review`, `@coderabbitai review`), and never treat a
bot's silence as something to wait for.

Process, at most TWO rounds (a round = collect → triage → one batched commit →
push → required CI green on the new head):

1. Collect all open feedback: human reviews, bot comments, unresolved and
   outdated threads, failing checks.
2. Triage each finding against the code:
   - **Fix in the batch:** real correctness, security, or data-integrity
     issues, and anything a human reviewer explicitly requested.
   - **Reply, don't push:** style nits, defensive hardening for invariants
     that already hold, severity-inflated or duplicate findings. Answer the
     thread, resolve it, move on. A nit is never a reason for a push.
   - **Surface to the user:** product/architecture decisions, scope
     expansions, conflicting reviewer guidance.
3. Validate the complete head (original changes plus fixes), commit and push
   once, and wait for required CI (poll at 60–120 s intervals, never tight
   loops).

After two rounds, stop pushing: report remaining items with your triage and
recommendation. Feedback arriving after your final push does not reopen the
loop. Success: required checks green on the final head, human-requested
changes addressed, every open thread fixed or answered, and GitHub reports the
PR mergeable — bot re-reviews are never a completion requirement.

Do not merge, force-push, modify `main`, create follow-up PRs (nit-cleanup
follow-up PRs are explicitly banned), or make product and architecture
decisions without authorization.
