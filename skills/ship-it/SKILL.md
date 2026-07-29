---
name: ship-it
description: "Ship finished work: the graded local review gate, then one PR carried to green CI. Use when the user wants to ship, open, or update a PR, or when another skill needs that graded gate."
---

# Ship It

Open or update a PR for the current work. Quality is enforced locally, before
the PR exists.

1. Read the repository instructions and inspect the current branch, diff, and
   working tree. Preserve unrelated user changes. Before review, mark each
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
   - From Codex/headless, `acceptEdits` writes to the worktree unsupervised,
     so bracket the run. Snapshot the pre-run tree first as a baseline patch,
     `git diff HEAD --binary > <baseline patch>` — it captures the
     intent-to-add paths from step 1, which `git stash create` refuses. Then
     start this in the background against a log, keeping its PID (stock
     macOS has no `timeout` binary, so the deadline is yours):
     `claude -p --model opus --permission-mode acceptEdits --strict-mcp-config --no-chrome --output-format stream-json --include-partial-messages --verbose "/simplify"`.
     Streamed events make progress visible: the log growing is the liveness
     signal, and 20 minutes without a new line, or 60 minutes in total, is a
     hang. Complete means exit 0 plus a final `result` event with
     `is_error: false`.
     On a hang, a nonzero exit, or a missing result: kill that PID and
     confirm no `claude` process is still writing before touching the tree
     (background jobs share the caller's process group, so kill the PID
     itself, never the group). Restore with
     `git checkout HEAD -- . && git apply --binary <baseline patch>`, re-mark
     the step 1 intent-to-add paths, and review anything untracked the run
     left behind. Then mark Claude unavailable for this
     gate (step 4 regrades) and record `failed — <reason>` on the receipt's
     `Simplify:` line.
   On success, keep Claude's fixes in the working tree and run focused proof
   before the review gate. Skip simplify, like the gate, for
   docs/markdown/config-only diffs.
4. **Local review gate** at the graded level — `single`: the current agent's
   native review alone; `dual`: both native reviews below; `codex-only`: the
   Codex review alone; `claude-only`: the Claude review alone. Skip only for
   diffs touching exclusively
   docs/markdown/config with no runtime surface; the receipt names the
   graded level. A one-review gate — `single`, `codex-only`, `claude-only` —
   stops if that review cannot complete and never regrades to another agent;
   a `dual` review that cannot complete regrades to the other harness alone,
   named in the receipt. Everything else in this step
   applies to whichever review(s) run. This is a fresh adversarial
   review of the FINAL diff — reviews that happened while writing the code
   (pair acceptance, impeccable, in-flight feedback) are a different thing
   and leave this gate unrun:
   - Run your own NATIVE review harness against the merge base with the target
     branch. Use each agent's native command surface, not an assumed repository
     skill:
     - Claude Code: invoke the `/code-review` slash command itself on Opus —
       in-session when Claude is driving (the same command the user would
       type), or headless as
       `claude -p --model opus --permission-mode plan --strict-mcp-config --no-chrome --output-format stream-json --include-partial-messages --verbose "/code-review"`,
       backgrounded against a log, live and complete on step 3's terms. Its
       `plan` mode writes nothing, so it needs no baseline patch — a hang
       still gets the same kill.
       This gate is satisfied only by running the `/code-review` command in
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
   never tight loops). Fix a red check with one batched commit and return to
   steps 4–7; after two red rounds, stop and report.
9. Immediately before reporting shipped, re-fetch complete paginated reviews,
   issue comments, inline comments, and review threads, and capture the live
   `headRefOid`. Require it to match both the final-CI receipt SHA and the SHA
   whose required checks passed; any mismatch returns to steps 4–8. Handle
   every item newer than the baseline and every unresolved thread. If that
   changes the branch, return to steps 4–8. `review:verify` proves only its
   timestamp. Record the clean check timestamp and head.
10. Report the outcome to the user: PR link, exact head, CI status, live-review
   timestamp, receipt summary, and any findings discarded or deferred.

Do not force-push, merge, modify `main`, broaden scope, or change the target
branch without explicit authorization. Done when the PR is open with the
dual-review and passing final-CI receipt in its body, green required checks, a
clean timestamped live-review check on the exact head, and the user has the
report.
