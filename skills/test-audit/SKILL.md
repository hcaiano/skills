---
name: test-audit
description: "Test value gate and pruning workflow. Use when adding or changing tests, auditing a suite for low-value tests, or running a test-pruning campaign."
argument-hint: "[path, subsystem, or 'campaign']"
---

# Test Audit

One value bar, three modes:

- **Authoring**: gate every new or changed test before it lands.
- **Audit**: a focused, read-only sweep for tests that fail the bar, then one
  coherent deletion batch. Before starting one, read
  [references/audit.md](references/audit.md).
- **Campaign**: clean a whole app's test surface before a legacy refactor, one
  PR per subsystem. Before starting one, read
  [references/campaign.md](references/campaign.md).

Run tests through the repository's own commands (`package.json` scripts,
`Makefile`, CI workflows).

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
