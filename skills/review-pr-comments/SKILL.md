---
name: review-pr-comments
description: "Manual-only review cleanup for an existing PR: evaluate feedback, apply valid in-scope fixes, respond where useful, validate, and leave the PR merge-ready. Use only when the user explicitly invokes review-pr-comments. For local work that still needs commits and a PR, use ship-it."
disable-model-invocation: true
user-invocable: true
argument-hint: "[PR number, URL, or 'all' for all open PRs]"
---

# Review PR Comments

Make the selected existing PR merge-ready. Use the available GitHub tools and
repository conventions; choose the most efficient workflow for the live state.

Required outcomes:

- Inspect all relevant human and automated review feedback, including unresolved
  or outdated threads that remain open.
- Verify each finding against the code. Fix valid in-scope issues, explain false
  positives, and surface genuinely ambiguous or out-of-scope decisions.
- Keep changes scoped to the PR unless the user explicitly expands the task.
- Validate fixes, commit and push them safely, and resolve or reply to review
  threads when that improves the audit trail.
- Recheck the latest PR head, required checks, target-branch compatibility,
  unresolved feedback, and mergeability before declaring success.

Do not merge, force-push, modify `main`, create follow-up PRs, or make product and
architecture decisions without authorization. Do not wait for an arbitrary quiet
window: use judgment based on the repository's normal review automation and
report any remaining uncertainty explicitly.
