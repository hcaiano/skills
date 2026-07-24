---
name: ship-it
description: "Manual-only PR creation for current work: run the local dual-review gate, commit and push intentional changes, open the PR, and wait for green CI. Use only when the user explicitly invokes ship-it."
disable-model-invocation: true
user-invocable: true
argument-hint: "[branch name]"
---

# Ship It

Open or update a PR for the current work. Quality is enforced locally, BEFORE
the PR exists — cloud auto-review is disabled by design. Do not re-enable it,
request bot reviews, or wait for them.

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
   spends Claude tokens). If the open PR for this branch already
   carries a `Simplify:` line in its receipt, the pass has run: skip it.
   Otherwise have Claude run its native `/simplify` command on this same
   final diff (in-session when Claude is driving; headless form:
   `claude -p --model opus --permission-mode acceptEdits --output-format text "/simplify"`)
   and keep its fixes in the working tree for the gate to review. Skip it,
   like the gate, for docs/markdown/config-only diffs.
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
       type), or headless as
       `claude -p --model opus --permission-mode plan --output-format text "/code-review"`.
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
     harnesses run their own verification machinery — an improvised
     read-through of the diff does not count.
     Model budget: Claude uses Opus (`--model opus`), never Fable; Codex uses
     its default model with no extra-high reasoning. Fable is advisor-only.
   - `dual` only — in parallel, get a second independent review of the same
     diff from the other agent:
     - In a herdr-pair session, ask the peer (via `$ask-peer` / the pair
       channel) to run its native review harness and send back its findings.
     - Solo fallback: run the counterpart's headless command above on the same
       diff and collect its findings.
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
     `skipped — <reason>`), then naming the exact harness command each
     reviewer ran, the finding counts,
     and each valid finding's disposition (fixed in `<sha>` / deferred to
     `#N`). A skipped
     gate still leaves one stating the skip reason (e.g. docs-only diff).
5. Create clear, intentional commits using the repository conventions.
6. Push safely and open or update one accurate, ready-for-review PR whose body
   carries the gate receipt — no receipt, no PR: if you cannot point at a
   completed gate on this final diff, you are still at step 4. Create new
   PRs as non-draft; verify after creation that the draft/ready state on GitHub
   matches what you intended (tooling has silently dropped draft state before).
7. Wait for required CI checks on the PR head (poll at 60–120 s intervals,
   never tight loops). Fix a red check with one batched commit and push; after
   two red rounds, stop and report. Do not wait for or solicit bot reviews.
8. Report the outcome to the user: PR link, CI status, the receipt summary,
   and any findings you discarded or deferred. If actionable review comments appear later (humans,
   or a manually triggered CodeRabbit), the user can invoke
   `$review-pr-comments` to handle them — do not invoke it yourself.

Do not force-push, merge, modify `main`, broaden scope, or change the target
branch without explicit authorization. Done when the PR is open with the
dual-review receipt in its body, green required checks, and the user has the
report.
