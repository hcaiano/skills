---
name: write-pr
description: "Write or update a pull request title and description for a human reviewer. Use when opening or editing a PR."
---

# Write PR

A repo's own contributing or PR rules win where they conflict.

**Title.** Conventional Commits, `type(scope): subject`, imperative, no
trailing period.

**Body, in this order:**

1. **What and why.** The problem and the resulting behavior in plain words,
   then what the PR deliberately leaves out. About 150 words of prose for a
   routine PR; add detail only when the reviewer needs it to judge real
   complexity.
2. **Merge danger.** `Door: one-way` when a revert cannot undo it (data
   migrations, deletions, schema or public API changes, external side
   effects), otherwise `two-way`. `Blast radius:` one word, plus one line only
   for a material ramification.
3. **Screenshots**, for any visible change: before and after from the real
   app, each pair in one Markdown table row with the same route, viewport,
   theme, role and data. Label the state and name the baseline and final
   commits. Capture only the affected states, with test data.
4. **Video**, only when movement, timing or a complex interaction cannot be
   read from stills.
5. **Checks.** The checks actually run, their results and the verified commit,
   local and CI apart.
6. **Review.** Who reviewed (models), findings fixed or rejected, and the
   reviewed commit.

Put logs, research and long output behind links or in collapsed `<details>`.

**Media.** Attach with `gh pr create|edit|comment --attach <file>`; a
`![alt](./file.png)` in the body marks where it lands. Keep media out of git.
Missing browser, login or upload access is a blocker to report.

Done when every applicable section is present, the body reads in under a
minute, and each image and video renders on the PR page.
