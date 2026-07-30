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

1. Read the repository instructions and inspect the current branch, diff, and
   working tree. Preserve unrelated user changes. `git fetch origin
   <target-branch>` first, and take every merge base in this skill against
   `origin/<target-branch>` — a stale local target reviews another PR's
   commits. Before review, mark each
   intended untracked path with `git add --intent-to-add -- <path>` so the
   complete diff includes its contents; never do this to unrelated files.
2. **Grade the gate.** A reproduced, localized, reversible production hotfix
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
3. **Simplify pass** — once per PR, always before the review gate so the
   reviewers see the simplified diff; a `single` or `codex-only` gate skips
   it, as does `claude.pace` above 2 (step 2).
   Skip an existing receipt only when its
   `Simplify:` line proves a successful prior run or an applicable
   docs-only skip; a failed/aborted attempt is not success. Otherwise have
   Claude run its native `/simplify` command on this same final diff:
   - In-session when Claude is driving, invoke `/simplify` directly.
   - From Codex/headless, run it through the bundled wrapper — it owns the
     baseline patch, liveness deadline, kill, verified restore, and content
     validation, and reports leftover untracked files for review:

     ```bash
     node <skill dir>/scripts/headless-claude.mjs "/simplify" --writable true
     ```

     Exit 0 with `{ok: true}` is the only success. On `{ok: false}` the
     tree is already restored (a `restore_error` means it is NOT — inspect
     before touching anything); mark Claude unavailable for this gate
     (step 4 regrades) and record `failed — <reason>` on the receipt's
     `Simplify:` line.
   On success, keep Claude's fixes in the working tree and run focused proof
   before the review gate. Skip simplify, like the gate, for
   docs/markdown/config-only diffs.
4. **Local review gate** at the graded level — `single`: the current agent's
   native review alone; `dual`: both native reviews below; `codex-only`: the
   Codex review alone; `claude-only`: the Claude review alone. `dual` means
   one Claude review plus one Codex review: two reviews from the same
   harness satisfy only that harness's single level, whatever conservation
   pressure suggested them. Skip only for
   diffs touching exclusively
   docs/markdown/config with no runtime surface; the receipt names the
   graded level. A one-review gate — `single`, `codex-only`, `claude-only` —
   stops if that review cannot complete and never regrades to another agent;
   a `dual` review that cannot complete regrades to the other harness alone,
   named in the receipt. A review completes on content, not exit code: a
   clean exit whose output is a refusal, a rate-limit notice, or an empty
   payload is a failed review — rerun it or regrade per the rules above,
   never count it. Everything else in this step
   applies to whichever review(s) run. This is a fresh adversarial
   review of the FINAL diff — reviews that happened while writing the code
   (pair acceptance, impeccable, in-flight feedback) are a different thing
   and leave this gate unrun:
   - Run your own NATIVE review harness against the merge base with the target
     branch. Use each agent's native command surface, not an assumed repository
     skill:
     - Claude Code: invoke the `/code-review` slash command itself on Opus —
       in-session when Claude is driving (the same command the user would
       type), or headless via
       `node <skill dir>/scripts/headless-claude.mjs "/code-review"`
       (read-only plan mode; `{ok: true}` with a non-empty result is the
       only pass). This gate is satisfied only by running `/code-review` in
       full; nothing improvised stands in for it.
     - Codex: run `codex review "<final-diff review prompt>"`. Do not use
       `--base` when the final diff also has staged or unstaged changes because
       that mode omits them; do not use generic `codex exec` for this gate.
     The Codex prompt must name the exact complete diff command:
     `git diff "$(git merge-base HEAD <target-branch>)"`. With intended
     untracked paths already marked intent-to-add, this covers committed,
     staged, unstaged, and intended new-file changes from the true merge base.
     Include the applicable spec sources and read-only output contract. Both
     harnesses may run focused verification; step 6 owns the complete
     repository local-CI gate. An improvised read-through of the diff does not
     count.
     Model budget: Claude uses Opus (`--model opus`), never Fable; Codex uses
     its default model with no extra-high reasoning. Fable is advisor-only.
   - `dual` only — in parallel, get a second independent review of the same
     diff from the other agent:
     - In a herdr-pair session, ask the peer (via `$ask-peer` / the pair
       channel) to run its native review harness and send back its findings.
     - Outside a pair, run the counterpart's headless command above on the
       same diff and collect its findings.
   - Merge and deduplicate the findings lists. Review output is advisory: a
     finding is valid only after you verify it against the real code path.
     Fix valid, in-scope findings in ONE batch. Discard style nits and
     out-of-scope suggestions (note the interesting ones in the PR description
     instead of fixing them). A fix that demands a new contract or
     architecture, or would roughly double the diff, is not a fix — stop and
     surface it as a follow-up. Re-review only the fix diff once to confirm it
     is clean — never a third full pass; surface any leftovers to the user
     instead.
   - The gate leaves a **receipt**: a `## Dual-review` section for the PR body
     opening with a `Gate:` line (`single — hotfix` / `dual` / the degraded
     level and why) and a
     `Simplify:` line (`applied in <sha>` / `already run` /
     `skipped — <reason>` / `failed — <reason>`), then naming the exact harness command each
     reviewer ran, the finding counts,
     and each valid finding's disposition (fixed in `<sha>` / deferred to
     `#N`). A skipped
     gate still leaves one stating the skip reason (e.g. docs-only diff).
