---
name: review-it
description: "Manual-only graded review gate for a finished change: risk grade, one simplify pass, one graded LLM review round, one material correction batch, then a receipt. Leaves a clean local HEAD and never pushes, opens, or merges anything. Invoke only when the user explicitly names review-it or an explicitly invoked workflow delegates its graded gate."
disable-model-invocation: true
---

# Review Gate

Grade a finished change, simplify it, review it, and correct what the review
finds. The gate ends at a clean local HEAD and a `## Review gate` receipt.

It never pushes, opens or updates a PR, waits on CI, merges, or deploys. That
restraint is what makes it safe to run against a branch whose PR already
exists: it changes only the working tree and the local history its corrections
require.

Run it only when the user invokes review-it or ship-it delegates its graded
gate — finishing a change is not an invitation to review it.

## Fix the range first

Every later step reads the same range. Resolve it once, name it to the user,
and never recompute it mid-gate:

- default — the merge base with the target branch. `git fetch origin
  <target-branch>` first and take the merge base against
  `origin/<target-branch>`; a stale local target reviews another PR's commits.
- an explicit commit, when re-reviewing one landed change.
- the uncommitted working tree, when nothing is committed yet.

Mark each intended untracked path with `git add --intent-to-add -- <path>` so
simplification and review see the complete change; never do this to unrelated
files.

The gate assumes its caller already proved the change: the smallest
repository-defined checks covering every changed contract and its changed direct
consumers pass on this range. Standalone, run them before grading. A gate over
an unproven range reviews a moving target.

Read pool capacity before committing either review pool: run
`node scripts/usage-state.mjs` from the orchestrate skill installed
alongside this one. A pool is out of headroom at `used_percent` ≥ 90 or when its
CLI is observed refusing — a null reading never degrades on its own. A pool
inside its headroom but reading `pace` above 2 spends at twice what the rest of
its window funds, so it empties before its reset. The graded reviews still run
at that pace; what gives way is the Claude simplify pass, and only to
`claude.pace`.

That helper is a sibling skill, not a bundled one. When it is not installed,
record `Gate: <grade> — pool state unread (usage-state.mjs not installed)` and
run the grade's required reviewers anyway. A missing capacity reading leaves
the semantic grade, the reviewer count, and simplify exactly as graded; only an
observed CLI refusal degrades execution.

Before starting any simplify or review command, read and follow
[process transport](references/visible-herdr-runs.md). An interactive slash
command in the current agent pane is already visible; every external Claude or
Codex command runs through the transport, which records whether it ran in a
visible Herdr pane or as a local background process. The visible backend needs
`pair` installed beside this skill for its caller-pane proof, and
the two environments resolve its absence differently. Outside `HERDR_ENV=1` the
transport selects `local`, and the gate records that its runs had no live
surface for the user to watch or interject in. Inside `HERDR_ENV=1` a missing
proof stops the gate: a gate Herdr is hosting runs where the user can see it,
so tell the user to install `pair` rather than demoting the run to
an invisible process.

Done when the range, the pool state, and any required transport pin are
explicit.

## 1. Grade

Grade the complete proven diff by its semantics:

- `skip` — a non-runtime change, or a mechanical low-risk runtime change, whose
  specification is closed and whose focused proof covers every altered
  behavior. It runs no simplify and no LLM review.
- `single` — a normal runtime change contained within one subsystem.
- `dual` — auth, permissions, security, payments, migrations, destructive data,
  infrastructure, concurrency, public contracts, cross-service or
  multi-subsystem changes; ambiguous requirements; or a blast radius that
  focused proof cannot bound.

Staffing, implementing model, and use of a pair never choose the grade or number
of reviews. An explicit user grade is a floor. A caller's issue-time grade is
provisional: regrade the actual diff here and record why it stayed the same,
rose, or fell. Any uncertainty about satisfying `skip` promotes to `single`; any
uncertainty about subsystem containment, requirements, or blast radius promotes
to `dual`.

After the semantic grade is fixed, `single` prefers a reviewer from the model
family that did not implement the change, then the cooler available pool; `dual`
requires both families. Claude out records `dual — degraded to codex-only`;
Codex out records `dual — degraded to claude-only`; capacity changes execution,
not the semantic grade. With a reviewed gate, both out → stop and ask the user
whether to use whichever harness still responds or wait for a reset. Tell the
user the candidate grade and every capacity degradation.

