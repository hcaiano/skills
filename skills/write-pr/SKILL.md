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

1. **What and why.** One paragraph of at most 80 words: the problem, the
   resulting behavior in plain words, and what the PR deliberately leaves out.
2. **Merge danger.** `Door: one-way` when a revert cannot undo it (data
   migrations, deletions, schema or public API changes, external side
   effects), otherwise `two-way`. `Blast radius:` one word. Add one sentence
   only for a material ramification.
3. **Screenshots**, for any visible change: one `| State | Before | After |`
   table with a row per affected state. Each pair comes from the real app
   with the same route, viewport, theme, role, locale and test data. Crop
   both to the same box around the changed component, at most about 400 CSS
   px wide so it shows unscaled and sharp in its column; on desktop that means
   the component, not the full row. Take a missing before from a worktree at
   the baseline commit.
   Name the baseline and final commits.
4. **Video**, only when movement, timing or a complex interaction cannot be
   read from stills.
5. **Checks.** The checks actually run, their results and the verified commit,
   local and CI apart.
6. **Review.** The `review-it` receipt line.

Shape, with sections that do not apply dropped:

```markdown
<What and why paragraph.>

**Merge danger.** Door: two-way. Blast radius: <word>.

| State | Before | After |
| --- | --- | --- |
| <state> | ![Before: <state>](./before-<state>.png) | ![After: <state>](./after-<state>.png) |

Baseline `<sha>`, final `<sha>`.

**Video.** <What it shows.>

![<what it shows>](./demo.mp4)

**Checks.** <Local: check, result, commit. CI: result, commit.>

**Review.** <grade> by <models>; <n> fixed, <n> rejected; reviewed <sha>
```

No code snippets, diffs, diagrams or file lists: the reviewer has the diff.
Put logs, research and long output behind links or in collapsed `<details>`.

**Media.** Write each image and video into the body file as
`![alt](./file.png)` at its place, then pass the same paths to
`gh pr create|edit --body-file <body> --attach ./file.png`: gh swaps each
reference for the uploaded asset, and a video reference becomes a player.
Reference every attached file, since gh appends unreferenced ones to the end
of the body. Keep media out of git. Missing browser, login or upload access is
a blocker to report.

**Updates.** Update the body whenever a push, a review round, or a change in
draft, CI or blocker state makes any line of it wrong. Rewrite it from the
full `<base>..HEAD` diff rather than the last commit, carry the latest
`review-it` receipt, and drop state that no longer holds, such as draft,
pending CI or blocked. Link issues with `Refs #<n>` unless the PR completes
the issue.

Done when every applicable section is present, the body reads in under a
minute, `gh pr view --json body` shows no `./` media paths left, and each
image renders and each video plays on the PR page.
