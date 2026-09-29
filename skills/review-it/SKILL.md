---
name: review-it
description: "Manual-only graded review gate for a finished change: risk grade, one Standards and Spec review round from a different model family, one correction batch, then a receipt. Leaves a clean local HEAD and never pushes, opens, or merges anything. Invoke only when the user explicitly names review-it or an explicitly invoked workflow delegates its graded gate."
disable-model-invocation: true
---

# Review gate

Grade a finished change, have other models review it, and fix what they find.
The gate ends at a clean local HEAD and a `## Review gate` receipt. It never
pushes, opens or updates a PR, waits on CI, merges, or deploys, so it is safe
on a branch whose PR already exists.

Run it only when the user invokes review-it or ship-it delegates to it.

## 1. Fix the range

Resolve the range once, tell the user, and never recompute it mid-gate:

- default: the merge base with `origin/<target-branch>`, after
  `git fetch origin <target-branch>`. A stale local target reviews another
  PR's commits.
- an explicit commit, when re-reviewing one landed change.
- the uncommitted working tree, when nothing is committed yet.

Mark each intended untracked path with `git add --intent-to-add -- <path>` so
reviewers see it. Never do this to unrelated files.

The caller has already run the smallest repo checks that cover the change.
Standalone, run them first. Do not review a moving target.

## 2. Grade

Grade the complete diff by what it changes:

- `skip`: docs, config, or a mechanical low-risk change whose focused proof
  covers every altered behavior. No LLM review.
- `single`: a normal runtime change inside one subsystem.
- `dual`: auth, permissions, security, payments, migrations, destructive data,
  infrastructure, concurrency, public contracts, cross-subsystem changes,
  ambiguous requirements, or a blast radius the focused proof cannot bound.

When unsure, go up one grade. An explicit user grade is a floor. A caller's
earlier grade is provisional: regrade the actual diff and record why.

## 3. Staff the reviewers

`single` uses one reviewer from a model family that did not implement the
change. `dual` uses two different families, one per axis. Pick from native
Claude (Opus), native Codex (its default model), and Cursor (Fable or Sol from
`other_models`; Grok from `cursor_models` only as a fallback). Never Google
models or Composer.

Check capacity first with `node <orchestrate-dir>/scripts/usage-state.mjs`
from the sibling `orchestrate` skill. Skip a pool at `used_percent` >= 90, with
`pace` > 1, or whose CLI refuses. If no eligible pool remains, state the
use, pace, and reset, and ask whether to spend a protected pool or wait. When
only one pool is left for a `dual`, run one reviewer on both axes and record
the reduction. If the helper is not installed, record that and staff anyway.

## 4. Review

Read [the review brief](references/review-brief.md) and paste its rules and the
assigned axes into each reviewer prompt, with the pinned range, the commit list,
the repo's instruction files, and the spec source. `single` covers Standards
and Spec in one review. `dual` assigns Standards to one reviewer and Spec to the
other; start both before waiting on either.

Run external commands through [the process transport](references/visible-herdr-runs.md):

- Claude: `node <skill dir>/scripts/headless-claude.mjs "<brief prompt>"
  --receipt <review.json>` (read-only plan mode, Opus). When Claude is the lead
  in its own visible pane and did not implement the change, it may review
  directly with the brief instead.
- Codex: `node <skill dir>/scripts/headless-codex.mjs "<brief prompt>" --base
  origin/<target-branch> --receipt <review.json>`. Use `--commit <sha>` or
  `--uncommitted` for those ranges. The wrapper pins the range itself.
- Cursor: `node <skill dir>/scripts/headless-cursor.mjs "<brief prompt>"
  --model <live-catalog-id> --base origin/<target-branch> --receipt
  <review.json>`, with the same range selectors.

A review counts only when the wrapper returns `{ok: true}` with non-empty
findings output. A refusal, rate-limit notice, or empty payload is a failed
review even with exit 0: rerun it or restaff under step 3. An improvised
read-through does not count.

If a `single` reviewer finds a material problem on the other axis, a `dual`
signal, or conflicting sources, promote to `dual` and run the missing reviewer
on the same HEAD.

## 5. Fix in one batch

Deduplicate the findings and check each one against the real code. Apply every
valid, material, in-scope finding in one batch, including structural
simplifications that keep behavior. Discard nits and record out-of-scope ideas
as follow-ups. A fix that needs a new contract or architecture, or roughly
doubles the diff, stops the gate for user direction.

Run a second, final review only when the batch changes behavior, expands
scope, or adds a security or architecture risk. Apply its valid findings
without a third review. If those fixes would need another such change, stop
for user direction.

Rerun the affected focused checks. On a branch range, commit the fixes and end
on a clean HEAD. On an uncommitted range, leave the fixes in the working tree
and commit nothing.

## 6. Receipt

Leave this block. Callers embed it verbatim.

```markdown
## Review gate
- Gate: <skip | single | dual> — <reason; any capacity reduction>
- Risk: <signals and blast radius>
- Regrade: <kept, raised, or lowered, and why>
- Reviewers: <harness/model — axis — finding count>
- Findings: <each finding — fixed in <sha> | deferred to <issue> | discarded: <reason>>
- Second review: <ran or skipped, and why>
- Reviewed HEAD: <40-char SHA the reviewers read>
- Gate HEAD: <40-char SHA the gate ends on; `<sha> — uncommitted` for a working-tree range>
- Transport: <each run's transport, label, and receipt path>
```

Paste SHAs from `git rev-parse HEAD`; never retype them.

## Report

Give the user the receipt, each discarded or deferred finding, and the HEAD the
gate ends on. Say that nothing was pushed and what the change still needs to
ship.
