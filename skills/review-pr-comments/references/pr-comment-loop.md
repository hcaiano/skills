# PR Comment Loop

Shared policy for `review-pr-comments` and `ship-it`.

## Mode-Split Safety

Start in default single-PR mode unless the user explicitly expands scope.

- **Default single-PR mode:** fix comments in files already in the PR diff, reply to processed comments, commit, and push to the same PR branch.
- **Expanded mode:** requires explicit user confirmation before processing `all`, creating follow-up PRs, touching files outside the PR diff, switching branches, modifying `main`, or opening more than one PR.

If a comment is valid but outside the current PR diff, verify it and then ask before doing follow-up work unless the user already confirmed expanded mode.

## Categories

| Category | Criteria | Action |
|---|---|---|
| Fix | Clear, actionable change in the current PR diff. | Apply the smallest code change, commit, and reply. |
| Out of Scope | Valid finding outside the current PR diff. | Verify, then defer or ask for expanded-mode follow-up. |
| False Positive | Incorrect, already handled, or conflicts with repo conventions. | Reply with concise reasoning. |
| Needs Discussion | Ambiguous, architectural, product-sensitive, or behavior-changing without clear confidence. | Flag for the user; do not reply automatically. |
| Informational | Praise, summaries, walkthroughs, status updates. | Optionally react; no text reply needed. |

Human comments are authoritative unless obviously praise, status, or a question. Bot comments must be validated against code and repo instruction files.

## Bot Detection

Treat an author as a bot when `user.login` contains `bot`, or when it matches a known automation account such as CodeRabbit, Codex/OpenAI, Devin, Copilot, Sonar, Greptile, Korbit, or Ultracite. Everything else is human.

## Required Context Before Classification

For each actionable-looking comment:

1. Read the target file and surrounding code.
2. Check whether the target file is in the PR diff.
3. Read repo instruction files (`AGENTS.md`, `CLAUDE.md`, or local equivalents).
4. Check whether the suggestion changes behavior, security, data flow, or public API.
5. Check whether multiple comments identify the same root issue.

Classify from evidence, not from comment text alone.

## Reply Format

**Hard rule: every actionable finding gets its own threaded reply on the original comment.** A single summary comment on the PR is not a substitute and is forbidden as the only response — the user cannot tell which issues were handled if replies are not attached to each thread.

- Reply to threaded review comments using `in_reply_to=<COMMENT_ID>` so the reply nests under the original thread.
- Reply to top-level issue comments as a new issue comment that quotes the original (short quote + permalink) so the timeline stays readable.
- One reply per finding. Do not batch multiple findings into one reply.
- Do not skip a reply because the fix is "obvious from the diff" — the reply is the audit trail.

Reply body templates (keep them short, one line is fine):

- Fix: `Fixed in <commit-sha> — <what changed>.`
- False Positive: `False positive — <why>. <link to code or repo instruction if relevant>.`
- Out of Scope: `Out of scope for this PR — <reason>. <follow-up PR/issue link if opened>.`
- Needs Discussion: no automatic reply; flag to the user in the summary.
- Informational: optional `+1` reaction; no text reply.

If a single commit fixes multiple comments, reply on each comment individually, all pointing to the same commit SHA.

## Recheck Loop

After every push, inspect all latest-head surfaces again:

- new comments
- unresolved review threads
- CI/check status
- mergeability/conflict state
- branch staleness against target

**Reviewer-first invariant:** never wait on pending CI while there are unresolved, non-outdated review threads, fresh reviewer comments, or unreplied actionable findings. Reviewer feedback is the immediate work queue. Pending CI is background signal until the review surface is clean.

Use this order after each push:

1. Record the latest head SHA from the PR.
2. Fetch unresolved review threads, review comments, reviews, and issue comments.
3. If active review feedback exists, classify the whole current sweep and group compatible fixes. Fix all actionable items from that sweep before pushing unless they conflict or one fix is risky enough to isolate. Then run the local quality gate, commit, push, reply on each original thread, resolve threads when appropriate, and restart the loop. Do not wait for CI before doing this.
4. Only when the reviewer surface is quiet, check CI status for the latest head.
5. If a CI check has completed with a real failure, read the failed logs, fix, run the local quality gate, commit, push, and restart the loop.
6. If CI is only queued or in progress and reviewer feedback is clean, it is acceptable to wait/poll CI, but every poll must re-check reviewer threads/comments before checking CI again.

This avoids wasting a full CI cycle after every reviewer fix. Bots often post comments while CI is still running, and any fix push restarts CI anyway. The only signal that strictly requires green CI is the final done condition.

Success requires two consecutive clean rechecks on the latest head. A clean recheck means reviewer feedback is quiet, every Fix / False Positive / Out of Scope item has a threaded reply, CI is green for the latest head, the branch is synced, and GitHub reports the PR mergeable. Stop with a precise blocker when auth/rate limits prevent inspection, CI remains pending without progress after repeated reviewer-clean polls, merge conflicts require broader judgment, or the next action needs expanded-mode confirmation.
