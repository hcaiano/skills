---
name: review-pr-comments
description: "Fetch PR review comments from bots and humans, triage as fix/false-positive/out-of-scope/needs-discussion/informational, apply valid same-PR fixes, reply to processed threads, push to the PR branch, and keep rechecking until the latest head is stably clean. Use when the user asks to review PR comments, check PR feedback, handle reviews, address comments, triage a PR, or fix PR comments."
user-invocable: true
argument-hint: "[PR number, URL, or 'all' for all open PRs]"
---

# Review PR Comments

This skill is the dedicated entrypoint for the PR comment loop. Load `../references/pr-comment-loop.md` before classifying or replying to comments. Load `../references/github-comment-fetching.md` when you need exact GitHub API endpoints or unresolved-thread queries.

## Modes

Start in **default single-PR mode** unless the user explicitly asks otherwise.

- **Default single-PR mode:** may fix comments in files that belong to the current PR, reply to processed comments, commit, and push to the same PR branch.
- **Expanded mode:** requires explicit user confirmation before doing any of these: processing `all`, creating follow-up PRs, touching files outside the PR diff, switching branches, modifying `main`, or opening more than one PR.

When a requested action crosses modes, stop and ask for confirmation before changing files.

## Inputs

- `$ARGUMENTS` can be a PR number, full PR URL, or `all`.
- With no argument, detect the PR from the current branch: `gh pr view --json number -q .number`.
- `all` means multi-PR expanded mode. List candidate PRs and confirm before processing.

## Preflight

Fail early with a clear blocker instead of discovering environment problems after edits.

1. Verify GitHub CLI access: `gh auth status` and `gh repo view`.
2. Verify repository state: `git status`, current branch, remote, and push permission.
3. Refuse to work directly on `main` unless the user explicitly asked.
4. Resolve the target PR or confirm expanded mode for `all`.
5. Read repo instruction files: `AGENTS.md`, `CLAUDE.md`, or project-local equivalents.
6. Identify the project quality gate from repo instructions, lockfiles, and package scripts. If unknown, ask the user.
7. Fetch the PR diff file list before classification.

## Discovery

Use `../references/github-comment-fetching.md` for the exact commands.

Fetch all review surfaces for the target PR:

- PR review comments
- PR reviews
- issue timeline comments
- unresolved review threads
- latest-head checks and mergeability state

Filter out already-resolved or outdated comments unless the user asks to include them. Group comments by thread and author.

## Classification

Use the categories from `../references/pr-comment-loop.md`:

| Category | Action |
|---|---|
| Fix | Apply a minimal same-PR code change. |
| Out of Scope | Confirm the finding, then ask before follow-up work unless already in expanded mode. |
| False Positive | Reply with concise reasoning. |
| Needs Discussion | Do not reply automatically; flag for the user. |
| Informational | Optionally react; no text reply required. |

Bot detection should be generic: treat `user.login` values containing `bot` as bots, plus known automation accounts such as CodeRabbit, Codex/OpenAI, Devin, Copilot, Sonar, Greptile, Korbit, and Ultracite. Everything else is human feedback. Human feedback is authoritative unless it is clearly a question or praise.

Before classifying any code suggestion, read the target file and surrounding context. If a suggestion conflicts with repo instruction files or local conventions, classify it as False Positive and explain why.

## Execution

For each Fix item:

1. Read the file and surrounding context.
2. Apply the smallest change that satisfies the comment.
3. Stage only the changed files for that fix group.
4. Batch related fixes into conventional commits.
5. Run the project quality gate identified during preflight.

For Out of Scope findings:

- Verify the bug/risk exists before treating it as real.
- Low-severity unrelated nits can be deferred with a reply.
- Follow-up branches/PRs require expanded-mode confirmation.
- Never open follow-up PRs that depend on unmerged parent-PR changes.

## Replies

Reply once per processed finding. Do not bundle unrelated comments.

- **Fix:** say what changed and reference the commit.
- **Out of Scope:** say whether it was deferred or link the follow-up PR.
- **False Positive:** give the reason.
- **Needs Discussion:** do not reply automatically.
- **Informational:** optional thumbs-up reaction.

For top-level issue comments, quote and link the parent so the timeline stays legible:

```markdown
> [Reviewer note](https://github.com/.../#issuecomment-XXXXX)
> one-line excerpt

Addressed in commit abc1234 - short explanation.
```

For threaded review comments, use the pull review comment reply endpoint from `../references/github-comment-fetching.md`.

## Push And Recheck

After committing fixes:

1. Pull/rebase or merge the latest target branch according to repo convention.
2. Resolve conflicts if any.
3. Rerun the quality gate.
4. Push normally. Never force push unless the user explicitly asks.
5. Re-fetch comments, unresolved threads, checks, and mergeability.

Stop only after two consecutive clean rechecks on the latest head:

- no actionable comments
- no unresolved review threads
- no pending/failing relevant checks
- branch is current with target
- GitHub reports the PR mergeable/not conflicted

Use a progress guard instead of a fixed timer. If checks or reviews do not change over repeated rechecks, or auth/rate limits block inspection, stop and report the exact blocker.

## Summary Report

End with:

```markdown
PR #123 - Review Complete
Fixed:
Dismissed:
Out-of-scope:
Needs attention:
CI:
Merge-ready:
Commits:
Remaining:
```
