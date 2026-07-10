---
name: ship-it
description: "Ship a branch through the full PR lifecycle: intentional commits, local quality gate, push, PR creation/update, CI, target-branch sync, and the shared review-clean loop. Use when the user asks to ship end to end or get a branch fully review-ready. For review feedback on an existing PR without the commit/PR lifecycle, use review-pr-comments."
user-invocable: true
argument-hint: "[branch name or PR number]"
---

# Ship It

Full PR lifecycle automation: commit, quality gate, push, PR, CI, and review
loop. The leading word is **clean**: the PR is not done until the latest head is
clean across local checks, CI, reviewer surfaces, branch sync, and mergeability.

## Phase 1: Commit

1. Run `git status` and `git diff` to understand all changes.
2. Group changes into logical conventional commits (`feat:`, `fix:`, `chore:`, etc.).
3. Stage and commit each group with a message focused on the *why*.

Done when every intended change is committed in a logical conventional commit and
the working tree contains no unrelated staged changes.

## Phase 2: Quality gate

Run the project's quality gate before push — local first catches what CI would catch 3–5 minutes later. Detect the gate, in this order:

1. **Repo instruction files** (`CLAUDE.md`, `AGENTS.md`, or a project-local equivalent). If one documents a quality-gate command, use it.
2. **Lockfile + scripts** for Node-shaped repos: `bun.lock` → `bun`, `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, `package-lock.json` → `npm`. Read `package.json` `scripts` for `check`, `check-types`/`typecheck`, `build`, `test` (or the project's chosen names).
3. **Other ecosystems:** `Cargo.toml` → `cargo check && cargo clippy && cargo build`. `go.mod` → `go vet ./... && go build ./...`. Python pyproject with ruff/mypy → `ruff check && mypy . && pytest`. Adjust to what's actually configured.
4. **Fallback:** ask the user what the gate is, then persist the answer in the PR summary so re-runs don't re-detect.

If any check fails, fix the root cause and commit fixes as separate conventional
commits (`fix(lint): ...`, `fix(types): ...`). Re-run until clean.

Done when the detected project quality gate passes locally, or a precise blocker
has been reported.

## Phase 3: Push & PR

Push the branch (`-u` if needed). Create the PR with `gh pr create`: short title,
summary bullets, test plan. If a PR already exists for the branch, update its
description rather than opening a new one. Never force-push to a shared branch.

Done when the remote branch exists and one PR points at it with an accurate
description.

## Phase 4: CI & review loop

Run the shared loop in `../review-pr-comments/references/pr-comment-loop.md`;
load `../review-pr-comments/references/github-comment-fetching.md` when fetching
GitHub surfaces. Do not re-implement that policy here.

Ship-it adds only these deltas:

1. Run the Phase 2 quality gate before every fix push.
2. Commit loop fixes as logical conventional commits.
3. Push every fix commit to the PR branch.

Done when the shared loop reaches its clean state on the latest head and live
target tip, or reports its precise blocker.

## Done condition

Ship it is done when Phase 4 is clean and the PR remains mergeable. Do not merge;
that is the user's call.
