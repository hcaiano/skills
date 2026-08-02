---
name: ship-it
description: "Ship finished work: the graded local review gate, then one PR carried to green CI. Use when the user wants to ship, open, or update a PR, or when another skill needs that graded gate."
---

# Ship It

Open or update a PR for the current work. Quality is enforced locally, before
the PR exists.

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

   Grade the gate before spending either review pool. A reproduced, localized,
   reversible production hotfix
   with a focused regression and no migration, auth or permission, payment,
   destructive-infrastructure, or public-API change uses `single`: skip pool
   grading and run only the current agent's native review. Otherwise the gate
   spends both usage pools — Claude (simplify + review) and Codex (review) — so
   fix its level before anything runs. When an orchestrator names a graded gate,
   ship-it still owns this hotfix check: `single` overrides that grade; otherwise
   the orchestrator's grade wins. Read the pools either way: run
   `node scripts/usage-state.mjs` from the herdr-orchestrate skill
   installed alongside this one; a pool is out of headroom at
   `used_percent` ≥ 90 or when its CLI is observed refusing — a null
   reading never degrades on its own. Absent an orchestrator grade, both
   pools with headroom → `dual`. Claude out → `codex-only`. Codex out →
   `claude-only`. Both out → stop and ask the user whether to ship on
   whichever harness still responds or wait for a reset. Tell the user the
   graded level when it is anything but `dual`.
   A pool inside its headroom but reading `pace` above 2 spends at twice
   what the rest of its window funds, so it empties before its reset. The
   graded reviews still run at that pace; what gives way is the Claude
   simplify pass, and only to `claude.pace` — a hot Codex pool never skips
   it (step 3).
   Before starting any simplify or native review command, read and follow
   [Visible Herdr runs](references/visible-herdr-runs.md). An interactive
   slash command in the current agent pane is already visible; every external
   Claude or Codex command runs in a labeled shell pane inside the same
   transcript-proven unit tab. A gate that needs an external process is
   blocked outside Herdr. This step is complete when the target, complete local
   diff, graded level, and any required visible-run pin are explicit.
2. **Finish the implementation and focused proof.** Keep the branch local.
   Complete the requested scope and run the smallest tests and checks that
   exercise the changed behavior. Fix failures until every intended change is
   present and the focused proof passes. The complete repository CI belongs to
   the final push in step 7; this step is complete without running it.
3. **Simplify pass** — once per review epoch, after the implementation and
   focused proof pass, and always before the review gate so the
   reviewers see the simplified diff; a `single` or `codex-only` gate skips
   it, as does `claude.pace` above 2 (step 1).
   Skip an existing receipt only when its `Simplify:` line names the current
   clean review HEAD and the complete diff has not changed, or proves an
   applicable docs-only skip. A failed/aborted attempt is not success.
   Otherwise have
   Claude run its native `/simplify` command on the focused-proven
   implementation diff:
   - When Claude is driving, invoke `/simplify` directly in its visible pane.
     In a live pair, Codex may ask the Claude peer to do the same.
   - Otherwise launch the bundled wrapper through the visible-run contract.
     The wrapper owns the baseline patch, liveness deadline, kill, verified
     restore, content validation, and leftover-untracked report:
     `node <skill dir>/scripts/headless-claude.mjs "/simplify" --writable true`.

     Exit 0 with `{ok: true}` is the only success. On `{ok: false}` the
     tree is already restored (a `restore_error` means it is NOT — inspect
     before touching anything). Record `failed — <reason>` on the receipt's
     `Simplify:` line, mark Claude unavailable, and regrade under step 1.
     Continue only when that regrade is explicitly `codex-only`; otherwise
     stop.
   On success, keep Claude's changes in the working tree. Skip simplify, like
   the gate, for docs/markdown/config-only diffs. This step is complete only
   with a successful receipt, an applicable pre-run skip, or a failed attempt
   whose recorded regrade is `codex-only`.
4. **Validate the simplified change.** Inspect every simplify edit and rerun
   the focused tests and checks affected by it. Create clear, intentional local
   commits and reach a clean review HEAD without pushing. This step is complete
   when the simplified diff has focused proof and `git status` contains no
   intended uncommitted change.
5. **Review Standards and Spec** on that exact review HEAD. `dual` assigns one
   native reviewer to **Standards** (correctness, security, regressions,
   repository conventions, and test quality) and the other to **Spec**
   (requested behavior, acceptance criteria, scope, and applicable source
   documents). `single`, `codex-only`, and `claude-only` use their one native
   review to cover **Standards + Spec**. Two reviews from the same harness do
   not satisfy `dual`.

   Skip only for diffs touching exclusively docs/markdown/config with no
   runtime surface; the receipt names the graded level. A one-review gate stops
   if its review cannot complete and never regrades to another agent. A `dual`
   review that cannot complete regrades to the other harness alone, named in
   the receipt. A review completes on content: a refusal, rate-limit notice, or
   empty payload is a failed review even with exit zero. Rerun it or regrade
   under these rules; never count it. In-flight feedback from implementation is
   not this fresh final-diff gate:
   - Run your own NATIVE review harness against the merge base with the target
     branch. Use each agent's native command surface, not an assumed repository
     skill:
     - Claude Code: invoke the `/code-review` slash command itself on Opus in
       Claude's visible agent pane, or launch
       `node <skill dir>/scripts/headless-claude.mjs "/code-review"` through
       the visible-run contract (read-only plan mode). `{ok: true}` with a
       non-empty result is the only pass. This gate is satisfied only by
       running `/code-review` in full; nothing improvised stands in for it.
     - Codex: launch `codex review "<final-diff review prompt>"` through the
       visible-run contract; generic `codex exec` does not satisfy this gate.
     The Codex prompt must name the exact complete diff command:
     `git diff "$(git merge-base HEAD origin/<target-branch>)"`. With intended
     changes committed in step 4, this covers the exact review HEAD from the
     true merge base. Name the assigned axis, include its applicable sources,
     and require read-only findings output. Both harnesses may run focused
     verification; step 7 owns the complete
     repository local-CI gate. An improvised read-through of the diff does not
     count.
     Model budget: Claude uses Opus (`--model opus`), never Fable; Codex uses
     its default model with no extra-high reasoning. Fable is advisor-only.
   - `dual` only — start the Standards and Spec reviews in distinct panes
     before waiting for either.
     In a herdr-pair session, ask the Claude peer through the pair channel to
     run its visible native slash command when applicable; external commands
     still use labeled process panes in this unit. Outside a pair, launch the
     counterpart through the same visible-run contract.
   This step is complete when every required axis has valid findings output
   against the same review HEAD.
