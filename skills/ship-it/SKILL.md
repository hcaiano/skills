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
   working tree. Preserve unrelated user changes.
2. **Local dual-review gate** (skip only for diffs touching exclusively
   docs/markdown/config with no runtime surface). This is a fresh adversarial
   review of the FINAL diff — reviews that happened while writing the code
   (pair acceptance, impeccable, in-flight feedback) are a different thing
   and leave this gate unrun:
   - Run your own review command against the merge base with the target branch
     (Claude: the `code-review` skill; Codex: `/review` against that branch).
     Model budget: run reviews on the standard tier (Claude: Opus, e.g.
     `--model opus` or a code-reviewer subagent pinned to Opus — never Fable;
     Codex: default model, no extra-high reasoning). Fable is advisor-only.
   - In parallel, get a second independent review of the same diff from the
     other agent:
     - In a herdr-pair session, ask the peer (via `$ask-peer` / the pair
       channel) to run its review command and send back its findings.
     - Solo fallback: run the counterpart CLI headlessly on the same diff
       (`codex exec` in read-only mode, or `claude -p` with the code-review
       skill) and collect its findings.
   - Merge and deduplicate both findings lists. Review output is advisory: a
     finding is valid only after you verify it against the real code path.
     Fix valid, in-scope findings in ONE batch. Discard style nits and
     out-of-scope suggestions (note the interesting ones in the PR description
     instead of fixing them). A fix that demands a new contract or
     architecture, or would roughly double the diff, is not a fix — stop and
     surface it as a follow-up. Re-review only the fix diff once to confirm it
     is clean — never a third full pass; surface any leftovers to the user
     instead.
   - The gate leaves a **receipt**: a `## Dual-review` section for the PR body
     naming both reviewers that ran, the finding counts, and each valid
     finding's disposition (fixed in `<sha>` / deferred to `#N`). A skipped
     gate still leaves one stating the skip reason (e.g. docs-only diff).
3. Create clear, intentional commits using the repository conventions.
4. Push safely and open or update one accurate, ready-for-review PR whose body
   carries the step-2 receipt — no receipt, no PR: if you cannot point at a
   completed gate on this final diff, you are still at step 2. Create new
   PRs as non-draft; verify after creation that the draft/ready state on GitHub
   matches what you intended (tooling has silently dropped draft state before).
5. Wait for required CI checks on the PR head (poll at 60–120 s intervals,
   never tight loops). Fix a red check with one batched commit and push; after
   two red rounds, stop and report. Do not wait for or solicit bot reviews.
6. Report the outcome to the user: PR link, CI status, the receipt summary,
   and any findings you discarded or deferred. If actionable review comments appear later (humans,
   or a manually triggered CodeRabbit), the user can invoke
   `$review-pr-comments` to handle them — do not invoke it yourself.

Do not force-push, merge, modify `main`, broaden scope, or change the target
branch without explicit authorization. Done when the PR is open with the
dual-review receipt in its body, green required checks, and the user has the
report.
