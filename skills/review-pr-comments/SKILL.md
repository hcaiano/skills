---
name: review-pr-comments
description: "Fetch PR review comments from bots and humans, triage as fix/false-positive/out-of-scope/needs-discussion/informational, apply valid same-PR fixes, reply to processed threads, push to the PR branch, and keep rechecking until the latest head is stably clean. Use when the user asks to review PR comments, check PR feedback, handle reviews, address comments, triage a PR, or fix PR comments."
user-invocable: true
argument-hint: "[PR number, URL, or 'all' for all open PRs]"
---

# Review PR Comments

Dedicated entrypoint for the PR comment loop. The policy (modes, categories, classification context, reply format, recheck loop) lives in `references/pr-comment-loop.md`. API endpoints live in `references/github-comment-fetching.md`. Load both before acting.

## When to run (proactive contract — don't wait to be asked)

You OWN the review threads on every PR YOU open. Run this loop **automatically** — without a user request — at two moments, scoped to PRs you created in this work (do not retroactively sweep older/other agents' PRs):

1. **~3-5 min after `gh pr create`** — CodeRabbit, the Codex/ChatGPT connector, and Socket post line comments a few minutes *after* open, not at open.
2. **After every push** to that PR branch — bots re-review new commits and surface findings progressively.

**Hard reporting gate:** a PR is NOT done, and you must NOT report it as "green / ready / merge-ready / awaiting approval / done," until you have fetched review threads, review comments, PR review bodies, and issue comments on the current head and confirmed **0 unresolved threads, 0 unminimized actionable review bodies, and 0 unreplied actionable items**. CI-green ≠ review-clean. A status report is never a substitute for the review pass. The most common failures are declaring a PR ready at open-time before bots comment, checking only non-outdated review threads while unresolved outdated threads still show in GitHub, and checking only unresolved review threads while missing actionable review-body comments.

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
- PR reviews, including non-empty review bodies
- issue timeline comments
- unresolved review threads
- latest-head checks and mergeability state

Filter only resolved threads and clearly informational noise. **Do not filter out an unresolved thread just because `isOutdated=true` or the comment is on an older commit.** GitHub still displays unresolved outdated threads, and the user still sees them as issues. Group by thread, review body, and author.

**Review-body comments are first-class feedback.** Some bots put actionable findings in the pull request review body instead of a threaded review comment. Treat a non-empty review body from a bot or human as actionable when it contains a concrete finding title, severity badge, linked file/line, request to change code, or "Useful? React..." feedback block. Review-body findings have no GitHub thread to resolve; they still require a reply as a top-level issue comment quoting the review permalink/title after Fix / False Positive / Out of Scope classification. Do not ignore an unreplied actionable review body just because its reviewed commit is no longer the PR head; classify it against the current code and reply with the commit that fixed it, or explain why it is no longer applicable. After replying, if GraphQL says the review body is minimizable, minimize it as `RESOLVED` so stale fixed review-body blocks do not remain visually indistinguishable from active feedback. A non-empty actionable review body that remains unminimized is not clean unless it is explicitly classified under Needs attention.

## Classification

Categories and the reply policy come from `references/pr-comment-loop.md`. The skill-specific addition:

**Bot detection** — treat `user.login` containing `bot` as a bot, plus known automation accounts (CodeRabbit, Codex/OpenAI, Devin, Copilot, Sonar, Greptile, Korbit, Ultracite). Everything else is human feedback, authoritative unless it's clearly a question or praise.

Always read the target file and surrounding code before classifying a code suggestion. If a suggestion conflicts with repo instruction files, it's a False Positive — explain why in the reply.

## Execution

Keep a minimal working checklist keyed by original comment id/thread URL: category, reply status, resolution/minimization status, and fix commit SHA when relevant. A finding is done only after its original surface has the required reply and GitHub state confirms it is closed:

- review thread: reply posted, `resolveReviewThread` attempted for Fix / False Positive / Out of Scope, then exact thread re-query shows `isResolved=true`;
- review body: issue comment quotes the review permalink/title, then minimization is attempted when allowed and exact review re-query shows `isMinimized=true`;
- issue comment: follow-up issue comment quotes the original permalink/title.

For each Fix:

1. Read the file and surrounding context.
2. Apply the smallest change that satisfies the comment.
3. Stage only the changed files for that fix group.
4. Batch related fixes into conventional commits.
5. Run the project quality gate.
6. After the commit lands, reply on every comment or review-body finding fixed by that commit with the commit SHA (see Reply Format in `references/pr-comment-loop.md`). One reply per finding, even when several share a commit.

For each False Positive / Out of Scope: post the threaded reply immediately with the templated reasoning. Do not wait until the end.

Out of Scope: verify the bug/risk exists, defer low-severity nits with a reply, expanded-mode required for follow-up PRs, never open follow-ups that depend on unmerged parent-PR changes.

## Push

1. Pull/rebase or merge the target branch per repo convention.
2. Resolve conflicts.
3. Rerun the quality gate.
4. Push normally. Never force push without explicit user ask.
5. Re-fetch reviewer comments, review bodies, and unresolved threads first. If any unresolved thread exists, including `isOutdated=true`, handle it before waiting on queued/in-progress CI. If new actionable feedback appears, handle it before waiting on queued/in-progress CI.
6. Then re-fetch checks and mergeability, and continue per the shared recheck loop. During this re-fetch, verify every Fix / False Positive / Out of Scope item has a reply from your account on the original surface (review comments: match `in_reply_to_id`; review bodies and issue comments: a follow-up issue comment that quotes the original permalink/title). For review threads, also verify GraphQL `isResolved=true` after replying; if your account can resolve the thread and the finding is Fix / False Positive / Out of Scope, call `resolveReviewThread` and re-query the exact thread id. Post anything missing before reporting complete. A general PR summary is never a substitute.
7. Do not stop after a single clean check immediately after pushing or replying. Bots can post late. A clean finish requires two full reviewer-surface rechecks on the same latest head separated by at least 3 minutes after the most recent push/reply/resolve/minimize. The second recheck must still show **0 unresolved threads total** (not just active/non-outdated), **0 unminimized actionable review bodies**, and **0 unreplied actionable issue comments**.
8. If a recheck finds any issue, reset the clean counter to 0 and keep looping from Discovery. Only stop early for a real blocker: auth/rate-limit failure, merge conflict needing judgment, CI failure you cannot inspect, or a Needs Discussion item that requires user input. In blocker cases, do not call the PR clean; list exact URLs under Needs attention.

## Summary Report

End with:

```markdown
PR #123 - Review Complete
Fixed: <count> (each replied with commit SHA on the original thread)
Dismissed: <count> (each replied as false positive on the original thread)
Out-of-scope: <count> (each replied with deferral reason on the original thread)
Needs attention: <list of thread URLs awaiting user input>
Unreplied: <should be 0 — if not, list thread URLs and reason>
CI:
Merge-ready:
Commits:
Remaining:
```

`Unreplied` must be `0` for a clean run — it only counts Fix / False Positive / Out of Scope. Needs Discussion and Informational do not count as Unreplied, but every Needs Discussion thread must appear under `Needs attention` with its URL.
