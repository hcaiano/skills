---
name: ship-it
description: "Manual-only delivery gate for finished work: one graded local review round, one material correction batch, deterministic final-HEAD validation, then delivery. Invoke only when the user explicitly names ship-it or another explicitly invoked workflow delegates its graded gate."
disable-model-invocation: true
---

# Ship It

Open or update a PR for the current work, then carry an authorized delivery
through merge and deploy. Quality is enforced locally, before the PR exists.

Run it only when the user invokes ship-it or another skill (an orchestrator's
graded gate) delegates to it — finishing a change is not an invitation to
ship it.

1. **Prepare the local gate.** Read the repository instructions and inspect
   the current branch, diff, and working tree. Preserve unrelated user changes.
   `git fetch origin <target-branch>` first, and take every merge base in this
   skill against `origin/<target-branch>` — a stale local target reviews
   another PR's commits. Mark each intended untracked path with
   `git add --intent-to-add -- <path>` so focused proof and simplification see
   the complete change; never do this to unrelated files. If the worktree is
   on the target branch, create an intentional task branch before step 2.

   Read pool capacity before committing either review pool: run
   `node scripts/usage-state.mjs` from the herdr-orchestrate skill
   installed alongside this one; a pool is out of headroom at
   `used_percent` ≥ 90 or when its CLI is observed refusing — a null
   reading never degrades on its own.
   A pool inside its headroom but reading `pace` above 2 spends at twice
   what the rest of its window funds, so it empties before its reset. The
   graded reviews still run at that pace; what gives way is the Claude
   simplify pass, and only to `claude.pace` (step 3).
   Before starting any simplify or native review command, read and follow the
   [process transport contract](references/visible-herdr-runs.md). An
   interactive slash command in the current agent pane is already visible.
   Every external command uses the transport helper. With `HERDR_ENV=1`, a
   complete caller proof selects a visible, user-interruptible Herdr pane;
   missing or incomplete proof stops the gate. Outside Herdr, the helper uses
   a local background process. The completion receipt records the selected
   transport. This step is complete when the target, pool state, and transport
   prerequisites are explicit.
2. **Finish the implementation and proportional focused proof.** Keep the
   branch local. Map each changed runtime contract to its changed behavior and
   changed direct consumers, then run the smallest repository-defined tests and
   checks that exercise that map. A changed direct consumer is a path in the
   final diff that imports, calls, builds against, or relies on the changed
   contract; sharing a path or subsystem does not make it part of the proof.

   Treat path migrations as a focused branch: prove applicable old references
   are gone, new paths resolve, moved artifacts preserve their invariants, and
   changed direct consumers pass. The PR's native CI owns broader subsystem and
   platform coverage.

   When the local platform blocks a focused command, make one focused attempt
   through the repository's existing command or configuration. If the same
   incompatibility remains, record the command and evidence, then assign that
   check to the PR's native CI. Keep the local validation map closed to changed
   surfaces: an unrelated passing suite does not compensate for missing
   platform proof. This step is complete when the requested behavior is
   present, every mapped local check passes, and each platform-delegated check
   is explicit.
