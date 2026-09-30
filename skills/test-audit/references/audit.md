# Test audit

A focused, read-only sweep for tests that fail the bar in
[SKILL.md](../SKILL.md), then one coherent deletion batch. Optimize for
confidence, not deletion count. Each step ends on its completion criterion.

## Deletion rules

- A retained test that fails on the baseline is a possible product bug:
  reproduce it and fix the owner rather than deleting it.
- Static or slow is not a deletion reason.
- A test that resembles implementation may still be the only proof of a
  contract; prove otherwise before removing it.

## Steps

1. **Discover.** Read-only. For a broad scope, split it along production owner
   boundaries (not file prefixes) and give each part to its own read-only
   subagent, plus one cross-cutting junk-pattern sweep. Without subagents,
   sweep the parts one at a time as separate read-only passes. Done when each
   candidate names its junk pattern.
2. **Collect evidence.** Before judging a candidate, read the complete test,
   its production owner, entry point, callers, sibling implementations,
   overlapping tests, CI routing, and git history. When the test claims
   dependency-backed behavior, read the dependency's source or types. Done when
   every candidate has every field below; a missing field means it is not ready
   for deletion:
   - exact test name and location;
   - what failure it can actually detect;
   - non-test callers of the covered production or support seam;
   - the keeper that still proves the contract, or why no proof is needed;
   - why the test or seam exists, from history;
   - production or test-support code its deletion unlocks;
   - risk and the focused validation command.
3. **Edit** one coherent owner-boundary batch. Delete test-only exports,
   globals, wrappers, and dead production paths rather than keeping aliases.
   Move retained regressions to their keepers. Consolidate repeated dependency
   assertions into one contract. Aim for net-negative production LOC, and drop
   uncertain candidates rather than inflating the count. Done when every edit
   traces to a candidate with complete evidence.
4. **Validate.** Done when all of these pass:
   - the smallest owner and sibling tests;
   - for a removed source grep or config assertion, the script, build, or
     dry-run that owns the real contract;
   - the repository's formatter and linter on changed paths, and
     `git diff --check`;
   - the changed-files gate the repository's CI runs;
   - `git diff --numstat` reviewed, production and tooling counted apart from
     tests and test support.

Commit, push, or open a PR only when the user authorizes it. Land one batch at
a time; after it lands, refresh from the default branch and rediscover before
the next batch.

## Report

- removed low-value categories and their root cause;
- production seams removed;
- retained false positives and why they stay;
- focused and full proof actually run;
- production versus test LOC;
- commit, PR, and merge state;
- named follow-ups.
