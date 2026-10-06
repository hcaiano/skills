---
name: write-pr
description: "Write or update a pull request title and description for a human reviewer. Use when opening or editing a PR."
---

# Write PR

Use this instead of other PR description templates, including poteto-mode's.
A repo's own contributing or PR rules win where they conflict.

**Title.** Conventional Commits, `type(scope): subject`, imperative, no
trailing period.

**Body.** About 150 words of prose in total for a routine PR, not counting
tables and check lists; add detail only when the reviewer needs it to judge
real complexity. In this order:

1. **What and why.** One short paragraph: the problem, the resulting behavior
   in plain words, and what the PR deliberately leaves out.
2. **Merge danger.** `Door: one-way` when a revert cannot undo it (data
   migrations, deletions, schema or public API changes, external side
   effects), otherwise `two-way`. `Blast radius:` one word, plus one line only
   for a material ramification.
3. **Screenshots**, for any visible change: one `| State | Before | After |`
   table with a row per affected state, never images stacked below the text.
   Each pair uses the same route, viewport, theme, role, locale and data from
   the real app, cropped to the changed area, with test data. Name the
   baseline and final commits.
4. **Video**, only when movement, timing or a complex interaction cannot be
   read from stills.
5. **Checks.** The checks actually run, their results and the verified commit,
   local and CI apart.
6. **Review.** The `review-it` receipt line.

No code snippets, diffs, diagrams or file lists: the reviewer has the diff.
Put logs, research and long output behind links or in collapsed `<details>`.

**Media.** Attach with `gh pr create|edit|comment --attach <file>` and keep it
out of git.
Missing browser, login or upload access is a blocker to report.

Done when every applicable section is present, the body reads in under a
minute, and each image and video renders on the PR page.
