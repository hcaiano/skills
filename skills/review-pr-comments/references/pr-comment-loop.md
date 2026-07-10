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

## Inventory Rules

Build a checklist from the live GitHub surfaces on every loop iteration:

- every GraphQL review thread with `isResolved=false`, including threads where
  `isOutdated=true`;
- every non-empty actionable PR review body that is not minimized/resolved;
- every top-level issue comment that looks actionable and has no follow-up reply
  from your account quoting its permalink/title;
- every processed finding whose required reply, thread resolution, or review-body
  minimization cannot be verified.

`isOutdated=true` only means the diff hunk moved. It does not mean the thread is
closed. If GitHub still reports `isResolved=false`, the user can still see it as
an open issue. Reply with the current classification, resolve the thread when
appropriate, and re-query the exact thread id.

## Reply Format

**Hard rule: every actionable finding gets its own reply on the original surface.** A single summary comment on the PR is not a substitute and is forbidden as the only response — the user cannot tell which issues were handled if replies are not attached to, or clearly quote, each finding.

- Reply to threaded review comments using `in_reply_to=<COMMENT_ID>` so the reply nests under the original thread.
- After replying to a Fix / False Positive / Out of Scope review thread, resolve
  the thread when GraphQL exposes `resolveReviewThread`, then re-query that exact
  thread and require `isResolved=true`. A posted reply alone is not enough for a
  clean UI state.
- Reply to actionable PR review bodies as a top-level issue comment that quotes the review permalink and the finding title, because GitHub does not expose a resolvable thread for review-body findings. Process unreplied review-body findings even when their reviewed commit is older than the current PR head; stale review bodies remain visible in the timeline and still need an audit reply. Only after every actionable finding in that same review body has been classified, fixed or deferred, and replied to, check whether the review body implements `Minimizable`; if `viewerCanMinimize` is true, minimize it with classifier `RESOLVED`.
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

After every push, reply, thread resolution, or review-body minimization, inspect
all review surfaces again:

- new comments
- unresolved review threads, including outdated unresolved threads
- actionable PR review bodies
- unminimized actionable review bodies
- unreplied actionable issue comments
- CI/check status
- mergeability/conflict state
- branch staleness against target

**Reviewer-first invariant:** never wait on pending CI while there are unresolved review threads of any age, fresh reviewer comments, unminimized actionable review-body findings, or unreplied actionable findings. Reviewer feedback is the immediate work queue. Pending CI is background signal until the review surface is clean.

Use this order after each push:

1. Record the latest head SHA from the PR.
2. Fetch unresolved review threads, review comments, PR review bodies, and issue comments.
3. If any inventory item exists, classify the whole current sweep and group compatible fixes. Fix all actionable items from that sweep before pushing unless they conflict or one fix is risky enough to isolate. Then run the local quality gate, commit, push, reply on each original thread, resolve threads when appropriate, minimize processed review bodies when allowed, and restart the loop. Do not wait for CI before doing this.
4. Only when the reviewer surface is quiet, check CI status for the latest head.
5. If a CI check has completed with a real failure, read the failed logs, fix, run the local quality gate, commit, push, and restart the loop.
6. If CI is only queued or in progress and reviewer feedback is clean, poll every
   90 seconds. Every poll must re-check reviewer threads/comments before checking
   CI again.

This avoids wasting a full CI cycle after every reviewer fix. Bots often post comments while CI is still running, and any fix push restarts CI anyway. The only signal that strictly requires green CI is the final done condition.

## Target-Branch Sync

Target-branch sync is part of the loop, not optional PR maintenance. Resolve the
PR's current `baseRefName` from GitHub on every sync; the target is often `main`
but may be any branch. Use the commands in `github-comment-fetching.md` to fetch
the remote target and integrate its latest tip into the PR branch. Follow an
explicit repo merge/rebase convention; otherwise merge the remote target so the
push remains fast-forward. A rebase that would require a force-push needs explicit
user approval.

Resolve conflicts that are safely determined by the PR intent, target-branch
changes, tests, and repo instructions. Then require no unmerged paths, run the
full local quality gate, commit the integration when needed, and push. The new
head invalidates prior CI and clean rechecks, so restart the loop. If a conflict
requires product or architectural judgment that the available evidence cannot
settle, report the exact files and competing behaviours as a blocker.

Before each clean recheck, fetch the live target again and require its fetched tip
to be an ancestor of the PR head. If it advanced, integrate it and restart the
loop. A clean recheck is tied to both the same PR head SHA and the same target tip
SHA.

Success requires a quiet window, not an instantaneous clean state.

A **clean recheck** means the inventory is empty: `0` unresolved review threads
including outdated threads, `0` unminimized actionable review bodies, `0`
unreplied actionable issue comments, every Fix / False Positive / Out of Scope
item has a reply on the original surface, every processed review thread is
confirmed `isResolved=true`, every processed review-body finding is minimized
when minimization is allowed, every check required by GitHub for the latest head
is registered, completed, and green, the fetched target tip is an ancestor of
that head, and GitHub reports the PR mergeable. If this PR normally runs checks,
treat an empty check rollup shortly after a push as pending. Treat a transient
`UNKNOWN` merge state as pending too; re-poll both rather than counting them as
clean.

The first clean recheck opens a **10-minute quiet window**. Poll every 90 seconds
during that window, always inspecting reviewer surfaces before CI. Any new review
surface event; check run appearing, restarting, or failing; target-tip advance;
push; reply; thread resolution; or review-body minimization resets the window.
Handle the event, obtain a fresh first clean recheck, and open a new window.

The loop succeeds only when a second clean recheck observes the same PR head SHA
and target tip SHA after the full quiet window elapses without a reset.

Stop with a precise blocker instead of waiting indefinitely when CI remains
queued or pending for 30 minutes without any state change, the quiet window resets
five consecutive times solely because the target branch advances, auth or rate
limits prevent inspection, a merge conflict requires judgment the available
evidence cannot settle, or the next action needs expanded-mode confirmation.
