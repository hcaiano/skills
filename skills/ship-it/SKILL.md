---
name: ship-it
description: "Manual-only PR creation for current work: commit and push intentional changes, open or update the PR, then invoke review-pr-comments. Use only when the user explicitly invokes ship-it."
disable-model-invocation: true
user-invocable: true
argument-hint: "[branch name]"
---

# Ship It

Open or update a PR for the current work, then hand it to `$review-pr-comments`.

1. Read the repository instructions and inspect the current branch, diff, and
   working tree. Preserve unrelated user changes.
2. Create clear, intentional commits using the repository conventions.
3. Push safely and open or update one accurate PR.
4. Load and run the installed `$review-pr-comments` skill with that PR. It owns
   validation, review feedback, CI, and the merge-ready completion gate from this
   point onward.

Do not force-push, merge, modify `main`, broaden scope, or change the target
branch without explicit authorization. Done when the PR exists and
`$review-pr-comments` has taken over.
