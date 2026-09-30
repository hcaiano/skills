---
name: review-it
description: "Grade, review, and correct a finished change, ending at a clean local HEAD and a receipt."
disable-model-invocation: true
---

# Review gate

The gate ends at a clean local HEAD and a `## Review gate` receipt. Pushing,
PRs, CI, merge, and deploy stay with the caller, so the gate is safe on a
branch whose PR already exists.

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

A change that deletes or weakens test coverage is at least `single`. When
unsure, go up one grade. An explicit user grade is a floor. A caller's earlier
grade is provisional: regrade the actual diff and record why.

## 3. Staff the reviewers

`single` uses one reviewer from a model family that did not implement the
change. `dual` uses two different families, one per axis. Staff them from the
roster's [Review seat](../pair/references/models.md#review-seat); the roster
owns the families, their IDs, and their efforts.

Read capacity first with `node <pair-dir>/scripts/usage-state.mjs` from the
sibling `pair` skill, and skip any pool whose `states` entry is not
`available`; a Cursor model draws on the Cursor pool that bills it. The
roster's [Pools](../pair/references/models.md#pools) section defines the
states. When the Codex pool is skipped, a Cursor family from the Review seat
takes that reviewer's place; record the swap. When only one family is left for
a `dual`, run one reviewer on both axes and record the reduction. If no
eligible family remains, state each pool's use, pace, and reset, and ask
whether to spend a protected pool or wait. If the helper is not installed,
record that and staff anyway.

## 4. Review

Read [the review brief](references/review-brief.md) and paste its rules and the
assigned axes into each reviewer prompt, with the pinned range, the commit list,
the repo's instruction files, and the spec source. `single` covers Standards
and Spec in one review. `dual` assigns Standards to one reviewer and Spec to the
other; start both before waiting on either.

Each reviewer runs read-only through its wrapper in this skill's `scripts/`,
at the seat's model and effort:

- Claude: `headless-claude.mjs "<prompt>" --effort <effort>` (Opus by default).
- Codex: `headless-codex.mjs "<prompt>" --model <id> --effort <effort>
  --base origin/<target-branch>`.
- Cursor: `headless-cursor.mjs "<prompt>" --model <id>
  --base origin/<target-branch>`; the ID carries the effort and must appear in
  `cursor-agent --list-models`.

The Codex and Cursor wrappers pin the range themselves; pass `--commit <sha>`
or `--uncommitted` for those ranges. Launch each wrapper through the process
transport:

```bash
RUN_TRANSPORT=<skill dir>/scripts/run-transport.mjs
RUN=$(node "$RUN_TRANSPORT" start "${CALLER_ID[@]}" \
  --label "review-it · <standards|spec|combined> review" \
  -- node <skill dir>/scripts/<wrapper> <args...> --receipt <review.json>)
node "$RUN_TRANSPORT" wait --run-file "$(printf '%s' "$RUN" | jq -r .run_file)"
```

Outside Herdr and in a headless pair executor, `CALLER_ID` stays empty and the
run is a local background process: tell the user its label and transcript path.
Inside an interactive Herdr lead, read
[visible Herdr runs](references/visible-herdr-runs.md) first; it builds
`CALLER_ID` and owns the pane rules.

A review counts only when `wait` succeeds and the wrapper receipt holds
`{ok: true}` with non-empty findings output. A refusal, rate-limit notice, or
empty payload is a failed review even with exit 0: rerun it or restaff under
step 3.

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
- Transport: <each run's transport, label, receipt path, and closed Herdr pane>
```

Paste SHAs from `git rev-parse HEAD`; never retype them.

## Report

Give the user the receipt, each discarded or deferred finding, and the HEAD the
gate ends on. Say that nothing was pushed and what the change still needs to
ship.
