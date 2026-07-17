---
name: review-pr-comments
description: "Review cleanup for an existing PR: validate the complete head, evaluate feedback, apply valid in-scope fixes, respond where useful, and leave the PR merge-ready. Activate automatically only when ship-it hands off a newly opened or updated PR; otherwise require explicit review-pr-comments invocation."
user-invocable: true
argument-hint: "[PR number, URL, or 'all' for all open PRs]"
---

# Review PR Comments

Make the selected existing PR merge-ready. Use the available GitHub tools and
repository conventions; choose the most efficient workflow for the live state.

Invocation gate: activate automatically only after `$ship-it` was explicitly
invoked in the current turn. In every other case, require the user to invoke
`$review-pr-comments` explicitly.

Required outcomes:

- Inspect all relevant human and automated review feedback, including unresolved
  or outdated threads that remain open.
- Verify each finding against the code. Fix valid in-scope issues, explain false
  positives, and surface genuinely ambiguous or out-of-scope decisions.
- Keep changes scoped to the PR unless the user explicitly expands the task.
- Validate the complete PR head, including the original changes and any fixes.
  Commit and push fixes safely, and resolve or reply to review threads when that
  improves the audit trail.
- Babysit the PR through a settled review epoch as defined below.

## Review epoch

Every push starts a new review epoch and invalidates all earlier clean results.
Capture the new head SHA and keep polling the live PR, checking reviewer surfaces
before CI. Inspect unresolved threads (including outdated ones), review comments,
review bodies, issue comments, checks, target-branch compatibility, and
mergeability.

While the epoch is active:

- Wait for the automatic reviewers and checks normally observed for this PR or
  repository to report a terminal result tied to the captured head SHA. A clean
  snapshot before that is provisional.
- Treat every new actionable finding or failure as current work: verify it, fix
  all valid in-scope feedback, validate, commit, push, and restart the epoch with
  the new head SHA.
- Keep polling normally pending automation. Stop only for a precise blocker such
  as required user judgment, unavailable authentication, rate limits, or
  automation that is demonstrably stalled.

Success requires one settled epoch: the head SHA is unchanged; every expected
reviewer and required check has completed for that SHA; required checks are
green; the complete head passes the relevant repository validation; no
unresolved, actionable, or unanswered feedback remains on any review surface;
the target branch is compatible; and GitHub reports the PR mergeable. If an
expected reviewer has no observable completion signal, report that as remaining
uncertainty rather than declaring success.

Do not merge, force-push, modify `main`, create follow-up PRs, or make product and
architecture decisions without authorization.