5. Create clear, intentional commits and reach a clean final HEAD. Use focused
   proof before this point; reserve the complete local-CI gate for the push.
6. Push normally. When pre-push runs the complete local CI (for example
   `bun run ci:local`), require it to pass and use it as the only complete gate
   on this HEAD — do not run it manually first. Use the repo's queued/coalesced
   CI entrypoint without a manual lease when present; otherwise use its
   documented `global-ci` lease. If pre-push has no complete gate, run the
   repo's full command once before pushing and require it to pass. Put the exact
   HEAD and successful result in the receipt.
7. Open or update one accurate, ready-for-review PR whose body carries the
   gate and final-CI receipt — no receipt, no PR. Create new PRs as non-draft;
   verify after creation that GitHub preserved the intended ready state.
   Handle current reviews, comments, and unresolved threads. If that changes
   the branch, return to steps 4–7 before recording the clean live-review
   baseline time.
8. Wait for required checks on the exact PR head (poll at 60–120 s intervals,
   never tight loops). Required checks are the only thing waited on: cloud
   auto-review bots are disabled by design — never wait for or solicit one.
   Green means every required check passed; pending is not green. A check
   that cannot run at all (billing, runner outage) is a blocker — report the
   PR blocked on it, never shipped with a waiver. Fix a red check with one
   batched commit and return to
   steps 4–7; after two red rounds, stop and report. The same brake bounds
   the gate itself: a third full review gate on one PR — whoever asks for
   it — stops and surfaces the churn to the user instead of running.
9. Immediately before reporting shipped, re-fetch complete paginated reviews,
   issue comments, inline comments, and review threads, and capture the live
   `headRefOid`. Require it to match both the final-CI receipt SHA and the SHA
   whose required checks passed; any mismatch returns to steps 4–8. Handle
   every item newer than the baseline and every unresolved thread. If that
   changes the branch, return to steps 4–8. Require GitHub to report the PR
   mergeable against its base; a conflict returns to steps 4–8 after a merge
   from the base. `review:verify` proves only its
   timestamp. Record the clean check timestamp and head.
10. Report the outcome to the user: PR link, exact head, CI status, live-review
   timestamp, receipt summary, and any findings discarded or deferred.

Do not force-push, merge, modify `main`, broaden scope, or change the target
branch without explicit authorization. When the base moved under the branch,
merge `origin/<target>` in and re-enter the gate on the merge HEAD — a
pushed branch is never rebased, so force-push is never needed. Done when the PR is open with the
dual-review and passing final-CI receipt in its body, green required checks, a
clean timestamped live-review check on the exact head, and the user has the
report.
