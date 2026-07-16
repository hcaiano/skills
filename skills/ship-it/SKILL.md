---
name: ship-it
description: "Manual-only end-to-end shipping of current work: commit intentional changes, validate, push, create or update the PR, and leave it merge-ready. Use only when the user explicitly invokes ship-it. For an existing PR that only needs feedback handled, use review-pr-comments."
disable-model-invocation: true
user-invocable: true
argument-hint: "[branch name or PR number]"
---

# Ship It

Take the current work from local changes to a merge-ready PR. Choose the workflow
that best fits the repository instead of following a fixed sequence.

Required outcomes:

- Understand the intended changes and preserve unrelated user work.
- Make clear, intentional commits using the repository's conventions.
- Run the relevant local validation and fix failures caused by this work.
- Push safely and create or update one accurate PR.
- Apply the `review-pr-comments` completion contract to the resulting PR.
- Report precise blockers when completion depends on the user or an external
  system.

Do not force-push, merge, broaden scope, or change the target branch without
explicit authorization. The PR is complete only when its latest head is
validated, review-clean, up to date enough to merge safely, and GitHub reports it
mergeable.
