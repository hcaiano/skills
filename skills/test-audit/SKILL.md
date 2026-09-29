---
name: test-audit
description: "Test value gate and pruning workflow. Use when adding or changing tests, auditing a suite for low-value, duplicated, or implementation-coupled tests, or running a test-pruning campaign."
argument-hint: "[path, subsystem, or 'campaign <subsystem>']"
---

# Test Audit

One value bar, three modes:

- **Authoring**: gate every new or changed test before it lands.
- **Audit**: a focused, read-only sweep for tests that fail the bar, then one
  coherent deletion batch. Optimize for confidence, not deletion count.
- **Campaign**: prune one subsystem's whole test surface in one PR. Before
  starting one, read [references/campaign.md](references/campaign.md).

Read the root and scoped `AGENTS.md` / `CLAUDE.md` first. Take test commands
from the repository (`package.json` scripts, `Makefile`, CI workflows), never
from memory.

## Authoring gate

Before adding or changing a test, answer four questions. A missing answer
means the test does not land yet.

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression turns it red?
3. Why does existing coverage not already catch that regression? Each contract
   has one **keeper**: the primary test at the strongest boundary. A second
   layer needs its own distinct risk, such as a transport or lifecycle failure
   the keeper cannot reach. Extend a table-driven case or shared fixture before
   writing a near-duplicate, and consolidate duplicated setup in the same change.
4. Does it need a production seam (export, flag, wrapper, injection hook) that
   no production caller needs? Then test at the real boundary instead.

Then check it against every [junk pattern](#junk-patterns). A match fails the
gate unless the [retention bar](#retention-bar) names the contract the test
independently guards. A test that breaks under a behavior-preserving refactor
asserts implementation; rewrite it at the owning boundary before landing it.

A bug regression test must go red on the pre-fix code for the intended reason
and green after the owner-boundary fix. One that never went red proves the
mock, not the fix. One regression at the owner boundary covers the bug; do not
replay the scenario at every layer it crosses.

## Junk patterns

The shared checklist: the gate rejects new tests that match one, and audits
hunt existing tests that do.

- assertion-free coverage probes, and render-and-exists checks
  (`toBeDefined`, `toBeTruthy`, "renders without crashing") that nothing can
  turn red;
- snapshots of large output that reviewers approve without reading;
- tests that restate a constant, config value, type, schema shape, or declared
  flag instead of exercising what it promises;
- tests of framework or dependency behavior the app does not own;
- self-comparisons, identity copiers, and expected values produced by the
  helper or renderer under test;
- copied fixtures, inventories, manifests, or export lists;
- exact source, import, or string greps;
- private helpers or call shapes already covered at the real boundary;
- duplicate invocations of the same contract, and local replays of a shared
  helper's tests;
- mocks that implement the asserted behavior, or one identical mock standing in
  for different APIs;
- fixtures that supply the result, ordering, or callback the owner should
  produce, or persistence asserted against a store the path never writes;
- tests whose only purpose is keeping test-only exports, globals, or wrappers
  alive, and dead production code whose only callers are tests;
- negative controls that pass for an unrelated reason, such as a rejection from
  a different guard or one the production path never reaches;
- names or fixtures that promise more than the input exercises. Judge a test by
  its assertions, not its name.

## Retention bar

Keep a test when it independently enforces a public API, protocol, config,
migration, storage, security, auth, billing, platform, default, or
cross-package contract. Also keep:

- call ordering when order is observable behavior;
- regressions with a credible failure mode;
- source inspection when it is the cheapest independent guard: it fails when
  the contract changes (a user-facing key, byte, or path) and survives an
  identifier-only refactor.

A retained test that fails on the baseline is a possible product bug: reproduce
it and fix the owner rather than deleting it. Static or slow is not a deletion
reason. A test that resembles implementation may still be the only proof of a
contract; prove otherwise before removing it.

## Audit

1. **Discover.** Read-only. For a broad scope, split it along production owner
   boundaries (not file prefixes) and give each part to its own read-only
   subagent, plus one cross-cutting junk-pattern sweep. Prefer a few
   high-confidence candidates over a large speculative inventory. Done when
   each candidate names its junk pattern.
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
   - the smallest owner and sibling tests, via the repository's test command;
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

## Handoff

Report:

- removed low-value categories and their root cause;
- production seams removed;
- retained false positives and why they stay;
- focused and full proof actually run;
- production versus test LOC;
- commit, PR, and merge state;
- named follow-ups.