3. **Grade, then simplify** — ship-it is the primary authority for the
   delivery gate. Grade the complete focused-proven diff by its semantics:
   - `skip` — a non-runtime change, or a mechanical low-risk runtime change,
     whose specification is closed and whose focused proof covers every
     altered behavior. It runs no simplify and no LLM review, proceeding only
     through exact final-HEAD validation, required and delegated CI, PR receipt
     verification, and live-review surfaces.
   - `single` — a normal runtime change contained within one subsystem.
   - `dual` — auth, permissions, security, payments, migrations, destructive
     data, infrastructure, concurrency, public contracts, cross-service or
     multi-subsystem changes; ambiguous requirements; or a blast radius that
     focused proof cannot bound.

   Staffing, implementing model, and use of a pair never choose the grade or
   number of reviews. An explicit user grade is a floor. An orchestrator's
   issue-time grade is provisional: regrade the actual diff here and record
   why it stayed the same, rose, or fell. Any uncertainty about satisfying
   `skip` promotes to `single`; any uncertainty about subsystem containment,
   requirements, or blast radius promotes to `dual`. After the semantic grade
   is fixed, `single` prefers a reviewer from the model family that did not
   implement the change, then the cooler available pool; `dual` requires both
   families. Claude out records `dual — degraded to codex-only`; Codex out
   records `dual — degraded to claude-only`; capacity changes execution, not
   the semantic grade. With a reviewed gate, both out → stop and ask the user
   whether to use whichever harness still responds or wait for a reset. Tell
   the user the candidate grade and every capacity degradation.

   The ship-it driver also owns the simplify decision. Name one concrete
   structural target:
   duplicated production logic, avoidable cross-file indirection, or complex
   branching/state orchestration. Run `/simplify` only when that named target
   makes a behavior-preserving reduction likely; size alone is not a target.
   Choose a recorded simplify skip when there is no concrete target, when the
   delivery grade is `skip`, or when the change's core surface is
   docs/Markdown/config, generated output, migrations, schemas/contracts,
   allowlists, or security/performance guards. A user-requested simplify pass
   overrides every one of those eligibility skips, at any grade including
   `skip` — the user asking for it is the target.

   Simplify is independent of reviewer count. An eligible pass runs once per
   delivery, after focused proof and before review so reviewers see the
   resulting diff. Claude being unavailable or `claude.pace` above 2 records a
   skip.
   Skip an existing receipt only when its `Simplify:` line names the current
   clean review HEAD and the complete diff has not changed, or proves an
   applicable eligibility skip. A failed/aborted attempt is not success.
   Otherwise have Claude run its native `/simplify` command on the
   focused-proven implementation diff:
   - When Claude is driving, invoke `/simplify` directly in its visible pane.
     In a live pair, Codex may ask the Claude peer to do the same.
   - Otherwise launch the bundled wrapper through the process transport.
     The wrapper owns the baseline patch, liveness deadline, kill, verified
     restore, content validation, and leftover-untracked report:
     `node <skill dir>/scripts/headless-claude.mjs "/simplify" --writable true
     --receipt <simplify-result.json>`.

     Exit 0 with `{ok: true}` is the only success. On `{ok: false}` the
     tree is already restored (a `restore_error` means it is NOT — inspect
     before touching anything). Record `failed — <reason>` on the receipt's
     `Simplify:` line, mark Claude unavailable, and apply step 3's capacity
     rules without changing the semantic grade. Continue only when Codex can
     execute the reviewed gate as `single — Codex` or `dual — degraded to
     codex-only`; otherwise stop.
   On success, keep Claude's changes in the working tree. This step is complete
   only when the candidate review grade is recorded and simplify has a
   successful receipt naming the structural target, a recorded
   eligibility/capacity skip, or a failed attempt whose recorded capacity
   disposition preserves the semantic grade.
4. **Finalize the initial review HEAD.** When simplify ran, inspect every edit
   and rerun the focused tests and checks affected by it. Create clear,
   intentional local commits and reach a clean review HEAD without pushing.
   Reapply step 3's risk grade to this resulting complete diff and record the
   final grade plus any change from the candidate. This step is complete when
   the final diff has focused proof, `git status` contains no intended
   uncommitted change, and the initial review grade is explicit.
