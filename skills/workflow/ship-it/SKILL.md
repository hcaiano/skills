---
name: ship-it
description: "Full PR lifecycle: splits unstaged changes into logical conventional commits, runs the project's quality gate, creates or updates the PR, then keeps polling CI and reviewer comments until the PR reaches a stable clean state rather than stopping after a tiny fixed loop."
user-invocable: true
argument-hint: "[branch name or PR number]"
---

# Ship It

Full PR lifecycle automation — from uncommitted changes to a reviewed, CI-passing PR.

## When to use

"ship it", "ship this", "get this ready for review", "commit everything and open a PR", "push and handle CI", "submit for review", or any request for the full commit-push-CI-review cycle end to end.

## Phase 1: Commit

1. Run `git status` and `git diff` to understand all changes.
2. Group changes into logical conventional commits (`feat:`, `fix:`, `chore:`, etc.).
3. Stage and commit each group with a message focused on the *why*.

## Phase 2: Quality gate

Run the project's quality gate before push — local first catches what CI would catch 3–5 minutes later. Detect the gate, in this order:

1. **Repo instruction files** (`CLAUDE.md`, `AGENTS.md`, or a project-local equivalent). If one documents a quality-gate command, use it.
2. **Lockfile + scripts** for Node-shaped repos: `bun.lock` → `bun`, `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, `package-lock.json` → `npm`. Read `package.json` `scripts` for `check`, `check-types`/`typecheck`, `build`, `test` (or the project's chosen names).
3. **Other ecosystems:** `Cargo.toml` → `cargo check && cargo clippy && cargo build`. `go.mod` → `go vet ./... && go build ./...`. Python pyproject with ruff/mypy → `ruff check && mypy . && pytest`. Adjust to what's actually configured.
4. **Fallback:** ask the user what the gate is, then persist the answer in the PR summary so re-runs don't re-detect.

If any check fails, fix the root cause and commit fixes as separate conventional commits (`fix(lint): ...`, `fix(types): ...`). Re-run until clean.

## Phase 3: Push & PR

Push the branch (`-u` if needed). Create the PR with `gh pr create` — short title, summary bullets, test plan. If a PR already exists for the branch, update its description rather than opening a new one. Never force-push to a shared branch.

## Phase 4: CI & review loop

Run the recheck loop documented in `skills/workflow/references/pr-comment-loop.md`. It covers mode-split safety, comment classification, reply format, and the "two consecutive clean rechecks" stop condition. Don't re-implement that policy here.

After each push:

1. **Check CI:** `gh pr checks {number}`. For failures, read logs with `gh run view {run_id} --log-failed`. Distinguish infra failures (CodeQL config, flaky tests) from real code failures; fix the real ones, commit, push.
2. **Run the PR comment loop** per the shared reference. Default to single-PR mode; ask before any expanded-mode action.
3. **Sync with target branch** before claiming ready:
   ```bash
   git fetch origin main
   git merge --no-edit origin/main
   ```
   Resolve conflicts immediately, re-run the quality gate, push. If the merge created a new head, restart the recheck loop.
4. **Re-run the quality gate** after fixes. Push.

## Done condition

Ship it is done when the latest head shows:

- No new actionable comments on the latest head.
- No unresolved review threads.
- No pending or failing checks relevant to the latest head.
- Branch synced with the target.
- GitHub reports the PR as mergeable.

Two consecutive rechecks meeting all of the above. Stop before that condition only when the shared reference's "stop with a precise blocker" criteria fire (auth/rate limits, checks stop changing across repeated rechecks, merge conflicts requiring broader judgment, expanded-mode confirmation needed). Never declare ready while threads or latest-head checks are still pending. Don't merge — that's the user's call.
