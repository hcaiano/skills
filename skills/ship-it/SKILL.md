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
2. **Grade the gate.** The gate spends both usage pools — Claude
   (simplify + review) and Codex (review) — so fix its level before
   anything runs. An orchestrator-graded gate named in the invocation
   wins. Otherwise read the pools yourself: run
   `node scripts/usage-state.mjs` from the herdr-orchestrate skill
   installed alongside this one; a pool is out of headroom at
   `used_percent` ≥ 90 or when its CLI is observed refusing — a null
   reading never degrades on its own. Both with headroom → `dual`.
   Claude out → `codex-only`. Codex out → `claude-only`. Both out →
   stop and ask the user whether to ship on whichever harness still
   responds or wait for a reset. Tell the user the graded level when it
   is anything but `dual`.
3. **Simplify pass** — once per PR, always before the review gate so the
   reviewers see the simplified diff; a `codex-only` gate skips it (it
   spends Claude tokens). Skip an existing receipt only when its
   `Simplify:` line proves a successful prior run or an applicable
   docs-only skip; a failed/aborted attempt is not success. Otherwise have
   Claude run its native `/simplify` command on this same final diff:
   - In-session when Claude is driving, invoke `/simplify` directly.
   - From Codex/headless, run the bundled transactional wrapper from the
     target worktree:
     `node <ship-it-dir>/scripts/run-claude-native.mjs simplify`.
     The wrapper owns the 60-minute total deadline and 20-minute
     no-progress deadline, streams structured progress, disables Chrome and
     unrelated MCP startup, requires Claude's successful final result event,
     and restores the exact pre-run Git-visible working tree on every
     incomplete result.
     Do not wrap it in a shorter timeout, interrupt it while its heartbeats
     continue, or replace it with the old buffered `--output-format text`
     command. A failed run leaves Claude's partial work in a named recoverable
     stash and exits nonzero; report the stash, mark Claude unavailable for
     this gate, regrade to `codex-only`, and continue without those edits.
   On success, keep Claude's fixes in the working tree and run focused proof
   before the review gate. Skip simplify, like the gate, for
   docs/markdown/config-only diffs.
4. **Local review gate** at the graded level — `dual`: both native
   reviews below; `codex-only`: the Codex review alone; `claude-only`:
   the Claude review alone. Skip only for diffs touching exclusively
   docs/markdown/config with no runtime surface; the receipt names the
   graded level. Everything else in this step applies to whichever
   review(s) run. This is a fresh adversarial
   review of the FINAL diff — reviews that happened while writing the code
   (pair acceptance, impeccable, in-flight feedback) are a different thing
   and leave this gate unrun:
   - Run your own NATIVE review harness against the merge base with the target
     branch. Use each agent's native command surface, not an assumed repository
     skill:
     - Claude Code: invoke the `/code-review` slash command itself on Opus —
       in-session when Claude is driving (the same command the user would
       type), or from Codex/headless as
       `node <ship-it-dir>/scripts/run-claude-native.mjs review`.
       The same structured-result, heartbeat, timeout, MCP-isolation, and
       transactional rollback rules from simplify apply. A nonzero result
       makes Claude unavailable for this gate and regrades it; do not improvise
       a replacement Claude prompt.
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
     opening with a `Gate:` line (`dual` / the degraded level and why) and a
     `Simplify:` line (`applied in <sha>` / `already run` /
     `skipped — <reason>` / `failed — workspace restored, partial stash
     <sha>`), then naming the exact harness command each
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
