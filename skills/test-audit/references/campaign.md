# Test-pruning campaign

A campaign cleans a whole app's test surface, usually to prepare a legacy app
for refactoring. The scope is the app; delivery is one PR per **subsystem**.
The authoring gate, junk patterns, and retention bar in
[SKILL.md](../SKILL.md), and the deletion rules, candidate evidence,
validation, and report in [audit.md](audit.md), apply to every lane; read
audit.md before step 1. This file adds the order of work. Each step ends on its
completion criterion; do not start the next step early.

## Ground rules

- **The campaign lands before the refactor.** Test pruning and production
  refactors go in separate PRs, so lost coverage never hides inside a refactor
  diff. Removing test-only production seams belongs to the campaign;
  restructuring and behavior changes belong to the refactor. The one
  exception is a product defect a keeper exposes (step 7): it lands in its own
  commit with its own control run.
- **Keepers sit at boundaries the refactor keeps**: public API, HTTP routes,
  UI behavior, CLI, persisted data. A test pinning internals the refactor will
  change is consolidated (`C`) into such a keeper, not retained (`R`). The
  campaign's product is the safety net the refactor runs against.
- **Notes** (app map, baselines, ledgers, plans) live under
  `$(git rev-parse --git-common-dir)/test-audit/`: `app.md` for the app, one
  folder per subsystem. Only steps 1 and 9 write `app.md`; a subsystem writes
  only its own folder, so parallel subsystems never overwrite each other.
  Every worktree of the repository shares that directory, it is never
  committed, and it survives context compaction; reread it when resuming.

## 1. App map

Runs once per app. Pin the default-branch SHA. Record app-wide test,
test-support, and production line counts, and every test file's pass or fail
state. Keep baseline failures in their own list: they are product bug
candidates, not stale tests, until proven otherwise.

Split the app into subsystems along production owner boundaries: a package, an
app area, or a domain such as billing or auth. Each subsystem becomes one PR.
Order them by junk density and by what the refactor touches first. An app with
a few dozen test files can be a single subsystem.

Show the map and order to the user before starting the first subsystem.

Done when every test file belongs to exactly one subsystem, the order is
recorded, and the user has seen it.

Steps 2–8 run once per subsystem, in the recorded order. Start each from the
current default branch. Subsystems with no shared files may run in parallel
worktrees; changes to shared harnesses, fixtures, and test setup go through one
subsystem at a time.

## 2. Lanes

Split the subsystem into **lanes** along production owner boundaries, not file
prefixes. Include its cases at shared boundaries and its e2e, integration, and
fixture-harness tests.

Done when every test file the subsystem owns belongs to exactly one lane.

## 3. Ledger per lane

Give each lane to its own read-only subagent; without subagents, ledger the
lanes one at a time as separate read-only passes. Each pass reads every assigned
test in full, including parameter tables, and the production owners with their
entry points, callers, history, and CI routing. Each test declaration goes into
the lane's **ledger** with one mark and one evidence line. A parameterized
test (`it.each`, `test.each`, `@pytest.mark.parametrize`) is one declaration
unless its rows need different marks.

- `R` retain: name the contract and the bug it catches. A retained test that
  only moves to a better-named file stays `R` with the move noted.
- `F` fix: keep the contract, repair the assertion, such as a negative check
  that passes when only one of several items is missing.
- `C` consolidate: name the keeper that absorbs the assertion first, such as a
  sibling table case, a stronger boundary suite, or a shared owner elsewhere.
- `D` delete: name the proof that remains, or why no contract exists.

Done when every declaration in the lane has a mark and an evidence line.

## 4. Layer plan per lane

The ledger is input, not the edit list. A second read-only pass starts from the
ledger and looks for the redundant **layer**: several suites replaying the same
shared logic through mocks around a stronger real-boundary suite. Name the
keeper for each contract. Prefer the real boundary with a fake network,
database, or clock over a mocked collaborator. Correct ledger errors found here.

Done when each lane plan names its retired files, its keeper per contract, the
assertions to carry into keepers, and the test-only production seams unlocked.

## 5. Cutover

Edit lane by lane. With each lane, remove the test-only production seams it
unlocks: injection parameters, getters, reset exports, and indirection layers.
Update CI routing, test inventories, and coverage thresholds the moves affect.

The first subsystem PR adds one pointer line to the repository's `AGENTS.md`
or `CLAUDE.md`: `Before adding or changing tests, apply the test-audit
authoring gate.` Any PR may add a rule drawn from a mistake the campaign
actually found.

Done when every lane plan is applied and each lane's keepers pass.

## 6. Preservation review

Before claiming completion, have independent read-only reviewers, one per
boundary group, compare deleted coverage against the keepers. They look for
contracts that lost their only proof, and for new assertions that cannot fail,
such as a rejection row the production code never reaches. Run each reviewer
with `delegate_task`, read-only, on a different model than the author's.

For each restored contract, make one deliberate **mutation** of the production
owner and confirm the keeper goes red. Copy the owner file before mutating it;
after restoring, `cmp` it against that copy and delete the copy.

Done when every reported gap is restored or rejected with source evidence, and
every restored contract has a caught mutation.

## 7. Product defects

A baseline failure that survives into a keeper is a bug. Fix it at its owner in
a separate commit and prove it through the real user flow, with a **control**
run that reverts the fix and shows the old behavior. Record unrelated product
discrepancies as follow-ups instead of fixing them in the campaign.

Done when each repaired defect has a failing control and a passing candidate on
the same harness.

## 8. Reconcile and hand off the subsystem

Merge the default branch into the subsystem branch rather than rebasing it.
When the default branch changed a file the campaign deleted, keep the deletion,
port the new contract into its keeper, and confirm every new regression test
there still has a home. Rerun the whole subsystem suite on the merged head.

Run interrogate on the subsystem diff. Its intent paragraph carries the step-6
preservation review: each retired contract, the keeper that now proves it, and
the gaps restored with their mutations. Once the user authorizes delivery, open
the subsystem PR through poteto-mode's Opening a PR playbook. The PR carries
the [audit.md](audit.md) report, plus:

- baseline and final test and test-support line counts, production counted
  separately;
- lanes, retired layers, and keepers;
- preservation gaps found and their mutations;
- product defects with control and candidate proof;
- interrogate's Act On findings and how each was resolved.

Done when the report is saved as `result.md` in the subsystem's notes folder
and either the PR is open with each Act On finding fixed and verified
(restored coverage gets step 6's mutation proof) or rejected with source
evidence, or a blocking finding is reported to the user and the PR is held.

## 9. Close the app

After the last subsystem lands, rerun the whole app suite on the default
branch, merge every subsystem's `result.md` into `app.md`, and report:

- app-wide test, test-support, and production line counts, before and after;
- product defects found across the campaign;
- keepers the refactor should run against, per subsystem;
- lessons that should change this skill.