Done when the candidate grade and every capacity degradation are recorded.

## 2. Simplify

Name one concrete structural target: duplicated production logic, avoidable
cross-file indirection, or complex branching/state orchestration. Run
`/simplify` only when that named target makes a behavior-preserving reduction
likely; size alone is not a target.

Choose a recorded simplify skip when there is no concrete target, when the grade
is `skip`, or when the change's core surface is docs/Markdown/config, generated
output, migrations, schemas/contracts, allowlists, or security/performance
guards. A user-requested simplify pass overrides every one of those eligibility
skips, at any grade including `skip` — the user asking for it is the target.

Simplify is independent of reviewer count. An eligible pass runs once per gate,
before review so reviewers see the resulting diff. Claude being unavailable or
`claude.pace` above 2 records a skip. Skip an existing receipt only when its
`Simplify:` line names the current clean review HEAD and the complete diff has
not changed, or proves an applicable eligibility skip. A failed or aborted
attempt is not success.

Otherwise have Claude run its native `/simplify` command on the proven diff:

- When Claude is driving, invoke `/simplify` directly in its visible pane. In a
  live pair, Codex may ask the Claude peer to do the same.
- Otherwise launch the bundled wrapper through the transport. The wrapper owns
  the baseline patch, liveness deadline, kill, verified restore, content
  validation, and leftover-untracked report:
  `node <skill dir>/scripts/headless-claude.mjs "/simplify" --writable true
  --receipt <simplify-result.json>`.

  Exit 0 with `{ok: true}` is the only success. On `{ok: false}` the tree is
  already restored (a `restore_error` means it is NOT — inspect before touching
  anything). Record `failed — <reason>` on the receipt's `Simplify:` line, mark
  Claude unavailable, and apply step 1's capacity rules without changing the
  semantic grade. Continue only when Codex can execute the reviewed gate as
  `single — Codex` or `dual — degraded to codex-only`; otherwise stop.

On success, keep Claude's changes in the working tree.

Done when simplify has a successful receipt naming the structural target, a
recorded eligibility or capacity skip, or a failed attempt whose recorded
capacity disposition preserves the semantic grade.

## 3. Finalize the review HEAD

When simplify ran, inspect every edit and rerun the focused tests and checks
affected by it. Reapply step 1's risk grade to the resulting complete diff and
record the final grade plus any change from the candidate.

Commit only what this gate is entitled to commit. When the range is a branch,
create clear, intentional local commits and reach a clean review
HEAD without pushing. When the range is the uncommitted working tree, that tree is the
review HEAD: review it in place and commit nothing the gate did not itself
produce — a `skip` grade over uncommitted work commits nothing at all.

Done when the final diff has focused proof, no correction the gate made is left
uncommitted on a branch range, and the review grade is explicit.

## 4. Review Standards and Spec

Review on that exact review HEAD. `skip` records its semantic reason and runs no
review. `single` and a capacity-degraded `dual` use one native reviewer to cover
**Standards + Spec**. `dual` assigns one native reviewer to **Standards**
(correctness, security, regressions, repository conventions, and test quality)
and the other to **Spec** (requested behavior, acceptance criteria, scope, and
applicable source documents). Two reviews from the same harness do not satisfy
`dual`.

A `single` reviewer promotes the gate before any correction when it finds a
valid material issue that crosses into the other axis, discovers a `dual` signal
from step 1, finds conflicting source authority, or cannot confidently close
either axis. Run the missing reviewer against the same review HEAD; a local,
bounded finding stays `single`. Apply the capacity degradation from step 1 if
promotion cannot reach both pools, and record it.

A one-review gate stops if its review cannot complete and never regrades to
another agent. A `dual` review that cannot complete preserves its semantic grade
and records degraded execution on the other harness alone, named in the receipt.
A review completes on content: a refusal, rate-limit notice, or empty payload is
a failed review even with exit zero. Rerun it or apply the capacity degradation
under these rules; never count it. In-flight feedback from implementation is not
this fresh final-diff gate.

Use each agent's native command surface, not an assumed repository skill:

- Claude Code: invoke the `/code-review` slash command itself on Opus in
  Claude's visible agent pane, or launch
  `node <skill dir>/scripts/headless-claude.mjs "/code-review" --receipt
  <review-result.json>` through the transport (read-only plan mode). This gate
  is satisfied only by running `/code-review` in full; nothing improvised stands
  in for it.