6. **Correct once and re-review once.** Merge and deduplicate the findings,
   then verify each one against the real code path. Apply every valid, in-scope
   correction in one batch; discard style nits and out-of-scope suggestions,
   recording useful follow-ups instead. A correction that requires a new
   contract or architecture, or roughly doubles the diff, is a follow-up that
   stops the gate for user direction.

   Rerun the affected focused proof, commit the correction batch, and perform
   one read-only re-review round of only the correction diff on the applicable
   axes, starting parallel axes together. This is the sole correction/re-review
   round: surface remaining valid findings instead of starting another fix
   cycle. With zero valid initial findings, the initial review HEAD is already
   final. Otherwise this step is complete only when the correction commit is
   the clean final HEAD and the bounded re-review has valid content.

   Leave a `## Dual-review` receipt for the PR body with `Gate:`
   (`single — hotfix` / `dual` / degraded level and reason), `Simplify:`
   (`applied in <sha>` / `already run` / `skipped — <reason>` /
   `failed — <reason>`), `Reviewed HEAD: <40-character final SHA>`, each
   reviewer, native command, assigned axis, finding count, and each finding's
   disposition (`fixed in <sha>` / `deferred to #N` / discarded reason).
   A skipped gate states its reason. Name every visible process pane and its
   matching completion receipt. The gate is complete only when this receipt
   describes the clean final HEAD.
7. **Push the reviewed HEAD.** Push normally. When pre-push runs the complete
   local CI (for example `bun run ci:local`), require it to pass and use it as
   the only complete gate on this final HEAD; the push is its first invocation
   on that SHA. Use the repo's queued/coalesced entrypoint without a manual
   lease when present; otherwise use its documented `global-ci` lease. If
   pre-push has no complete gate, run the repository's full command once before
   pushing and require it to pass. A failure that changes the branch returns
   to step 2. Record the exact pushed HEAD and successful result. This step is
   complete only when the remote head equals the reviewed final HEAD and its
   authoritative local CI passed.
8. **Open or update the PR and verify its receipt.** Maintain one accurate,
   ready-for-review PR whose body carries the review and final-CI receipts —
   no receipt, no PR. Create new PRs as non-draft and verify GitHub preserved
   that state. Immediately run the repository's `review:verify` command when
   it exists (for example `bun run review:verify -- <pr-number>`); repair only
   PR-body receipt errors and rerun until it passes. Then handle current
   reviews, comments, and unresolved threads. A branch mutation returns to
   step 2 and must finish with a new push, PR update, and `review:verify` pass.
   This step is complete when the live PR, its body, its base, and its head all
   match the verified final receipt.
9. Wait for required checks on the exact PR head (poll at 60–120 s intervals,
   never tight loops). Required checks are the only thing waited on: cloud
   auto-review bots are disabled by design — never wait for or solicit one.
   Green means every required check passed; pending is not green. A check
   that cannot run at all (billing, runner outage) is a blocker — report the
   PR blocked on it, never shipped with a waiver. Fix a red check with one
   batched commit and return to
   steps 2–8; after two red rounds, stop and report. The same brake bounds
   the gate itself: a third full review gate on one PR — whoever asks for
   it — stops and surfaces the churn to the user instead of running.
   Immediately before reporting shipped, re-fetch complete paginated reviews,
   issue comments, inline comments, and review threads, and capture the live
   `headRefOid`. Require it to match both the final-CI receipt SHA and the SHA
   whose required checks passed; any mismatch returns to steps 2–9. Handle
   every item newer than the baseline and every unresolved thread. A branch
   change returns to steps 2–9. Require GitHub to report the PR mergeable
   against its base; a conflict returns to steps 2–9 after a merge from the
   base. Rerun `review:verify` after any PR-body or head change. Record the
   clean check timestamp and head.
10. Report the outcome to the user: PR link, exact head, CI status, live-review
   timestamp, receipt summary, and any findings discarded or deferred.

Do not force-push, merge, modify `main`, broaden scope, or change the target
branch without explicit authorization. When the base moved under the branch,
merge `origin/<target>` in and re-enter the gate on the merge HEAD — a
pushed branch is never rebased, so force-push is never needed. Done when the PR is open with the
dual-review and passing final-CI receipt in its body, green required checks, a
clean timestamped live-review check on the exact head, and the user has the
report.
