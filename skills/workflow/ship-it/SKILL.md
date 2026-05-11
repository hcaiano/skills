---
name: ship-it
description: "Full PR lifecycle: splits unstaged changes into logical conventional commits, runs build/lint, creates or updates the PR, then keeps polling CI and reviewer comments until the PR reaches a stable clean state rather than stopping after a tiny fixed loop."
user-invocable: true
argument-hint: "[branch name or PR number]"
---

# Ship It

Full PR lifecycle automation — from uncommitted changes to a reviewed, CI-passing PR.

## When to use

Use when the user says "ship it", "ship this", "get this ready for review", "commit everything and open a PR", "push and handle CI", "submit for review", or wants the full commit-push-CI-review cycle handled end to end.

## Workflow

### Phase 1: Commit
1. Run `git status` and `git diff` to understand all changes
2. Group changes into logical conventional commits (feat, fix, chore, etc.)
3. Stage and commit each group separately with clear commit messages

### Phase 2: Quality Gate (MANDATORY — never skip)
1. Run the full quality check suite: `bun check && bun check-types && bun build`
2. If ANY check fails, fix ALL errors before proceeding — do not skip or defer
3. Commit fixes as separate conventional commits (e.g., `fix(lint): ...`, `fix(types): ...`)
4. Re-run the full suite until it passes clean — zero errors, zero warnings treated as errors

### Phase 3: Push & PR
1. Push branch to remote with `-u` flag if needed
2. Create PR using `gh pr create` — short title, summary bullets, test plan
3. If PR already exists, update it instead

### Phase 4: CI & Review Loop

1. **Start a bounded recheck loop for up to ~20 minutes after each push**
   - Recheck after ~90s, ~3m, ~5m, then every ~5m until the PR is clean or the time budget is exhausted
   - Do not stop after a single wait if checks are still pending or bot reviews are likely still arriving

2. **Check CI status**:
   ```bash
   gh pr checks {number}
   ```
   - If a check fails, read the logs with `gh run view {run_id} --log-failed`
   - Distinguish infra failures (CodeQL config, flaky tests) from real code failures
   - Fix real failures, commit, and push before proceeding

3. **Fetch ALL review comments**:
   ```bash
   gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate
   gh api repos/{owner}/{repo}/pulls/{number}/reviews --paginate
   ```
   - Skip already-resolved/outdated comments
   - Skip purely informational comments (summaries, walkthrough tables)
   - Also fetch or inspect **unresolved review threads** explicitly; flat comments alone are not enough

4. **Classify each comment** by source and action:

   | Source | How to detect |
   |--------|--------------|
   | CodeRabbit | `user.login` contains "coderabbitai" |
   | Codex | `user.login` contains "codex" or "openai" |
   | Devin | `user.login` contains "devin" |
   | Human | Everything else — always treat as valid |

   For each comment, decide: **FIX** or **FALSE POSITIVE**.
   - Read the actual code at the referenced file/line before deciding
   - If a bot suggests something that contradicts CLAUDE.md or project conventions, it's a false positive
   - Check "also applies to" sections in CodeRabbit comments — fix ALL referenced locations

5. **Fix valid issues** — apply the minimal change, stage, but batch commits logically:
   - Each critical/high fix gets its own commit
   - Medium fixes can be grouped per-file
   - Low/cosmetic fixes get batched into one commit

6. **Reply to EVERY processed comment** on the PR thread:

   For fixes:
   ```bash
   gh api repos/{owner}/{repo}/pulls/{number}/comments/{comment_id}/replies \
     -f body="Fixed — [brief explanation of what was changed]"
   ```

   For false positives:
   ```bash
   gh api repos/{owner}/{repo}/pulls/{number}/comments/{comment_id}/replies \
     -f body="Reviewed — false positive. [brief explanation why]"
   ```

   Add a reaction to mark as reviewed:
   ```bash
   gh api repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions -f content="+1"
   ```

7. **Run quality gate again** (`bun check && bun check-types && bun build`), fix any regressions, push

8. **Always sync with the latest `main` before finalizing**:
   ```bash
   git fetch origin main
   git merge --no-edit origin/main
   ```
   - If conflicts appear, resolve them immediately
   - Stage the resolutions, complete the merge, rerun the full quality gate, and push
   - If syncing with `main` created a new head commit, restart the recheck loop from the beginning

9. **Repeat** — after each push, restart the bounded recheck loop. Only finish after **two consecutive clean rechecks** with:
   - No new actionable comments on the latest head
   - No unresolved review threads
   - No pending or failing checks relevant to the latest head
   - Branch is synced with the latest `main`
   - GitHub reports the PR as mergeable / not conflicted

10. If the ~20 minute time budget is exhausted, stop and report the exact remaining blockers or pending reviewers instead of treating the PR as fully clean.

### Rules
- Conventional commits format
- Never force push or skip hooks — `--no-verify` is FORBIDDEN on commits and pushes
- Quality gate (Phase 2) is MANDATORY — never skip, never defer to CI. All lint, type checks, and build must pass locally before pushing
- If a pre-commit hook fails, fix the root cause — never bypass with `--no-verify`
- PR target branch is `main`
- Never merge — only create/update
- Do not declare the loop complete while review threads or latest-head checks are still pending
- Always integrate latest `main` and resolve conflicts before calling the PR ready
- "Ready" means merge-ready on GitHub, not just locally green
