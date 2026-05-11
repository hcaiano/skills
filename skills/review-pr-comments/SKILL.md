---
name: review-pr-comments
description: "Fetch PR review comments from bots and humans, triage as fix/false-positive/out-of-scope/needs-discussion/informational, apply valid same-PR fixes, reply to processed threads, push to the PR branch, and keep rechecking until the latest head is stably clean. Use when the user asks to review PR comments, check PR feedback, handle reviews, address comments, triage a PR, or fix PR comments."
user-invocable: true
argument-hint: "[PR number, URL, or 'all' for all open PRs]"
---

# Review PR Comments

Dedicated entrypoint for the PR comment loop. The policy (modes, categories, classification context, reply format, recheck loop) lives in `references/pr-comment-loop.md`. API endpoints live in `references/github-comment-fetching.md`. Load both before acting.

## Inputs

`$ARGUMENTS` is a PR number, URL, or `all`. With no argument, detect the PR from the current branch: `gh pr view --json number -q .number`. `all` is multi-PR expanded mode — list candidates and confirm before processing.

## Preflight

Fail early with a clear blocker instead of discovering environment problems after edits.

1. `gh auth status` and `gh repo view` — GitHub CLI is authed and the repo resolves.
2. `git status`, current branch, remote, push permission.
3. Refuse to work directly on `main` unless the user explicitly asked.
4. Resolve the target PR or confirm expanded mode for `all`.
5. Read repo instruction files (`AGENTS.md`, `CLAUDE.md`, or local equivalent).
6. Identify the project quality gate (instructions → lockfiles → package scripts → ask).
7. Fetch the PR diff file list before classification.

## Discovery

Fetch all review surfaces for the target PR (commands in `references/github-comment-fetching.md`):

- PR review comments
- PR reviews
- issue timeline comments
- unresolved review threads
- latest-head checks and mergeability state

Filter resolved/outdated comments unless the user asks to include them. Group by thread and author.

## Classification

Categories and the reply policy come from `references/pr-comment-loop.md`. The skill-specific addition:

**Bot detection** — treat `user.login` containing `bot` as a bot, plus known automation accounts (CodeRabbit, Codex/OpenAI, Devin, Copilot, Sonar, Greptile, Korbit, Ultracite). Everything else is human feedback, authoritative unless it's clearly a question or praise.

Always read the target file and surrounding code before classifying a code suggestion. If a suggestion conflicts with repo instruction files, it's a False Positive — explain why in the reply.

## Execution

For each Fix:

1. Read the file and surrounding context.
2. Apply the smallest change that satisfies the comment.
3. Stage only the changed files for that fix group.
4. Batch related fixes into conventional commits.
5. Run the project quality gate.

Out of Scope: verify the bug/risk exists, defer low-severity nits with a reply, expanded-mode required for follow-up PRs, never open follow-ups that depend on unmerged parent-PR changes.

## Push

1. Pull/rebase or merge the target branch per repo convention.
2. Resolve conflicts.
3. Rerun the quality gate.
4. Push normally. Never force push without explicit user ask.
5. Re-fetch comments, threads, checks, mergeability — then continue per the shared recheck loop.

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