5. **Review Standards and Spec** on that exact review HEAD. `skip` records its
   semantic reason and runs no native review. `single` and a capacity-degraded
   `dual` use one native reviewer to cover **Standards + Spec**.
   `dual` assigns one native reviewer to **Standards** (correctness, security,
   regressions, repository conventions, and test quality) and the other to
   **Spec** (requested behavior, acceptance criteria, scope, and applicable
   source documents). Two reviews from the same harness do not satisfy `dual`.

   A `single` reviewer promotes the gate before any correction when it finds
   a valid material issue that crosses into the other axis, discovers a
   `dual` signal from step 3, finds conflicting source authority, or cannot
   confidently close either axis. Run the missing reviewer against the same
   review HEAD; a local, bounded finding stays `single`. Apply the capacity
   degradation from step 3 if promotion cannot reach both pools, and record it.

   A one-review gate stops if its review cannot complete and never regrades to
   another agent. A `dual` review that cannot complete preserves its semantic
   grade and records degraded execution on the other harness alone, named in
   the receipt. A review completes on content: a refusal, rate-limit notice, or
   empty payload is a failed review even with exit zero. Rerun it or apply the
   capacity degradation under these rules; never count it. In-flight feedback
   from implementation is not this fresh final-diff gate:
   - Run your own NATIVE review harness against the merge base with the target
     branch. Use each agent's native command surface, not an assumed repository
     skill:
     - Claude Code: invoke the `/code-review` slash command itself on Opus in
       Claude's visible agent pane, or launch
       `node <skill dir>/scripts/headless-claude.mjs "/code-review" --receipt
       <review-result.json>` through the process transport (read-only plan
       mode). `{ok: true}` with a non-empty result is the only pass. This gate
       is satisfied only by running `/code-review` in full; nothing improvised
       stands in for it.
     - Codex: launch the bundled `headless-codex.mjs "<axis prompt>" --base
       origin/<target-branch>` wrapper through the process
       transport. The wrapper resolves the merge base before starting the
       review, pins that range in the prompt, and records the resolved SHA in
       its receipt. `codex exec` with a freeform prompt does not satisfy this
       gate. `{ok: true}` with a non-empty result is the only pass.
     Name the assigned axis in the wrapper prompt, include its applicable
     sources, and require read-only findings output. Both harnesses may run focused
     verification; step 7 owns proportional final-HEAD validation; step 9 owns
     native PR-CI proof. An
     improvised read-through of the diff does not count.
     Model budget: Claude uses Opus (`--model opus`), never Fable; Codex uses
     its default model with no extra-high reasoning. Fable is advisor-only.
   - `dual` only — start the Standards and Spec reviews in distinct panes
     before waiting for either.
     In a herdr-pair session, ask the Claude peer through the pair channel to
     run its visible native slash command when applicable; external commands
     still use the process transport. Outside a pair, launch the counterpart
     through the same transport.
   This step is complete when every required axis has valid findings output
   against the same review HEAD.
6. **Correct material findings in one batch.** A `skip` gate writes its
   receipt and proceeds to step 7. Every reviewed gate merges and deduplicates
   the findings, verifies each against the real code path, and applies every
   valid, material, in-scope correction in one batch. Discard style nits and
   out-of-scope suggestions, recording useful follow-ups instead. A correction
   that requires a new contract or architecture, or roughly doubles the diff,
   is a follow-up that stops the gate for user direction.

   The delivery gets one LLM review round. A second, final review round happens
   only when the correction batch substantially changes behavior, expands the
   authorized scope, or introduces a new security or architectural risk. Run
   that conditional review against the complete corrected diff on the
   applicable axes. A changed SHA, ordinary implementation edits, or the
   possibility of further polish does not trigger it.

   Apply any valid, material, in-scope findings from that conditional review in
   one batch without a third review. If those corrections themselves require
   another qualifying behavior, scope, security, or architecture change, stop
   for user direction instead of opening another review cycle. Rerun the
   affected focused proof, commit all corrections, and reach a clean final
   HEAD. Every later branch mutation in this delivery follows the same trigger:
   retain the existing review when the change is bounded, or spend the single
   conditional review when it qualifies and has not already run.
   This step is complete when every finding has a disposition, the conditional
   review decision is recorded, focused proof passes, and the final HEAD is
   clean.