- Codex: launch the bundled
  `node <skill dir>/scripts/headless-codex.mjs "<axis prompt>" --base
  origin/<target-branch>` wrapper through the transport. The wrapper resolves
  the merge base before the review starts, pins that range in the prompt, and
  records the resolved SHA in its receipt, so the reviewed range is a fact
  rather than an instruction the model may skip. Use its `--commit` or
  `--uncommitted` selector when the gate's range is one of those. `codex exec`
  with a freeform prompt does not satisfy this gate.

`{ok: true}` with a non-empty result is the only pass for either wrapper. Name
the assigned axis in the reviewer's prompt, include its applicable sources, and
require read-only findings output. An improvised read-through of the diff does
not count. Model budget: Claude uses Opus (`--model opus`), never Fable; Codex
uses its default model with no extra-high reasoning. Fable is advisor-only.

`dual` only — start the Standards and Spec reviews in distinct panes before
waiting for either. In a `pair` session, ask the Claude peer through the
pair channel to run its visible native slash command when applicable; external
commands still use the transport.

Done when every required axis has valid findings output against the same review
HEAD.

## 5. Correct material findings in one batch

A `skip` gate writes its receipt and finishes. Every reviewed gate merges and
deduplicates the findings, verifies each against the real code path, and applies
every valid, material, in-scope correction in one batch. Discard style nits and
out-of-scope suggestions, recording useful follow-ups instead. A correction that
requires a new contract or architecture, or roughly doubles the diff, is a
follow-up that stops the gate for user direction.

The gate gets one LLM review round. A second, final review round happens only
when the correction batch substantially changes behavior, expands the authorized
scope, or introduces a new security or architectural risk. Run that conditional
review against the complete corrected diff on the applicable axes. A changed
SHA, ordinary implementation edits, or the possibility of further polish does
not trigger it.

Apply any valid, material, in-scope findings from that conditional review in one
batch without a third review. If those corrections themselves require another
qualifying behavior, scope, security, or architecture change, stop for user
direction instead of opening another review cycle. Rerun the affected focused
proof, then reach the end state this gate's range allows: on a branch range,
commit all corrections and reach a clean final HEAD; on an uncommitted range,
leave the corrections in the working tree beside the work already there, since
committing is what step 3 withheld.

Done when every finding has a disposition, the conditional review decision is
recorded, focused proof passes, and the gate's end state matches its range.

## 6. Write the receipt

Leave a `## Review gate` receipt. A caller that delivers this change embeds the
block verbatim rather than restating it.

- `Gate:` — `skip — <reason>` / `single — <reviewer>; <reason>` / `dual` /
  semantic grade plus any degraded execution and reason.
- `Risk:` — the semantic classification signals and known or unbounded blast
  radius.
- `Regrade:` — why the actual final diff stayed at, rose above, or fell below
  the provisional grade.
- `Simplify:` — `applied in <sha> — target: <target>` / `already run` /
  `skipped — <reason>` / `failed — <reason>`.
- `Reviewed HEAD:` — the 40-character last gate-reviewed SHA, an ancestor of the
  final HEAD whenever the gate found anything.
- `Gate HEAD:` — the 40-character clean SHA this gate ends on. On an
  uncommitted range, the unchanged SHA the reviewed tree sits on, written
  `<sha> — uncommitted` so no caller reads it as a shippable head.
- Each reviewer, its native command, assigned axis, finding count, and each
  finding's disposition (`fixed in <sha>` / `deferred to #N` / discarded
  reason), plus whether the conditional review ran and why.
- Every transport run: its transport, label, and matching completion receipt.
  Confirm each finished visible pane was closed after its artifacts were
  validated.

`Reviewed HEAD` and `Gate HEAD` are the gate's chain of custody — reviewed at
this ancestor, fixed in these SHAs — so a corrected gate is expected to carry
two different HEADs. A skipped gate states its reason.

Done when the receipt truthfully separates review evidence from the HEAD the
gate ends on, and every finding has a disposition.

## Report

Give the user the receipt summary, the final grade and any capacity degradation,
each finding discarded or deferred, and the exact HEAD the gate ends on — naming
the uncommitted corrections still in the working tree when the range was one.
Say plainly that nothing was pushed and no PR was touched, and name what the
change still needs to ship.