7. **Validate the final HEAD, then push it.** On the clean final HEAD, rerun
   step 2's proportional validation map for the final diff: repository-defined
   test, lint, typecheck, and build entries covering the changed contracts and
   their changed direct consumers. One aggregate command may satisfy its
   included checks; run the complete local-CI entrypoint only when repository
   instructions or branch policy name it as the delivery authority. Use the
   repo's queued/coalesced entrypoint without a manual lease when present;
   otherwise use its documented `global-ci` lease. Fix a code failure in one
   batch under step 6's review trigger, then rerun the affected proportional
   gate on the resulting HEAD. Preserve a platform incompatibility already
   delegated in step 2 as an explicit pending PR-CI obligation. Missing native
   coverage for an applicable risk blocks delivery; it does not expand the
   local validation map.

   After it passes, push normally. Mandatory pre-push checks must also pass,
   but do not replace the already-recorded final-HEAD validation. Record the
   exact pushed HEAD and successful results. This step is complete only when
   the remote head equals the final validated HEAD, its proportional local gate
   passed on that SHA, and every native-CI delegation is named for step 9.

   Leave a `## Delivery gate` receipt for the PR body. Include `Gate:`
   (`skip — <reason>` / `single — <reviewer>; <reason>` / `dual` / semantic
   grade plus any degraded execution and reason), `Risk:` (the semantic
   classification signals and known or unbounded blast radius), `Focused
   proof:` (why its exact commands cover every altered behavior), `Regrade:`
   (why the actual final diff stayed at, rose above, or fell below the
   provisional grade), `Simplify:`
   (`applied in <sha> — target: <target>` / `already run` /
   `skipped — <reason>` / `failed — <reason>`),
   `Reviewed HEAD: <40-character last gate-reviewed SHA, an ancestor of the
   final HEAD whenever the gate found anything>`,
   `Final validated HEAD: <40-character pushed SHA>`, the deterministic commands
   and results, every check delegated to native PR CI and why, whether the
   conditional review ran and why, each reviewer, native command, assigned
   axis, finding count, and each finding's disposition (`fixed in <sha>` /
   `deferred to #N` / discarded reason). A skipped gate states its reason.
   Those three fields are the delivery's chain of custody — reviewed at this
   ancestor, fixed in these SHAs, validated on the head that ships — so a
   corrected delivery is expected to carry two different HEADs.
   For every external process, record `Transport: herdr|local`, its matching
   completion receipt, and transcript. A Herdr record also names the visible
   process pane and confirms that the lead closed it after validating its
   artifacts. The receipt is complete when it truthfully distinguishes
   transport, review evidence, proportional final-HEAD proof, and pending
   native-CI obligations.
8. **Open or update the PR and verify its receipt.** Maintain one accurate,
   ready-for-review PR whose body carries the review and final-CI receipts —
   no receipt, no PR. Create new PRs as non-draft and verify GitHub preserved
   that state. Record the live-review baseline timestamp immediately before the
   first complete paginated fetch of current reviews, comments, and unresolved
   threads, then handle those surfaces. A branch mutation returns to steps 6–8 and must finish with a new
   deterministic gate, push, and PR update.
   This step is complete when the live PR, its body, its base, and its head all
   match the verified final receipt and the baseline is explicit.
9. Wait for required checks and every native-CI check delegated in steps 2 or
   7 on the exact PR head (poll at 60–120 s intervals, never tight loops).
   Delegated checks are delivery-required even when branch protection does not
   mark them required. Cloud auto-review bots are disabled by design — never
   wait for or solicit one. Green means every required and delegated check
   passed; pending is not green. A check that cannot run at all (billing,
   runner outage, missing native coverage) is a blocker — report the PR blocked
   on it, never shipped with a waiver. Fix a red check with one batched commit
   under step 6's review trigger and return to steps 7–8; after two red rounds,
   stop and report.
   Immediately before reporting shipped, re-fetch complete paginated reviews,
   issue comments, inline comments, and review threads, and capture the live
   `headRefOid`. Require it to match both the final-CI receipt SHA and the SHA
   whose required and delegated checks passed; any mismatch returns to steps
   6–9. Handle every item newer than the baseline and every unresolved thread.
   A branch change returns to steps 6–9. Require GitHub to report the PR
   mergeable against its base; a conflict merges the base into the branch and
   returns to steps 6–9. Record the clean check timestamp and head.
10. **Merge and deploy when authorized.** A ship-it invocation authorizes its
    local gate, push, and PR work; merge and deployment require explicit user
    authorization or an enclosing workflow with standing authorization. When
    that authority is already present, proceed directly without another LLM
    review or confirmation. Merge with the repository's documented method,
    verify the merged commit and base state, then run the repository's
    documented deployment path when deployment is in scope. Verify the
    deployment with its required rollout, health, or canary evidence. Without
    merge or deploy authority, stop at the corresponding ready state and name
    the missing authorization.
11. Report the outcome to the user: PR link, exact head, deterministic and
    required-check status, live-review timestamp, receipt summary, merge and
    deployment evidence when applicable, and any findings discarded or
    deferred.

Do not force-push, modify `main`, broaden scope, or change the target branch
without explicit authorization. When the base moved under the branch, merge
`origin/<target>` in and apply step 6's review trigger to the merge HEAD — a
pushed branch is never rebased, so force-push is never needed. Done when the PR
has truthful review and passing final-validation receipts, required checks and
live-review surfaces are clean on the exact head, every authorized merge or
deployment is verified, and the user has the report.
